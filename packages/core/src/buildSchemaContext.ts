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
  enumValues: string[] | null;
  hints: ColumnHints | undefined;
}): ColumnContext {
  const { column, primaryKey, foreignKeyColumns, enumValues, hints } = input;
  const parsed = parseCommentTags(column.comment);
  const isPrimaryKey = primaryKey.includes(column.name);
  const isForeignKey = foreignKeyColumns.has(column.name);

  const widget: WidgetType =
    hints?.widget ??
    parsed.widget ??
    inferWidget({
      column,
      isForeignKey,
      enumValues,
      commentBody: parsed.body,
    });

  const label = hints?.label ?? deriveLabel(column.name);

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
    widget,
    enumValues,
    readonly: hints?.readonly ?? false,
  };
}

function buildRelations(table: RawTable): RelationContext[] {
  const uniqueColumnSets = new Set<string>();
  for (const idx of table.indexes) {
    if (idx.unique) {
      uniqueColumnSets.add(idx.columns.slice().sort().join(','));
    }
  }
  if (table.primaryKey.length > 0) {
    uniqueColumnSets.add(table.primaryKey.slice().sort().join(','));
  }

  return table.foreignKeys
    .filter((fk) => fk.columns.length === 1)
    .map<RelationContext>((fk) => {
      const fkKey = fk.columns.slice().sort().join(',');
      const cardinality: RelationContext['cardinality'] = uniqueColumnSets.has(fkKey)
        ? 'one-to-one'
        : 'many-to-one';
      return {
        field: fk.columns[0]!,
        references: {
          schema: fk.referencedSchema,
          table: fk.referencedTable,
          column: fk.referencedColumns[0] ?? 'id',
        },
        cardinality,
        meaning: fk.comment,
      };
    });
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
  for (const fk of table.foreignKeys) {
    for (const col of fk.columns) fkColumns.add(col);
  }

  const columns = table.columns.map((c) =>
    buildColumn({
      column: c,
      primaryKey: table.primaryKey,
      foreignKeyColumns: fkColumns,
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

  const relations = buildRelations(table);
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

  const tables = raw.tables.map<TableContext>((t) =>
    buildTableContext({
      table: t,
      hints: uiHints?.tables?.[t.name],
      issues,
      knownTables,
    }),
  );

  const views = raw.views.map<ViewContext>((v) =>
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

  const concepts = raw.views.map<ConceptContext>(buildConcept);

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
