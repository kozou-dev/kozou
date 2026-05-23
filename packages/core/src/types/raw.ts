// RawIntrospection type definitions per Kozou v0.1 spec §4.1. This is the
// output contract of @kozou/introspect.
//
// Per Kozou v0.1 spec §0, this file is the source of truth on the code
// side; when type changes diverge from the spec, the same PR must update
// Kozou v0.1 spec.

/** introspect output: the raw structural information pulled from PostgreSQL. */
export type RawIntrospection = {
  /** PostgreSQL server version, e.g. "16.2" */
  serverVersion: string;
  /** When introspect ran (ISO 8601) */
  introspectedAt: string;
  /** Target schemas (default: ["public"]) */
  schemas: string[];

  tables: RawTable[];
  views: RawView[];
  enums: RawEnum[];
  /** v0.1 collects these but uses them sparingly in UI/MCP */
  functions: RawFunction[];
};

export type RawTable = {
  schema: string;
  name: string;
  comment: string | null;
  columns: RawColumn[];
  /** Array of column names */
  primaryKey: string[];
  foreignKeys: RawForeignKey[];
  checks: RawCheck[];
  indexes: RawIndex[];
};

export type RawColumn = {
  name: string;
  /** e.g. "uuid", "text", "numeric(12,2)", "timestamptz" */
  dataType: string;
  /** information_schema.columns.udt_name */
  udtName: string;
  nullable: boolean;
  defaultExpr: string | null;
  comment: string | null;
  /** Ordinal position (1-based, from information_schema.columns) */
  position: number;
};

export type RawForeignKey = {
  name: string;
  /** Column name(s) on the referencing (this) side */
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
  /** Raw CHECK expression, e.g. "status IN ('for_sale', 'reserved', 'sold')" */
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
  /** Inferred columns of the VIEW (with their own COMMENTs) */
  columns: RawColumn[];
  /** Underlying tables resolved by parsing the view definition where possible */
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
