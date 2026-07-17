// B-flat companion arm (NOT gated).
//
// Assembles the B-style describe (DDL + verbatim comments) of EVERY relation
// into one context block and answers single-shot. This is the old flat-dump
// shape; it exists only to show the arithmetic-trivial token reduction of a
// flat dump vs selective retrieval. Its cost is NEVER used for the C-B gate
// (that comparison is against the selective arm B). Recorded for context.

import Anthropic from '@anthropic-ai/sdk';
import type { ClientBase } from 'pg';

import { listRelations, describeRelation } from '../tools/catalog.js';
import type { BenchTask } from '../types.js';
import { EFFORT, type TurnUsage } from './loop.js';

const MAX_TOKENS = 4096;

/** Concatenate a B-style describe of every table and view in the schema. */
export async function generateBFlatContext(client: ClientBase, schema: string): Promise<string> {
  const tables = await listRelations(client, schema, 'r');
  const views = await listRelations(client, schema, 'v');
  const blocks: string[] = ['-- Full schema (all relations, with comments).'];
  for (const t of tables) {
    blocks.push(await describeRelation(client, schema, t.name, { includeComments: true, includeViewDef: false }));
  }
  for (const v of views) {
    blocks.push(await describeRelation(client, schema, v.name, { includeComments: true, includeViewDef: true }));
  }
  return blocks.join('\n\n');
}

const SUBMIT_TOOL = {
  name: 'submit_answer',
  description: 'Submit your final answer: a single PostgreSQL SELECT statement.',
  input_schema: {
    type: 'object',
    properties: {
      sql: { type: 'string' },
      notes: { type: 'string' },
    },
    required: ['sql', 'notes'],
    additionalProperties: false,
  },
} as const;

export interface FlatResult {
  ok: boolean;
  sql: string;
  notes: string;
  usage: TurnUsage[];
  error?: string;
}

export async function askBFlat(
  client: Anthropic,
  model: string,
  task: BenchTask,
  context: string,
): Promise<FlatResult> {
  const prompt = [
    'You are a data analyst answering a business question against a PostgreSQL database.',
    'Everything you know about the database is in the context block below.',
    'You cannot run exploratory queries; answer with one final SQL statement by calling submit_answer.',
    '',
    '<database_context>',
    context,
    '</database_context>',
    '',
    `Question: ${task.question}`,
    `Your SQL must return ${task.result_shape}. Do not modify any data.`,
  ].join('\n');

  const usage: TurnUsage[] = [];
  const readU = (u: Anthropic.Usage): TurnUsage => {
    const a = u as unknown as {
      input_tokens: number; output_tokens: number;
      cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null;
    };
    return {
      input: a.input_tokens ?? 0, output: a.output_tokens ?? 0,
      cacheCreation: a.cache_creation_input_tokens ?? 0, cacheRead: a.cache_read_input_tokens ?? 0,
    };
  };
  const findSubmit = (content: Anthropic.ContentBlock[]) =>
    content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'submit_answer');

  try {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt }];
    // Turn 1: tool_choice 'auto' so the model can REASON before answering (#5)
    // — a forced tool call would suppress reasoning and make this arm weaker
    // than the agentic arms it is compared against.
    const first = await client.messages.create({
      model, max_tokens: MAX_TOKENS,
      tools: [SUBMIT_TOOL] as unknown as Anthropic.ToolUnion[],
      tool_choice: { type: 'auto' },
      output_config: { effort: EFFORT },
      messages,
    } as Anthropic.MessageCreateParamsNonStreaming);
    usage.push(readU(first.usage));

    let submit = findSubmit(first.content);
    if (!submit) {
      // Model reasoned but did not call submit_answer; force it on a 2nd turn.
      messages.push({ role: 'assistant', content: first.content });
      messages.push({ role: 'user', content: 'Now call submit_answer with your final single SELECT statement.' });
      const second = await client.messages.create({
        model, max_tokens: MAX_TOKENS,
        tools: [SUBMIT_TOOL] as unknown as Anthropic.ToolUnion[],
        tool_choice: { type: 'tool', name: 'submit_answer' },
        output_config: { effort: EFFORT },
        messages,
      } as Anthropic.MessageCreateParamsNonStreaming);
      usage.push(readU(second.usage));
      submit = findSubmit(second.content);
    }

    const input = (submit?.input ?? {}) as { sql?: unknown; notes?: unknown };
    const sql = typeof input.sql === 'string' ? input.sql : '';
    const notes = typeof input.notes === 'string' ? input.notes : '';
    return { ok: sql.trim() !== '', sql, notes, usage, error: sql.trim() === '' ? 'no sql' : undefined };
  } catch (err) {
    return { ok: false, sql: '', notes: '', usage, error: err instanceof Error ? err.message : String(err) };
  }
}
