// @kozou/core: Schema Context, type definitions, UI Hints zod schema, DataAdapter interface.
// Per Kozou v0.1 spec §0, the type definitions in this package are the
// source of truth on the code side.

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
  RawFunctionArg,
  RawFunctionReturn,
  RawFunctionSearchPathElement,
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
  FunctionContext,
  FunctionArgContext,
  FunctionReturnContext,
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
  ResourceId,
  ListParams,
  ListResult,
  SortSpec,
  SearchRelationParams,
  RelationOption,
} from './types/adapter.js';

export {
  parseCommentTags,
  type ParsedComment,
  type ExposeKind,
  type ArgHint,
} from './parseCommentTags.js';
export {
  buildFunctionContexts,
  type RpcBuildConfig,
} from './buildFunctionContext.js';
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
