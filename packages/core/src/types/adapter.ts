// Kozou v0.1 spec §4.4 の DataAdapter interface。
//
// v0.1 では @kozou/core 配下に最初の concrete adapter を実装する想定。差し
// 替え可能な境界を作っておくことで v0.2 の `@kozou/api` 導入を non-breaking
// にする (Kozou v0.1 spec §4.4 末尾)。具体的な adapter 実装名は Kozou v0.1 spec §4.4 を参照。

export interface DataAdapter {
  /** 一覧取得 (ページネーション、検索、ソート) */
  list(resource: string, params: ListParams): Promise<ListResult>;

  /** 単一レコード取得 */
  get(resource: string, id: string | number): Promise<Record<string, unknown>>;

  /** 新規作成 */
  create(
    resource: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /** 更新 */
  update(
    resource: string,
    id: string | number,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /** 削除 */
  delete(resource: string, id: string | number): Promise<void>;

  /** relation-select 用の軽量検索 (label / search field のみ取得) */
  searchRelation(
    resource: string,
    params: SearchRelationParams,
  ): Promise<RelationOption[]>;
}

export type ListParams = {
  /** 全文検索クエリ (v0.1 では `ilike` ベース) */
  search?: string;
  /** カラム別フィルタ。値はそのまま渡す */
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
