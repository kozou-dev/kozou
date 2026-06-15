# Kozou quickstart demo

Point an AI agent at a real business database and ask it a simple question —
*"what was our revenue last quarter?"* — and it will confidently give you the
**wrong number**. Not because the model is weak, but because the answer isn't in
the schema's column types. It's in the business rules around them: which column
is authoritative, what a status really means, which rows don't count.

This demo makes that gap concrete, and shows how Kozou closes it. It's a small
online-store schema (`customers` / `products` / `orders` / `order_items` + three
reporting views) where the obvious revenue query is off by **4.8×** — and an
agent with Kozou's context gets it right.

## The punchline

The schema has six paid-looking orders. Ask for total revenue:

| Query an agent writes from… | Result | Why |
| --- | --- | --- |
| …the raw DDL — the obvious column (`sum(amount_total)` over paid orders) | **575.00** ❌ | `amount_total` is a deprecated stale cache |
| …the raw DDL — recompute from `products.list_price` | **580.00** ❌ | values old orders at *today's* catalog price |
| …the raw DDL — sum line items at the captured `unit_price` | **560.00** ❌ | the careful answer — and still wrong |
| …Kozou's context (`sum(net_revenue)` from `vw_recognized_revenue`) | **120.00** ✅ | the view encapsulates every recognition rule |

All three wrong answers share one irreducible error that **no choice of amount
column fixes**: a $400 internal **test** order and two rows that should be
**excluded** (one soft-deleted order, and one order belonging to a soft-deleted
customer) are counted as revenue.
Those facts are nowhere in the DDL — they live in `COMMENT ON` text, which Kozou
hands to the agent. (The `amount_total` and `list_price` variants *also* misvalue
the three real orders on top of that; the captured-`unit_price` answer gets the
per-line amounts right and is still wrong.)

Every number above is real — reproduce them at the bottom of this file.

## Run it (under 10 minutes)

Requires Docker. From this directory:

```bash
cp .env.example .env
docker compose up
```

That brings up PostgreSQL (initialized with [`schema.sql`](schema.sql)) and
`kozou dev` — the bundled Admin UI plus an MCP server, both pointed at the
database. Then:

- **Admin UI:** <http://localhost:3333>
- **MCP endpoint (HTTP):** <http://localhost:3334/mcp>

## Point an AI agent at it

Configure your MCP client (Claude Code, Claude Desktop, Cursor, …) to connect to
the MCP server, then ask it about revenue, active products, or customer value.

- **HTTP transport** (the stack above): point the client at
  `http://localhost:3334/mcp`.
- **stdio transport** (no stack needed — the client launches Kozou itself):

  ```bash
  DATABASE_URL=postgres://kozou:kozou@localhost:5432/kozou npx -p kozou kozou mcp --stdio
  ```

See <https://kozou.org> for client-specific MCP setup.

## Why the obvious query is wrong

Run `\d orders` and a capable agent sees this and reaches for the obvious column:

```text
 amount_total | numeric(12,2)            |   -- looks like the order total
 status       | text                     |   -- 'paid' must mean a sale
 is_test      | boolean                  |   -- no DDL signal it must be excluded
```

Nothing in the DDL says `amount_total` is abandoned, that test orders are mixed
in, or that prices must come from the line items. That knowledge lives in
people's heads — or, here, in `COMMENT ON` text that Kozou compiles and hands to
the agent over MCP. The same `describe_table("public.orders")` call returns,
per column (abridged here to the relevant fields — the real output also carries
`nullable`, `defaultExpr`, `isForeignKey`, `references`, …):

```jsonc
{
  "name": "amount_total",
  "dataType": "numeric(12,2)",
  "aiDescription": "Do NOT use this for reporting — it is a stale cache the application stopped maintaining, can disagree with the line items, and includes test orders. Compute revenue from vw_recognized_revenue instead."
},
{
  "name": "is_test",
  "aiDescription": "ALWAYS exclude is_test = true from revenue, order counts, and dashboards — these are not real customer orders."
},
{
  "name": "status",
  "enumValues": ["cart", "pending", "paid", "refunded", "chargeback"],
  "aiDescription": "Only 'paid' is a captured sale; 'cart' and 'pending' are not sales yet; 'refunded' and 'chargeback' reverse a prior sale."
}
```

…and on the table itself (again abridged), a policy and a pointer to the
authoritative view:

```jsonc
{
  "qualifiedName": "public.orders",
  "aiDescription": "An order is recognized revenue only when status = 'paid' AND is_test = false AND deleted_at IS NULL ...; value each line at order_items.unit_price (the captured price), not products.list_price.\nThe vw_recognized_revenue view already applies every one of these rules — start there for any revenue question.",
  "policy": ["'refunded' and 'chargeback' reverse a sale; never count them as revenue."]
}
```

With that context the agent stops re-deriving business rules and uses the view
that encapsulates them. Same model, same question — a correct answer instead of
a plausible wrong one.

## Reproduce the numbers

```bash
docker compose exec postgres psql -U kozou -d kozou
```

```sql
-- Correct: the view encapsulates every recognition rule
SELECT sum(net_revenue) FROM vw_recognized_revenue;            -- 120.00

-- Wrong: the "obvious" column, over paid orders
SELECT sum(amount_total) FROM orders WHERE status = 'paid';    -- 575.00

-- Wrong: recompute from the CURRENT catalog price
SELECT sum(oi.quantity * p.list_price - oi.discount)
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
JOIN products p ON p.id = oi.product_id
WHERE o.status = 'paid';                                        -- 580.00

-- Wrong: the "careful" answer — line items at the captured price, but still
-- blind to the test order and the soft-deleted rows
SELECT sum(oi.quantity * oi.unit_price - oi.discount)
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
WHERE o.status = 'paid';                                        -- 560.00
```

## What's in the schema

[`schema.sql`](schema.sql) is heavily commented; the traps it encodes are all
things a `\d` dump cannot tell you:

- `orders.amount_total` — a **deprecated** denormalized cache (stale; includes test orders).
- `orders.is_test` — internal QA / load-test orders that must be excluded everywhere.
- `orders.status` — only `paid` is a sale; `refunded` / `chargeback` reverse one.
- `order_items.unit_price` vs `products.list_price` — value history at the **captured** price, never the current one.
- soft-delete (`deleted_at`) on customers, products, and orders.
- three views (`vw_recognized_revenue`, `vw_active_products`, `vw_customer_lifetime_value`) as the "faithful, named concepts" an agent should prefer.

## License

Apache-2.0.
