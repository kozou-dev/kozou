import type { RawForeignKey, RawTable, RawView } from '@kozou/core';

// Convert one user-facing glob into a RegExp that matches a fully
// qualified `schema.name` string.
//
// - Supported wildcards: `*` (zero or more chars except `.`) and `?`
//   (exactly one char except `.`). All other regex metacharacters are
//   escaped, so callers can safely use names containing `+`, `(`, etc.
// - A pattern without a `.` is treated as `*.<pattern>` so users can
//   write `users` to mean "the `users` table in any schema".
// - `*` does not cross schema boundaries: `*.users` matches
//   `public.users` but not `public.audit.users` (which is not a valid
//   PostgreSQL identifier anyway, but the constraint keeps the
//   semantics predictable).
function compilePattern(pattern: string): RegExp {
  const qualified = pattern.includes('.') ? pattern : `*.${pattern}`;
  let body = '';
  for (const ch of qualified) {
    if (ch === '*') {
      body += '[^.]*';
    } else if (ch === '?') {
      body += '[^.]';
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      body += `\\${ch}`;
    } else {
      body += ch;
    }
  }
  return new RegExp(`^${body}$`);
}

function compilePatterns(patterns: readonly string[] | undefined): RegExp[] {
  if (!patterns || patterns.length === 0) return [];
  return patterns.map(compilePattern);
}

function matchesAny(qualified: string, regexes: readonly RegExp[]): boolean {
  for (const re of regexes) {
    if (re.test(qualified)) return true;
  }
  return false;
}

export type FilterOptions = {
  include?: readonly string[];
  exclude?: readonly string[];
};

// Returns true if `qualified` should be retained given the filter.
// Semantics:
// - If `include` is non-empty, the name must match at least one include
//   pattern.
// - If `exclude` is non-empty, the name must not match any exclude
//   pattern.
// - Both lists can be combined; exclude wins over include on conflict.
export function shouldRetain(
  qualified: string,
  includeRes: readonly RegExp[],
  excludeRes: readonly RegExp[],
): boolean {
  if (includeRes.length > 0 && !matchesAny(qualified, includeRes)) {
    return false;
  }
  if (excludeRes.length > 0 && matchesAny(qualified, excludeRes)) {
    return false;
  }
  return true;
}

export function filterTables(
  tables: readonly RawTable[],
  opts: FilterOptions,
): RawTable[] {
  const includeRes = compilePatterns(opts.include);
  const excludeRes = compilePatterns(opts.exclude);
  if (includeRes.length === 0 && excludeRes.length === 0) {
    return [...tables];
  }
  return tables.filter((t) =>
    shouldRetain(`${t.schema}.${t.name}`, includeRes, excludeRes),
  );
}

export function filterViews(
  views: readonly RawView[],
  opts: FilterOptions,
): RawView[] {
  const includeRes = compilePatterns(opts.include);
  const excludeRes = compilePatterns(opts.exclude);
  if (includeRes.length === 0 && excludeRes.length === 0) {
    return [...views];
  }
  return views.filter((v) =>
    shouldRetain(`${v.schema}.${v.name}`, includeRes, excludeRes),
  );
}

// When a table is filtered out, any FK that points to it becomes a
// dangling reference. Drop those FKs so downstream consumers (graph
// builder in @kozou/core, MCP responses) never have to handle
// references to tables that aren't in `tables`.
export function pruneDanglingForeignKeys(tables: RawTable[]): void {
  const present = new Set<string>();
  for (const t of tables) present.add(`${t.schema}.${t.name}`);
  for (const t of tables) {
    const kept: RawForeignKey[] = [];
    for (const fk of t.foreignKeys) {
      const target = `${fk.referencedSchema}.${fk.referencedTable}`;
      if (present.has(target)) kept.push(fk);
    }
    t.foreignKeys = kept;
  }
}
