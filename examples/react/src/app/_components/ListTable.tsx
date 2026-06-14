// React analogue of the reference UI's ListTable.svelte. Identical data
// contract and identical use of @kozou/ui-core: sort-header links via
// buildSortHref, pagination via buildHref, cell text via formatCell, and
// the per-row link segment via rowIdSegment. Only the markup is React.
//
// Plain <a> elements (native navigation, full server re-render per click)
// mirror the reference UI's anchors and keep the read path JS-free.

import {
  buildHref,
  buildSortHref,
  formatCell,
  rowIdSegment,
  type ListViewParams,
} from '@kozou/ui-core';

interface ListColumn {
  name: string;
  label: string;
}

interface ListTableProps {
  /** Heading text (table label). */
  title: string;
  /** `schema.table`, shown under the heading. */
  qualifiedName: string;
  columns: ListColumn[];
  rows: Record<string, unknown>[];
  total: number;
  listParams: ListViewParams;
  /** Route base for per-row links, e.g. `/tables/<qn>`. */
  basePath: string;
  /** Primary-key column names used to build the per-row link target. */
  primaryKey?: string[];
}

export function ListTable({
  title,
  qualifiedName,
  columns,
  rows,
  total,
  listParams,
  basePath,
  primaryKey = [],
}: ListTableProps) {
  const sortLookup = new Map(listParams.sort.map((s) => [s.field, s.order]));
  const totalPages = Math.max(1, Math.ceil(total / listParams.pageSize));

  // The `[id]` path segment for a row: a single key is the encoded value, a
  // composite key joins its columns. Falls back to the row index when the
  // key is absent.
  const rowKey = (row: Record<string, unknown>, idx: number): string =>
    rowIdSegment(row, primaryKey) ?? String(idx);

  return (
    <>
      <h1>{title}</h1>
      <p className="subtitle">{qualifiedName}</p>

      <form method="GET" className="toolbar">
        <input
          type="text"
          name="q"
          defaultValue={listParams.search}
          placeholder="Search…"
        />
        <button type="submit">Search</button>
      </form>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.name}>
                  <a href={buildSortHref(listParams, col.name)}>
                    {col.label}
                    {sortLookup.has(col.name)
                      ? ` ${sortLookup.get(col.name) === 'asc' ? '↑' : '↓'}`
                      : ''}
                  </a>
                </th>
              ))}
              <th>View</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="empty" colSpan={columns.length + 1}>
                  No rows.
                </td>
              </tr>
            ) : (
              rows.map((row, idx) => (
                <tr key={rowKey(row, idx)}>
                  {columns.map((col) => (
                    <td key={col.name}>{formatCell(row[col.name])}</td>
                  ))}
                  <td>
                    <a href={`${basePath}/${rowKey(row, idx)}`}>View</a>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <nav className="pager">
        <span className="subtitle">
          Page {listParams.page} of {totalPages} ({total} total)
        </span>
        <div className="links">
          {listParams.page > 1 && (
            <a
              className="btn"
              href={buildHref(listParams, { page: String(listParams.page - 1) })}
            >
              ← Prev
            </a>
          )}
          {listParams.page < totalPages && (
            <a
              className="btn"
              href={buildHref(listParams, { page: String(listParams.page + 1) })}
            >
              Next →
            </a>
          )}
        </div>
      </nav>
    </>
  );
}
