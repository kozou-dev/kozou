import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// The claim this guards, stated in README.md and in the comment above the
// probe in src/tables.ts: introspection reads *whether* a row-security policy
// exists, never *what it says*. The authorization model stays in the database
// and out of an agent's context.
//
// A canary in the emitted surfaces cannot reach this half of the claim: a
// value that is fetched and then dropped leaves no trace in any output. So the
// assertion here is about the shape of the SQL itself — the two catalog
// columns that carry the expressions (`polqual`, `polwithcheck`) and the view
// whose target list renders both (`pg_policies`) must not appear in this
// package's source at all.
//
// `pg_policies` matters even though selecting one column from it looks
// harmless: whether the two `pg_get_expr` calls in its target list are
// evaluated depends on how the planner trims unreferenced view output columns,
// which would leave the claim resting on a planner detail rather than on the
// query we wrote. `pg_policy` — the catalog, which the existing EXISTS probe
// reads — is the unambiguous spelling and stays allowed.
//
// `pg_get_expr` is deliberately NOT on the list, and the reason is worth
// writing down so nobody "completes" it later: this package already calls it
// on `pg_attrdef.adbin` to render column defaults, which are part of what a
// schema surface is for. Banning the renderer would ban that feature. The
// columns are the precise thing — an expression cannot be rendered without
// naming the column that holds it.
//
// Scope, stated rather than implied: this is a source tripwire over the
// package that owns the queries. It does not constrain SQL assembled at run
// time out of fragments, and it is not an observation of what the database was
// actually asked. It is a cheap check that the one thing standing between the
// claim and its violation is not a comment.

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

/** Every source file in this package, recursively.
 *
 *  Deliberately not filtered by extension. A scan that only opens `.ts` is
 *  silently blind to a `.mts`, a `.js` or a `.sql` file added later — and
 *  "the forbidden token was in the one file we did not read" is exactly the
 *  way a tripwire fails without anyone noticing. Everything under src/ is
 *  text; reading a little more than necessary costs nothing here. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

const FORBIDDEN = ['polqual', 'polwithcheck', 'pg_policies'];

describe('introspection never reads a policy expression', () => {
  const files = sourceFiles(SRC_DIR).map((path) => ({
    path,
    text: readFileSync(path, 'utf8').toLowerCase(),
  }));

  it('names no policy-expression column and no rendering view', () => {
    const hits = files.flatMap(({ path, text }) =>
      FORBIDDEN.filter((token) => text.includes(token)).map((token) => `${path}: ${token}`),
    );
    expect(hits).toEqual([]);
  });

  // Without this, the assertion above would also pass for a scanner that read
  // nothing at all — an empty file list, a wrong directory. What it
  // establishes is exactly that: two strings the source really does contain
  // were found in the file that holds the probe, so the scan opened it. It
  // says nothing about a file the walk never reached, which is why the walk
  // above filters by nothing.
  //
  // `named('pg_policy')` would also match `pg_policies`, and both anchors
  // match comment text as well as code. That is fine for what this control
  // claims — the file was read — and it is not evidence that the probe itself
  // is still there.
  it('positive control: the scan reads the source that holds the line', () => {
    expect(files.length).toBeGreaterThan(0);
    const named = (token: string) =>
      files.filter(({ text }) => text.includes(token)).map(({ path }) => path.split('/').pop());
    expect(named('pg_policy')).toContain('tables.ts');
    expect(named('pg_get_expr')).toContain('tables.ts');
  });
});
