// Error posture of the MCP request dispatcher (issue #180): a deliberate,
// client-safe tool error (a not-found message echoing the caller's own input)
// is surfaced to the agent, while any unexpected error (here a zod parse
// failure) is reported with a generic message so raw internal/identifier text
// never reaches the client. Driven through a real Client over an in-memory
// transport — no database needed (the cache is stubbed with a fixed context).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildSchemaContext, type RawIntrospection } from '@kozou/core';
import { createMcpServer, type SchemaCache } from '../src/index.js';

// `client.callTool` is typed as a union that includes a legacy
// `{ toolResult }` shape without `content`; the kozou server only ever
// produces the content-bearing shape, so narrow on `content` before reading.
type ToolCallResult = Awaited<ReturnType<Client['callTool']>>;

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

/** Text of the first content block of a tool result. */
function text(result: ToolCallResult): string {
  if (!('content' in result) || !Array.isArray(result.content)) {
    throw new Error('expected a content-bearing tool result');
  }
  const block = result.content[0];
  if (block?.type !== 'text') throw new Error('expected a text content block');
  return block.text;
}

describe('MCP request dispatch error posture (#180)', () => {
  let client: Client;

  beforeAll(async () => {
    const ctx = await buildSchemaContext({ raw: RAW });
    // The dispatcher only calls cache.get(); a stub avoids a live database.
    const cache = { get: async () => ctx } as unknown as SchemaCache;
    const server = createMcpServer(cache);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterAll(async () => {
    await client?.close();
  });

  it('surfaces a deliberate not-found message so an agent can self-correct', async () => {
    const res = await client.callTool({
      name: 'describe_table',
      arguments: { qualifiedName: 'public.nope' },
    });
    expect(res.isError).toBe(true);
    // The message echoes only the caller's own input — safe to return.
    expect(text(res)).toBe('Table not found: public.nope');
  });

  it('reports an unexpected (non-tool) error generically, not its raw text', async () => {
    // `schema` must be a string; a number makes the tool's zod parse throw — an
    // error that is not a deliberate McpToolError, so its raw text (which could
    // carry internal detail in other paths) must not reach the client.
    const res = await client.callTool({
      name: 'list_tables',
      arguments: { schema: 123 },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('The "list_tables" tool failed.');
  });

  it('describe_table: a missing required argument is actionable, not generic', async () => {
    const res = await client.callTool({ name: 'describe_table', arguments: {} });
    expect(res.isError).toBe(true);
    // Names the argument and gives an example so an agent can self-correct,
    // instead of the unhelpful "The describe_table tool failed."
    expect(text(res)).toBe(
      'describe_table: missing required argument "qualifiedName" (a non-empty string, e.g. "public.orders").',
    );
    expect(text(res)).not.toContain('tool failed');
  });

  it('describe_view: a missing required argument is actionable, not generic', async () => {
    const res = await client.callTool({ name: 'describe_view', arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe(
      'describe_view: missing required argument "qualifiedName" (a non-empty string, e.g. "public.vw_active_users").',
    );
  });

  it('describe_table: an empty-string argument is treated as missing', async () => {
    const res = await client.callTool({
      name: 'describe_table',
      arguments: { qualifiedName: '' },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe(
      'describe_table: missing required argument "qualifiedName" (a non-empty string, e.g. "public.orders").',
    );
  });

  it('describe_table: accepts `name` as an alias for `qualifiedName`', async () => {
    const res = await client.callTool({
      name: 'describe_table',
      arguments: { name: 'public.widgets' },
    });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain('public.widgets');
  });
});
