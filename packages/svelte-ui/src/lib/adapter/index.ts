// DataAdapter implementations and their shared surface.
// See Kozou v0.1 design spec §4.4 (DataAdapter interface) and §8.5.
//
// Concrete adapter implementations land in sibling modules:
//   - ./postgrest.ts  -> PostgrestDataAdapter (Sub-step 6-D and 6-E)
//
// The PostgrestDataAdapter is the only adapter expected to mention
// PostgREST by name; the license-check workflow whitelists the two
// files that do so (postgrest.ts + this index re-export).

export type { FetchLike } from './types.js';
export type { AdapterErrorCode, AdapterErrorInit } from './errors.js';
export { AdapterError } from './errors.js';
export type {
  PostgrestAdapterOptions,
  PostgrestPrimaryKeyResolver,
} from './postgrest.js';
export { PostgrestAdapterError, PostgrestDataAdapter } from './postgrest.js';
