// DataAdapter implementations and their shared surface.
//
// Concrete adapter implementations land in sibling modules:
//   - ./postgrest.ts  -> PostgrestDataAdapter (external REST adapter)
//   - ./kozou-api.ts  -> KozouApiDataAdapter (in-house @kozou/api)
//
// The PostgrestDataAdapter is the only adapter expected to mention the
// external REST server by name; the license-check workflow whitelists
// the files that carry that identifier (postgrest.ts, this index
// re-export, and the package barrel src/index.ts). The
// KozouApiDataAdapter speaks the in-house @kozou/api wire format.

export type { FetchLike } from './types.js';
export type { AdapterErrorCode, AdapterErrorInit } from './errors.js';
export { AdapterError } from './errors.js';
export type {
  PostgrestAdapterOptions,
  PostgrestPrimaryKeyResolver,
} from './postgrest.js';
export { PostgrestAdapterError, PostgrestDataAdapter } from './postgrest.js';
export type { KozouApiAdapterOptions } from './kozou-api.js';
export { KozouApiAdapterError, KozouApiDataAdapter } from './kozou-api.js';
