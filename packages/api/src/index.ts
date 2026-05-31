// @kozou/api: Kozou's own REST layer (experimental, Kozou v0.2).
// Serves the tables and views of a SchemaContext as a REST API. See the
// Kozou v0.2 design spec §2–§4.

export {
  startApiServer,
  createApiRequestListener,
  isLoopbackHost,
  type StartApiServerOptions,
  type ApiServerHandle,
} from './startApiServer.js';

export {
  handleApiRequest,
  parseListParams,
  type Queryable,
  type ApiHandlerDeps,
  type ApiHttpRequest,
  type ApiHttpResult,
} from './handler.js';

export {
  buildResourceLookup,
  type Resource,
  type ResourceKind,
  type ResourceLookup,
} from './schema-lookup.js';

export {
  buildListQuery,
  buildGetQuery,
  buildInsertQuery,
  buildUpdateQuery,
  buildDeleteQuery,
  buildRelationOptionsQuery,
  quoteIdent,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  DEFAULT_RELATION_LIMIT,
  MAX_RELATION_LIMIT,
  type ListQueryParams,
  type BuiltListQuery,
  type BuiltGetQuery,
  type BuiltMutation,
  type RelationOptionsParams,
  type BuiltRelationOptions,
  type SortDirection,
} from './query-builder.js';

export { buildOpenApiDocument, type OpenApiOptions } from './openapi.js';

export { KozouApiError, type ApiErrorBody } from './errors.js';
