// Kozou v0.1 spec §4.1 の RawIntrospection 型定義。@kozou/introspect の出力契約。
// Kozou v0.1 spec §0 の規約により本 file をコード側の正本とする (本書と乖離した場合
// は PR で Kozou v0.1 spec を同期更新する)。

/** introspect の output: PostgreSQL から取得した生の構造情報。 */
export type RawIntrospection = {
  /** PostgreSQL server version, e.g. "16.2" */
  serverVersion: string;
  /** introspect 実行時刻 (ISO 8601) */
  introspectedAt: string;
  /** 対象 schema 名 (default: ["public"]) */
  schemas: string[];

  tables: RawTable[];
  views: RawView[];
  enums: RawEnum[];
  /** v0.1 では取得のみ、UI/MCP での使用は最小 */
  functions: RawFunction[];
};

export type RawTable = {
  schema: string;
  name: string;
  comment: string | null;
  columns: RawColumn[];
  /** column 名の配列 */
  primaryKey: string[];
  foreignKeys: RawForeignKey[];
  checks: RawCheck[];
  indexes: RawIndex[];
};

export type RawColumn = {
  name: string;
  /** 例: "uuid", "text", "numeric(12,2)", "timestamptz" */
  dataType: string;
  /** information_schema.columns.udt_name */
  udtName: string;
  nullable: boolean;
  defaultExpr: string | null;
  comment: string | null;
  /** ordinal position (1-based、information_schema.columns 由来) */
  position: number;
};

export type RawForeignKey = {
  name: string;
  /** 自テーブル側の column 名 */
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
  onDelete: FkAction;
  onUpdate: FkAction;
  comment: string | null;
};

export type FkAction =
  | 'NO ACTION'
  | 'RESTRICT'
  | 'CASCADE'
  | 'SET NULL'
  | 'SET DEFAULT';

export type RawCheck = {
  name: string;
  /** raw CHECK expression, e.g. "status IN ('for_sale', 'reserved', 'sold')" */
  expression: string;
};

export type RawIndex = {
  name: string;
  columns: string[];
  unique: boolean;
};

export type RawView = {
  schema: string;
  name: string;
  comment: string | null;
  /** 推論された VIEW の列 (COMMENT 含む) */
  columns: RawColumn[];
  /** 構文解析でわかる場合の参照テーブル */
  underlyingTables: { schema: string; name: string }[];
  /** pg_views.definition */
  definition: string;
};

export type RawEnum = {
  schema: string;
  name: string;
  values: string[];
};

export type RawFunction = {
  schema: string;
  name: string;
  returnType: string;
  arguments: { name: string; type: string }[];
  comment: string | null;
};
