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
import { describeFunctions } from './tools/describe_functions.js';
import { callTool } from './tools/call.js';
import type { SchemaCache } from './schemaCache.js';
import type { McpExecution } from './execution.js';
import { successResult, errorResult } from './result.js';
import { McpToolError } from './errors.js';
import type { SchemaContext } from '@kozou/core';

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
        includeSystem: { type: 'boolean', description: 'Include system schemas (currently ignored)' },
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
  {
    name: 'describe_functions',
    description:
      'List the functions exposed as RPC actions (issue #103): each with its ' +
      'arguments, return shape, volatility/security, and the schema author’s ' +
      '@ai / @policy advisory. Run one with the `call` tool (when enabled on ' +
      'this server) or POST /rpc/<schema>.<fn>.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const;

// The execution tool, listed only when the operator enabled execution (an
// McpExecution is supplied to createMcpServer). describe-only is the default.
const CALL_TOOL_DEFINITION = {
  name: 'call',
  description:
    'Execute an exposed RPC action (issue #103). First use describe_functions to ' +
    'learn the available functions, their arguments, return shape, and the ' +
    'schema author’s @ai / @policy advisory; then call one here. It runs as the ' +
    'operator-configured execution role — PostgreSQL’s EXECUTE privilege and the ' +
    'function’s row-level-security policies are enforced. The input/output shape ' +
    'is a stable contract as of Kozou v1.6.',
  inputSchema: {
    type: 'object',
    properties: {
      function: {
        type: 'string',
        description: 'Schema-qualified function name, e.g. public.approve_order',
      },
      args: {
        type: 'object',
        description: 'Named arguments for the function (omit for a no-argument call)',
      },
    },
    required: ['function'],
  },
} as const;

type ToolName = (typeof TOOL_DEFINITIONS)[number]['name'] | (typeof CALL_TOOL_DEFINITION)['name'];

/**
 * Build the MCP server bound to a read-only schema cache, and — when an
 * `execution` capability is supplied — the `call` tool that runs exposed
 * functions under the operator's single execution role. Without `execution`
 * the server is describe-only (the default): `call` is neither listed nor
 * runnable.
 */
export function createMcpServer(cache: SchemaCache, execution?: McpExecution): Server {
  const server = new Server(
    { name: 'kozou', version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  const tools = execution
    ? [...TOOL_DEFINITIONS, CALL_TOOL_DEFINITION]
    : [...TOOL_DEFINITIONS];

  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({ tools: tools.map((t) => ({ ...t })) }),
  );

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name as ToolName;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    // Schema introspection runs first and is shared by every tool. If it fails
    // (connection / auth / catalog error) the raw message can carry connection
    // detail, so it is logged server-side and reported generically — never
    // echoed. This keeps the `call` tool's no-leak contract intact end to end:
    // its own database errors are classified in callTool, and this covers the
    // one shared step that runs before it.
    let ctx: SchemaContext;
    try {
      ctx = await cache.get();
    } catch (err) {
      process.stderr.write(
        `[kozou mcp] schema unavailable: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return errorResult('Schema is currently unavailable.');
    }

    try {
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
        case 'describe_functions':
          return successResult(describeFunctions(args, ctx));
        case 'call':
          // Defense in depth: the tool is not listed without execution, but a
          // client could still send the name. callTool owns its own success /
          // error shaping (and never leaks raw database text).
          if (execution === undefined) {
            return errorResult('The "call" tool is not enabled on this server.');
          }
          return await callTool(args, ctx, execution);
        default:
          return errorResult(`Unknown tool: ${name as string}`);
      }
    } catch (err) {
      // A deliberate, client-safe tool error (e.g. "Table not found: <name>"
      // echoing the caller's own input) is surfaced as-is so an agent can
      // self-correct. Anything else — a zod parse failure, an unexpected
      // programming or database error — can carry internal/identifier detail,
      // so it is logged server-side and reported generically, mirroring the
      // schema-unavailable catch above and the HTTP entrypoint's no-leak
      // posture. The raw detail stays behind KOZOU_DEV.
      if (err instanceof McpToolError) {
        return errorResult(err.message);
      }
      const dev = process.env.KOZOU_DEV === '1';
      process.stderr.write(
        `[kozou mcp] tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      const detail = dev && err instanceof Error && err.stack ? `\n${err.stack}` : '';
      return errorResult(`The "${name}" tool failed.${detail}`);
    }
  });

  return server;
}
