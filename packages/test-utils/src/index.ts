// Internal test helpers shared across the @kozou package test suites.
//
// PRIVATE package — never published (see package.json "private": true).
// Consumed only by other packages' test files via vitest, which transpiles
// the TypeScript source directly, so this package ships no build step.
//
// Consolidates what used to be copy-pasted into each package's
// test/setup.ts plus the inline SQL fixtures duplicated across the
// introspect / mcp suites (Kozou v0.1 design spec §16.1.1 B, Codex 3rd
// pass N1).

import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

export type DatabaseHandle = {
  connectionString: string;
  /** Unique schema name for the test suite; fixtures are created under it. */
  schema: string;
  cleanup: () => Promise<void>;
};

/**
 * Spin up a throwaway PostgreSQL for an integration test suite.
 *
 * Honors `KOZOU_TEST_DATABASE_URL` (CI / shared DB): when set, reuses that
 * server and only drops the generated schema on cleanup. Otherwise starts a
 * `postgres:16` testcontainer and stops it on cleanup. The schema name is
 * randomized so concurrent suites against a shared server never collide.
 */
export async function setupDatabase(): Promise<DatabaseHandle> {
  const schema = `kozou_test_${randomBytes(4).toString('hex')}`;

  const envUrl = process.env.KOZOU_TEST_DATABASE_URL;
  if (envUrl) {
    return {
      connectionString: envUrl,
      schema,
      cleanup: async () => {
        const { default: pkg } = await import('pg');
        const c = new pkg.Client({ connectionString: envUrl });
        await c.connect();
        try {
          await c.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally {
          await c.end();
        }
      },
    };
  }

  const container = await new PostgreSqlContainer('postgres:16').start();
  return {
    connectionString: container.getConnectionUri(),
    schema,
    cleanup: async () => {
      await container.stop();
    },
  };
}

/**
 * Minimal two-table fixture (authors + books) for suites that only need a
 * couple of related tables — e.g. cache TTL/invalidate behaviour and the
 * MCP-over-HTTP round trip. Create it under a fresh schema after a
 * `SET search_path`.
 */
export const MINIMAL_FIXTURE_SQL = `
CREATE TABLE authors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL
);
COMMENT ON TABLE authors IS 'Authors of books.';

CREATE TABLE books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES authors(id),
  title text NOT NULL
);
COMMENT ON TABLE books IS 'Books authored by an author.';
`;

/**
 * The generic English fixture (authors / books / editions / inventory_items
 * + the vw_inventory_for_sale view) used by the schema-introspection and MCP
 * tool suites. Carries representative COMMENT metadata: @ai / @widget tags
 * and an @example block on the view, so the suites exercise the full
 * COMMENT-parsing surface. Mirrors Kozou v0.1 design spec §10.2 / §11.
 */
export const GENERIC_FIXTURE_SQL = `
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

CREATE VIEW vw_inventory_for_sale AS
  SELECT i.id, i.edition_id, i.selling_price, e.book_id, b.title AS book_title, b.author_id, a.display_name AS author_name
  FROM inventory_items i
  JOIN editions e ON e.id = i.edition_id AND e.deleted_at IS NULL
  JOIN books b ON b.id = e.book_id AND b.deleted_at IS NULL
  JOIN authors a ON a.id = b.author_id AND a.deleted_at IS NULL
  WHERE i.status = 'for_sale' AND i.deleted_at IS NULL AND i.visibility = 'public';
COMMENT ON VIEW vw_inventory_for_sale IS 'Inventory items currently available for sale.
@ai: start from this VIEW for stock-related queries; no need to re-JOIN.
@example: Items currently for sale, by author
  SELECT author_name, book_title, selling_price
  FROM vw_inventory_for_sale
  ORDER BY author_name, book_title;';
`;
