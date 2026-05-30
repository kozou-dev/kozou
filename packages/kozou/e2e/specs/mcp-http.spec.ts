// The MCP Streamable HTTP server `kozou dev` runs in-process, exercised
// over real HTTP against the same stack the Admin UI talks to.
//
// Uses the standard MCP SDK client (the same transport Claude Desktop /
// Claude Code speak) to initialise a session, list tools, and call
// list_tables — proving the in-process MCP server introspects the live
// database and returns the fixture's tables. Also checks the
// `POST /admin/refresh` cache-invalidation route (spec §7.5). Tracks
// Kozou v0.1 design spec §7.1 / §7.5 and §16.1.1 B.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, test } from '@playwright/test';

const MCP_BASE = 'http://127.0.0.1:3434';
const MCP_URL = `${MCP_BASE}/mcp`;

test('MCP HTTP serves the tool list and a live list_tables call', async () => {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  const client = new Client({ name: 'kozou-dev-e2e', version: '0.0.0' });
  try {
    await client.connect(transport);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain('list_tables');
    expect(names).toContain('describe_table');

    const result = await client.callTool({
      name: 'list_tables',
      arguments: { schema: 'public' },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text) as {
      tables: Array<{ qualifiedName: string }>;
    };
    const qualified = payload.tables.map((t) => t.qualifiedName).sort();
    expect(qualified).toEqual([
      'public.authors',
      'public.books',
      'public.editions',
      'public.inventory_items',
    ]);
  } finally {
    await client.close();
  }
});

test('POST /admin/refresh invalidates the cache and returns ok', async ({
  request,
}) => {
  const res = await request.post(`${MCP_BASE}/admin/refresh`);
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
