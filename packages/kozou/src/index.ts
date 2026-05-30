// kozou (CLI package): public API surface for adopters embedding the
// commands programmatically. The bin entry points live in cli.ts and
// create-kozou.ts; this module re-exports the underlying primitives so
// integrators can build their own glue if they need to.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// `package.json` is the single source of truth for the version. Read it
// at module load (the same createRequire idiom commands/dev-runtime.ts
// uses to resolve a sibling package) instead of hardcoding a copy here,
// so a release bump in package.json can never drift from this constant.
// `../package.json` resolves to packages/kozou/package.json from the
// compiled dist/index.js, and npm always ships package.json in the
// published tarball.
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(require.resolve('../package.json'), 'utf8')) as {
  version: string;
};

export const PACKAGE_VERSION = pkg.version;

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
