// The agentic tool-use loop shared by all gated arms (A/B/C).
//
// The agent sees ONLY the arm's exploration tools (never data rows). It calls
// them selectively; when done it calls `submit_answer` with a single SQL
// statement, which the harness executes and scores. The prompt, loop, cap, and
// scoring are identical across arms — the only variable is which tools the
// provider exposes and what they return.
//
// Cost is the point: each turn resends the growing transcript, so a chatty
// exploration pays super-linearly in input tokens. Per-turn raw token fields
// (input / cache_creation / cache_read / output) are recorded so the analysis
// can derive both a billed (cache-on) and an uncached (intrinsic volume)
// figure. Prompt caching is enabled so both are observable from one run.

import Anthropic from '@anthropic-ai/sdk';

import type { ArmToolProvider } from '../tools/provider.js';

/** The minimal task shape the loop needs (BenchTask and GateTask both satisfy). */
export interface PromptTask {
  question: string;
  result_shape: string;
}

export const DEFAULT_MODEL = 'claude-sonnet-5';
export const EFFORT = 'high';
/** Pre-registered exploration cap (tool calls, excluding submit_answer). */
export const TOOL_CALL_CAP = 30;
const MAX_TURNS = 40;
const MAX_TOKENS = 4096;

export interface TurnUsage {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
}

export interface LoopResult {
  ok: boolean;
  sql: string;
  notes: string;
  usage: TurnUsage[];
  toolCalls: number;
  /** Count of enumerate-all calls (list_*), tracked separately (C-12). */
  enumerateCalls: number;
  turns: number;
  capHit: boolean;
  stopReason: string | null;
  error?: string;
}

const SUBMIT_TOOL = {
  name: 'submit_answer',
  description:
    'Submit your final answer: a single PostgreSQL SELECT statement that answers the question. Call this exactly once, when you are done exploring.',
  input_schema: {
    type: 'object',
    properties: {
      sql: { type: 'string', description: 'A single PostgreSQL SELECT statement.' },
      notes: { type: 'string', description: 'Caveats or uncertainty; empty string if none.' },
    },
    required: ['sql', 'notes'],
    additionalProperties: false,
  },
} as const;

function systemPrompt(): string {
  return [
    'You are a data analyst answering a business question against a PostgreSQL database.',
    'You cannot see any data rows and you cannot run exploratory queries.',
    'Use the provided tools to explore the schema (relations, columns, and any',
    'available documentation), then answer with ONE final SQL statement by',
    'calling submit_answer. Explore only as much as you need.',
    'Do not modify any data.',
  ].join('\n');
}

function userPrompt(task: PromptTask): string {
  return [
    `Question: ${task.question}`,
    '',
    `Your submitted SQL must return ${task.result_shape}.`,
    'If the available information seems insufficient or the result may be',
    'incomplete, say so in "notes" but still submit your best single SELECT.',
  ].join('\n');
}

type Block = Anthropic.ContentBlockParam;

function withCacheControl(blocks: Block[]): Block[] {
  if (blocks.length === 0) return blocks;
  const last = blocks[blocks.length - 1] as { cache_control?: unknown };
  last.cache_control = { type: 'ephemeral' };
  return blocks;
}

function readUsage(u: Anthropic.Usage): TurnUsage {
  const anyU = u as unknown as {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  return {
    input: anyU.input_tokens ?? 0,
    output: anyU.output_tokens ?? 0,
    cacheCreation: anyU.cache_creation_input_tokens ?? 0,
    cacheRead: anyU.cache_read_input_tokens ?? 0,
  };
}

export interface RunLoopOptions {
  client: Anthropic;
  model: string;
  task: PromptTask;
  provider: ArmToolProvider;
}

export async function runAgentLoop(opts: RunLoopOptions): Promise<LoopResult> {
  const { client, model, task, provider } = opts;
  const tools = [...provider.tools, SUBMIT_TOOL] as unknown as Anthropic.ToolUnion[];
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: systemPrompt(), cache_control: { type: 'ephemeral' } },
  ];
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userPrompt(task) },
  ];

  const usage: TurnUsage[] = [];
  let toolCalls = 0;
  let enumerateCalls = 0;
  let capHit = false;

  for (let turn = 1; turn <= MAX_TURNS; turn += 1) {
    const forceSubmit = capHit; // after the cap, force a final answer
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system,
        tools,
        tool_choice: forceSubmit ? { type: 'tool', name: 'submit_answer' } : { type: 'auto' },
        output_config: { effort: EFFORT },
        messages,
      } as Anthropic.MessageCreateParamsNonStreaming);
    } catch (err) {
      return {
        ok: false, sql: '', notes: '', usage, toolCalls, enumerateCalls, turns: turn - 1,
        capHit, stopReason: null, error: err instanceof Error ? err.message : String(err),
      };
    }

    usage.push(readUsage(response.usage));
    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    if (toolUses.length === 0) {
      // Model stopped without a tool call. Nudge once toward submit_answer.
      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: withCacheControl([
          { type: 'text', text: 'Call submit_answer with your final single SELECT statement.' },
        ]),
      });
      continue;
    }

    // Handle a submit_answer if present.
    const submit = toolUses.find((t) => t.name === 'submit_answer');
    if (submit) {
      const input = submit.input as { sql?: unknown; notes?: unknown };
      const sql = typeof input.sql === 'string' ? input.sql : '';
      const notes = typeof input.notes === 'string' ? input.notes : '';
      if (sql.trim() === '') {
        return {
          ok: false, sql: '', notes, usage, toolCalls, enumerateCalls, turns: turn,
          capHit, stopReason: response.stop_reason, error: 'submit_answer had empty sql',
        };
      }
      return {
        ok: true, sql, notes, usage, toolCalls, enumerateCalls, turns: turn, capHit,
        stopReason: response.stop_reason,
      };
    }

    // Execute exploration tools; assemble tool_result blocks.
    messages.push({ role: 'assistant', content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      toolCalls += 1;
      if (use.name.startsWith('list_')) enumerateCalls += 1;
      let text: string;
      let isError = false;
      try {
        text = await provider.execute(use.name, (use.input as Record<string, unknown>) ?? {});
      } catch (err) {
        text = err instanceof Error ? err.message : String(err);
        isError = true;
      }
      results.push({ type: 'tool_result', tool_use_id: use.id, content: text, is_error: isError });
    }
    if (toolCalls >= TOOL_CALL_CAP) capHit = true;
    messages.push({ role: 'user', content: withCacheControl(results as Block[]) });
  }

  return {
    ok: false, sql: '', notes: '', usage, toolCalls, enumerateCalls, turns: MAX_TURNS,
    capHit, stopReason: null, error: 'exceeded max turns without an answer',
  };
}
