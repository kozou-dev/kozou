import type { RowSecurity, SchemaContext } from '@kozou/core';
import { McpToolError } from '../errors.js';
import { requireQualifiedName } from './qualifiedName.js';
import {
  type DescribeTableOutput,
  type DescribeTableColumn,
} from '../schemas/describe_table.js';

/** "a", "a and b", "a, b and c" — the list reads as a sentence, because it is
 *  inside one. */
function englishList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Build the human-readable advisory for the row-security signal. Returns a
 *  `note` only when RLS is enabled — a non-RLS table needs no caveat, and the
 *  bare `enabled: false` already says "rows are not filtered". */
function rowSecurityNote(rls: RowSecurity): { note: string } | Record<string, never> {
  if (!rls.enabled) return {};
  const base = rls.hasPolicies
    ? 'Row-level security is enabled: the rows you can read and the rows you can write are ' +
      'filtered by policy for the connecting role, so do not assume a result is complete or ' +
      'that a write will be accepted.'
    : 'Row-level security is enabled but no policy is defined, so non-owner roles can read and ' +
      'write no rows (default-deny).';
  // Named only alongside the "policies exist" branch: with no policy at all the
  // sentence above already says every command is refused, and repeating it as a
  // list would read as a second, narrower fact.
  const denied = rls.deniedCommands ?? [];
  const perCommand =
    rls.hasPolicies && denied.length > 0
      ? ` No permissive policy covers ${englishList(denied)}, so ` +
        `${denied.length === 1 ? 'that command is' : 'those commands are'} refused for every role ` +
        'RLS applies to, whatever privileges have been granted. An INSERT raises an error only ' +
        'once it writes a row, and one that writes none reports success; a refused SELECT, ' +
        'UPDATE or DELETE matches no rows instead of failing.'
      : '';
  const forced = rls.forced
    ? ' RLS also applies to the table owner (roles with BYPASSRLS still bypass it).'
    : '';
  return { note: `${base}${perCommand}${forced}` };
}

export function describeTable(
  input: Record<string, unknown>,
  ctx: SchemaContext,
): DescribeTableOutput {
  const qualifiedName = requireQualifiedName('describe_table', input, 'public.orders');
  const table = ctx.tables.find((t) => t.qualifiedName === qualifiedName);
  if (!table) {
    throw new McpToolError(`Table not found: ${qualifiedName}`);
  }

  // Annotate every FK column with its referenced column. For a composite FK
  // each member column maps to its positionally-aligned referenced column.
  const referencesByField = new Map<string, { table: string; column: string }>();
  for (const rel of table.relations) {
    const refTable = `${rel.references.schema}.${rel.references.table}`;
    const fields = rel.fields ?? [rel.field];
    const refCols = rel.references.columns ?? [rel.references.column];
    fields.forEach((field, i) => {
      referencesByField.set(field, { table: refTable, column: refCols[i]! });
    });
  }

  const columns: DescribeTableColumn[] = table.columns.map((c) => ({
    name: c.name,
    dataType: c.dataType,
    nullable: c.nullable,
    defaultExpr: c.defaultExpr,
    description: c.description,
    aiDescription: c.aiDescription,
    policy: c.policy ?? [],
    enumValues: c.enumValues,
    isForeignKey: c.isForeignKey,
    references: referencesByField.get(c.name) ?? null,
    // Privilege-aware mode only; `undefined` (omitted) when not evaluated.
    ...(c.insertable === undefined ? {} : { insertable: c.insertable }),
    ...(c.updatable === undefined ? {} : { updatable: c.updatable }),
  }));

  return {
    qualifiedName: table.qualifiedName,
    label: table.label,
    description: table.description,
    aiDescription: table.aiDescription,
    policy: table.policy ?? [],
    primaryKey: table.primaryKey,
    // Privilege-aware mode only; omitted when privileges were not evaluated.
    ...(table.privileges ? { privileges: table.privileges } : {}),
    // Row-level security signal; present whenever
    // introspection captured it. The policy expressions are never surfaced.
    ...(table.rowSecurity
      ? { rowSecurity: { ...table.rowSecurity, ...rowSecurityNote(table.rowSecurity) } }
      : {}),
    columns,
    relations: table.relations.map((r) => ({
      field: r.field,
      fields: r.fields ?? [r.field],
      referencesTable: `${r.references.schema}.${r.references.table}`,
      referencesColumn: r.references.column,
      referencesColumns: r.references.columns ?? [r.references.column],
      meaning: r.meaning,
    })),
    checkConstraints: table.rawTable.checks.map((c) => ({
      name: c.name,
      expression: c.expression,
    })),
  };
}
