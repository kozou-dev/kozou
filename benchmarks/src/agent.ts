// Drives the model under test through the Anthropic Messages API.
//
// The agent sees ONLY the arm's context block (never the data rows) and must
// answer with a single SQL statement; the harness executes that SQL against
// the fixture and scores the result. The prompt template is identical across
// arms — the context block is the only thing that varies.
//
// Determinism note: current Claude models reject sampling parameters
// (temperature and friends), so run-to-run variance is handled by executing
// multiple runs per (task, arm) and reporting per-arm distributions instead.

import Anthropic from '@anthropic-ai/sdk';

import type { BenchTask } from './types.js';

/** Phase 1 model (user-gated decision): the current Sonnet tier. */
export const DEFAULT_MODEL = 'claude-sonnet-5';

/** Explicit so the run metadata records it (this is the API default). */
export const EFFORT = 'high';

const MAX_TOKENS = 8000;

const ANSWER_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      sql: {
        type: 'string',
        description:
          'A single PostgreSQL SELECT statement answering the question.',
      },
      notes: {
        type: 'string',
        description:
          'Caveats, assumptions, or uncertainty about the answer. Empty string if none.',
      },
    },
    required: ['sql', 'notes'],
    additionalProperties: false,
  },
} as const;

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AgentAnswer {
  ok: boolean;
  sql: string;
  notes: string;
  stopReason: string | null;
  error?: string;
  usage: AgentUsage;
  requestId: string | null;
}

export function buildPrompt(task: BenchTask, contextText: string): string {
  return [
    'You are a data analyst answering a business question against a PostgreSQL database.',
    '',
    'Everything you know about the database is in the context block below.',
    'You cannot run exploratory queries; respond with one final SQL statement.',
    '',
    '<database_context>',
    contextText,
    '</database_context>',
    '',
    `Question: ${task.question}`,
    '',
    'Respond with a single PostgreSQL SELECT statement that answers the question.',
    `The statement must return ${task.result_shape}.`,
    'Do not modify any data. If you believe the available information is',
    'insufficient or the result may be incomplete, say so in "notes".',
  ].join('\n');
}

export function createAnthropicClient(): Anthropic {
  return new Anthropic();
}

export async function askAgent(
  client: Anthropic,
  model: string,
  prompt: string,
): Promise<AgentAnswer> {
  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      output_config: { effort: EFFORT, format: ANSWER_FORMAT },
      messages: [{ role: 'user', content: prompt }],
    } as Anthropic.MessageCreateParamsNonStreaming);
  } catch (err) {
    return {
      ok: false,
      sql: '',
      notes: '',
      stopReason: null,
      error: err instanceof Error ? err.message : String(err),
      usage: { inputTokens: 0, outputTokens: 0 },
      requestId: null,
    };
  }

  const usage: AgentUsage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
  const requestId =
    (response as Anthropic.Message & { _request_id?: string | null })
      ._request_id ?? null;

  if (response.stop_reason === 'refusal') {
    return {
      ok: false,
      sql: '',
      notes: '',
      stopReason: response.stop_reason,
      error: 'model refused the request',
      usage,
      requestId,
    };
  }
  if (response.stop_reason === 'max_tokens') {
    return {
      ok: false,
      sql: '',
      notes: '',
      stopReason: response.stop_reason,
      error: 'response truncated at max_tokens',
      usage,
      requestId,
    };
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      sql: '',
      notes: '',
      stopReason: response.stop_reason,
      error: `structured output was not valid JSON: ${text.slice(0, 200)}`,
      usage,
      requestId,
    };
  }
  const answer = parsed as { sql?: unknown; notes?: unknown };
  if (typeof answer.sql !== 'string' || answer.sql.trim() === '') {
    return {
      ok: false,
      sql: '',
      notes: typeof answer.notes === 'string' ? answer.notes : '',
      stopReason: response.stop_reason,
      error: 'structured output did not contain a non-empty "sql" string',
      usage,
      requestId,
    };
  }
  return {
    ok: true,
    sql: answer.sql,
    notes: typeof answer.notes === 'string' ? answer.notes : '',
    stopReason: response.stop_reason,
    usage,
    requestId,
  };
}
