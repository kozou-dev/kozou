// Execute agent-written SQL against the fixture and score the result.
//
// Execution safety: the statement runs inside a READ ONLY transaction, as the
// fixture's read-only `analyst` role, with a statement timeout, and
// multi-statement strings are rejected (a second statement could COMMIT its
// way out of the read-only transaction). The database is a disposable fixture
// either way; these guards keep failure modes tidy and mirror how a
// least-privilege reporting connection behaves.

import type { ClientBase } from 'pg';

import type { Scoring } from './types.js';

export interface SqlExecution {
  ok: boolean;
  rows: unknown[][];
  error?: string;
}

export interface Score {
  correct: boolean;
  /** Human-readable rendering of what the SQL returned. */
  observed: string;
  /** observed / expected, numeric tasks only (severity of the miss). */
  errorRatio?: number;
  detail: string;
}

/** Failure decomposition (C-13): navigation (couldn't reach the right objects
 *  -> SQL error) vs semantic (ran fine but wrong logic) vs no-answer. */
export type Outcome = 'correct' | 'no-answer' | 'navigation' | 'semantic';

export function classifyOutcome(agentOk: boolean, execOk: boolean, correct: boolean): Outcome {
  if (correct) return 'correct';
  if (!agentOk) return 'no-answer';
  if (!execOk) return 'navigation';
  return 'semantic';
}

export async function executeTaskSql(client: ClientBase, sql: string): Promise<SqlExecution> {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (trimmed.includes(';')) {
    return { ok: false, rows: [], error: 'multi-statement SQL is not allowed' };
  }
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query('SET LOCAL ROLE analyst');
    const result = await client.query({ text: trimmed, rowMode: 'array' });
    return { ok: true, rows: result.rows as unknown[][] };
  } catch (err) {
    return { ok: false, rows: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
  }
}

function renderRows(rows: unknown[][]): string {
  return JSON.stringify(rows.map((row) => row.map((cell) => String(cell))));
}

export function scoreRows(scoring: Scoring, rows: unknown[][]): Score {
  const observed = renderRows(rows);
  switch (scoring.kind) {
    case 'numeric': {
      if (rows.length !== 1 || rows[0].length !== 1) {
        return { correct: false, observed, detail: `expected 1 row x 1 column, got ${rows.length} row(s)` };
      }
      const value = Number(rows[0][0]);
      if (!Number.isFinite(value)) {
        return { correct: false, observed, detail: `value is not numeric: ${String(rows[0][0])}` };
      }
      const tolerance = scoring.tolerance ?? 0.005;
      const correct = Math.abs(value - scoring.expected) <= tolerance;
      const errorRatio = scoring.expected !== 0 ? value / scoring.expected : undefined;
      return {
        correct,
        observed,
        errorRatio,
        detail: correct ? `matched expected ${scoring.expected}` : `expected ${scoring.expected}, got ${value}`,
      };
    }
    case 'text': {
      if (rows.length !== 1 || rows[0].length !== 1) {
        return { correct: false, observed, detail: `expected 1 row x 1 column, got ${rows.length} row(s)` };
      }
      const value = String(rows[0][0]).trim().toLowerCase();
      const accepted = [scoring.expected, ...(scoring.aliases ?? [])].map((s) => s.trim().toLowerCase());
      const correct = accepted.includes(value);
      return {
        correct,
        observed,
        detail: correct ? `matched expected "${scoring.expected}"` : `expected "${scoring.expected}", got "${String(rows[0][0])}"`,
      };
    }
    case 'string_set': {
      if (rows.some((row) => row.length !== 1)) {
        return { correct: false, observed, detail: 'expected a single column per row' };
      }
      // Exact row count first: a Set comparison alone would credit SQL whose
      // join fan-out duplicates a value.
      if (rows.length !== scoring.expected.length) {
        return { correct: false, observed, detail: `expected ${scoring.expected.length} row(s), got ${rows.length}` };
      }
      const got = new Set(rows.map((row) => String(row[0]).trim().toLowerCase()));
      const expected = new Set(scoring.expected.map((s) => s.trim().toLowerCase()));
      const correct = got.size === expected.size && [...expected].every((s) => got.has(s));
      return {
        correct,
        observed,
        detail: correct ? `matched expected set {${scoring.expected.join(', ')}}` : `expected {${scoring.expected.join(', ')}}, got ${observed}`,
      };
    }
  }
}
