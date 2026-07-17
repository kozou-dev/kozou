// The core synthetic business domain.
//
// A small, coherent legacy-style online-retail domain. Every relation and
// column has an OPAQUE mangled name (see mangle.ts); ALL business meaning
// lives in COMMENT text (@ai / @policy / @example), never in names or in view
// filter logic. Views are REAL and visible to every arm, but are pure joins
// with NO business filtering, so no single view SELECT answers a task — the
// agent must combine the view with comment-encoded rules. This is what keeps
// arm A (comment-less) from recovering answers from view definitions.
//
// Authoring uses placeholders so the source stays readable while the emitted
// SQL uses mangled names:
//   {{t:key}}            -> table's mangled name
//   {{v:key}}            -> view's mangled name
//   {{c:tableKey.col}}   -> column's mangled name (within that table)
// The core mangling is INDEPENDENT of scale, so the mangled names (and hence
// every canonical_sql) are identical at S/M/L; only noise tables differ.

import { Mangler, REL_NS } from './mangle.js';

export interface ColumnSpec {
  key: string;
  type: string;
  notNull?: boolean;
  default?: string;
  pk?: boolean;
  unique?: boolean;
  comment?: string;
}

export interface FkSpec {
  columnKey: string;
  refTableKey: string;
  refColumnKey: string;
  comment?: string;
}

export interface TableSpec {
  key: string;
  columns: ColumnSpec[];
  fks?: FkSpec[];
  comment?: string;
}

export interface ViewSpec {
  key: string;
  /** SELECT body, written with placeholders. */
  definition: string;
  comment?: string;
}

// ---------------------------------------------------------------------------
// Core tables. `id` columns are also mangled (no readable `id`).
// ---------------------------------------------------------------------------

const CORE_TABLES: TableSpec[] = [
  {
    key: 'customer',
    comment:
      'People who place orders.\n' +
      '@ai: rows where {{c:customer.removed}} IS NOT NULL are soft-deleted (kept for audit/legal retention); exclude them from customer counts, metrics, and revenue.\n' +
      '@policy: {{c:customer.email}} is personal data; never expose it in aggregates or public reports.',
    columns: [
      { key: 'id', type: 'uuid', pk: true, default: 'gen_random_uuid()' },
      { key: 'full_name', type: 'text', notNull: true, comment: 'Full name of the person.' },
      { key: 'email', type: 'text', notNull: true, unique: true, comment: 'Login / contact email (unique). Personal data.' },
      { key: 'country', type: 'text', comment: 'ISO country of residence.' },
      { key: 'created', type: 'timestamptz', notNull: true, default: 'now()', comment: 'When the customer record was created.' },
      { key: 'removed', type: 'timestamptz', comment: 'Soft-delete timestamp; NULL means active.' },
    ],
  },
  {
    key: 'product',
    comment:
      'Catalog of sellable products.\n' +
      '@ai: {{c:product.active}} = false means delisted (not purchasable) but kept so historical orders still resolve.\n' +
      '@ai: rows where {{c:product.removed}} IS NOT NULL are soft-deleted; exclude them entirely.\n' +
      '@ai: a product is currently purchasable only when {{c:product.active}} = true AND {{c:product.removed}} IS NULL.\n' +
      '@ai: {{c:product.list_price}} is the CURRENT catalog price; never use it to value historical orders — use the captured price on the order line ({{c:order_item.unit_price}}).',
    columns: [
      { key: 'id', type: 'uuid', pk: true, default: 'gen_random_uuid()' },
      { key: 'sku', type: 'text', notNull: true, unique: true, comment: 'Stock-keeping unit (unique).' },
      { key: 'name', type: 'text', notNull: true, comment: 'Display name.' },
      { key: 'list_price', type: 'numeric(12,2)', notNull: true, comment: 'CURRENT catalog price. Not for valuing historical orders.' },
      { key: 'active', type: 'boolean', notNull: true, default: 'true', comment: 'false = delisted (not purchasable), kept for history.' },
      { key: 'removed', type: 'timestamptz', comment: 'Soft-delete timestamp; NULL means active.' },
    ],
  },
  {
    key: 'order',
    comment:
      'Order headers.\n' +
      "@ai: {{c:order.status}} lifecycle — 'cart' and 'pending' are NOT yet sales; 'paid' is a recognized sale; 'refunded' and 'chargeback' REVERSE a sale.\n" +
      '@ai: {{c:order.is_test}} = true marks internal test orders; exclude them from EVERY business metric.\n' +
      '@ai: {{c:order.amount_total}} is a DEPRECATED denormalized cache (stale; still includes test orders and pre-reversal totals) — do NOT use it for revenue; compute revenue from the order lines instead.\n' +
      "@ai: {{c:order.channel}} is the sales channel ('web' or 'store').\n" +
      '@ai: a recognized sale is an order with {{c:order.status}} = \'paid\', {{c:order.is_test}} = false, whose customer is not soft-deleted.',
    fks: [
      {
        columnKey: 'customer_id',
        refTableKey: 'customer',
        refColumnKey: 'id',
        comment: 'The customer who placed the order; join to exclude soft-deleted customers from sales.',
      },
    ],
    columns: [
      { key: 'id', type: 'uuid', pk: true, default: 'gen_random_uuid()' },
      { key: 'code', type: 'text', notNull: true, unique: true, comment: 'External order reference code.' },
      { key: 'customer_id', type: 'uuid', notNull: true, comment: 'Owning customer.' },
      { key: 'status', type: 'text', notNull: true, comment: "Lifecycle state: cart|pending|paid|refunded|chargeback." },
      { key: 'is_test', type: 'boolean', notNull: true, default: 'false', comment: 'true = internal test order; exclude from metrics.' },
      { key: 'amount_total', type: 'numeric(12,2)', comment: 'DEPRECATED stale cache of the order total; do not use for revenue.' },
      { key: 'channel', type: 'text', comment: "Sales channel: web|store." },
      { key: 'placed', type: 'timestamptz', notNull: true, default: 'now()', comment: 'When the order was placed.' },
    ],
  },
  {
    key: 'order_item',
    comment:
      'Order line items.\n' +
      '@ai: {{c:order_item.unit_price}} is the price CAPTURED at order time — use this for historical revenue, never {{c:product.list_price}}.\n' +
      '@ai: line revenue = {{c:order_item.quantity}} * {{c:order_item.unit_price}} - {{c:order_item.discount}}.',
    fks: [
      {
        columnKey: 'order_id',
        refTableKey: 'order',
        refColumnKey: 'id',
        comment: 'The order this line belongs to; join to apply status / test / soft-delete rules.',
      },
      {
        columnKey: 'product_id',
        refTableKey: 'product',
        refColumnKey: 'id',
        comment: 'The product sold on this line.',
      },
    ],
    columns: [
      { key: 'id', type: 'uuid', pk: true, default: 'gen_random_uuid()' },
      { key: 'order_id', type: 'uuid', notNull: true, comment: 'Owning order.' },
      { key: 'product_id', type: 'uuid', notNull: true, comment: 'Product sold.' },
      { key: 'quantity', type: 'integer', notNull: true, comment: 'Units sold on this line.' },
      { key: 'unit_price', type: 'numeric(12,2)', notNull: true, comment: 'Price captured at order time (historical).' },
      { key: 'discount', type: 'numeric(12,2)', notNull: true, default: '0', comment: 'Per-line discount amount.' },
    ],
  },
];

const CORE_VIEWS: ViewSpec[] = [
  {
    key: 'order_enriched',
    // Output columns use OPAQUE aliases (k1..kN): a readable alias like
    // "AS status" would leak meaning into the view definition, which arm A
    // can read. Meaning stays in the COMMENT only.
    definition:
      'SELECT o.{{c:order.id}} AS k1, o.{{c:order.status}} AS k2, o.{{c:order.is_test}} AS k3, ' +
      'o.{{c:order.channel}} AS k4, o.{{c:order.amount_total}} AS k5, ' +
      'c.{{c:customer.id}} AS k6, c.{{c:customer.full_name}} AS k7, ' +
      'c.{{c:customer.country}} AS k8, c.{{c:customer.removed}} AS k9 ' +
      'FROM {{t:order}} o JOIN {{t:customer}} c ON c.{{c:customer.id}} = o.{{c:order.customer_id}}',
    comment:
      'Convenience join of each order to its customer (output columns k1=order id, k2=status, k3=is-test flag, k4=channel, k5=deprecated cached total, k6=customer id, k7=customer name, k8=country, k9=customer soft-delete timestamp).\n' +
      '@ai: this view applies NO business rules — it does not filter test orders, soft-deleted customers, or by status. Apply those yourself per the table guidance.\n' +
      '@example: peek at a few joined rows\n' +
      '  SELECT * FROM {{v:order_enriched}} LIMIT 5;',
  },
  {
    key: 'order_lines',
    definition:
      'SELECT oi.{{c:order_item.id}} AS k1, oi.{{c:order_item.order_id}} AS k2, ' +
      'oi.{{c:order_item.product_id}} AS k3, oi.{{c:order_item.quantity}} AS k4, ' +
      'oi.{{c:order_item.unit_price}} AS k5, oi.{{c:order_item.discount}} AS k6, ' +
      'o.{{c:order.status}} AS k7, o.{{c:order.is_test}} AS k8 ' +
      'FROM {{t:order_item}} oi JOIN {{t:order}} o ON o.{{c:order.id}} = oi.{{c:order_item.order_id}}',
    comment:
      'Convenience join of each line to its order header (output columns k1=line id, k2=order id, k3=product id, k4=quantity, k5=captured unit price, k6=discount, k7=order status, k8=order is-test flag).\n' +
      '@ai: this view applies NO business rules; it does not filter by status, test, or soft-delete. Combine with the order/customer guidance to compute recognized revenue.',
  },
];

// ---------------------------------------------------------------------------
// Deterministic seed data. Aggregates are stable (ground truth is CI-verified
// by executing each task's canonical_sql). Reference rows by natural keys
// (email / sku / order code) so no generated UUID needs to be known.
// ---------------------------------------------------------------------------

interface CustomerRow { email: string; full_name: string; country: string; removed: boolean; }
interface ProductRow { sku: string; name: string; list_price: number; active: boolean; removed: boolean; }
interface OrderRow { code: string; email: string; status: string; is_test: boolean; amount_total: number; channel: string; }
interface ItemRow { code: string; sku: string; quantity: number; unit_price: number; discount: number; }

const CUSTOMERS: CustomerRow[] = [
  { email: 'alice@example.test', full_name: 'Alice Adams', country: 'US', removed: false },
  { email: 'bob@example.test', full_name: 'Bob Brown', country: 'US', removed: false },
  { email: 'carol@example.test', full_name: 'Carol Diaz', country: 'CA', removed: false },
  { email: 'dave@example.test', full_name: 'Dave Evans', country: 'GB', removed: true },
];

const PRODUCTS: ProductRow[] = [
  { sku: 'WID-001', name: 'Widget', list_price: 10.0, active: true, removed: false },
  { sku: 'GAD-001', name: 'Gadget', list_price: 20.0, active: true, removed: false },
  { sku: 'GIZ-001', name: 'Gizmo', list_price: 30.0, active: false, removed: false },
  { sku: 'DOO-001', name: 'Doohickey', list_price: 40.0, active: true, removed: true },
];

// amount_total is intentionally a wrong/stale cache (includes the test order,
// does not reflect reversals). It is NEVER the correct basis for revenue.
const ORDERS: OrderRow[] = [
  { code: 'O1', email: 'alice@example.test', status: 'paid', is_test: false, amount_total: 20, channel: 'web' },
  { code: 'O2', email: 'bob@example.test', status: 'paid', is_test: false, amount_total: 20, channel: 'store' },
  { code: 'O3', email: 'carol@example.test', status: 'paid', is_test: false, amount_total: 30, channel: 'web' },
  { code: 'O4', email: 'alice@example.test', status: 'paid', is_test: true, amount_total: 400, channel: 'web' },
  { code: 'O5', email: 'dave@example.test', status: 'paid', is_test: false, amount_total: 20, channel: 'web' },
  { code: 'O6', email: 'bob@example.test', status: 'refunded', is_test: false, amount_total: 10, channel: 'store' },
  { code: 'O7', email: 'carol@example.test', status: 'chargeback', is_test: false, amount_total: 20, channel: 'web' },
  { code: 'O8', email: 'alice@example.test', status: 'cart', is_test: false, amount_total: 10, channel: 'web' },
  { code: 'O9', email: 'bob@example.test', status: 'pending', is_test: false, amount_total: 20, channel: 'store' },
  { code: 'O10', email: 'carol@example.test', status: 'paid', is_test: false, amount_total: 10, channel: 'web' },
];

// unit_price is the CAPTURED price (deliberately differs from current
// list_price on O3's Gadget line: captured 15.00 vs current 20.00).
const ITEMS: ItemRow[] = [
  { code: 'O1', sku: 'WID-001', quantity: 2, unit_price: 10.0, discount: 0 },
  { code: 'O2', sku: 'GAD-001', quantity: 1, unit_price: 20.0, discount: 0 },
  { code: 'O3', sku: 'WID-001', quantity: 1, unit_price: 10.0, discount: 0 },
  { code: 'O3', sku: 'GAD-001', quantity: 1, unit_price: 15.0, discount: 0 },
  { code: 'O4', sku: 'WID-001', quantity: 1, unit_price: 400.0, discount: 0 },
  { code: 'O5', sku: 'GAD-001', quantity: 1, unit_price: 20.0, discount: 0 },
  { code: 'O6', sku: 'WID-001', quantity: 1, unit_price: 10.0, discount: 0 },
  { code: 'O7', sku: 'GAD-001', quantity: 1, unit_price: 20.0, discount: 0 },
  { code: 'O8', sku: 'WID-001', quantity: 1, unit_price: 10.0, discount: 0 },
  { code: 'O9', sku: 'GAD-001', quantity: 1, unit_price: 20.0, discount: 0 },
  { code: 'O10', sku: 'WID-001', quantity: 1, unit_price: 10.0, discount: 0 },
];

export const SEED = { CUSTOMERS, PRODUCTS, ORDERS, ITEMS };
export const CORE_SPEC = { tables: CORE_TABLES, views: CORE_VIEWS };

// ---------------------------------------------------------------------------
// Build: mangle every name, then resolve placeholders. Returns resolved
// structures plus a legend (semantic key -> mangled name) for emit/tests.
// ---------------------------------------------------------------------------

export interface ResolvedColumn {
  key: string;
  name: string;
  type: string;
  notNull: boolean;
  default?: string;
  pk: boolean;
  unique: boolean;
  comment?: string;
}

export interface ResolvedFk {
  name: string;
  column: string;
  refTable: string;
  refColumn: string;
  comment?: string;
}

export interface ResolvedTable {
  key: string;
  name: string;
  columns: ResolvedColumn[];
  fks: ResolvedFk[];
  comment?: string;
}

export interface ResolvedView {
  key: string;
  name: string;
  definition: string;
  comment?: string;
}

export interface CoreDomain {
  tables: ResolvedTable[];
  views: ResolvedView[];
  seedStatements: string[];
  /** semantic key -> mangled identifier, e.g. "t:order" or "c:order.status". */
  legend: Record<string, string>;
}

export function buildCoreDomain(mangler: Mangler): CoreDomain {
  const legend: Record<string, string> = {};

  // 1. Mangle relation names and column names.
  const tableName = new Map<string, string>();
  const colName = new Map<string, string>(); // `${tableKey}.${colKey}` -> mangled
  for (const t of CORE_TABLES) {
    const name = mangler.name('table', REL_NS, `core:${t.key}`);
    tableName.set(t.key, name);
    legend[`t:${t.key}`] = name;
    for (const c of t.columns) {
      const cn = mangler.name('column', name, c.key);
      colName.set(`${t.key}.${c.key}`, cn);
      legend[`c:${t.key}.${c.key}`] = cn;
    }
  }
  const viewName = new Map<string, string>();
  for (const v of CORE_VIEWS) {
    const name = mangler.name('view', REL_NS, `core:${v.key}`);
    viewName.set(v.key, name);
    legend[`v:${v.key}`] = name;
  }

  // 2. Placeholder resolver.
  const resolve = (text: string): string =>
    text.replace(/\{\{([tvc]):([^}]+)\}\}/g, (_m, kind: string, key: string) => {
      if (kind === 't') {
        const n = tableName.get(key);
        if (!n) throw new Error(`unknown table placeholder {{t:${key}}}`);
        return n;
      }
      if (kind === 'v') {
        const n = viewName.get(key);
        if (!n) throw new Error(`unknown view placeholder {{v:${key}}}`);
        return n;
      }
      const n = colName.get(key);
      if (!n) throw new Error(`unknown column placeholder {{c:${key}}}`);
      return n;
    });

  // 3. Resolve tables/views.
  const tables: ResolvedTable[] = CORE_TABLES.map((t) => ({
    key: t.key,
    name: tableName.get(t.key)!,
    comment: t.comment ? resolve(t.comment) : undefined,
    columns: t.columns.map((c) => ({
      key: c.key,
      name: colName.get(`${t.key}.${c.key}`)!,
      type: c.type,
      notNull: c.notNull ?? false,
      default: c.default,
      pk: c.pk ?? false,
      unique: c.unique ?? false,
      comment: c.comment ? resolve(c.comment) : undefined,
    })),
    fks: (t.fks ?? []).map((fk) => ({
      name: mangler.name('constraint', 'con', `core:${t.key}:${fk.columnKey}`),
      column: colName.get(`${t.key}.${fk.columnKey}`)!,
      refTable: tableName.get(fk.refTableKey)!,
      refColumn: colName.get(`${fk.refTableKey}.${fk.refColumnKey}`)!,
      comment: fk.comment ? resolve(fk.comment) : undefined,
    })),
  }));

  const views: ResolvedView[] = CORE_VIEWS.map((v) => ({
    key: v.key,
    name: viewName.get(v.key)!,
    definition: resolve(v.definition),
    comment: v.comment ? resolve(v.comment) : undefined,
  }));

  // 4. Seed statements (reference rows by natural keys).
  const col = (tableKey: string, colKey: string): string => colName.get(`${tableKey}.${colKey}`)!;
  const tbl = (tableKey: string): string => tableName.get(tableKey)!;
  const lit = (v: string): string => `'${v.replace(/'/g, "''")}'`;
  const bool = (b: boolean): string => (b ? 'true' : 'false');
  const numOrNull = (n: number | null): string => (n === null ? 'NULL' : String(n));

  const seedStatements: string[] = [];

  for (const c of CUSTOMERS) {
    seedStatements.push(
      `INSERT INTO ${tbl('customer')} (${col('customer', 'full_name')}, ${col('customer', 'email')}, ${col('customer', 'country')}, ${col('customer', 'removed')}) ` +
        `VALUES (${lit(c.full_name)}, ${lit(c.email)}, ${lit(c.country)}, ${c.removed ? 'now()' : 'NULL'});`,
    );
  }
  for (const p of PRODUCTS) {
    seedStatements.push(
      `INSERT INTO ${tbl('product')} (${col('product', 'sku')}, ${col('product', 'name')}, ${col('product', 'list_price')}, ${col('product', 'active')}, ${col('product', 'removed')}) ` +
        `VALUES (${lit(p.sku)}, ${lit(p.name)}, ${p.list_price}, ${bool(p.active)}, ${p.removed ? 'now()' : 'NULL'});`,
    );
  }
  for (const o of ORDERS) {
    seedStatements.push(
      `INSERT INTO ${tbl('order')} (${col('order', 'code')}, ${col('order', 'customer_id')}, ${col('order', 'status')}, ${col('order', 'is_test')}, ${col('order', 'amount_total')}, ${col('order', 'channel')}) ` +
        `SELECT ${lit(o.code)}, c.${col('customer', 'id')}, ${lit(o.status)}, ${bool(o.is_test)}, ${numOrNull(o.amount_total)}, ${lit(o.channel)} ` +
        `FROM ${tbl('customer')} c WHERE c.${col('customer', 'email')} = ${lit(o.email)};`,
    );
  }
  for (const it of ITEMS) {
    seedStatements.push(
      `INSERT INTO ${tbl('order_item')} (${col('order_item', 'order_id')}, ${col('order_item', 'product_id')}, ${col('order_item', 'quantity')}, ${col('order_item', 'unit_price')}, ${col('order_item', 'discount')}) ` +
        `SELECT o.${col('order', 'id')}, p.${col('product', 'id')}, ${it.quantity}, ${it.unit_price}, ${it.discount} ` +
        `FROM ${tbl('order')} o, ${tbl('product')} p WHERE o.${col('order', 'code')} = ${lit(it.code)} AND p.${col('product', 'sku')} = ${lit(it.sku)};`,
    );
  }

  return { tables, views, seedStatements, legend };
}
