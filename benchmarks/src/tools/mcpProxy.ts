// Arm C tool provider: a proxy to a real running `kozou mcp` server.
//
// Connects with a real MCP client (the same Streamable HTTP transport Claude
// Desktop / Claude Code speak), lists the server's tools, and exposes the
// UNDERSTANDING tools (list/describe/concept/etc.) to the agent verbatim —
// whatever the shipped server returns is what the agent sees. Tools that
// EXECUTE or mutate SQL are excluded: like A and B, arm C must produce a
// single SQL statement for the harness to run, never have Kozou run it. The
// offered/excluded split is recorded for transparency.

import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { ArmToolProvider, ToolDef } from './provider.js';

/** Exclude anything that executes/mutates: the agent explores, then writes SQL. */
const EXECUTION_DENYLIST = /(^|_)(call|exec|execute|run|query|rpc|write|insert|update|delete|mutate|create|drop|alter|apply)($|_)?/i;

function isUnderstandingTool(name: string): boolean {
  return !EXECUTION_DENYLIST.test(name);
}

export async function createKozouMcpProvider(mcpUrl: string): Promise<ArmToolProvider> {
  const client = new McpClient({ name: 'kozou-benchmarks', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  await client.connect(transport);

  const listed = await client.listTools();
  const offered: string[] = [];
  const excluded: string[] = [];
  const tools: ToolDef[] = [];

  for (const t of listed.tools) {
    if (isUnderstandingTool(t.name)) {
      offered.push(t.name);
      tools.push({
        name: t.name,
        description: t.description ?? '',
        input_schema: (t.inputSchema as Record<string, unknown>) ?? {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
      });
    } else {
      excluded.push(t.name);
    }
  }

  return {
    tools,
    meta: { arm: 'C', offeredTools: offered, excludedTools: excluded },
    async execute(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const content = (result.content as Array<{ type: string; text?: string }>)[0];
      if (!content || content.type !== 'text' || typeof content.text !== 'string') {
        throw new Error(`unexpected MCP content from tool ${name}`);
      }
      if (result.isError) throw new Error(`tool ${name} error: ${content.text}`);
      // Re-serialize JSON for a stable, readable block; pass through otherwise.
      try {
        return JSON.stringify(JSON.parse(content.text) as unknown, null, 2);
      } catch {
        return content.text;
      }
    },
    async close() {
      await client.close();
    },
  };
}
