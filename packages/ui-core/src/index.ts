// @kozou/ui-core — framework-agnostic UI logic shared by reference UIs.
//
// This is the read-path slice extracted from @kozou/svelte-ui. None of
// the modules below import Svelte / SvelteKit / React or any other UI
// framework runtime; they turn a SchemaContext + DataAdapter into the
// data a list/detail view renders. The reference Svelte UI consumes
// them, and any additional UI (e.g. a React renderer) can consume the
// same logic instead of re-implementing it.
//
// DataAdapter / ResourceId / ListParams / ListResult / RelationOption
// and the SchemaContext shape itself live in @kozou/core; they are not
// re-exported here.

// DataAdapter implementations + their shared surface.
export type {
  FetchLike,
  AdapterErrorCode,
  AdapterErrorInit,
  PostgrestAdapterOptions,
  PostgrestPrimaryKeyResolver,
  KozouApiAdapterOptions,
} from './adapter/index.js';
export {
  AdapterError,
  PostgrestAdapterError,
  PostgrestDataAdapter,
  KozouApiAdapterError,
  KozouApiDataAdapter,
} from './adapter/index.js';

// Resource id: composite-key segment encode / decode / parse.
export {
  rowIdSegment,
  encodeResourceId,
  parseResourceId,
} from './resource-id.js';

// List params: URL <-> ListParams.
export {
  DEFAULT_PAGE_SIZE,
  parseListParamsFromUrl,
} from './query/list-params.js';
export type {
  ParseListParamsInput,
  ParsedListParams,
} from './query/list-params.js';

// List href helpers + list-cell formatting.
export { buildHref, buildSortHref, formatCell } from './list/list-href.js';
export type { ListViewParams } from './list/list-href.js';

// View column heuristics.
export {
  pickViewDisplayColumns,
  pickViewSearchFields,
} from './view/columns.js';

// Detail cell formatting + FK label resolution.
export { formatCellValue } from './detail/format-cell.js';
export type { FormatCellInput } from './detail/format-cell.js';
export { resolveFkLabels } from './detail/resolve-fk-labels.js';
export type {
  ResolvedFkLabel,
  ResolveFkLabelsArgs,
} from './detail/resolve-fk-labels.js';

// Server-side caches (clock/loader injected; no Node-only dependency).
export { SchemaCache } from './server/schema-cache.js';
export type {
  SchemaLoader,
  Clock,
  SchemaCacheOptions,
} from './server/schema-cache.js';
export { FkRowCache } from './server/fk-row-cache.js';
export type {
  FkRowCacheOptions,
  FkRowLoader,
} from './server/fk-row-cache.js';
