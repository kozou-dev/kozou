// Detail route. Reads the row via DataAdapter.get, resolves each FK column
// to the referenced row's displayField label through @kozou/ui-core's
// resolveFkLabels (backed by the per-process FkRowCache), and renders the
// fields. Read-only: no edit/delete (that is Phase 2).

import { notFound } from 'next/navigation';

import type { ColumnContext } from '@kozou/core';
import {
  encodeResourceId,
  formatCellValue,
  parseResourceId,
  resolveFkLabels,
  type ResolvedFkLabel,
} from '@kozou/ui-core';

import { getAdapter } from '@/lib/server/adapter';
import { getFkRowCache, getSchema } from '@/lib/server/schema';

export const dynamic = 'force-dynamic';

export default async function DetailPage({
  params,
}: {
  params: Promise<{ table: string; id: string }>;
}) {
  const { table: tableSlug, id: idSegment } = await params;

  const schema = await getSchema();
  const table = schema.tables.find((t) => t.qualifiedName === tableSlug);
  if (!table) notFound();

  const adapter = getAdapter();
  const fkRowCache = getFkRowCache();

  const id = parseResourceId(idSegment, table.primaryKey);
  const row = await adapter.get(table.qualifiedName, id);

  const fkLabels = await resolveFkLabels({
    table,
    row,
    schema,
    loadRow: (qualifiedName, rid) =>
      // Swallow adapter errors so one missing target row does not block the
      // other FK columns; the field then falls back to the raw value.
      fkRowCache.get(qualifiedName, rid, (qn, identifier) =>
        adapter.get(qn, identifier).catch(() => null),
      ),
  });

  return (
    <>
      <h1>{table.label}</h1>
      <p className="subtitle">
        {table.qualifiedName} / {encodeResourceId(id)}
      </p>

      <dl>
        {table.columns.map((col) => (
          <div key={col.name}>
            <dt>{col.label}</dt>
            <dd>
              <Field col={col} value={row[col.name]} fkLabel={fkLabels[col.name]} />
            </dd>
          </div>
        ))}
      </dl>

      <p style={{ marginTop: '2rem' }}>
        <a className="btn" href={`/tables/${table.qualifiedName}`}>
          Back
        </a>
      </p>
    </>
  );
}

function Field({
  col,
  value,
  fkLabel,
}: {
  col: ColumnContext;
  value: unknown;
  fkLabel: ResolvedFkLabel | undefined;
}) {
  if (col.widget === 'json') {
    return <pre>{formatCellValue({ value, widget: col.widget })}</pre>;
  }
  if (col.widget === 'image-url' && value) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={String(value)}
        alt={col.label}
        style={{ maxHeight: '12rem', borderRadius: 6 }}
        loading="lazy"
      />
    );
  }
  if (value === null || value === undefined) {
    return <span className="subtitle">—</span>;
  }
  if (fkLabel !== undefined && fkLabel.label !== null) {
    return (
      <>
        <a href={`/tables/${fkLabel.referencedQualifiedName}/${fkLabel.value}`}>
          {fkLabel.label}
        </a>{' '}
        <span className="subtitle">
          ({formatCellValue({ value, widget: col.widget })})
        </span>
      </>
    );
  }
  return <>{formatCellValue({ value, widget: col.widget })}</>;
}
