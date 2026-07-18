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
import { searchSchema } from './tools/search_schema.js';
import { callToolAs } from './tools/call.js';
import type { SchemaCache } from './schemaCache.js';
import { fixedIdentity, type CallIdentity, type McpExecution } from './execution.js';
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
    description:
      'List tables with their labels and descriptions. Also returns ' +
      '`sourceSchemas` (the introspected schemas) and `outOfScope` (true when ' +
      'the requested schema was not introspected), so an empty `tables` for an ' +
      'out-of-scope schema is distinguishable from an in-scope empty one. The ' +
      'introspected set is configured when the schema is built, not per call.',
    inputSchema: {
      type: 'object',
      properties: {
        schema: { type: 'string', description: 'Target schema (default: public)' },
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
    description:
      'List views with their labels and purposes. Also returns `sourceSchemas` ' +
      '(the introspected schemas) and `outOfScope` (true when the requested ' +
      'schema was not introspected), so an empty `views` for an out-of-scope ' +
      'schema is distinguishable from an in-scope empty one.',
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
  {
    name: 'search_schema',
    description:
      'Search the schema documentation for a substring and return ranked hits ' +
      '— the way to find "which tables, columns, views, functions, or enums ' +
      'relate to X?" without enumerating the whole catalog. Matches object ' +
      'names, labels, COMMENT bodies, @ai notes, @policy notes, and enum ' +
      'members. Each hit names what matched, which field it matched on, and a ' +
      'snippet, so you know which describe_table / describe_view / ' +
      'describe_functions call to make next. Reads only already-introspected ' +
      'metadata — no row data.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          description: 'Case-insensitive substring to search for',
        },
        schema: { type: 'string', description: 'Restrict to a single schema (default: all)' },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: ['table', 'column', 'view', 'function', 'enum'] },
          minItems: 1,
          description: 'Restrict to these object kinds (default: all)',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          description: 'Max hits to return, ranked (default 20, capped at 100)',
        },
      },
      required: ['query'],
    },
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

/** Scope names gating the two tool facets when the server sits behind the
 *  OAuth resource-server layer: describe tools require `describe`, the `call`
 *  tool requires `execute`. Tools whose scope the token does not carry are
 *  not advertised (and a direct call is refused). Absent = no scope gate
 *  (the no-auth loopback mode). */
export type McpToolScopes = { describe: string; execute: string };

/**
 * Build the MCP server bound to a read-only schema cache, and — when an
 * `execution` capability is supplied — the `call` tool that runs exposed
 * functions. Without `execution` the server is describe-only (the default):
 * `call` is neither listed nor runnable.
 *
 * With `scopes` set (the OAuth resource-server mode), tool advertising and
 * dispatch are gated on the verified token's scopes, and `call` runs as the
 * token's role/claims instead of the fixed execution role. A request that
 * reaches the handlers without auth info is treated as having no scopes
 * (fail closed). That mode with `execution` requires a non-empty
 * `allowedRoles`: the token's role claim selects the execution role, and
 * this layer cannot see how the embedder's transport verified it, so the
 * assumable roles must be an explicit allowlist — enforced again at
 * dispatch for each call.
 */
export function createMcpServer(
  cache: SchemaCache,
  execution?: McpExecution,
  scopes?: McpToolScopes,
  allowedRoles?: string[],
): Server {
  if (scopes !== undefined && execution !== undefined && (allowedRoles?.length ?? 0) === 0) {
    throw new Error(
      '@kozou/mcp: execution with a scope gate (OAuth resource-server mode) requires a ' +
        "non-empty allowedRoles — the token's role claim selects the execution role, so " +
        'the assumable roles must be an explicit allowlist.',
    );
  }
  const allowedRoleSet = allowedRoles === undefined ? undefined : new Set(allowedRoles);

  const server = new Server(
    { name: 'kozou', version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, (_request, extra) => {
    const tools = [];
    if (scopes === undefined) {
      tools.push(...TOOL_DEFINITIONS);
      if (execution !== undefined) tools.push(CALL_TOOL_DEFINITION);
    } else {
      const granted = new Set(extra.authInfo?.scopes ?? []);
      if (granted.has(scopes.describe)) tools.push(...TOOL_DEFINITIONS);
      if (execution !== undefined && granted.has(scopes.execute)) tools.push(CALL_TOOL_DEFINITION);
    }
    return Promise.resolve({ tools: tools.map((t) => ({ ...t })) });
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name as ToolName;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    // Scope gate (OAuth mode): the transport layer already refuses
    // out-of-scope calls with a proper HTTP 403 challenge; this dispatch-level
    // check is defense in depth for any other transport wiring. The message
    // names only the required scope (part of the advertised surface).
    if (scopes !== undefined) {
      const granted = new Set(extra.authInfo?.scopes ?? []);
      const required = name === 'call' ? scopes.execute : scopes.describe;
      if (!granted.has(required)) {
        return errorResult(`This operation requires the "${required}" scope.`);
      }
    }

    // Schema introspection runs first and is shared by every tool. If it fails
    // (connection / auth / catalog error) the raw message can carry connection
    // detail, so it is logged server-side and reported generically — never
    // echoed. This keeps the `call` tool's no-leak contract intact end to end:
    // its own database errors are classified in callToolAs, and this covers
    // the one shared step that runs before it.
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
          return successResult(describeTable(args, ctx));
        case 'list_views':
          return successResult(listViews(args, ctx));
        case 'describe_view':
          return successResult(describeView(args, ctx));
        case 'list_concepts':
          return successResult(listConcepts(args, ctx));
        case 'get_concept_context':
          return successResult(getConceptContext(args as { name: string }, ctx));
        case 'describe_functions':
          return successResult(describeFunctions(args, ctx));
        case 'search_schema':
          return successResult(searchSchema(args as { query: string }, ctx));
        case 'call': {
          // Defense in depth: the tool is not listed without execution, but a
          // client could still send the name. callToolAs owns its own success
          // / error shaping (and never leaks raw database text).
          if (execution === undefined) {
            return errorResult('The "call" tool is not enabled on this server.');
          }
          // OAuth mode: the call runs as the verified token's role with the
          // token's claims. A gated server never falls back to the fixed
          // execution role — a missing verified role is a refusal.
          let identity: CallIdentity;
          if (scopes !== undefined) {
            const who = extra.authInfo?.extra as { role?: unknown; claims?: unknown } | undefined;
            if (typeof who?.role !== 'string' || who.role.length === 0) {
              return errorResult('No authenticated role is available for this call.');
            }
            // Dispatch-level allowlist check (defense in depth: the HTTP
            // authenticator already refused out-of-list roles; this covers
            // any other transport wiring that attaches auth info).
            if (allowedRoleSet !== undefined && !allowedRoleSet.has(who.role)) {
              return errorResult('The authenticated role is not allowed on this server.');
            }
            identity = { role: who.role, claims: who.claims ?? {} };
          } else {
            identity = fixedIdentity(execution, '[kozou mcp]');
          }
          return await callToolAs(args, ctx, execution, identity);
        }
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
