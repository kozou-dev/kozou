import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The benchmark reuses the quickstart demo schema verbatim so the measured
 *  context is exactly what the shipped demo encodes. */
export const QUICKSTART_SCHEMA_PATH = path.resolve(
  here,
  '../../examples/quickstart/schema.sql',
);

const CREATE_ROLE_STMT = 'CREATE ROLE analyst NOLOGIN;';

/** Roles are cluster-global, so creating `analyst` must be idempotent when
 *  the fixture is loaded into a shared test server (CI reuses one Postgres
 *  via KOZOU_TEST_DATABASE_URL). Catching duplicate_object (rather than
 *  check-then-create) stays correct when two test files load the fixture
 *  concurrently. */
const IDEMPOTENT_ROLE_STMT = `DO $$
BEGIN
  CREATE ROLE analyst NOLOGIN;
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END
$$;`;

/** Read the quickstart fixture and prepare it for loading.
 *
 *  When `schema` is not `public`, the caller is loading the fixture into an
 *  isolated schema via `search_path` (the CI test pattern); the two
 *  `... SCHEMA public ...` GRANT statements are rewritten to that schema so
 *  the `analyst` role can read the isolated copy.
 */
export function loadFixtureSql(schema = 'public'): string {
  let sql = readFileSync(QUICKSTART_SCHEMA_PATH, 'utf8');
  if (!sql.includes(CREATE_ROLE_STMT)) {
    throw new Error(
      `expected "${CREATE_ROLE_STMT}" in ${QUICKSTART_SCHEMA_PATH} — ` +
        'the upstream fixture changed; update benchmarks/src/fixture.ts',
    );
  }
  // Function replacement: a plain string replacement would interpret the
  // `$$` dollar-quoting in the DO block as a replace-pattern escape.
  sql = sql.replace(CREATE_ROLE_STMT, () => IDEMPOTENT_ROLE_STMT);
  if (schema !== 'public') {
    sql = sql.replaceAll('SCHEMA public', `SCHEMA "${schema}"`);
  }
  return sql;
}
