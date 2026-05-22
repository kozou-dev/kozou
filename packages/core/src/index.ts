// @kozou/core: Schema Context, type definitions, UI Hints zod schema, DataAdapter interface.
// dev_spec §0 規約により本パッケージの型定義をコード側の正本とする。

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

export { parseCommentTags, type ParsedComment } from './parseCommentTags.js';
export { inferWidget, type InferWidgetInput } from './widget.js';
export { inferDisplayField, type InferDisplayFieldInput } from './displayField.js';
export { extractCheckEnums } from './checkEnum.js';
export {
  buildSchemaContext,
  KozouBuildError,
  type BuildOptions,
  type BuildIssue,
} from './buildSchemaContext.js';
export { loadUIHints, KozouUIHintsError } from './loadUIHints.js';
