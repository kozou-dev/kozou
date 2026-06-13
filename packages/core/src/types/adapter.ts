// DataAdapter interface.
//
// In v0.1 the first concrete adapter ships under @kozou/core. Defining a
// pluggable boundary up front lets v0.2's `@kozou/api` slot in as a
// non-breaking change.

/**
 * Identifier of a single record. A scalar for a single-column primary key;
 * an array — in `SchemaContext.tables[].primaryKey` declaration order — for a
 * composite primary key. Widening the scalar form to also allow an array is
 * backward compatible: existing single-key callers pass a scalar unchanged.
 */
export type ResourceId = string | number | Array<string | number>;

export interface DataAdapter {
  /** List records (pagination, search, sort) */
  list(resource: string, params: ListParams): Promise<ListResult>;

  /** Fetch a single record */
  get(resource: string, id: ResourceId): Promise<Record<string, unknown>>;

  /** Create a record */
  create(
    resource: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /** Update a record */
  update(
    resource: string,
    id: ResourceId,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /** Delete a record */
  delete(resource: string, id: ResourceId): Promise<void>;

  /** Lightweight search used by relation-select (returns label / search fields only) */
  searchRelation(
    resource: string,
    params: SearchRelationParams,
  ): Promise<RelationOption[]>;

  /**
   * Invoke an exposed RPC function (issue #103). `qualifiedName` is the
   * schema-qualified identity (`schema.function`); `args` is the named-argument
   * object. Resolves to the function's result: a scalar, an object, an array,
   * or null for a void function. Optional — only the in-house @kozou/api
   * backend serves the `/rpc/` surface; an adapter without it has no RPC
   * actions and the Admin UI hides the "Actions" surface.
   */
  callFunction?(
    qualifiedName: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}

export type ListParams = {
  /** Free-text search query (v0.1 is `ilike`-based) */
  search?: string;
  /** Per-column filters; values are forwarded verbatim */
  filters?: Record<string, unknown>;
  sort?: SortSpec[];
  /** 1-based page index */
  page?: number;
  pageSize?: number;
};

export type SortSpec = {
  field: string;
  order: 'asc' | 'desc';
};

export type ListResult = {
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
};

export type SearchRelationParams = {
  query: string;
  labelField: string;
  searchFields: string[];
  limit?: number;
};

export type RelationOption = {
  /**
   * Identifier of the candidate target row. A scalar when the target has a
   * single-column primary key; an array — in the target's `primaryKey`
   * declaration order — when the target's primary key is composite, so an
   * option id is always a valid {@link ResourceId} for the target resource.
   * Widening the scalar form to also allow an array is runtime-compatible —
   * single-column targets keep producing scalars unchanged — though
   * TypeScript consumers that read `id` as a bare scalar must widen their
   * reads.
   */
  id: ResourceId;
  label: string;
};
