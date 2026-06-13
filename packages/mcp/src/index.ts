// @kozou/mcp public API.
// Provides the MCP server defined in Kozou v0.1 spec §7. Stdio mode
// (via the CLI) lives in src/cli.ts.

export { createMcpServer } from './server.js';
export { SchemaCache, type SchemaCacheOptions } from './schemaCache.js';
export { startStdioServer, type StartStdioServerOptions } from './startStdioServer.js';
export {
  startHttpServer,
  isLoopbackHost,
  type StartHttpServerOptions,
  type HttpServerHandle,
} from './startHttpServer.js';
export { listTables } from './tools/list_tables.js';
export { describeTable } from './tools/describe_table.js';
export { listViews } from './tools/list_views.js';
export { describeView } from './tools/describe_view.js';
export { listConcepts } from './tools/list_concepts.js';
export { getConceptContext } from './tools/get_concept_context.js';
export { describeFunctions } from './tools/describe_functions.js';
export * from './schemas/list_tables.js';
export * from './schemas/describe_table.js';
export * from './schemas/list_views.js';
export * from './schemas/describe_view.js';
export * from './schemas/list_concepts.js';
export * from './schemas/get_concept_context.js';
export * from './schemas/describe_functions.js';
