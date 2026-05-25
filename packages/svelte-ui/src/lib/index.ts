// @kozou/svelte-ui — Admin UI library exports.
//
// See Kozou v0.1 design spec §8 for the SvelteKit Admin UI
// specification. The Step 7 release PR will flip the `private`
// flag on packages/svelte-ui/package.json and these re-exports
// will become the package's public API on npm.

export const PACKAGE_VERSION = '0.0.0';

export type {
  AdapterErrorCode,
  AdapterErrorInit,
  FetchLike,
  PostgrestAdapterOptions,
  PostgrestPrimaryKeyResolver,
} from './adapter/index.js';
export {
  AdapterError,
  PostgrestAdapterError,
  PostgrestDataAdapter,
} from './adapter/index.js';
