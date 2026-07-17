// Load a generated synthetic schema into a fresh Postgres schema and grant the
// read-only `analyst` role SELECT on it. Callers create/isolate the schema via
// @kozou/test-utils' setupDatabase (a random schema name), then load here.

import type { ClientBase } from 'pg';

import { generateSchema, type Scale } from './schema/generate.js';

/**
 * Create `schema`, load the generated fixture for `scale` into it, and grant
 * the `analyst` role read access. Assumes the caller opened `client` with
 * sufficient privileges to CREATE SCHEMA and GRANT.
 */
/** Fixed advisory-lock key that serializes cluster-global DDL (the analyst
 *  role) across concurrently-loading fixtures on a shared CI cluster. */
const ROLE_LOCK_KEY = 4210_2010;

export async function loadFixture(client: ClientBase, schema: string, scale: Scale): Promise<void> {
  const { sql } = generateSchema(scale);
  // Serialize the cluster-global role creation across concurrent loaders; the
  // fixture SQL's DO block is also idempotent (and now catches unique_violation).
  await client.query('SELECT pg_advisory_lock($1)', [ROLE_LOCK_KEY]);
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(sql);
    await client.query(`GRANT USAGE ON SCHEMA "${schema}" TO analyst`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO analyst`);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ROLE_LOCK_KEY]).catch(() => undefined);
  }
}
