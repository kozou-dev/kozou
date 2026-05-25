// @kozou/svelte-ui — Admin UI library exports.
//
// See Kozou v0.1 design spec §8 for the SvelteKit Admin UI
// specification. These re-exports are the package's public API on
// npm starting with v0.1.0.

export const PACKAGE_VERSION = '0.1.0';

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
