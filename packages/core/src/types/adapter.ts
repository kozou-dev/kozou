// DataAdapter interface as defined in Kozou v0.1 spec §4.4.
//
// In v0.1 the first concrete adapter ships under @kozou/core. Defining a
// pluggable boundary up front lets v0.2's `@kozou/api` slot in as a
// non-breaking change (see end of Kozou v0.1 spec §4.4). For the concrete
// adapter implementation names, refer to Kozou v0.1 spec §4.4.

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
  id: string | number;
  label: string;
};
