import type { RawColumn, RawEnum, RawIntrospection, RawTable, RawView } from './types/raw.js';
import type { ColumnHints, TableHints, UIHints, ViewHints } from './types/ui-hints.js';
import type {
  ColumnContext,
  ConceptContext,
  EnumContext,
  RelationContext,
  SchemaContext,
  TableContext,
  ViewContext,
  WidgetType,
} from './types/context.js';
import { parseCommentTags } from './parseCommentTags.js';
import { extractCheckEnums } from './checkEnum.js';
import { inferWidget } from './widget.js';
import { inferDisplayField } from './displayField.js';
import { buildFunctionContexts, findEnumValues, type RpcBuildConfig } from './buildFunctionContext.js';

export type BuildOptions = {
  raw: RawIntrospection;
  uiHints?: UIHints;
  /** Whether to warn-only on validation issues, or throw. Default: false (warn only). */
  strict?: boolean;
  /** RPC exposure config (issue #103). When omitted, no `security definer` or
   *  PUBLIC-EXECUTE function can be exposed; invoker functions tagged
   *  `@expose: rpc` (with PUBLIC EXECUTE revoked) still are. */
  rpc?: RpcBuildConfig;
  /** How to treat a relation the privilege role cannot SELECT, when privilege-
   *  aware introspection ran (issue #99):
   *  - `'filter'` (default): hide it from the generated surfaces. This is the
   *    Admin UI's behaviour — its forms/nav should be faithful to what the role
   *    may *do*, so an unreadable table is simply absent.
   *  - `'annotate'`: keep every relation and surface its privileges instead.
   *    This is the MCP / `kozou docs` behaviour — an AI agent should still see
   *    the table exists and be *told* it cannot read it ("knows what it may
   *    touch"), rather than have it vanish.
   *  Has no effect when privileges were not evaluated. */
  privilegeDisplay?: 'filter' | 'annotate';
};

export type BuildIssue = {
  path: string;
  message: string;
};

export class KozouBuildError extends Error {
  readonly issues: BuildIssue[];
  constructor(message: string, issues: BuildIssue[]) {
    super(message);
    this.name = 'KozouBuildError';
    this.issues = issues;
  }
}

function deriveLabel(name: string): string {
  return name
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function firstParagraph(text: string | null): string | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const [first] = trimmed.split(/\n\s*\n/);
  return first ?? null;
}

function joinAi(ai: string[]): string | null {
  return ai.length > 0 ? ai.join('\n') : null;
}

/** Look up UI Hints for a relation, preferring a schema-qualified key
 *  (`schema.name`) and falling back to the bare name. The fallback keeps
 *  single-schema hint files working as before; the qualified key lets two
 *  same-named relations in different schemas (e.g. `public.users` and
 *  `audit.users`) each carry their own hints instead of colliding on one. */
function lookupHints<T>(
  hints: Record<string, T> | undefined,
  schema: string,
  name: string,
): T | undefined {
  if (hints === undefined) return undefined;
  return hints[`${schema}.${name}`] ?? hints[name];
}

function buildColumn(input: {
  column: RawColumn;
  primaryKey: string[];
  foreignKeyColumns: Set<string>;
  /** Columns that are the sole column of a single-column FK — relation-select
   *  eligible. A composite-FK column is in `foreignKeyColumns` but not here. */
  singleColumnForeignKeyColumns: Set<string>;
  enumValues: string[] | null;
  nativeEnum: boolean;
  hints: ColumnHints | undefined;
}): ColumnContext {
  const {
    column,
    primaryKey,
    foreignKeyColumns,
    singleColumnForeignKeyColumns,
    enumValues,
    nativeEnum,
    hints,
  } = input;
  const parsed = parseCommentTags(column.comment);
  const isPrimaryKey = primaryKey.includes(column.name);
  const isForeignKey = foreignKeyColumns.has(column.name);

  const widget: WidgetType =
    hints?.widget ??
    parsed.widget ??
    inferWidget({
      column,
      isForeignKey,
      // Only a single-column FK backs a usable relation-select; composite-FK
      // columns keep isForeignKey but get a type-based widget instead.
      relationSelectable: singleColumnForeignKeyColumns.has(column.name),
      enumValues,
      commentBody: parsed.body,
    });

  const label = hints?.label ?? deriveLabel(column.name);

  // Privilege-aware mode (issue #99): when the serving role's privileges were
  // evaluated, surface them as `insertable` / `updatable` (the privilege
  // truth). `readonly` stays sourced from UI Hints only — applying the grant
  // to read-only is mode-dependent (a column may be insertable but not
  // updatable, or vice versa), so the Admin UI derives a per-mode read-only
  // from `insertable` (create) / `updatable` (edit). Keeping it out of the
  // shared `readonly` leaves `@kozou/api` / MCP schema-wide.
  const priv = column.privileges;
  const insertable = priv === undefined ? undefined : priv.insert;
  const updatable = priv === undefined ? undefined : priv.update;

  return {
    name: column.name,
    dataType: column.dataType,
    effectiveType: column.effectiveType ?? column.dataType,
    nullable: column.nullable,
    defaultExpr: column.defaultExpr,
    isPrimaryKey,
    isForeignKey,
    label,
    description: parsed.body !== '' ? parsed.body : null,
    aiDescription: joinAi(parsed.ai),
    policy: parsed.policy,
    widget,
    enumValues,
    nativeEnum,
    readonly: hints?.readonly ?? false,
    ...(insertable === undefined ? {} : { insertable }),
    ...(updatable === undefined ? {} : { updatable }),
  };
}

function buildRelations(table: RawTable, issues: BuildIssue[]): RelationContext[] {
  const uniqueColumnSets = new Set<string>();
  for (const idx of table.indexes) {
    if (idx.unique) {
      uniqueColumnSets.add(idx.columns.slice().sort().join(','));
    }
  }
  if (table.primaryKey.length > 0) {
    uniqueColumnSets.add(table.primaryKey.slice().sort().join(','));
  }

  const relations: RelationContext[] = [];
  for (const fk of table.foreignKeys) {
    // A zero-column foreign key cannot come from real PostgreSQL introspection;
    // skip the degenerate case silently, matching the prior behaviour.
    if (fk.columns.length === 0) continue;

    // Resolve the referenced columns, enforcing positional alignment with the
    // FK columns. A single-column FK with no referenced column keeps the legacy
    // `['id']` fallback; any other length mismatch is malformed input — record a
    // BuildIssue and skip, rather than emit a misaligned relation that would
    // break composite embed JOIN construction (which indexes columns[i]).
    let refColumns: string[];
    if (fk.referencedColumns.length === fk.columns.length) {
      refColumns = fk.referencedColumns.slice();
    } else if (fk.columns.length === 1 && fk.referencedColumns.length === 0) {
      refColumns = ['id'];
    } else {
      issues.push({
        path: `tables.${table.name}.relations.${fk.name}`,
        message:
          `Foreign key "${fk.name}" on "${table.schema}.${table.name}" has ${fk.columns.length} ` +
          `column(s) (${fk.columns.join(', ')}) but ${fk.referencedColumns.length} referenced ` +
          `column(s); the relation is skipped because the columns are not positionally aligned.`,
      });
      continue;
    }

    // Single- and composite-column foreign keys are both modelled, since v1.1:
    // `fields` / `references.columns` carry the full (possibly multi-column)
    // set, and the scalar `field` / `references.column` keep `[0]` for
    // back-compat. The cardinality check uses the whole column set.
    const fkKey = fk.columns.slice().sort().join(',');
    const cardinality: RelationContext['cardinality'] = uniqueColumnSets.has(fkKey)
      ? 'one-to-one'
      : 'many-to-one';
    relations.push({
      field: fk.columns[0]!,
      fields: fk.columns.slice(),
      references: {
        schema: fk.referencedSchema,
        table: fk.referencedTable,
        column: refColumns[0]!,
        columns: refColumns,
      },
      cardinality,
      meaning: fk.comment,
    });
  }
  return relations;
}

function buildTableContext(input: {
  table: RawTable;
  hints: TableHints | undefined;
  issues: BuildIssue[];
  knownTables: Set<string>;
  enums: RawEnum[];
}): TableContext {
  const { table, hints, issues, knownTables, enums } = input;
  const parsed = parseCommentTags(table.comment);
  const enumMap = extractCheckEnums(table.checks);
  const fkColumns = new Set<string>();
  const singleFkColumns = new Set<string>();
  for (const fk of table.foreignKeys) {
    for (const col of fk.columns) fkColumns.add(col);
    if (fk.columns.length === 1) singleFkColumns.add(fk.columns[0]!);
  }

  const columns = table.columns.map((c) => {
    // A CHECK-constraint pseudo-enum takes precedence (it can narrow further);
    // otherwise fall back to a native ENUM type resolved by udtName, the same
    // way function arguments resolve theirs. Only a native ENUM has an
    // exhaustive label set, so record which source won: value pre-flight must
    // not treat a non-exhaustive CHECK set as a whitelist.
    const checkEnum = enumMap.get(c.name);
    const nativeEnumValues =
      checkEnum === undefined ? (findEnumValues(enums, c.udtName, table.schema) ?? null) : null;
    return buildColumn({
      column: c,
      primaryKey: table.primaryKey,
      foreignKeyColumns: fkColumns,
      singleColumnForeignKeyColumns: singleFkColumns,
      enumValues: checkEnum ?? nativeEnumValues,
      nativeEnum: checkEnum === undefined && nativeEnumValues !== null,
      hints: hints?.columns?.[c.name],
    });
  });

  const declaredColumnNames = new Set(table.columns.map((c) => c.name));
  if (hints?.columns) {
    for (const hintCol of Object.keys(hints.columns)) {
      if (!declaredColumnNames.has(hintCol)) {
        issues.push({
          path: `tables.${table.name}.columns.${hintCol}`,
          message: `UIHints column "${hintCol}" does not exist on ${table.name}`,
        });
      }
    }
  }

  const relations = buildRelations(table, issues);
  for (const rel of relations) {
    const refKey = `${rel.references.schema}.${rel.references.table}`;
    if (!knownTables.has(refKey)) {
      issues.push({
        path: `tables.${table.name}.relations.${rel.field}`,
        message: `FK target table "${refKey}" does not exist in raw.tables`,
      });
    }
  }

  let displayField: string | null = hints?.displayField ?? null;
  if (displayField !== null && !declaredColumnNames.has(displayField)) {
    issues.push({
      path: `tables.${table.name}.displayField`,
      message: `UIHints displayField "${displayField}" does not exist on ${table.name}`,
    });
    displayField = null;
  }
  if (displayField === null) {
    displayField = inferDisplayField({
      columns: table.columns,
      primaryKey: table.primaryKey,
    });
  }

  // Title shown in the UI: an explicit UI Hint wins, otherwise the bare object
  // name. The COMMENT is surfaced separately as `description`, so deriving the
  // label from it would render the comment twice (title + description) and hide
  // the table name. This mirrors the VIEW path (see buildViewContext) and keeps
  // the dashboard's Tables and Views lists consistent.
  const label = hints?.label ?? table.name;

  return {
    schema: table.schema,
    name: table.name,
    qualifiedName: `${table.schema}.${table.name}`,
    label,
    description: parsed.body !== '' ? parsed.body : null,
    aiDescription: joinAi(parsed.ai),
    policy: parsed.policy,
    ...(table.privileges ? { privileges: table.privileges } : {}),
    ...(table.rowSecurity ? { rowSecurity: table.rowSecurity } : {}),
    primaryKey: table.primaryKey,
    displayField,
    columns,
    relations,
    rawTable: table,
  };
}

function buildViewContext(input: {
  view: RawView;
  hints: ViewHints | undefined;
  issues: BuildIssue[];
  enums: RawEnum[];
}): ViewContext {
  const { view, hints, issues, enums } = input;
  const parsed = parseCommentTags(view.comment);

  const declaredColumnNames = new Set(view.columns.map((c) => c.name));
  if (hints?.columns) {
    for (const hintCol of Object.keys(hints.columns)) {
      if (!declaredColumnNames.has(hintCol)) {
        issues.push({
          path: `views.${view.name}.columns.${hintCol}`,
          message: `UIHints column "${hintCol}" does not exist on view ${view.name}`,
        });
      }
    }
  }

  const columns = view.columns.map<ColumnContext>((c) => {
    const colParsed = parseCommentTags(c.comment);
    const colHints = hints?.columns?.[c.name];
    // A view column has no CHECK constraints, but it can still be typed as a
    // native ENUM — resolve its members by udtName like the table path does.
    const enumValues = findEnumValues(enums, c.udtName, view.schema) ?? null;
    const widget: WidgetType =
      colHints?.widget ??
      colParsed.widget ??
      inferWidget({
        column: c,
        isForeignKey: false,
        enumValues,
        commentBody: colParsed.body,
      });
    return {
      name: c.name,
      dataType: c.dataType,
      effectiveType: c.effectiveType ?? c.dataType,
      nullable: c.nullable,
      defaultExpr: c.defaultExpr,
      isPrimaryKey: false,
      isForeignKey: false,
      label: colHints?.label ?? deriveLabel(c.name),
      description: colParsed.body !== '' ? colParsed.body : null,
      aiDescription: joinAi(colParsed.ai),
      policy: colParsed.policy,
      widget,
      enumValues,
      // A view column has no CHECK constraints, so a non-null enumValues here is
      // always a native ENUM resolved by udtName.
      nativeEnum: enumValues !== null,
      readonly: colHints?.readonly ?? true,
    };
  });

  // Title shown in the UI: UI Hint, otherwise the bare view name. The COMMENT is
  // surfaced as `description`, never as the title (kept symmetric with the TABLE
  // path in buildTableContext so the dashboard lists stay consistent).
  const label = hints?.label ?? view.name;

  return {
    schema: view.schema,
    name: view.name,
    qualifiedName: `${view.schema}.${view.name}`,
    label,
    description: parsed.body !== '' ? parsed.body : null,
    aiDescription: joinAi(parsed.ai),
    policy: parsed.policy,
    ...(view.privileges ? { privileges: view.privileges } : {}),
    purpose: firstParagraph(parsed.body),
    columns,
    underlyingTables: view.underlyingTables,
    rawView: view,
  };
}

/** Derive join suggestions for a VIEW from the *real* foreign keys among its
 *  underlying tables, instead of the old unresolved
 *  `<fk_column> = <pk_column>` placeholder. For each underlying table with a FK
 *  to another underlying table, surface the actual ON condition (a composite FK
 *  becomes an `AND`-joined multi-column condition). A view whose underlying
 *  tables have no FK between them yields `[]` — the concept stays silent rather
 *  than guessing. Reuses the already-built `RelationContext`, so misaligned FKs
 *  (skipped by buildRelations) never reach here. Under privilegeDisplay
 *  'filter' a hidden table, absent from `relationsByTable`, contributes no
 *  outgoing edges; an edge from a visible table to a hidden one is still
 *  surfaced, the same way `TableContext.relations` retains such edges. */
function deriveJoinSuggestions(
  view: RawView,
  relationsByTable: Map<string, RelationContext[]>,
): { table: string; on: string; meaning: string | null }[] {
  const underlying = new Set(view.underlyingTables.map((t) => `${t.schema}.${t.name}`));
  const suggestions: { table: string; on: string; meaning: string | null }[] = [];
  for (const ut of view.underlyingTables) {
    const relations = relationsByTable.get(`${ut.schema}.${ut.name}`);
    if (relations === undefined) continue; // an underlying view, or a hidden table
    for (const rel of relations) {
      const target = `${rel.references.schema}.${rel.references.table}`;
      // Only suggest joins between tables the view actually reads from.
      if (!underlying.has(target)) continue;
      // `fields` / `references.columns` are the composite (v1.1+) sets; normalize
      // against the scalar back-compat fields, as documented on RelationContext.
      const fields = rel.fields ?? [rel.field];
      const refColumns = rel.references.columns ?? [rel.references.column];
      const on = fields
        .map((field, i) => `${ut.name}.${field} = ${rel.references.table}.${refColumns[i]!}`)
        .join(' AND ');
      // The FK's COMMENT documents what the relationship means; surface it so an
      // agent gets the join's purpose, not just its mechanics. null when absent.
      suggestions.push({ table: target, on, meaning: rel.meaning });
    }
  }
  return suggestions;
}

function buildConcept(
  view: RawView,
  relationsByTable: Map<string, RelationContext[]>,
): ConceptContext {
  const parsed = parseCommentTags(view.comment);
  return {
    name: view.name,
    label: view.name,
    description: parsed.body !== '' ? parsed.body : null,
    kind: 'VIEW',
    joinSuggestions: deriveJoinSuggestions(view, relationsByTable),
    aiNotes: parsed.ai,
    policies: parsed.policy,
    // `@example:` blocks on the VIEW's COMMENT - surfaced through MCP
    // `get_concept_context.exampleQueries`.
    exampleQueries: parsed.examples,
  };
}

export async function buildSchemaContext(opts: BuildOptions): Promise<SchemaContext> {
  const { raw, uiHints, strict = false, rpc, privilegeDisplay = 'filter' } = opts;
  const annotatePrivileges = privilegeDisplay === 'annotate';
  const issues: BuildIssue[] = [];

  const knownTables = new Set(raw.tables.map((t) => `${t.schema}.${t.name}`));
  raw.views.forEach((v) => knownTables.add(`${v.schema}.${v.name}`));

  // A hint key matches either the bare relation name or its schema-qualified
  // form (`schema.name`), the same precedence `lookupHints` uses — so a valid
  // qualified key is not mistaken for a hint on a non-existent relation.
  if (uiHints?.tables) {
    for (const tableName of Object.keys(uiHints.tables)) {
      if (!raw.tables.some((t) => t.name === tableName || `${t.schema}.${t.name}` === tableName)) {
        issues.push({
          path: `tables.${tableName}`,
          message: `UIHints table "${tableName}" does not exist in raw.tables`,
        });
      }
    }
  }
  if (uiHints?.views) {
    for (const viewName of Object.keys(uiHints.views)) {
      if (!raw.views.some((v) => v.name === viewName || `${v.schema}.${v.name}` === viewName)) {
        issues.push({
          path: `views.${viewName}`,
          message: `UIHints view "${viewName}" does not exist in raw.views`,
        });
      }
    }
  }

  // Privilege-aware mode (issue #99): a table / view the serving role cannot
  // SELECT (or whose schema it cannot USAGE — both folded into `select`) is
  // hidden from the generated surfaces rather than listed and erroring on open.
  // Hiding is intended behaviour, not a validation issue, so it is reported on a
  // separate informational channel (never thrown, even under strict). Relations
  // whose privileges were not evaluated (`undefined`) are always kept. Relation
  // targets are still resolved against the full `knownTables`, so a relation
  // pointing at a hidden table is not flagged as missing; such an embed would be
  // denied at query time (mapped to 403) — see issue #99 known limitations.
  //
  // In `annotate` mode (MCP / `kozou docs`) nothing is hidden: every relation is
  // kept and its privileges are surfaced (see `RelationPrivileges`), so an agent
  // is told what it may touch rather than having unreadable tables disappear.
  const hiddenNames: string[] = [];
  const visibleRawTables = annotatePrivileges
    ? raw.tables
    : raw.tables.filter((t) => {
        if (t.privileges?.select === false) {
          hiddenNames.push(t.name);
          return false;
        }
        return true;
      });
  const visibleRawViews = annotatePrivileges
    ? raw.views
    : raw.views.filter((v) => {
        if (v.privileges?.select === false) {
          hiddenNames.push(v.name);
          return false;
        }
        return true;
      });
  if (hiddenNames.length > 0) {
    const role =
      raw.tables.find((t) => t.privileges !== undefined)?.privileges?.role ??
      raw.views.find((v) => v.privileges !== undefined)?.privileges?.role ??
      'the role';
    console.warn(
      `[@kozou/core] privilege-aware introspection: hid ${hiddenNames.length} relation(s) ` +
        `that "${role}" cannot SELECT: ${hiddenNames.join(', ')}`,
    );
  }

  const tables = visibleRawTables.map<TableContext>((t) =>
    buildTableContext({
      table: t,
      hints: lookupHints(uiHints?.tables, t.schema, t.name),
      issues,
      knownTables,
      enums: raw.enums,
    }),
  );

  const views = visibleRawViews.map<ViewContext>((v) =>
    buildViewContext({
      view: v,
      hints: lookupHints(uiHints?.views, v.schema, v.name),
      issues,
      enums: raw.enums,
    }),
  );

  const enums = raw.enums.map<EnumContext>((e) => ({
    schema: e.schema,
    name: e.name,
    values: e.values,
    description: null,
  }));

  // Join suggestions are derived from the real FK graph among a view's
  // underlying tables (see deriveJoinSuggestions), reusing the relations already
  // built for the visible tables.
  const relationsByTable = new Map<string, RelationContext[]>(
    tables.map((t) => [t.qualifiedName, t.relations]),
  );
  const concepts = visibleRawViews.map<ConceptContext>((v) =>
    buildConcept(v, relationsByTable),
  );

  // RPC functions (issue #103): decide which tagged functions are exposed and
  // shape them; skipped-but-tagged functions append loud-skip issues below.
  const functions = buildFunctionContexts({
    functions: raw.functions,
    enums: raw.enums,
    rpc,
    issues,
  });

  if (issues.length > 0) {
    if (strict) {
      throw new KozouBuildError(
        `buildSchemaContext: ${issues.length} validation issue(s) (strict=true)`,
        issues,
      );
    }
    for (const issue of issues) {
      console.warn(`[@kozou/core] ${issue.path}: ${issue.message}`);
    }
  }

  return {
    meta: {
      serverVersion: raw.serverVersion,
      builtAt: new Date().toISOString(),
      sourceSchemas: raw.schemas,
    },
    tables,
    views,
    enums,
    concepts,
    functions,
  };
}
