// Arm A2 — "Kozou-compiled context": the product's real output.
//
// Drives a running `kozou mcp` HTTP endpoint with a real MCP client (the
// same Streamable HTTP transport Claude Desktop / Claude Code speak) and
// assembles the describe-family tool outputs into one context block. Nothing
// is mocked; whatever the shipped server returns is what the agent sees.

import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

interface ListTablesOutput {
  tables: Array<{ qualifiedName: string }>;
}

interface ListViewsOutput {
  views: Array<{ qualifiedName: string }>;
}

interface ListConceptsOutput {
  concepts: Array<{ name: string }>;
}

async function callToolJson(client: McpClient, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content as Array<{ type: string; text?: string }>)[0];
  if (!content || content.type !== 'text' || typeof content.text !== 'string') {
    throw new Error(`unexpected MCP content from tool ${name}`);
  }
  if (result.isError) {
    throw new Error(`MCP tool ${name} returned an error: ${content.text}`);
  }
  // Re-serialize for a stable, readable context block.
  return JSON.stringify(JSON.parse(content.text) as unknown, null, 2);
}

export async function generateKozouMcpContext(
  mcpUrl: string,
  schema: string,
): Promise<string> {
  const client = new McpClient({ name: 'kozou-benchmarks', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  await client.connect(transport);
  try {
    const sections: string[] = [
      '-- Kozou MCP describe-tool outputs (verbatim JSON from the running server).',
    ];
    const record = (label: string, json: string): void => {
      sections.push(`## ${label}\n${json}`);
    };

    const tablesJson = await callToolJson(client, 'list_tables', { schema });
    record(`list_tables {"schema":"${schema}"}`, tablesJson);
    const tables = JSON.parse(tablesJson) as ListTablesOutput;
    for (const table of tables.tables) {
      const json = await callToolJson(client, 'describe_table', {
        qualifiedName: table.qualifiedName,
      });
      record(`describe_table {"qualifiedName":"${table.qualifiedName}"}`, json);
    }

    const viewsJson = await callToolJson(client, 'list_views', { schema });
    record(`list_views {"schema":"${schema}"}`, viewsJson);
    const views = JSON.parse(viewsJson) as ListViewsOutput;
    for (const view of views.views) {
      const json = await callToolJson(client, 'describe_view', {
        qualifiedName: view.qualifiedName,
      });
      record(`describe_view {"qualifiedName":"${view.qualifiedName}"}`, json);
    }

    const conceptsJson = await callToolJson(client, 'list_concepts', {});
    record('list_concepts {}', conceptsJson);
    const concepts = JSON.parse(conceptsJson) as ListConceptsOutput;
    for (const concept of concepts.concepts) {
      const json = await callToolJson(client, 'get_concept_context', {
        name: concept.name,
      });
      record(`get_concept_context {"name":"${concept.name}"}`, json);
    }

    const functionsJson = await callToolJson(client, 'describe_functions', {});
    record('describe_functions {}', functionsJson);

    return sections.join('\n\n');
  } finally {
    await client.close();
  }
}
