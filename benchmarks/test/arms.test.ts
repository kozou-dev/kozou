// Verifies the arm separation invariants on the live fixture:
//   A0 must contain the catalog facts but NO comment text,
//   A1 must add the verbatim comment text,
//   A2 (driven through a real MCP HTTP server) must carry Kozou's compiled
//      structure (concepts, AI notes) that A1 does not have.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { setupDatabase, type DatabaseHandle } from '@kozou/test-utils';
import { SchemaCache, startHttpServer, type HttpServerHandle } from '@kozou/mcp';

import { generateRawDdlContext } from '../src/arms/a0RawDdl.js';
import { generateRawCommentContext } from '../src/arms/a1RawComment.js';
import { generateKozouMcpContext } from '../src/arms/a2KozouMcp.js';
import { loadFixtureSql } from '../src/fixture.js';

describe('arm context generation', () => {
  let db: DatabaseHandle;
  let client: pg.Client;
  let handle: HttpServerHandle | undefined;

  beforeAll(async () => {
    db = await setupDatabase();
    client = new pg.Client({ connectionString: db.connectionString });
    await client.connect();
    await client.query(`CREATE SCHEMA "${db.schema}"`);
    await client.query(`SET search_path TO "${db.schema}"`);
    await client.query(loadFixtureSql(db.schema));
  });

  afterAll(async () => {
    if (handle) await handle.close();
    await client?.end();
    await db?.cleanup();
  });

  it('A0 exposes catalog facts and nothing that lives in comments', async () => {
    const context = await generateRawDdlContext(client, db.schema);
    expect(context).toContain('TABLE orders');
    expect(context).toContain('VIEW vw_recognized_revenue');
    expect(context).toContain('amount_total');
    // CHECK constraints are catalog facts and must be visible (fair A0).
    expect(context).toContain("'chargeback'");
    // Comment-only knowledge must NOT leak into A0.
    expect(context).not.toContain('@ai');
    expect(context).not.toContain('DEPRECATED');
    expect(context).not.toContain('recognized revenue');
  });

  it('A1 adds the verbatim comment text without interpretation', async () => {
    const context = await generateRawCommentContext(client, db.schema);
    expect(context).toContain('TABLE orders');
    expect(context).toContain('@ai:');
    expect(context).toContain('DEPRECATED denormalized order total');
    // A1 is pass-through: no Kozou-compiled structure.
    expect(context).not.toContain('preferredQuerySource');
    expect(context).not.toContain('aiNotes');
  });

  it('A2 carries the Kozou-compiled context from a real MCP server', async () => {
    const cache = new SchemaCache({
      connection: db.connectionString,
      schemas: [db.schema],
      ttlMs: 60_000,
    });
    handle = await startHttpServer(cache, { port: 0, host: '127.0.0.1' });
    const context = await generateKozouMcpContext(
      `http://127.0.0.1:${handle.port}/mcp`,
      db.schema,
    );
    expect(context).toContain('list_tables');
    expect(context).toContain('describe_table');
    expect(context).toContain('get_concept_context');
    // Kozou's interpretation layer: structured AI notes and concepts.
    expect(context).toContain('vw_recognized_revenue');
    expect(context).toContain('amount_total');
    expect(context).toMatch(/aiNotes|aiDescription/);
  });
});
