// Kozou v0.1 spec §4.2 の SchemaContext 型定義。@kozou/core.buildSchemaContext の
// output 契約であり、@kozou/mcp と @kozou/svelte-ui の入力契約。
// Kozou v0.1 spec §0 の規約によりコード側を正本とする。

import type { RawTable, RawView } from './raw.js';

/** core.buildSchemaContext の output。MCP / UI の入力。 */
export type SchemaContext = {
  meta: {
    serverVersion: string;
    builtAt: string;
    sourceSchemas: string[];
  };
  tables: TableContext[];
  views: ViewContext[];
  enums: EnumContext[];
  /** VIEW から導出される業務概念 (v0.1 では VIEW = 業務概念とみなす) */
  concepts: ConceptContext[];
};

export type TableContext = {
  schema: string;
  name: string;
  /** "schema.name" */
  qualifiedName: string;
  /** UI Hints > COMMENT 1 行目 > name の順 */
  label: string;
  /** COMMENT 全文 (plain text、@ai/@widget/@policy tag を除いた本文) */
  description: string | null;
  /** COMMENT 内 @ai: 行を抽出したもの */
  aiDescription: string | null;
  primaryKey: string[];
  /** UI Hints 由来、なければ heuristic (Kozou v0.1 spec §6.5) */
  displayField: string | null;
  columns: ColumnContext[];
  relations: RelationContext[];
  /** 後段で必要な原情報 */
  rawTable: RawTable;
};

export type ColumnContext = {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultExpr: string | null;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  label: string;
  description: string | null;
  aiDescription: string | null;
  /** UI Hints > @widget: tag > heuristic (Kozou v0.1 spec §6.4) */
  widget: WidgetType;
  /** CHECK 制約から抽出された列挙値、または ENUM */
  enumValues: string[] | null;
  /** UI Hints 由来 */
  readonly: boolean;
};

/** Kozou v0.1 spec §6.4 widget 推論の domain。 */
export type WidgetType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'enum-select'
  | 'relation-select'
  | 'json'
  | 'image-url'
  | 'uuid'
  | 'currency';

export type RelationContext = {
  /** このテーブル側の column (v0.1 は 1 個に限定) */
  field: string;
  references: {
    schema: string;
    table: string;
    column: string;
  };
  /** v0.1 はこの 2 種のみ */
  cardinality: 'many-to-one' | 'one-to-one';
  /** FK の COMMENT 由来 */
  meaning: string | null;
};

export type ViewContext = {
  schema: string;
  name: string;
  qualifiedName: string;
  label: string;
  description: string | null;
  aiDescription: string | null;
  /** COMMENT の最初の段落 */
  purpose: string | null;
  columns: ColumnContext[];
  underlyingTables: { schema: string; name: string }[];
  /** 後段で必要な原情報 (MCP describe_view.definition 等) */
  rawView: RawView;
};

export type EnumContext = {
  schema: string;
  name: string;
  values: string[];
  description: string | null;
};

/** v0.1: ConceptContext は ViewContext の薄いラッパー。Kozou v0.1 spec §4.2 末尾。 */
export type ConceptContext = {
  /** ViewContext.name と一致 */
  name: string;
  label: string;
  description: string | null;
  /** "VIEW" 固定 (v0.1)。将来 "FUNCTION" 等を追加する余地を残す */
  kind: 'VIEW';
  /** 推奨 query path: VIEW を joinable する先 */
  joinSuggestions: { table: string; on: string }[];
  /** COMMENT の @ai: tag */
  aiNotes: string[];
};
