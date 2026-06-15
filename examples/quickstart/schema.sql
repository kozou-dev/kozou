-- Quickstart demo schema for Kozou.
--
-- A small, realistic online-store domain (customers / products / orders /
-- order_items + three reporting views). It is deliberately full of business
-- semantics that a plain `\d` / DDL dump does NOT reveal — the kind of
-- knowledge that normally lives in a data dictionary, a tribal-knowledge wiki,
-- or someone's head:
--
--   * orders.amount_total is a DEPRECATED denormalized cache (stale; includes
--     test orders) — the obvious column to sum, and the wrong one.
--   * is_test orders must be excluded from every revenue number.
--   * only 'paid' orders are sales; 'refunded' / 'chargeback' reverse them.
--   * historical revenue must use the price CAPTURED on the line
--     (order_items.unit_price), never the CURRENT products.list_price.
--   * soft-deleted rows (deleted_at IS NOT NULL) must be excluded.
--
-- All of that is encoded as COMMENT ON ... text with @ai / @policy / @example
-- tags, so Kozou hands it verbatim to an AI agent over MCP. Point an agent at
-- the raw DDL and it confidently writes the wrong revenue query; point it at
-- Kozou's context and it writes the right one. See README.md for the
-- side-by-side.
--
-- Note: @ai / @policy notes are kept to a single line each (use several @ai
-- lines for several points). Only @example blocks span multiple lines.

-- ---------------------------------------------------------------------------
-- A read-only reporting role: it can SELECT every table and view but cannot
-- write — a realistic non-owner role for the kind of reporting an agent runs.
-- Enforcement of who-can-do-what always stays in PostgreSQL (GRANTs and RLS).
-- ---------------------------------------------------------------------------
CREATE ROLE analyst NOLOGIN;
GRANT USAGE ON SCHEMA public TO analyst;

-- ---------------------------------------------------------------------------
-- Tables.
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  email text NOT NULL UNIQUE,
  country text,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
COMMENT ON TABLE customers IS 'People who place orders.
@ai: Rows with deleted_at IS NOT NULL are soft-deleted (kept for audit / legal retention); exclude them from customer-facing queries, counts, and metrics.
@policy: Treat email as personal data; do not expose it in aggregate or public reports.';
COMMENT ON COLUMN customers.email IS 'Login / contact email (unique).';
COMMENT ON COLUMN customers.deleted_at IS 'Soft-delete timestamp; NULL means active.';

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text NOT NULL UNIQUE,
  name text NOT NULL,
  list_price numeric(12, 2) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz
);
COMMENT ON TABLE products IS 'Catalog of sellable products.
@ai: is_active = false means delisted (not purchasable) but kept so historical orders still resolve; exclude deleted_at IS NOT NULL rows entirely.';
COMMENT ON COLUMN products.list_price IS 'The CURRENT catalog price.
@ai: This price changes over time. NEVER use it to value past orders — each order captured its own price in order_items.unit_price; joining list_price onto historical orders silently misprices revenue.';
COMMENT ON COLUMN products.is_active IS 'Whether the product is currently sellable.
@widget: boolean';

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  placed_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'cart'
    CHECK (status IN ('cart', 'pending', 'paid', 'refunded', 'chargeback')),
  channel text NOT NULL DEFAULT 'web'
    CHECK (channel IN ('web', 'retail', 'wholesale')),
  is_test boolean NOT NULL DEFAULT false,
  amount_total numeric(12, 2),
  deleted_at timestamptz
);
COMMENT ON TABLE orders IS 'Customer orders.
@ai: An order is recognized revenue only when status = ''paid'' AND is_test = false AND deleted_at IS NULL and its customer is not soft-deleted; value each line at order_items.unit_price (the captured price), not products.list_price.
@ai: The vw_recognized_revenue view already applies every one of these rules — start there for any revenue question.
@policy: ''refunded'' and ''chargeback'' reverse a sale; never count them as revenue.';
COMMENT ON COLUMN orders.status IS 'Lifecycle state of the order.
@ai: Only ''paid'' is a captured sale; ''cart'' and ''pending'' are not sales yet; ''refunded'' and ''chargeback'' reverse a prior sale.
@widget: enum-select';
COMMENT ON COLUMN orders.is_test IS 'Internal QA / load-test order flag.
@ai: ALWAYS exclude is_test = true from revenue, order counts, and dashboards — these are not real customer orders.';
COMMENT ON COLUMN orders.channel IS 'Sales channel the order came through.
@widget: enum-select';
COMMENT ON COLUMN orders.amount_total IS 'DEPRECATED denormalized order total.
@ai: Do NOT use this for reporting — it is a stale cache the application stopped maintaining, can disagree with the line items, and includes test orders. Compute revenue from vw_recognized_revenue instead.';

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  product_id uuid NOT NULL REFERENCES products(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(12, 2) NOT NULL,
  discount numeric(12, 2) NOT NULL DEFAULT 0
);
COMMENT ON TABLE order_items IS 'Line items within an order.';
COMMENT ON COLUMN order_items.unit_price IS 'Per-unit price CAPTURED when the order was placed.
@ai: Use this for revenue, never products.list_price (the current catalog price, which drifts over time). Net line revenue = quantity * unit_price - discount.
@widget: currency';
COMMENT ON COLUMN order_items.discount IS 'Absolute discount applied to this line.
@widget: currency';

-- ---------------------------------------------------------------------------
-- Reporting views — the "faithful, named concepts" an agent should prefer
-- over re-deriving business rules from base tables.
-- ---------------------------------------------------------------------------

-- The authoritative revenue source. Encapsulates every recognition rule so no
-- caller has to remember them.
CREATE VIEW vw_recognized_revenue AS
  SELECT
    o.id          AS order_id,
    o.customer_id,
    o.placed_at,
    o.channel,
    sum(oi.quantity * oi.unit_price - oi.discount) AS net_revenue
  FROM orders o
  JOIN customers c ON c.id = o.customer_id AND c.deleted_at IS NULL
  JOIN order_items oi ON oi.order_id = o.id
  WHERE o.status = 'paid'
    AND o.is_test = false
    AND o.deleted_at IS NULL
  GROUP BY o.id, o.customer_id, o.placed_at, o.channel;
COMMENT ON VIEW vw_recognized_revenue IS 'Authoritative recognized revenue, one row per paid order.
@ai: This is the source of truth for revenue — it already excludes test orders, soft-deleted orders and customers, and non-paid statuses, and values each line at the captured unit_price minus discount. Start here for any revenue / sales question; do not re-derive from orders.amount_total or products.list_price.
@example: Revenue by quarter.
  SELECT date_trunc(''quarter'', placed_at) AS quarter,
         sum(net_revenue) AS revenue
  FROM vw_recognized_revenue
  GROUP BY 1
  ORDER BY 1;';

-- "Active product" has a precise meaning that the column names only hint at.
CREATE VIEW vw_active_products AS
  SELECT id, sku, name, list_price
  FROM products
  WHERE is_active = true
    AND deleted_at IS NULL;
COMMENT ON VIEW vw_active_products IS 'Products that are currently sellable.
@ai: "Active" means is_active = true AND not soft-deleted; use this view rather than filtering products ad hoc, so delisted and deleted products stay out.';

-- Composition: lifetime value is built on the revenue rules above, not redefined.
CREATE VIEW vw_customer_lifetime_value AS
  SELECT
    c.id        AS customer_id,
    c.full_name,
    coalesce(sum(r.net_revenue), 0) AS lifetime_revenue
  FROM customers c
  LEFT JOIN vw_recognized_revenue r ON r.customer_id = c.id
  WHERE c.deleted_at IS NULL
  GROUP BY c.id, c.full_name;
COMMENT ON VIEW vw_customer_lifetime_value IS 'Total recognized revenue per active customer.
@ai: Lifetime value reuses vw_recognized_revenue, so the same recognition rules apply automatically; soft-deleted customers are excluded.';

-- ---------------------------------------------------------------------------
-- Seed data. Numbers are chosen so the "obvious" revenue query and the correct
-- one disagree loudly (see README.md). Recognized revenue is 120.00; summing
-- orders.amount_total over paid orders gives 575.00; recomputing from the
-- current list_price over paid orders gives 580.00.
-- ---------------------------------------------------------------------------
INSERT INTO customers (id, full_name, email, country, created_at, deleted_at) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'Alice Martin', 'alice@example.com', 'US', '2024-09-01T10:00:00Z', NULL),
  ('00000000-0000-0000-0000-0000000000c2', 'Bob Nguyen',   'bob@example.com',   'US', '2024-09-02T10:00:00Z', NULL),
  ('00000000-0000-0000-0000-0000000000c3', 'Carol Diaz',   'carol@example.com', 'CA', '2024-09-03T10:00:00Z', NULL),
  ('00000000-0000-0000-0000-0000000000c4', 'Dave Olsen',   'dave@example.com',  'CA', '2024-09-04T10:00:00Z', '2024-10-15T10:00:00Z');

-- Note: Widget's captured price below (20.00) is LESS than its current
-- list_price (25.00) — valuing past orders at list_price overstates revenue.
INSERT INTO products (id, sku, name, list_price, is_active, deleted_at) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'WID-001', 'Widget',    25.00, true,  NULL),
  ('00000000-0000-0000-0000-0000000000a2', 'GAD-001', 'Gadget',    40.00, true,  NULL),
  ('00000000-0000-0000-0000-0000000000a3', 'GIZ-001', 'Gizmo',     15.00, false, NULL),
  ('00000000-0000-0000-0000-0000000000a4', 'DOO-001', 'Doohickey', 99.00, true,  '2024-08-01T10:00:00Z');

-- id, customer, placed_at, status, channel, is_test, amount_total (stale cache), deleted_at
INSERT INTO orders (id, customer_id, placed_at, status, channel, is_test, amount_total, deleted_at) VALUES
  -- Real, recognized sales (paid, not test, not deleted, live customer):
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000c1', '2024-11-05T12:00:00Z', 'paid',       'web',    false,  50.00, NULL),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000c2', '2024-11-06T12:00:00Z', 'paid',       'web',    false,  40.00, NULL),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000c3', '2024-11-07T12:00:00Z', 'paid',       'retail', false,  45.00, NULL),
  -- Reversals — must NOT count as revenue:
  ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000c1', '2024-11-08T12:00:00Z', 'refunded',   'web',    false,  40.00, NULL),
  ('00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-0000000000c2', '2024-11-09T12:00:00Z', 'chargeback', 'web',    false,  25.00, NULL),
  -- Not sales yet:
  ('00000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000c3', '2024-11-10T12:00:00Z', 'pending',    'web',    false,  25.00, NULL),
  ('00000000-0000-0000-0000-0000000000f7', '00000000-0000-0000-0000-0000000000c1', '2024-11-11T12:00:00Z', 'cart',       'web',    false,  80.00, NULL),
  -- Internal test order (paid!) — the big trap: 400.00 of fake revenue:
  ('00000000-0000-0000-0000-0000000000f8', '00000000-0000-0000-0000-0000000000c2', '2024-11-12T12:00:00Z', 'paid',       'web',    true,  400.00, NULL),
  -- Soft-deleted paid order:
  ('00000000-0000-0000-0000-0000000000f9', '00000000-0000-0000-0000-0000000000c3', '2024-11-13T12:00:00Z', 'paid',       'web',    false,  20.00, '2024-11-20T10:00:00Z'),
  -- Paid order belonging to a soft-deleted customer:
  ('00000000-0000-0000-0000-0000000000fa', '00000000-0000-0000-0000-0000000000c4', '2024-11-14T12:00:00Z', 'paid',       'web',    false,  20.00, NULL);

-- Net line revenue = quantity * unit_price - discount.
INSERT INTO order_items (order_id, product_id, quantity, unit_price, discount) VALUES
  -- f1 (paid): 2 x Widget @ 20.00 captured (current list 25.00) = 40.00
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 2, 20.00, 0.00),
  -- f2 (paid): 1 x Gadget @ 40.00, 5.00 discount = 35.00
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a2', 1, 40.00, 5.00),
  -- f3 (paid): 3 x Gizmo @ 15.00 = 45.00
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000a3', 3, 15.00, 0.00),
  -- f4 (refunded): would be 40.00, excluded by status
  ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000a2', 1, 40.00, 0.00),
  -- f5 (chargeback): excluded by status
  ('00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-0000000000a1', 1, 25.00, 0.00),
  -- f6 (pending): excluded by status
  ('00000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000a1', 1, 25.00, 0.00),
  -- f7 (cart): excluded by status
  ('00000000-0000-0000-0000-0000000000f7', '00000000-0000-0000-0000-0000000000a2', 2, 40.00, 0.00),
  -- f8 (paid, TEST): 10 x Gadget @ 40.00 = 400.00, excluded by is_test
  ('00000000-0000-0000-0000-0000000000f8', '00000000-0000-0000-0000-0000000000a2', 10, 40.00, 0.00),
  -- f9 (paid, soft-deleted order): excluded by deleted_at
  ('00000000-0000-0000-0000-0000000000f9', '00000000-0000-0000-0000-0000000000a1', 1, 20.00, 0.00),
  -- fa (paid, deleted customer): excluded by customer deleted_at
  ('00000000-0000-0000-0000-0000000000fa', '00000000-0000-0000-0000-0000000000a1', 1, 20.00, 0.00);

-- ---------------------------------------------------------------------------
-- Grant the read-only role SELECT on everything (tables + views), last, so it
-- can see the seeded rows. No INSERT / UPDATE / DELETE is granted.
-- ---------------------------------------------------------------------------
GRANT SELECT ON ALL TABLES IN SCHEMA public TO analyst;
