// kozou (CLI package): public API surface for adopters embedding the
// commands programmatically. The bin entry points live in cli.ts and
// create-kozou.ts; this module re-exports the underlying primitives so
// integrators can build their own glue if they need to.

export const PACKAGE_VERSION = '0.1.0';

export { loadConfig, KozouConfigError } from './config.js';
export type { KozouConfig, KozouConfigIssue, LoadConfigOptions } from './config.js';

export { inspectCommand } from './commands/inspect.js';
export type { InspectOptions } from './commands/inspect.js';

export { mcpCommand } from './commands/mcp.js';
export type { McpOptions } from './commands/mcp.js';

export { devCommand } from './commands/dev.js';
export type { DevOptions } from './commands/dev.js';

export { createKozouScaffold, KozouScaffoldError } from './scaffold.js';
export type { CreateScaffoldOptions } from './scaffold.js';
