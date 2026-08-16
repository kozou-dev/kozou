// RawIntrospection type definitions. This is the
// output contract of @kozou/introspect.
//
// This file is the source of truth on the code side.

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

/** Privileges of one role on a table, evaluated by `has_table_privilege`.
 *  Only populated when introspection runs with `privilegeRole` set (the
 *  opt-in privilege-aware mode, Kozou issue #99); otherwise `undefined`,
 *  meaning "privileges were not evaluated" — distinct from "all denied". */
export type RawTablePrivileges = {
  /** Evaluated for this role name. */
  role: string;
  select: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
};

/** Privileges of one role on a single column, from `has_column_privilege`.
 *  Postgres reports a column privilege as held when it is granted either at
 *  the column level or table-wide, so these subsume the table grants. */
export type RawColumnPrivileges = {
  insert: boolean;
  update: boolean;
};

/** Whether a table is protected by row-level security (RLS), from `pg_class`
 *  and the existence of any `pg_policy` row. This is a role-independent
 *  structural fact (like a primary key), read unconditionally — not the opt-in,
 *  per-role privilege mode. It tells an AI agent that results may be filtered
 *  and writes may be rejected for the connecting role; the policy *expressions*
 *  (USING / WITH CHECK) are deliberately NOT read or surfaced (they encode the
 *  authorization model and are treated as security-sensitive). Advisory only:
 *  PostgreSQL enforces RLS regardless of whether the agent knows about it. */
export type RawRowSecurity = {
  /** `pg_class.relrowsecurity`: RLS is enabled on the table. */
  enabled: boolean;
  /** `pg_class.relforcerowsecurity`: RLS also applies to the table owner (and
   *  roles that would otherwise bypass it without BYPASSRLS). */
  forced: boolean;
  /** Whether at least one policy exists for the table (existence only — the
   *  policy expressions are never read). When `enabled` is true but this is
   *  false, the table is effectively default-deny for non-owner roles. */
  hasPolicies: boolean;
  /** Commands with no permissive policy that could apply, in a fixed order.
   *
   *  RLS is enforced per command, while `hasPolicies` is per table — so a table
   *  can be enabled, carry a policy, hold the GRANT and still refuse every
   *  INSERT, because the only policy written was `FOR SELECT`.
   *  This is the part of that gap which is soundly derivable without reading a
   *  policy expression: a command with no permissive policy is refused for every
   *  role RLS applies to, whatever the expressions say.
   *
   *  Derived from `polcmd` and `polpermissive` only. `FOR ALL` (`polcmd = '*'`)
   *  counts for every command, restrictive policies grant nothing, and
   *  `polroles` is deliberately not consulted so the answer stays the same for
   *  every role. Empty when RLS is disabled — RLS then refuses nothing.
   *
   *  Sound in one direction only, and it is the safe one: a command listed here
   *  IS refused. A command NOT listed may still be refused — by a policy scoped
   *  to other roles, or by a `USING` expression that matches nothing — so this
   *  never says a write will succeed. */
  deniedCommands: RlsCommand[];
};

/** The four commands PostgreSQL enforces row-level security for. */
export type RlsCommand = 'select' | 'insert' | 'update' | 'delete';

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
  /** Privileges of the serving role, present only in privilege-aware mode
   *  (issue #99). `undefined` = not evaluated. */
  privileges?: RawTablePrivileges;
  /** Row-level security status of the table (always read in any mode).
   *  `undefined` only on a raw record built before this field existed, so
   *  consumers treat absence as "unknown" rather than "no RLS". */
  rowSecurity?: RawRowSecurity;
  /** Planner-maintained row count estimate (`pg_class.reltuples`).
   *  PostgreSQL stores -1 for "never analyzed"; that case maps to
   *  null here so consumers always see "a non-negative count, or
   *  unknown" instead of mixing the sentinel into the numeric
   *  domain. Surfaced through `list_tables`. */
  rowCountEstimate: number | null;
};

export type RawColumn = {
  name: string;
  /** e.g. "uuid", "text", "numeric(12,2)", "timestamptz" */
  dataType: string;
  /** `dataType` with one level of DOMAIN resolved to its base type + typmod
   *  (e.g. a domain over numeric(12,2) yields "numeric(12,2)", not the domain
   *  name); equals `dataType` for non-domain columns. Introspection always
   *  populates it; absent only on a raw record built before this field existed,
   *  so consumers normalize with `effectiveType ?? dataType` (issue #85). */
  effectiveType?: string;
  /** information_schema.columns.udt_name */
  udtName: string;
  nullable: boolean;
  defaultExpr: string | null;
  comment: string | null;
  /** Ordinal position (1-based, from information_schema.columns) */
  position: number;
  /** Privileges of the serving role on this column, present only in
   *  privilege-aware mode (issue #99). `undefined` = not evaluated. */
  privileges?: RawColumnPrivileges;
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
  /** Privileges of the serving role, present only in privilege-aware mode
   *  (issue #99). A view the role cannot SELECT (or whose schema it cannot
   *  USAGE) is hidden, like a table. `undefined` = not evaluated. */
  privileges?: RawTablePrivileges;
};

export type RawEnum = {
  schema: string;
  name: string;
  values: string[];
};

/** One declared argument of a function, as introspected from pg_proc. Covers
 *  all modes; the function-context builder keeps only the input ones (`in` /
 *  `inout` / `variadic`) when shaping the RPC surface, and treats `variadic` /
 *  unnamed args as a loud skip. */
export type RawFunctionArg = {
  /** Argument name, or '' for an unnamed positional argument. */
  name: string;
  /** `format_type` rendering, e.g. "uuid", "integer", "public.order_status". */
  typeName: string;
  /** `pg_type.typname` of the argument's type, e.g. "uuid", "order_status".
   *  Used for widget inference (mirrors RawColumn.udtName). */
  udtName: string;
  /** `pg_type.oid` of the argument's type. */
  typeOid: number;
  /** Argument mode. `table` is an OUT column of a `RETURNS TABLE(...)` function. */
  mode: 'in' | 'out' | 'inout' | 'variadic' | 'table';
  /** Whether the argument has a DEFAULT (so the RPC body may omit it). */
  hasDefault: boolean;
};

/** Classification of a function's return type for the RPC wire shape.
 *  `unsupported` covers OUT/INOUT composite, record, polymorphic,
 *  and anything else v1 does not map — a loud skip when the function is tagged
 *  for exposure. */
export type RawFunctionReturn = {
  kind: 'scalar' | 'composite' | 'setof' | 'void' | 'unsupported';
  /** `format_type` rendering of the return type, e.g. "integer", "SETOF orders". */
  typeName: string;
  /** True for `SETOF` / `RETURNS TABLE(...)` (the array wire shape). */
  returnsSet: boolean;
  /** Columns of a composite / TABLE(...) return, when resolvable. */
  columns?: { name: string; typeName: string; typeOid: number }[];
};

/** One element of a `security definer` function's declared `SET search_path`,
 *  used by the owner-relative safe-search_path predicate. */
export type RawFunctionSearchPathElement = {
  /** Raw element text from proconfig, e.g. "public", "pg_catalog", "$user". */
  raw: string;
  /** Resolved schema name, or null for a dynamic / unresolvable element
   *  (`$user`, a non-existent schema) — treated as unsafe (fail-closed). */
  schema: string | null;
  /** Whether PUBLIC, or any role other than the function owner, may CREATE in
   *  this schema (the hijack surface). `null` = could not be determined, which
   *  the predicate treats as unsafe (fail-closed). Not evaluated for the
   *  `pg_temp` element (`isTemp: true`), whose hazard is presence/position. */
  writableByOthers: boolean | null;
  /** True for the `pg_temp` element (the session temp schema). */
  isTemp: boolean;
};

/** A function pulled from pg_proc. Populated by @kozou/introspect for the RPC
 *  surface. All fields beyond schema/name/comment are used by
 *  the exposure decision and the wire mapping; see RawFunctionArg / return /
 *  search-path types above. */
export type RawFunction = {
  schema: string;
  name: string;
  /** Human-readable signature from `pg_get_function_arguments`, e.g.
   *  "order_id uuid, qty integer DEFAULT 1". Kept for diagnostics / docs. */
  argumentSignature: string;
  arguments: RawFunctionArg[];
  returns: RawFunctionReturn;
  volatility: 'immutable' | 'stable' | 'volatile';
  /** `prosecdef`: a `security definer` function runs as its owner and needs the
   *  double opt-in + safe search_path. */
  security: 'invoker' | 'definer';
  /** `proowner`: the role the function runs as under `security definer`, and
   *  the "only role allowed to CREATE" anchor of the safe-search_path
   *  predicate. */
  owner: { oid: number; name: string };
  /** Whether PUBLIC holds EXECUTE on this function — the default-grant footgun
   *  (`CREATE FUNCTION` grants EXECUTE to PUBLIC by default). A tagged
   *  function that still has this is hard-skipped unless overridden. */
  publicExecute: boolean;
  /** Parsed `proconfig` `search_path` elements; null = none declared. Drives the
   *  safe-search_path predicate for `security definer` functions. */
  searchPath: RawFunctionSearchPathElement[] | null;
  comment: string | null;
};
