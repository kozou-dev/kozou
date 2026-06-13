import type { RawColumn, RawIntrospection, RawTable, RawView } from './types/raw.js';
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

export type BuildOptions = {
  raw: RawIntrospection;
  uiHints?: UIHints;
  /** Whether to warn-only on validation issues, or throw. Default: false (warn only). */
  strict?: boolean;
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

function buildColumn(input: {
  column: RawColumn;
  primaryKey: string[];
  foreignKeyColumns: Set<string>;
  /** Columns that are the sole column of a single-column FK — relation-select
   *  eligible. A composite-FK column is in `foreignKeyColumns` but not here. */
  singleColumnForeignKeyColumns: Set<string>;
  enumValues: string[] | null;
  hints: ColumnHints | undefined;
}): ColumnContext {
  const { column, primaryKey, foreignKeyColumns, singleColumnForeignKeyColumns, enumValues, hints } =
    input;
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
}): TableContext {
  const { table, hints, issues, knownTables } = input;
  const parsed = parseCommentTags(table.comment);
  const enumMap = extractCheckEnums(table.checks);
  const fkColumns = new Set<string>();
  const singleFkColumns = new Set<string>();
  for (const fk of table.foreignKeys) {
    for (const col of fk.columns) fkColumns.add(col);
    if (fk.columns.length === 1) singleFkColumns.add(fk.columns[0]!);
  }

  const columns = table.columns.map((c) =>
    buildColumn({
      column: c,
      primaryKey: table.primaryKey,
      foreignKeyColumns: fkColumns,
      singleColumnForeignKeyColumns: singleFkColumns,
      enumValues: enumMap.get(c.name) ?? null,
      hints: hints?.columns?.[c.name],
    }),
  );

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

  const commentFirstLine = parsed.body !== '' ? parsed.body.split('\n')[0]!.trim() : null;
  const label = hints?.label ?? commentFirstLine ?? table.name;

  return {
    schema: table.schema,
    name: table.name,
    qualifiedName: `${table.schema}.${table.name}`,
    label,
    description: parsed.body !== '' ? parsed.body : null,
    aiDescription: joinAi(parsed.ai),
    policy: parsed.policy,
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
}): ViewContext {
  const { view, hints, issues } = input;
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
    const widget: WidgetType =
      colHints?.widget ??
      colParsed.widget ??
      inferWidget({
        column: c,
        isForeignKey: false,
        enumValues: null,
        commentBody: colParsed.body,
      });
    return {
      name: c.name,
      dataType: c.dataType,
      nullable: c.nullable,
      defaultExpr: c.defaultExpr,
      isPrimaryKey: false,
      isForeignKey: false,
      label: colHints?.label ?? deriveLabel(c.name),
      description: colParsed.body !== '' ? colParsed.body : null,
      aiDescription: joinAi(colParsed.ai),
      policy: colParsed.policy,
      widget,
      enumValues: null,
      readonly: colHints?.readonly ?? true,
    };
  });

  const label = hints?.label ?? view.name;

  return {
    schema: view.schema,
    name: view.name,
    qualifiedName: `${view.schema}.${view.name}`,
    label,
    description: parsed.body !== '' ? parsed.body : null,
    aiDescription: joinAi(parsed.ai),
    policy: parsed.policy,
    purpose: firstParagraph(parsed.body),
    columns,
    underlyingTables: view.underlyingTables,
    rawView: view,
  };
}

function buildConcept(view: RawView): ConceptContext {
  const parsed = parseCommentTags(view.comment);
  const joinSuggestions = view.underlyingTables.map((t) => ({
    table: `${t.schema}.${t.name}`,
    on: `${view.name}.<fk_column> = ${t.name}.<pk_column>`,
  }));
  return {
    name: view.name,
    label: view.name,
    description: parsed.body !== '' ? parsed.body : null,
    kind: 'VIEW',
    joinSuggestions,
    aiNotes: parsed.ai,
    policies: parsed.policy,
    // `@example:` blocks on the VIEW's COMMENT - surfaced through MCP
    // `get_concept_context.exampleQueries` (Kozou v0.1 spec §7.3.6).
    exampleQueries: parsed.examples,
  };
}

export async function buildSchemaContext(opts: BuildOptions): Promise<SchemaContext> {
  const { raw, uiHints, strict = false } = opts;
  const issues: BuildIssue[] = [];

  const knownTables = new Set(raw.tables.map((t) => `${t.schema}.${t.name}`));
  raw.views.forEach((v) => knownTables.add(`${v.schema}.${v.name}`));

  if (uiHints?.tables) {
    for (const tableName of Object.keys(uiHints.tables)) {
      if (!raw.tables.some((t) => t.name === tableName)) {
        issues.push({
          path: `tables.${tableName}`,
          message: `UIHints table "${tableName}" does not exist in raw.tables`,
        });
      }
    }
  }
  if (uiHints?.views) {
    for (const viewName of Object.keys(uiHints.views)) {
      if (!raw.views.some((v) => v.name === viewName)) {
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
  const hiddenNames: string[] = [];
  const visibleRawTables = raw.tables.filter((t) => {
    if (t.privileges?.select === false) {
      hiddenNames.push(t.name);
      return false;
    }
    return true;
  });
  const visibleRawViews = raw.views.filter((v) => {
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
      hints: uiHints?.tables?.[t.name],
      issues,
      knownTables,
    }),
  );

  const views = visibleRawViews.map<ViewContext>((v) =>
    buildViewContext({
      view: v,
      hints: uiHints?.views?.[v.name],
      issues,
    }),
  );

  const enums = raw.enums.map<EnumContext>((e) => ({
    schema: e.schema,
    name: e.name,
    values: e.values,
    description: null,
  }));

  const concepts = visibleRawViews.map<ConceptContext>(buildConcept);

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
  };
}
