// SchemaContext type definitions.
//
// This is the output contract of @kozou/core.buildSchemaContext and the
// input contract for @kozou/mcp and @kozou/svelte-ui. The code is the
// source of truth.

import type { RawFunction, RawTable, RawView, RlsCommand } from './raw.js';

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
  /** Functions exposed as RPC actions (issue #103). Contains only
   *  the functions that pass the exposure decision; functions tagged for
   *  exposure that fail a guard are reported as build issues (loud skip),
   *  not listed here. Optional for back-compat: `buildSchemaContext` always
   *  populates it (possibly empty), but a context built before this field
   *  existed omits it, so readers normalize with `functions ?? []`. */
  functions?: FunctionContext[];
};

/** Effective privileges of the evaluated serving role on a table or view
 *  (privilege-aware introspection, issue #99). Present only when a privilege
 *  role was evaluated (`undefined` in the default, schema-wide mode). Surfaced
 *  read-only to AI agents (MCP `describe_table` / `describe_view`) and
 *  `kozou docs` so a caller knows what the role may *touch*, not just what the
 *  schema declares. Advisory only: enforcement stays in PostgreSQL (GRANTs and
 *  the schema author's row-level security). Column-level write privileges live
 *  on `ColumnContext.insertable` / `updatable`. */
export type RelationPrivileges = {
  /** The role these privileges were evaluated for. */
  role: string;
  /** May the role SELECT the relation (gated by schema USAGE). */
  select: boolean;
  /** May the role INSERT into the relation. */
  insert: boolean;
  /** May the role UPDATE the relation. */
  update: boolean;
  /** May the role DELETE from the relation. */
  delete: boolean;
};

/** Row-level security status of a table. A role-independent
 *  structural fact, surfaced unconditionally (unlike the opt-in per-role
 *  `privileges`): it tells an AI agent that the rows it sees may be filtered and
 *  its writes may be rejected by the connecting role's policies, so it should not
 *  assume a result is complete. The policy *expressions* are deliberately never
 *  read or surfaced (security-sensitive). Advisory only: PostgreSQL enforces RLS
 *  whether or not the agent knows about it. Surfaced on tables only — a view
 *  carries no `relrowsecurity`, and whether it masks its underlying tables' RLS
 *  depends on `security_invoker`, so claiming a view is unfiltered would mislead. */
export type RowSecurity = {
  /** RLS is enabled on the table (`pg_class.relrowsecurity`). */
  enabled: boolean;
  /** RLS also applies to the table owner (`pg_class.relforcerowsecurity`). */
  forced: boolean;
  /** At least one policy exists (existence only; expressions are never read).
   *  `enabled` true with `hasPolicies` false ⇒ default-deny for non-owners. */
  hasPolicies: boolean;
  /** Commands with no permissive policy that could apply, in a fixed order.
   *
   *  `hasPolicies` is per table; RLS is enforced per command. A table can be
   *  enabled, carry a policy and hold the GRANT and still refuse every INSERT,
   *  because the only policy written was `FOR SELECT`. This names that case
   *  without reading a policy expression: a command with no permissive policy is
   *  refused for every role RLS applies to.
   *
   *  `FOR ALL` counts for every command; restrictive policies grant nothing; the
   *  roles a policy names are deliberately not consulted, so the answer does not
   *  depend on who is asking. Empty when RLS is disabled.
   *
   *  One direction only, and it is the safe one: a listed command IS refused; an
   *  unlisted one may still be refused (a policy scoped to other roles, or a
   *  `USING` that matches nothing). It never promises a write will succeed. */
  deniedCommands: RlsCommand[];
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
  /** Effective privileges of the evaluated serving role (privilege-aware mode,
   *  issue #99). `undefined` when privileges were not evaluated (schema-wide).
   *  Surfaced read-only to AI agents / `kozou docs`; enforcement stays in
   *  PostgreSQL. */
  privileges?: RelationPrivileges;
  /** Row-level security status. Surfaced unconditionally
   *  (not gated by the privilege role). `undefined` only on a context built
   *  before this field existed. Tables only — never set on a view. */
  rowSecurity?: RowSecurity;
  primaryKey: string[];
  /** From UI Hints; otherwise a heuristic */
  displayField: string | null;
  columns: ColumnContext[];
  relations: RelationContext[];
  /** Raw record kept for downstream consumers */
  rawTable: RawTable;
};

export type ColumnContext = {
  name: string;
  dataType: string;
  /** `dataType` with one level of DOMAIN resolved to its base type + typmod
   *  (e.g. a domain over numeric(12,2) -> "numeric(12,2)"); equals `dataType`
   *  for non-domain columns. Used by `@kozou/api` value pre-flight so a
   *  domain-typed column is validated against its base type rather than the
   *  opaque domain name (issue #85). Optional for back-compat: normalize with
   *  `effectiveType ?? dataType`. */
  effectiveType?: string;
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
  /** Order: UI Hints > @widget: tag > heuristic */
  widget: WidgetType;
  /** Values extracted from CHECK constraints, or PostgreSQL ENUM members */
  enumValues: string[] | null;
  /** True when `enumValues` is the exhaustive label set of a native PostgreSQL
   *  ENUM type (resolved by udtName), not a non-exhaustive set extracted from a
   *  CHECK constraint. `@kozou/api` value pre-flight rejects an out-of-set value
   *  with a 400 only for a native ENUM (any other value is a 22P02 data error);
   *  a CHECK set is not exhaustive (a text/date predicate outside it is still a
   *  valid query), so it is left to PostgreSQL. Optional for back-compat. */
  nativeEnum?: boolean;
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

/** Widget domain. */
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
  /** Effective privileges of the evaluated serving role on the view
   *  (privilege-aware mode, issue #99). `undefined` when not evaluated.
   *  Surfaced read-only; enforcement stays in PostgreSQL. */
  privileges?: RelationPrivileges;
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

/** One input argument of an exposed RPC function, shaped for the surfaces.
 *  Only input args (`in` / `inout` / `variadic`)
 *  reach here; the builder excludes OUT / TABLE columns. */
export type FunctionArgContext = {
  name: string;
  /** `format_type` rendering of the argument's SQL type. */
  typeName: string;
  /** Whether the argument has a DEFAULT, so the RPC body may omit it. */
  hasDefault: boolean;
  /** ENUM members when the argument's type is a PostgreSQL ENUM (drives
   *  enum-select in the Admin UI action form). */
  enumValues?: string[];
  /** Relation target resolved from an `@arg: <name> relation(<ref>)` hint,
   *  for a relation-select argument widget. */
  relation?: { schema: string; table: string; column: string };
  /** Widget for the Admin UI action form: relation-select (relation hint),
   *  enum-select (enum type), else a type-based scalar widget. */
  widget: WidgetType;
};

/** Return shape of an exposed RPC function, mapped to the v1 wire. */
export type FunctionReturnContext = {
  kind: 'scalar' | 'composite' | 'setof' | 'void';
  typeName: string;
  /** Columns of a composite / SETOF return, when resolvable. */
  columns?: { name: string; typeName: string }[];
};

/** A function compiled into the RPC surface (issue #103). Only
 *  functions that pass the exposure decision become a FunctionContext;
 *  skipped-but-tagged functions are reported as build issues instead.
 *  The canonical external identity is the schema-qualified `qualifiedName`;
 *  REST path / OpenAPI operationId / MCP tool name all derive from it. */
export type FunctionContext = {
  schema: string;
  name: string;
  /** "schema.name" — the canonical external identity. */
  qualifiedName: string;
  /** Order: first line of COMMENT > name. */
  label: string;
  /** Full COMMENT body (plain text; `@ai:` / `@policy:` lines retained inline). */
  description: string | null;
  /** `@ai:` lines from the COMMENT. */
  aiDescription: string | null;
  /** `@policy:` advisory lines from the COMMENT (never enforced by kozou; see
   *  TableContext.policy). */
  policy?: string[];
  /** Input arguments, in declaration order. */
  args: FunctionArgContext[];
  returns: FunctionReturnContext;
  volatility: 'immutable' | 'stable' | 'volatile';
  security: 'invoker' | 'definer';
  /** Whether this function is intentionally public-callable: PUBLIC keeps
   *  EXECUTE by deliberate override (`@expose: rpc public` / `allowPublicExecute`).
   *  Default false: the function is callable only by roles with EXECUTE. */
  publicCallable: boolean;
  /** Raw record kept for downstream consumers. */
  rawFunction: RawFunction;
};

/** v0.1: ConceptContext is a thin wrapper around ViewContext. */
export type ConceptContext = {
  /** Matches ViewContext.name */
  name: string;
  label: string;
  description: string | null;
  /** Hard-coded "VIEW" in v0.1, with room to grow (e.g. "FUNCTION") */
  kind: 'VIEW';
  /** Suggested query path: real FK edges among the view's underlying tables.
   *  `on` is the actual join condition; `meaning` is the FK's COMMENT (the
   *  relationship's documented purpose), or null when the FK has no COMMENT. */
  joinSuggestions: { table: string; on: string; meaning: string | null }[];
  /** @ai: lines from the COMMENT */
  aiNotes: string[];
  /** `@policy:` lines from the COMMENT — advisory business rules surfaced to
   *  AI agents, never enforced by kozou (see TableContext.policy). */
  policies?: string[];
  /** @example: blocks from the COMMENT. Each
   *  entry is `{ description, sql }`: the text on the `@example:`
   *  line and the indented continuation block. */
  exampleQueries: { description: string; sql: string }[];
};
