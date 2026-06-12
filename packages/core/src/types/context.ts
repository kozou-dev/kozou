// SchemaContext type definitions per Kozou v0.1 spec §4.2.
//
// This is the output contract of @kozou/core.buildSchemaContext and the
// input contract for @kozou/mcp and @kozou/svelte-ui. Per Kozou v0.1 spec
// §0, the code is the source of truth.

import type { RawTable, RawView } from './raw.js';

/** Output of core.buildSchemaContext; input to MCP / UI. */
export type SchemaContext = {
  meta: {
    serverVersion: string;
    builtAt: string;
    sourceSchemas: string[];
  };
  tables: TableContext[];
  views: ViewContext[];
  enums: EnumContext[];
  /** Domain concepts derived from views (in v0.1, every view is a concept) */
  concepts: ConceptContext[];
};

export type TableContext = {
  schema: string;
  name: string;
  /** "schema.name" */
  qualifiedName: string;
  /** Order: UI Hints > first line of COMMENT > name */
  label: string;
  /** Full COMMENT body (plain text; `@widget:`/`@example:` are lifted out,
   *  while `@ai:`/`@policy:` lines are retained here for readability). */
  description: string | null;
  /** Lines from the COMMENT that start with `@ai:` */
  aiDescription: string | null;
  /** `@policy:` lines from the COMMENT — advisory business rules surfaced to
   *  AI agents (e.g. "status may not change in production"). Kozou does not
   *  enforce these; hard access control is the schema author's Postgres
   *  row-level security. Also retained inline in `description`. */
  policy?: string[];
  primaryKey: string[];
  /** From UI Hints; otherwise a heuristic (Kozou v0.1 spec §6.5) */
  displayField: string | null;
  columns: ColumnContext[];
  relations: RelationContext[];
  /** Raw record kept for downstream consumers */
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
  /** `@policy:` lines from the column COMMENT — advisory business rules
   *  surfaced to AI agents, never enforced by kozou (see TableContext.policy). */
  policy?: string[];
  /** Order: UI Hints > @widget: tag > heuristic (Kozou v0.1 spec §6.4) */
  widget: WidgetType;
  /** Values extracted from CHECK constraints, or PostgreSQL ENUM members */
  enumValues: string[] | null;
  /** Read-only in the Admin UI, sourced from UI Hints. Drives form rendering
   *  and payload exclusion. Privilege-aware mode (issue #99) does NOT fold into
   *  this flag: read-only is mode-dependent there, so the Admin UI derives a
   *  per-mode read-only from `insertable` / `updatable` (see below). */
  readonly: boolean;
  /** Privilege-aware mode only (issue #99): whether the serving role may INSERT
   *  this column. `undefined` = privileges were not evaluated (default mode).
   *  `false` makes the Admin UI render the column read-only on **create**. */
  insertable?: boolean;
  /** Privilege-aware mode only (issue #99): whether the serving role may UPDATE
   *  this column. `undefined` = not evaluated. `false` makes the Admin UI
   *  render the column read-only on **edit**. */
  updatable?: boolean;
};

/** Widget domain for Kozou v0.1 spec §6.4. */
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
  /** First foreign-key column on this side. Retained for back-compat; for a
   *  composite (multi-column) foreign key it is `fields[0]`, so prefer `fields`
   *  for the full set. */
  field: string;
  /** All foreign-key columns on this side, in declaration order. A single-column
   *  FK has one entry (`[field]`); a composite FK has several. Added in v1.1,
   *  when composite foreign keys became embeddable. Optional for back-compat:
   *  `buildSchemaContext` always populates it, but a v1.0-shaped relation may
   *  omit it, so readers normalize with `fields ?? [field]`. */
  fields?: string[];
  references: {
    schema: string;
    table: string;
    /** First referenced column. Back-compat; for a composite key it is
     *  `columns[0]`, so prefer `columns`. */
    column: string;
    /** All referenced columns, positionally aligned with `fields`. Added in v1.1.
     *  Optional for back-compat; normalize with `columns ?? [column]`. */
    columns?: string[];
  };
  /** v0.1 supports only these two */
  cardinality: 'many-to-one' | 'one-to-one';
  /** From the FK's COMMENT */
  meaning: string | null;
};

export type ViewContext = {
  schema: string;
  name: string;
  qualifiedName: string;
  label: string;
  description: string | null;
  aiDescription: string | null;
  /** `@policy:` lines from the view COMMENT — advisory, surfaced to AI agents
   *  and never enforced by kozou (see TableContext.policy). */
  policy?: string[];
  /** First paragraph of the COMMENT */
  purpose: string | null;
  columns: ColumnContext[];
  underlyingTables: { schema: string; name: string }[];
  /** Raw record kept for downstream consumers (e.g. MCP describe_view.definition) */
  rawView: RawView;
};

export type EnumContext = {
  schema: string;
  name: string;
  values: string[];
  description: string | null;
};

/** v0.1: ConceptContext is a thin wrapper around ViewContext. See end of Kozou v0.1 spec §4.2. */
export type ConceptContext = {
  /** Matches ViewContext.name */
  name: string;
  label: string;
  description: string | null;
  /** Hard-coded "VIEW" in v0.1, with room to grow (e.g. "FUNCTION") */
  kind: 'VIEW';
  /** Suggested query path: targets the VIEW can be joined to */
  joinSuggestions: { table: string; on: string }[];
  /** @ai: lines from the COMMENT */
  aiNotes: string[];
  /** `@policy:` lines from the COMMENT — advisory business rules surfaced to
   *  AI agents, never enforced by kozou (see TableContext.policy). */
  policies?: string[];
  /** @example: blocks from the COMMENT (Kozou v0.1 spec §7.3.6). Each
   *  entry is `{ description, sql }`: the text on the `@example:`
   *  line and the indented continuation block. */
  exampleQueries: { description: string; sql: string }[];
};
