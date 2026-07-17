// Load a generated synthetic schema into a fresh Postgres schema and grant the
// read-only `analyst` role SELECT on it. Callers create/isolate the schema via
// @kozou/test-utils' setupDatabase (a random schema name), then load here.

import type { Client } from 'pg';

import { generateSchema, type Scale } from './schema/generate.js';

/**
 * Create `schema`, load the generated fixture for `scale` into it, and grant
 * the `analyst` role read access. Assumes the caller opened `client` with
 * sufficient privileges to CREATE SCHEMA and GRANT.
 */
export async function loadFixture(client: Client, schema: string, scale: Scale): Promise<void> {
  const { sql } = generateSchema(scale);
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  await client.query(sql);
  await client.query(`GRANT USAGE ON SCHEMA "${schema}" TO analyst`);
  await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO analyst`);
}
