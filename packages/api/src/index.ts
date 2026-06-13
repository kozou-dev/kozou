// @kozou/api: Kozou's own REST layer — the default `kozou dev` data backend.
// Serves the tables and views of a SchemaContext as a REST API. Its wire
// format and OpenAPI are a stable contract as of Kozou v1.0; see the README
// for the supported surface and the scope table.

export {
  startApiServer,
  createApiRequestListener,
  isLoopbackHost,
  type StartApiServerOptions,
  type ApiServerHandle,
  type PoolClient,
  type ConnectionPool,
} from './startApiServer.js';

export {
  createAuthenticator,
  signServiceToken,
  type AuthConfig,
  type AuthContext,
  type Authenticator,
  type JwtAlgorithm,
  type ServiceTokenOptions,
} from './auth.js';

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
  type ReverseRelation,
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
  type Filter,
  type FilterOperator,
  type ScalarFilterOperator,
  type IsKeyword,
} from './query-builder.js';

export {
  buildFunctionLookup,
  buildRpcCall,
  shapeRpcResult,
  type FunctionLookup,
  type BuiltRpcCall,
  type RpcResult,
} from './rpc.js';

export { buildOpenApiDocument, type OpenApiOptions } from './openapi.js';

export {
  parseEmbedParam,
  resolveEmbedSpec,
  buildEmbedSelectFragment,
  MAX_EMBED_DEPTH,
  MAX_EMBED_RELATIONS,
  MAX_EMBED_CHILDREN,
  type EmbedKind,
  type EmbedNode,
  type EmbedSpec,
} from './embed.js';

export { KozouApiError, type ApiErrorBody } from './errors.js';
