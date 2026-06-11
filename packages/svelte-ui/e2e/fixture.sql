-- E2E test fixture for @kozou/svelte-ui Playwright suite.
--
-- Mirrors the generic English schema used by the @kozou/introspect unit
-- tests (authors / books / editions / inventory_items + the
-- vw_inventory_for_sale view) so the E2E suite exercises a realistic
-- schema-with-COMMENTs surface end-to-end. Tracks Kozou v0.1 design spec
-- §10.2 (sample schema shape) and §11 (comparison demo shape).
--
-- The fixture also seeds three authors / books / editions and three
-- inventory items in distinct states (for_sale, for_sale, reserved) so
-- the Playwright suite can assert both rendering of seed rows and the
-- filtering behaviour of the `for_sale + public` view.

-- ---------------------------------------------------------------------------
-- PostgREST anonymous role.
-- ---------------------------------------------------------------------------
-- v0.1 wires PostgREST without auth (dev_spec §1.3, §7.1). The anonymous
-- role gets full CRUD on the fixture tables so the Admin UI can exercise
-- the read + write paths.
CREATE ROLE web_anon NOLOGIN;
GRANT USAGE ON SCHEMA public TO web_anon;

-- ---------------------------------------------------------------------------
-- Tables.
-- ---------------------------------------------------------------------------
CREATE TABLE authors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  deleted_at timestamptz
);
COMMENT ON TABLE authors IS 'Authors of books.';
COMMENT ON COLUMN authors.display_name IS 'Display name of the author.';

CREATE TABLE books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES authors(id),
  title text NOT NULL,
  deleted_at timestamptz
);
COMMENT ON TABLE books IS 'Books authored by an author.';
COMMENT ON COLUMN books.author_id IS 'Reference to the author.';

CREATE TABLE editions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES books(id),
  isbn text UNIQUE,
  deleted_at timestamptz
);
COMMENT ON TABLE editions IS 'Editions of a book.';

CREATE TABLE inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id uuid NOT NULL REFERENCES editions(id),
  status text NOT NULL CHECK (status IN ('for_sale', 'reserved', 'sold')),
  selling_price numeric(12, 2),
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  deleted_at timestamptz
);
COMMENT ON TABLE inventory_items IS 'Inventory items available for sale.
@ai: prefer vw_inventory_for_sale when querying active stock.';
COMMENT ON COLUMN inventory_items.status IS 'Current state of the item.
@widget: enum-select';
COMMENT ON COLUMN inventory_items.selling_price IS 'Actual selling price.
@widget: currency';

-- A composite-primary-key table so the suite can exercise item-by-id CRUD
-- across both adapters (Kozou v1.0 dev spec §3.6 / §3.7). Integer key
-- columns keep the browser CRUD loop's form values easy to type.
CREATE TABLE order_lines (
  order_id integer NOT NULL,
  line_no integer NOT NULL,
  product text NOT NULL,
  qty integer NOT NULL,
  PRIMARY KEY (order_id, line_no)
);
COMMENT ON TABLE order_lines IS 'Line items on an order (composite primary key).';

-- A composite-key target with a text display column ("name" satisfies the
-- displayField heuristic), plus a child whose composite FOREIGN KEY points at
-- it, so the suite can exercise the composite relation picker (Kozou v1.0 dev
-- spec §5.2 Stage 2b) and the composite detail-page label.
CREATE TABLE warehouse_bins (
  aisle integer NOT NULL,
  shelf integer NOT NULL,
  name text NOT NULL,
  PRIMARY KEY (aisle, shelf)
);
COMMENT ON TABLE warehouse_bins IS 'Warehouse storage bins (composite primary key).';

CREATE TABLE bin_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aisle integer NOT NULL,
  shelf integer NOT NULL,
  note text,
  FOREIGN KEY (aisle, shelf) REFERENCES warehouse_bins (aisle, shelf)
);
COMMENT ON TABLE bin_assignments IS 'Assignments of stock to a warehouse bin (composite foreign key).';

CREATE VIEW vw_inventory_for_sale AS
  SELECT i.id, i.edition_id, i.selling_price, e.book_id, b.title AS book_title, b.author_id, a.display_name AS author_name
  FROM inventory_items i
  JOIN editions e ON e.id = i.edition_id AND e.deleted_at IS NULL
  JOIN books b ON b.id = e.book_id AND b.deleted_at IS NULL
  JOIN authors a ON a.id = b.author_id AND a.deleted_at IS NULL
  WHERE i.status = 'for_sale' AND i.deleted_at IS NULL AND i.visibility = 'public';
COMMENT ON VIEW vw_inventory_for_sale IS 'Inventory items currently available for sale.
@ai: start from this VIEW for stock-related queries; no need to re-JOIN.';

-- ---------------------------------------------------------------------------
-- Seed rows so the Playwright suite has data to render. UUIDs are stable
-- (deterministic) so assertions can refer to them when needed.
-- ---------------------------------------------------------------------------
INSERT INTO authors (id, display_name) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Margaret Atwood'),
  ('00000000-0000-0000-0000-000000000002', 'Ursula K. Le Guin'),
  ('00000000-0000-0000-0000-000000000003', 'Octavia Butler');

INSERT INTO books (id, author_id, title) VALUES
  ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', 'The Handmaid''s Tale'),
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000002', 'The Left Hand of Darkness'),
  ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000003', 'Kindred');

INSERT INTO editions (id, book_id, isbn) VALUES
  ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000010', '978-0385490818'),
  ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000011', '978-0441478125'),
  ('00000000-0000-0000-0000-000000000022', '00000000-0000-0000-0000-000000000012', '978-0807083697');

INSERT INTO inventory_items (id, edition_id, status, selling_price, visibility) VALUES
  ('00000000-0000-0000-0000-000000000030', '00000000-0000-0000-0000-000000000020', 'for_sale', 15.99, 'public'),
  ('00000000-0000-0000-0000-000000000031', '00000000-0000-0000-0000-000000000021', 'for_sale', 12.50, 'public'),
  ('00000000-0000-0000-0000-000000000032', '00000000-0000-0000-0000-000000000022', 'reserved', 18.00, 'public');

INSERT INTO order_lines (order_id, line_no, product, qty) VALUES
  (100, 1, 'Widget', 3),
  (100, 2, 'Gadget', 5),
  (200, 1, 'Sprocket', 2);

INSERT INTO warehouse_bins (aisle, shelf, name) VALUES
  (1, 1, 'Bin A1-S1'),
  (1, 2, 'Bin A1-S2'),
  (2, 1, 'Bin A2-S1');

-- A stable assignment so the no-JS (native form) spec can edit a known row.
INSERT INTO bin_assignments (id, aisle, shelf, note) VALUES
  ('00000000-0000-0000-0000-000000000040', 1, 1, 'Seeded assignment');

-- ---------------------------------------------------------------------------
-- Grants required for the PostgREST anonymous role to read + write.
-- Granted last so the role can see the seeded rows (default-deny on PG).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO web_anon;
GRANT SELECT ON vw_inventory_for_sale TO web_anon;
