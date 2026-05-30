import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { listTables } from './tools/list_tables.js';
import { describeTable } from './tools/describe_table.js';
import { listViews } from './tools/list_views.js';
import { describeView } from './tools/describe_view.js';
import { listConcepts } from './tools/list_concepts.js';
import { getConceptContext } from './tools/get_concept_context.js';
import type { SchemaCache } from './schemaCache.js';

// Read the advertised server version from this package's package.json so
// it tracks a release bump automatically instead of being hardcoded.
// `../package.json` resolves to packages/mcp/package.json from the
// compiled dist/server.js; npm always ships package.json in the tarball.
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(require.resolve('../package.json'), 'utf8')) as {
  version: string;
};
const SERVER_VERSION = pkg.version;

const TOOL_DEFINITIONS = [
  {
    name: 'list_tables',
    description: 'List tables with their labels and descriptions',
    inputSchema: {
      type: 'object',
      properties: {
        schema: { type: 'string', description: 'Target schema (default: public)' },
        includeSystem: { type: 'boolean', description: 'Include system schemas (ignored in v0.1)' },
      },
    },
  },
  {
    name: 'describe_table',
    description: 'Return the full schema + COMMENT for the given table',
    inputSchema: {
      type: 'object',
      properties: { qualifiedName: { type: 'string', description: 'e.g. public.users' } },
      required: ['qualifiedName'],
    },
  },
  {
    name: 'list_views',
    description: 'List views with their labels and purposes',
    inputSchema: {
      type: 'object',
      properties: { schema: { type: 'string', description: 'Target schema (default: public)' } },
    },
  },
  {
    name: 'describe_view',
    description: 'Return columns + purpose + underlying tables + definition for the given view',
    inputSchema: {
      type: 'object',
      properties: { qualifiedName: { type: 'string', description: 'e.g. public.vw_active_users' } },
      required: ['qualifiedName'],
    },
  },
  {
    name: 'list_concepts',
    description: 'List domain concepts (each backed by a VIEW)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_concept_context',
    description: 'Return related tables + recommended query path for the given concept',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Matches the VIEW name' } },
      required: ['name'],
    },
  },
] as const;

type ToolName = (typeof TOOL_DEFINITIONS)[number]['name'];

function successResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

export function createMcpServer(cache: SchemaCache): Server {
  const server = new Server(
    { name: 'kozou', version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({ tools: TOOL_DEFINITIONS.map((t) => ({ ...t })) }),
  );

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name as ToolName;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const ctx = await cache.get();
      switch (name) {
        case 'list_tables':
          return successResult(listTables(args, ctx));
        case 'describe_table':
          return successResult(describeTable(args as { qualifiedName: string }, ctx));
        case 'list_views':
          return successResult(listViews(args, ctx));
        case 'describe_view':
          return successResult(describeView(args as { qualifiedName: string }, ctx));
        case 'list_concepts':
          return successResult(listConcepts(args, ctx));
        case 'get_concept_context':
          return successResult(getConceptContext(args as { name: string }, ctx));
        default:
          return errorResult(`Unknown tool: ${name as string}`);
      }
    } catch (err) {
      const dev = process.env.KOZOU_DEV === '1';
      const msg = err instanceof Error ? err.message : String(err);
      const detail = dev && err instanceof Error && err.stack ? `\n${err.stack}` : '';
      return errorResult(`${msg}${detail}`);
    }
  });

  return server;
}
