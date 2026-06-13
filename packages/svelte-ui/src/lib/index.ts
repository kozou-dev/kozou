// @kozou/svelte-ui — Admin UI library exports.
//
// These re-exports are the package's public API on
// npm starting with v0.1.0.

// Sourced from package.json (single source of truth). Vite inlines the
// named JSON import at build time and tree-shakes it down to the version
// string, so a release bump in package.json cannot drift from this
// constant.
import { version } from '../../package.json';

export const PACKAGE_VERSION = version;

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
