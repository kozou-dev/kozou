// Executes agent-written SQL against the fixture and scores the result.
//
// Execution safety: the statement runs inside a READ ONLY transaction, as
// the fixture's read-only `analyst` role, with a statement timeout, and
// multi-statement strings are rejected outright (a second statement could
// otherwise COMMIT its way out of the read-only transaction). The database
// is a disposable fixture either way; these guards keep failure modes tidy.

import type { Client } from 'pg';

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

export async function executeTaskSql(
  client: Client,
  sql: string,
): Promise<SqlExecution> {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (trimmed.includes(';')) {
    return {
      ok: false,
      rows: [],
      error: 'multi-statement SQL is not allowed',
    };
  }
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query('SET LOCAL ROLE analyst');
    const result = await client.query({ text: trimmed, rowMode: 'array' });
    return { ok: true, rows: result.rows as unknown[][] };
  } catch (err) {
    return {
      ok: false,
      rows: [],
      error: err instanceof Error ? err.message : String(err),
    };
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
        return {
          correct: false,
          observed,
          detail: `expected 1 row x 1 column, got ${rows.length} row(s)`,
        };
      }
      const value = Number(rows[0][0]);
      if (!Number.isFinite(value)) {
        return {
          correct: false,
          observed,
          detail: `value is not numeric: ${String(rows[0][0])}`,
        };
      }
      const tolerance = scoring.tolerance ?? 0.005;
      const correct = Math.abs(value - scoring.expected) <= tolerance;
      const errorRatio =
        scoring.expected !== 0 ? value / scoring.expected : undefined;
      return {
        correct,
        observed,
        errorRatio,
        detail: correct
          ? `matched expected ${scoring.expected}`
          : `expected ${scoring.expected}, got ${value}`,
      };
    }
    case 'text': {
      if (rows.length !== 1 || rows[0].length !== 1) {
        return {
          correct: false,
          observed,
          detail: `expected 1 row x 1 column, got ${rows.length} row(s)`,
        };
      }
      const value = String(rows[0][0]).trim().toLowerCase();
      const accepted = [scoring.expected, ...(scoring.aliases ?? [])].map((s) =>
        s.trim().toLowerCase(),
      );
      const correct = accepted.includes(value);
      return {
        correct,
        observed,
        detail: correct
          ? `matched expected "${scoring.expected}"`
          : `expected "${scoring.expected}", got "${String(rows[0][0])}"`,
      };
    }
    case 'string_set': {
      if (rows.some((row) => row.length !== 1)) {
        return {
          correct: false,
          observed,
          detail: 'expected a single column per row',
        };
      }
      const got = new Set(rows.map((row) => String(row[0]).trim().toLowerCase()));
      const expected = new Set(
        scoring.expected.map((s) => s.trim().toLowerCase()),
      );
      const correct =
        got.size === expected.size && [...expected].every((s) => got.has(s));
      return {
        correct,
        observed,
        detail: correct
          ? `matched expected set {${scoring.expected.join(', ')}}`
          : `expected {${scoring.expected.join(', ')}}, got ${observed}`,
      };
    }
  }
}
