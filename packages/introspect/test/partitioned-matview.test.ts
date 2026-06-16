import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
import { introspect } from '../src/index.js';
import { setupDatabase, type DatabaseHandle } from '@kozou/test-utils';

// Declarative partitioned parent tables (relkind 'p') and materialized views
// (relkind 'm') used to be hard-filtered out of introspection (#160). The
// parent should appear as a normal table (its leaf partitions stay hidden), and
// a materialized view should appear as a read-only view.
const FIXTURE_SQL = `
  CREATE TABLE events (
    tenant_id uuid NOT NULL,
    occurred_at timestamptz NOT NULL,
    payload text,
    PRIMARY KEY (tenant_id, occurred_at)
  ) PARTITION BY RANGE (occurred_at);

  CREATE TABLE events_2026 PARTITION OF events
    FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');

  -- A plain table for contrast, and a materialized view over it.
  CREATE TABLE widgets (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE MATERIALIZED VIEW widget_names AS SELECT id, name FROM widgets;
`;

describe('introspect: partitioned tables + materialized views (#160)', () => {
  let db: DatabaseHandle;
  // A role name derived from the per-run schema, so it cannot collide with
  // other test files in the shared CI cluster (roles are cluster-global).
  let readerRole: string;

  beforeAll(async () => {
    db = await setupDatabase();
    readerRole = `${db.schema}_reader`;
    const client = new pkg.Client({ connectionString: db.connectionString });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${db.schema}"`);
      await client.query(`SET search_path TO "${db.schema}"`);
      await client.query(FIXTURE_SQL);
      // A role with no grant on the partitioned parent, to exercise
      // privilege-aware introspection (#99) over a relkind 'p' relation.
      await client.query(`CREATE ROLE "${readerRole}" NOLOGIN`);
    } finally {
      await client.end();
    }
  }, 120_000);

  afterAll(async () => {
    if (db) await db.cleanup();
  });

  const run = () => introspect({ connection: db.connectionString, schemas: [db.schema] });

  it('surfaces the partitioned parent but not its leaf partition', async () => {
    const r = await run();
    const names = r.tables.map((t) => t.name).sort();
    expect(names).toContain('events'); // the declarative parent (relkind 'p')
    expect(names).toContain('widgets'); // an ordinary table
    expect(names).not.toContain('events_2026'); // the leaf partition stays hidden
  });

  it('captures the partitioned parent’s columns and (composite) primary key', async () => {
    const r = await run();
    const events = r.tables.find((t) => t.name === 'events')!;
    expect(events.columns.map((c) => c.name).sort()).toEqual([
      'occurred_at',
      'payload',
      'tenant_id',
    ]);
    expect(events.primaryKey).toEqual(['tenant_id', 'occurred_at']);
  });

  it('surfaces a materialized view as a read-only view with its columns', async () => {
    const r = await run();
    const names = r.views.map((v) => v.name);
    expect(names).toContain('widget_names');
    const mv = r.views.find((v) => v.name === 'widget_names')!;
    expect(mv.columns.map((c) => c.name).sort()).toEqual(['id', 'name']);
    // The defining query is resolved (so the matview is not an opaque relation).
    expect(mv.definition).toMatch(/widgets/);
    // Its underlying table is attributed via the dependency query.
    expect(mv.underlyingTables.map((t) => t.name)).toContain('widgets');
  });

  it('evaluates privileges on a partitioned parent in privilege-aware mode (#99)', async () => {
    const r = await introspect({
      connection: db.connectionString,
      schemas: [db.schema],
      privilegeRole: readerRole,
    });
    const events = r.tables.find((t) => t.name === 'events')!;
    // Without extending the privilege queries to relkind 'p', this would be
    // `undefined` — the parent would bypass the privilege gate. The role has no
    // grant, so it reads as not-selectable (and not writable).
    expect(events.privileges).toMatchObject({ select: false, insert: false, update: false });
  });
});
