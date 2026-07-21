// Opt-in provenance stamp: when `server.mcp.provenance` is on, every
// read/describe tool result carries an additive `provenance` object
// ({ serverVersion, builtAt }) so an agent can explain which database version
// and schema build produced an answer. Default off keeps existing consumers'
// output byte-stable. The values come straight from the schema context
// (emit-only) — nothing new is introspected. Driven through a real Client over
// an in-memory transport with a stubbed cache (no database needed).

import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildSchemaContext, type RawIntrospection } from '@kozou/core';
import { createMcpServer, type SchemaCache } from '../src/index.js';

const RAW: RawIntrospection = {
  serverVersion: '16.2',
  introspectedAt: '2026-01-01T00:00:00.000Z',
  schemas: ['public'],
  enums: [],
  functions: [],
  tables: [
    {
      schema: 'public',
      name: 'widgets',
      comment: null,
      primaryKey: ['id'],
      foreignKeys: [],
      checks: [],
      indexes: [],
      rowCountEstimate: null,
      columns: [
        {
          name: 'id',
          dataType: 'uuid',
          udtName: 'uuid',
          nullable: false,
          defaultExpr: null,
          comment: null,
          position: 1,
        },
      ],
    },
  ],
  views: [],
};

type ToolCallResult = Awaited<ReturnType<Client['callTool']>>;

/** Parse the JSON payload from the first text content block of a tool result. */
function payload(result: ToolCallResult): Record<string, unknown> {
  if (!('content' in result) || !Array.isArray(result.content)) {
    throw new Error('expected a content-bearing tool result');
  }
  const block = result.content[0];
  if (block?.type !== 'text') throw new Error('expected a text content block');
  return JSON.parse(block.text) as Record<string, unknown>;
}

describe('MCP provenance stamp (opt-in, additive)', () => {
  let client: Client | undefined;

  /** Connect a client to a server built with the given provenance flag. */
  async function connect(provenance: boolean): Promise<Client> {
    const ctx = await buildSchemaContext({ raw: RAW });
    const cache = { get: async () => ctx } as unknown as SchemaCache;
    const server = createMcpServer(cache, undefined, undefined, undefined, provenance);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'test', version: '0' }, { capabilities: {} });
    await Promise.all([c.connect(clientTransport), server.connect(serverTransport)]);
    client = c;
    return c;
  }

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it('omits provenance by default (existing output unchanged)', async () => {
    const c = await connect(false);
    const p = payload(await c.callTool({ name: 'list_tables', arguments: {} }));
    expect(p).not.toHaveProperty('provenance');
    expect(p).toHaveProperty('tables');
  });

  it('stamps read tools with { serverVersion, builtAt } when enabled', async () => {
    const c = await connect(true);
    const p = payload(await c.callTool({ name: 'list_tables', arguments: {} }));
    const provenance = p.provenance as { serverVersion?: unknown; builtAt?: unknown } | undefined;
    // serverVersion is deterministic (from the fixture); builtAt is a build-time
    // timestamp, so assert its shape (ISO 8601), not an exact value.
    expect(provenance?.serverVersion).toBe('16.2');
    expect(typeof provenance?.builtAt).toBe('string');
    expect(provenance?.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Additive: the existing payload keys are untouched.
    expect(p.sourceSchemas).toEqual(['public']);
  });

  it('applies at the shared emit point, so describe_table is stamped too', async () => {
    const c = await connect(true);
    const p = payload(
      await c.callTool({ name: 'describe_table', arguments: { qualifiedName: 'public.widgets' } }),
    );
    expect(p.qualifiedName).toBe('public.widgets');
    const provenance = p.provenance as { serverVersion?: unknown } | undefined;
    expect(provenance?.serverVersion).toBe('16.2');
  });
});
