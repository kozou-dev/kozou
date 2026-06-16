import type { Client } from 'pg';
import type { RawTable, RawView } from '@kozou/core';
import { KozouIntrospectError, runQuery } from './errors.js';

// Privilege-aware introspection (Kozou issue #99). When `kozou` runs with
// `introspection.respectPrivileges: true`, we evaluate what the *serving
// role* (the Admin UI's minted-token role) may do with each table/column and
// fold that into the generated surfaces, so a column the role cannot UPDATE
// renders read-only and a table it cannot SELECT is hidden instead of erroring
// at request time. Privileges are evaluated for a named role via
// `has_table_privilege` / `has_column_privilege`, which any connection may
// call for any role — we do not need to connect as that role.

type TablePrivRow = {
  schema: string;
  name: string;
  // Whether the role has USAGE on the containing schema. Without it the role
  // cannot reach any object in the schema, so it gates every privilege below.
  usage: boolean;
  sel: boolean;
  ins: boolean;
  upd: boolean;
  del: boolean;
};

type ColumnPrivRow = {
  schema: string;
  table: string;
  name: string;
  usage: boolean;
  ins: boolean;
  upd: boolean;
};

const tableKey = (schema: string, name: string) => `${schema}.${name}`;

/** Throw a clear error if the configured privilege role does not exist, rather
 *  than letting `has_table_privilege` fail mid-query with a terse pg message. */
async function assertRoleExists(client: Client, role: string): Promise<void> {
  const rows = await runQuery<{ exists: boolean }>(
    client,
    'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
    [role],
    'fetchPrivileges (role check)',
  );
  if (rows[0]?.exists !== true) {
    throw new KozouIntrospectError(
      `introspection.respectPrivileges is on but the role "${role}" does not exist. ` +
        'Set it to the role the Admin UI assumes (auth.ui.role / auth.defaultRole), ' +
        'or turn privilege-aware introspection off.',
    );
  }
}

/**
 * Evaluate the privileges of `role` on every base table / view (and base-table
 * columns) in `schemas`, and attach them to the matching `RawTable` /
 * `RawColumn` / `RawView`. Mutates the inputs in place (mirrors
 * `mergeTableMetadata`). Call only when privilege-aware mode is on; otherwise
 * the privilege fields stay `undefined`.
 */
export async function fetchAndAttachPrivileges(
  client: Client,
  schemas: string[],
  role: string,
  tables: RawTable[],
  views: RawView[],
): Promise<void> {
  if (schemas.length === 0 || (tables.length === 0 && views.length === 0)) return;
  await assertRoleExists(client, role);

  // Every privilege is gated by schema USAGE: a role may hold a table/column
  // grant yet still be denied at query time without USAGE on the schema, which
  // would otherwise make the surface advertise access the role does not have.
  // Relations covers base tables ('r'), views ('v'), and materialized views
  // ('m') so views are hidden by the same SELECT/USAGE rule as tables.
  const tableRows = await runQuery<TablePrivRow>(
    client,
    `SELECT
       n.nspname AS schema,
       c.relname AS name,
       has_schema_privilege($2, n.nspname, 'USAGE') AS usage,
       has_table_privilege($2, c.oid, 'SELECT') AS sel,
       has_table_privilege($2, c.oid, 'INSERT') AS ins,
       has_table_privilege($2, c.oid, 'UPDATE') AS upd,
       has_table_privilege($2, c.oid, 'DELETE') AS del
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     -- Cover the same relations fetchTables / fetchViews surface: ordinary
     -- tables + partitioned parents (not leaf partitions) + views + matviews.
     WHERE c.relkind IN ('r', 'p', 'v', 'm')
       AND NOT c.relispartition
       AND n.nspname = ANY($1)`,
    [schemas, role],
    'fetchPrivileges (relations)',
  );

  // `has_column_privilege` reports a column privilege as held when it is
  // granted at the column level *or* table-wide, so this already subsumes
  // table grants — exactly the "may the role write this column" question.
  // Still gated by schema USAGE for the same reason as the table grants.
  const columnRows = await runQuery<ColumnPrivRow>(
    client,
    `SELECT
       n.nspname AS schema,
       c.relname AS table,
       a.attname AS name,
       has_schema_privilege($2, n.nspname, 'USAGE') AS usage,
       has_column_privilege($2, c.oid, a.attname, 'INSERT') AS ins,
       has_column_privilege($2, c.oid, a.attname, 'UPDATE') AS upd
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     -- Tables and partitioned parents (per-column write grants apply to both);
     -- leaf partitions are excluded, matching the relation set above.
     WHERE c.relkind IN ('r', 'p')
       AND NOT c.relispartition
       AND n.nspname = ANY($1)
       AND a.attnum > 0
       AND NOT a.attisdropped`,
    [schemas, role],
    'fetchPrivileges (columns)',
  );

  const tablePrivByKey = new Map<string, TablePrivRow>();
  for (const row of tableRows) tablePrivByKey.set(tableKey(row.schema, row.name), row);

  const columnPrivByKey = new Map<string, Map<string, ColumnPrivRow>>();
  for (const row of columnRows) {
    const key = tableKey(row.schema, row.table);
    if (!columnPrivByKey.has(key)) columnPrivByKey.set(key, new Map());
    columnPrivByKey.get(key)!.set(row.name, row);
  }

  // Gate each grant by schema USAGE so the attached privileges reflect what the
  // role can actually do at query time (not just the relation ACL).
  const gate = (tp: TablePrivRow) => ({
    role,
    select: tp.usage && tp.sel,
    insert: tp.usage && tp.ins,
    update: tp.usage && tp.upd,
    delete: tp.usage && tp.del,
  });

  for (const table of tables) {
    const key = tableKey(table.schema, table.name);
    const tp = tablePrivByKey.get(key);
    if (tp !== undefined) table.privileges = gate(tp);
    const cols = columnPrivByKey.get(key);
    if (cols !== undefined) {
      for (const column of table.columns) {
        const cp = cols.get(column.name);
        if (cp !== undefined) {
          column.privileges = { insert: cp.usage && cp.ins, update: cp.usage && cp.upd };
        }
      }
    }
  }

  // Views are hidden by the same USAGE + SELECT rule (a view the role cannot
  // read would otherwise show in the nav and error on open). View columns are
  // read-only in the Admin UI, so per-column privileges are not attached.
  for (const view of views) {
    const vp = tablePrivByKey.get(tableKey(view.schema, view.name));
    if (vp !== undefined) view.privileges = gate(vp);
  }
}
