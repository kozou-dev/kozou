// @kozou/core (v0.0.0 skeleton + dev_spec §4 types 確定)
// dev_spec §0 の規約により本パッケージの型定義をコード側の正本とする。
// v0.1 の buildSchemaContext / parseCommentTags / loadUIHints は Step 3-5 で
// 追加実装する。
export const PACKAGE_VERSION = '0.0.0';

// Type re-exports — dev_spec §4 の型を公開 API として提供する。
export type {
  RawIntrospection,
  RawTable,
  RawColumn,
  RawForeignKey,
  RawCheck,
  RawIndex,
  RawView,
  RawEnum,
  RawFunction,
  FkAction,
} from './types/raw.js';

export type {
  SchemaContext,
  TableContext,
  ColumnContext,
  WidgetType,
  RelationContext,
  ViewContext,
  EnumContext,
  ConceptContext,
} from './types/context.js';

export {
  uiHintsSchema,
  type UIHints,
  type TableHints,
  type ColumnHints,
  type ViewHints,
  type RelationHints,
} from './types/ui-hints.js';

export type {
  DataAdapter,
  ListParams,
  ListResult,
  SortSpec,
  SearchRelationParams,
  RelationOption,
} from './types/adapter.js';
