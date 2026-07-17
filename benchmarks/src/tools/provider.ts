// Arm tool providers.
//
// Every gated arm runs the same agentic loop; a provider supplies that arm's
// exploration tools (the loop adds `submit_answer`) and an executor. A and B
// share a catalog-backed provider (B adds comments + search); C is an MCP
// proxy (see mcpProxy.ts).

import type { Client } from 'pg';

import { listRelations, describeRelation, searchComments } from './catalog.js';

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ArmToolProvider {
  /** Exploration tools (submit_answer is added by the loop). */
  tools: ToolDef[];
  /** Run an exploration tool; return the text the model sees. */
  execute(name: string, args: Record<string, unknown>): Promise<string>;
  /** Transparency metadata recorded per run (e.g. offered/excluded tools). */
  meta: Record<string, unknown>;
  close(): Promise<void>;
}

const NAME_ARG = {
  type: 'object',
  properties: { name: { type: 'string', description: 'The relation name.' } },
  required: ['name'],
  additionalProperties: false,
} as const;

const NO_ARG = { type: 'object', properties: {}, additionalProperties: false } as const;

const QUERY_ARG = {
  type: 'object',
  properties: { query: { type: 'string', description: 'Case-insensitive substring to search for.' } },
  required: ['query'],
  additionalProperties: false,
} as const;

/**
 * Catalog-backed provider for arms A and B.
 * - A (withComments=false): raw DDL only; no search tool.
 * - B (withComments=true): DDL + verbatim comments; adds search_comments.
 * Tool descriptions are deliberately neutral and competent (they are pinned
 * and recorded); the only cross-arm difference is comments/search.
 */
export function createCatalogProvider(
  client: Client,
  schema: string,
  withComments: boolean,
): ArmToolProvider {
  const tools: ToolDef[] = [
    {
      name: 'list_tables',
      description: 'List the names of all base tables in the database.',
      input_schema: NO_ARG,
    },
    {
      name: 'describe_table',
      description: withComments
        ? 'Show a table\'s columns, types, constraints, and any documentation comments.'
        : "Show a table's columns, types, and constraints.",
      input_schema: NAME_ARG,
    },
    {
      name: 'list_views',
      description: 'List the names of all views in the database.',
      input_schema: NO_ARG,
    },
    {
      name: 'describe_view',
      description: withComments
        ? "Show a view's columns, its SQL definition, and any documentation comments."
        : "Show a view's columns and its SQL definition.",
      input_schema: NAME_ARG,
    },
  ];
  if (withComments) {
    tools.push({
      name: 'search_comments',
      description:
        'Search all documentation comments (on tables, columns, views, and constraints) for a substring. Returns matching relations/columns and their comment text.',
      input_schema: QUERY_ARG,
    });
  }

  return {
    tools,
    meta: { arm: withComments ? 'B' : 'A', tools: tools.map((t) => t.name) },
    async execute(name, args) {
      switch (name) {
        case 'list_tables': {
          const rels = await listRelations(client, schema, 'r');
          return rels.length ? rels.map((r) => r.name).join('\n') : '(no tables)';
        }
        case 'list_views': {
          const rels = await listRelations(client, schema, 'v');
          return rels.length ? rels.map((r) => r.name).join('\n') : '(no views)';
        }
        case 'describe_table':
          return describeRelation(client, schema, String(args.name), {
            includeComments: withComments,
            includeViewDef: false,
          });
        case 'describe_view':
          return describeRelation(client, schema, String(args.name), {
            includeComments: withComments,
            includeViewDef: true,
          });
        case 'search_comments':
          if (!withComments) throw new Error('search_comments is not available');
          return searchComments(client, schema, String(args.query));
        default:
          throw new Error(`unknown tool ${name}`);
      }
    },
    async close() {
      /* client lifecycle owned by the caller */
    },
  };
}
