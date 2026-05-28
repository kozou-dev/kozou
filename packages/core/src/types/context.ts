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
  /** Full COMMENT body (plain, with @ai/@widget/@policy tags stripped) */
  description: string | null;
  /** Lines from the COMMENT that start with `@ai:` */
  aiDescription: string | null;
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
  /** Order: UI Hints > @widget: tag > heuristic (Kozou v0.1 spec §6.4) */
  widget: WidgetType;
  /** Values extracted from CHECK constraints, or PostgreSQL ENUM members */
  enumValues: string[] | null;
  /** Sourced from UI Hints */
  readonly: boolean;
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
  /** Column on this side of the relation (v0.1 limits this to 1) */
  field: string;
  references: {
    schema: string;
    table: string;
    column: string;
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
  /** @example: blocks from the COMMENT (Kozou v0.1 spec §7.3.6). Each
   *  entry is `{ description, sql }`: the text on the `@example:`
   *  line and the indented continuation block. */
  exampleQueries: { description: string; sql: string }[];
};
