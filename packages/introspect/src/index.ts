import pkg from 'pg';
import type { Client, ClientConfig } from 'pg';
import type { RawIntrospection } from '@kozou/core';
import { fetchTables, mergeTableMetadata } from './tables.js';
import { fetchForeignKeys } from './fks.js';
import { fetchChecks } from './checks.js';
import { fetchViews } from './views.js';
import { fetchEnums } from './enums.js';
import { fetchAndAttachPrivileges } from './privileges.js';
import { KozouIntrospectError, runQuery } from './errors.js';
import { filterTables, filterViews, pruneDanglingForeignKeys } from './filter.js';

const PgClient = pkg.Client;

export type IntrospectOptions = {
  connection: string | ClientConfig;
  schemas?: string[];
  include?: string[];
  exclude?: string[];
  timeoutMs?: number;
  /** Privilege-aware introspection (issue #99): when set, evaluate this role's
   *  table/column privileges and attach them to the raw output (consumed by
   *  `buildSchemaContext` to hide unreadable tables and lock non-updatable
   *  columns). The serving role — e.g. the Admin UI's minted-token role. When
   *  omitted, privileges are not evaluated and surfaces stay schema-faithful
   *  (the default; the MCP server deliberately leaves this unset to stay
   *  schema-wide). */
  privilegeRole?: string;
};

export { KozouIntrospectError };
export type { KozouIntrospectErrorOptions } from './errors.js';

type PgErrorLike = { code?: string; message?: string };

function isPgErrorLike(value: unknown): value is PgErrorLike {
  return typeof value === 'object' && value !== null;
}

async function fetchExistingSchemas(client: Client, schemas: string[]): Promise<string[]> {
  const rows = await runQuery<{ schema_name: string }>(
    client,
    'SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1)',
    [schemas],
    'fetchExistingSchemas',
  );
  return rows.map((r) => r.schema_name);
}

export async function introspect(opts: IntrospectOptions): Promise<RawIntrospection> {
  const schemas = opts.schemas ?? ['public'];
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const baseConfig: ClientConfig =
    typeof opts.connection === 'string'
      ? { connectionString: opts.connection }
      : { ...opts.connection };
  const clientConfig: ClientConfig = { ...baseConfig, statement_timeout: timeoutMs };

  const client = new PgClient(clientConfig);

  try {
    await client.connect();
  } catch (err) {
    const pgErr = isPgErrorLike(err) ? err : {};
    throw new KozouIntrospectError(
      `Failed to connect to PostgreSQL: ${pgErr.message ?? String(err)}`,
      { pgErrorCode: pgErr.code, cause: err },
    );
  }

  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');

    const serverRows = await runQuery<{ server_version: string }>(
      client,
      'SHOW server_version',
      [],
      'showServerVersion',
    );
    const serverVersion = serverRows[0]?.server_version ?? 'unknown';

    const existing = await fetchExistingSchemas(client, schemas);
    for (const s of schemas) {
      if (!existing.includes(s)) {
        console.warn(`[@kozou/introspect] schema "${s}" does not exist (skip)`);
      }
    }
    const validSchemas = schemas.filter((s) => existing.includes(s));

    const allTables = await fetchTables(client, validSchemas);
    const fks = await fetchForeignKeys(client, validSchemas);
    const checks = await fetchChecks(client, validSchemas);
    mergeTableMetadata(allTables, fks, checks);

    const allViews = await fetchViews(client, validSchemas);
    const enums = await fetchEnums(client, validSchemas);

    if (opts.privilegeRole !== undefined) {
      await fetchAndAttachPrivileges(
        client,
        validSchemas,
        opts.privilegeRole,
        allTables,
        allViews,
      );
    }

    const filterOpts = { include: opts.include, exclude: opts.exclude };
    const tables = filterTables(allTables, filterOpts);
    pruneDanglingForeignKeys(tables);
    const views = filterViews(allViews, filterOpts);

    return {
      serverVersion,
      introspectedAt: new Date().toISOString(),
      schemas,
      tables,
      views,
      enums,
      functions: [],
    };
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch (err) {
      console.warn(`[@kozou/introspect] ROLLBACK failed (ignored): ${String(err)}`);
    }
    try {
      await client.end();
    } catch (err) {
      console.warn(`[@kozou/introspect] client.end failed (ignored): ${String(err)}`);
    }
  }
}
