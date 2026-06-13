import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
import { buildSchemaContext } from '@kozou/core';
import type { RawFunction } from '@kozou/core';
import type { RawEnum } from '@kozou/core';
import { introspect } from '../src/index.js';
import { setupDatabase, type DatabaseHandle } from '@kozou/test-utils';

// A fixture exercising every shape the RPC introspection must classify
// (RPC design §4). Created under the suite's schema after SET search_path, so
// unqualified type names (the enum) resolve there.
const FUNCTIONS_FIXTURE_SQL = `
  CREATE TYPE order_status AS ENUM ('pending', 'shipped');

  -- invoker, scalar return, named IN args incl. a default; PUBLIC EXECUTE revoked
  CREATE FUNCTION approve_order(order_id uuid, qty integer DEFAULT 1) RETURNS integer
    LANGUAGE sql AS $$ SELECT 1 $$;
  COMMENT ON FUNCTION approve_order(uuid, integer) IS 'Approve an order.
@expose: rpc';
  REVOKE EXECUTE ON FUNCTION approve_order(uuid, integer) FROM PUBLIC;

  -- invoker, void return, PUBLIC keeps EXECUTE (the CREATE FUNCTION default)
  CREATE FUNCTION touch(id uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;

  -- RETURNS TABLE -> setof with columns
  CREATE FUNCTION recent(n integer) RETURNS TABLE(id uuid, status order_status)
    LANGUAGE sql AS $$ SELECT gen_random_uuid(), 'pending'::order_status $$;

  -- SETOF scalar -> array of scalars (supported, no columns)
  CREATE FUNCTION ids(n integer) RETURNS SETOF integer
    LANGUAGE sql AS $$ SELECT generate_series(1, n) $$;

  -- SETOF record without a column definition list -> unmappable row shape
  CREATE FUNCTION manyrecords(n integer) RETURNS SETOF record
    LANGUAGE sql AS $$ SELECT i, i FROM generate_series(1, n) i $$;

  -- single-column RETURNS TABLE -> array of objects (named column kept),
  -- though pg collapses it to the scalar element type internally
  CREATE FUNCTION one_col(n integer) RETURNS TABLE(only_id uuid)
    LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;

  -- DOMAIN over a scalar -> scalar return
  CREATE DOMAIN positive AS integer CHECK (VALUE > 0);
  CREATE FUNCTION scaled() RETURNS positive LANGUAGE sql AS $$ SELECT 1::positive $$;

  -- DOMAIN over a composite -> composite return (resolved through the base type)
  CREATE TYPE point2d AS (x integer, y integer);
  CREATE DOMAIN pt_domain AS point2d;
  CREATE FUNCTION origin() RETURNS pt_domain LANGUAGE sql AS $$ SELECT ROW(0, 0)::pt_domain $$;

  -- definer with an owner-safe search_path (pg_catalog + trailing pg_temp)
  CREATE FUNCTION settle_safe(invoice_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT $$;

  -- definer whose search_path includes public (writable by a non-owner role) -> unsafe
  CREATE FUNCTION settle_public(invoice_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT $$;

  -- definer with no SET search_path
  CREATE FUNCTION settle_no_path(invoice_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER AS $$ SELECT $$;

  -- definer with a dynamic ($user) search_path element -> unresolvable -> unsafe
  CREATE FUNCTION settle_dynamic(invoice_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER SET search_path = "$user", pg_temp AS $$ SELECT $$;

  -- A definer endpoint should not keep the PUBLIC EXECUTE default; revoke it
  -- so the pipeline test isolates the search_path predicate from §6.1.
  REVOKE EXECUTE ON FUNCTION settle_safe(uuid) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION settle_public(uuid) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION settle_no_path(uuid) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION settle_dynamic(uuid) FROM PUBLIC;

  -- variadic
  CREATE FUNCTION tagit(VARIADIC tags text[]) RETURNS void LANGUAGE sql AS $$ SELECT $$;

  -- OUT args -> composite record return (unsupported in v1)
  CREATE FUNCTION split(IN x integer, OUT lo integer, OUT hi integer)
    LANGUAGE sql AS $$ SELECT 1, 2 $$;

  -- polymorphic
  CREATE FUNCTION idfn(val anyelement) RETURNS anyelement LANGUAGE sql AS $$ SELECT $1 $$;

  -- zero args
  CREATE FUNCTION noargs() RETURNS integer LANGUAGE sql AS $$ SELECT 42 $$;
`;

describe('introspect functions (RPC, issue #103)', () => {
  let db: DatabaseHandle;
  let functions: RawFunction[];
  let enums: RawEnum[];
  let owner: string;

  const byName = (name: string): RawFunction => {
    const fn = functions.find((f) => f.name === name);
    if (fn === undefined) throw new Error(`function ${name} not introspected`);
    return fn;
  };

  beforeAll(async () => {
    db = await setupDatabase();
    const client = new pkg.Client({ connectionString: db.connectionString });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${db.schema}"`);
      await client.query(`SET search_path TO "${db.schema}"`);
      await client.query(FUNCTIONS_FIXTURE_SQL);
      const r = await client.query<{ current_user: string }>('SELECT current_user');
      owner = r.rows[0]!.current_user;
    } finally {
      await client.end();
    }
    const raw = await introspect({ connection: db.connectionString, schemas: [db.schema] });
    functions = raw.functions;
    enums = raw.enums;
  }, 120_000);

  afterAll(async () => {
    if (db) await db.cleanup();
  });

  it('returns enum members as a real string[] (name[] is cast to text[])', () => {
    // Regression: array_agg over the `name`-typed enumlabel yields a name[] the
    // pg driver does not parse; the ::text cast makes it a proper JS array.
    const orderStatus = enums.find((e) => e.name === 'order_status');
    expect(orderStatus).toBeDefined();
    expect(Array.isArray(orderStatus!.values)).toBe(true);
    expect(orderStatus!.values).toEqual(['pending', 'shipped']);
  });

  it('introspects every ordinary function in the schema', () => {
    expect(functions.map((f) => f.name).sort()).toEqual([
      'approve_order',
      'idfn',
      'ids',
      'manyrecords',
      'noargs',
      'one_col',
      'origin',
      'recent',
      'scaled',
      'settle_dynamic',
      'settle_no_path',
      'settle_public',
      'settle_safe',
      'split',
      'tagit',
      'touch',
    ]);
  });

  it('reads named IN arguments, types, and DEFAULT', () => {
    const fn = byName('approve_order');
    expect(fn.arguments).toEqual([
      { name: 'order_id', typeName: 'uuid', udtName: 'uuid', typeOid: expect.any(Number), mode: 'in', hasDefault: false },
      { name: 'qty', typeName: 'integer', udtName: 'int4', typeOid: expect.any(Number), mode: 'in', hasDefault: true },
    ]);
    expect(fn.returns).toMatchObject({ kind: 'scalar', typeName: 'integer', returnsSet: false });
    expect(fn.volatility).toBe('volatile');
    expect(fn.security).toBe('invoker');
    expect(fn.owner.name).toBe(owner);
    expect(fn.argumentSignature).toContain('order_id uuid');
    expect(fn.comment).toContain('@expose: rpc');
  });

  it('detects PUBLIC EXECUTE: revoked vs the default grant', () => {
    expect(byName('approve_order').publicExecute).toBe(false); // revoked in fixture
    expect(byName('touch').publicExecute).toBe(true); // CREATE FUNCTION default
  });

  it('classifies void / setof(TABLE) / record returns', () => {
    expect(byName('touch').returns).toEqual({ kind: 'void', typeName: 'void', returnsSet: false });

    const recent = byName('recent').returns;
    expect(recent.kind).toBe('setof');
    expect(recent.returnsSet).toBe(true);
    expect(recent.columns?.map((c) => c.name)).toEqual(['id', 'status']);
    expect(recent.columns?.find((c) => c.name === 'status')?.typeName).toContain('order_status');

    // OUT args produce a composite record return, which v1 does not map.
    expect(byName('split').returns.kind).toBe('unsupported');

    // SETOF scalar is the array-of-scalars wire shape (supported, no columns).
    const ids = byName('ids').returns;
    expect(ids.kind).toBe('setof');
    expect(ids.columns).toBeUndefined();

    // SETOF record with no resolvable columns is unmappable -> unsupported,
    // so core does not expose a function with an unknown row shape.
    expect(byName('manyrecords').returns.kind).toBe('unsupported');

    // A single-column RETURNS TABLE keeps its named column (array of objects),
    // even though pg stores it as the scalar element type.
    const oneCol = byName('one_col').returns;
    expect(oneCol.kind).toBe('setof');
    expect(oneCol.columns?.map((c) => c.name)).toEqual(['only_id']);
  });

  it('resolves DOMAIN returns through their base type', () => {
    // Domain over a scalar -> scalar.
    expect(byName('scaled').returns.kind).toBe('scalar');
    // Domain over a composite -> composite, columns resolved from the base type.
    const origin = byName('origin').returns;
    expect(origin.kind).toBe('composite');
    expect(origin.columns?.map((c) => c.name)).toEqual(['x', 'y']);
  });

  it('marks variadic and polymorphic shapes (for the core loud-skip)', () => {
    expect(byName('tagit').arguments[0]).toMatchObject({ mode: 'variadic', name: 'tags' });
    expect(byName('idfn').arguments[0]!.udtName).toBe('anyelement');
    expect(byName('noargs').arguments).toEqual([]);
  });

  describe('SECURITY DEFINER search_path writability (§3.2)', () => {
    it('owner-only schema (pg_catalog) + trailing pg_temp is safe', () => {
      const sp = byName('settle_safe').searchPath;
      expect(sp).toEqual([
        { raw: 'pg_catalog', schema: 'pg_catalog', writableByOthers: false, isTemp: false },
        { raw: 'pg_temp', schema: null, writableByOthers: null, isTemp: true },
      ]);
      expect(byName('settle_safe').security).toBe('definer');
    });

    it('flags a search_path element writable by a non-owner role (public)', () => {
      const sp = byName('settle_public').searchPath!;
      const pub = sp.find((e) => e.schema === 'public');
      // public is owned by pg_database_owner, not the function owner -> unsafe.
      expect(pub?.writableByOthers).toBe(true);
    });

    it('reports no declared search_path as null', () => {
      expect(byName('settle_no_path').searchPath).toBeNull();
    });

    it('leaves a dynamic ($user) element unresolved (schema null), with a trailing pg_temp', () => {
      const sp = byName('settle_dynamic').searchPath!;
      expect(sp).toEqual([
        { raw: '$user', schema: null, writableByOthers: null, isTemp: false },
        { raw: 'pg_temp', schema: null, writableByOthers: null, isTemp: true },
      ]);
    });
  });

  // End-to-end: introspect -> core exposure decision. Proves the RawFunction
  // contract feeds buildFunctionContexts correctly against a real database.
  describe('pipeline into buildSchemaContext (exposure decision)', () => {
    it('exposes a tagged invoker with PUBLIC EXECUTE revoked', async () => {
      const raw = await introspect({ connection: db.connectionString, schemas: [db.schema] });
      const ctx = await buildSchemaContext({ raw });
      const exposed = (ctx.functions ?? []).map((f) => f.name);
      expect(exposed).toContain('approve_order');
    });

    it('honors the definer double opt-in + safe search_path against a real DB', async () => {
      const raw = await introspect({ connection: db.connectionString, schemas: [db.schema] });
      // Tag the two definer functions and authorize them; only the one with a
      // safe search_path should be exposed.
      for (const fn of raw.functions) {
        if (fn.name === 'settle_safe' || fn.name === 'settle_public') {
          fn.comment = '@expose: rpc';
        }
      }
      const qn = (n: string) => `${db.schema}.${n}`;
      const ctx = await buildSchemaContext({
        raw,
        rpc: { allowDefiner: [qn('settle_safe'), qn('settle_public')] },
      });
      const exposed = (ctx.functions ?? []).map((f) => f.name);
      expect(exposed).toContain('settle_safe');
      expect(exposed).not.toContain('settle_public'); // unsafe search_path (public)
    });
  });
});

// A non-superuser role that INHERITs a superuser role's CREATE grant can still
// create objects in a search_path schema. Writability must catch it: evaluating
// has_schema_privilege per non-superuser role (rather than dropping superuser
// grantees) sees the inherited grant. Roles are cluster-global, so names are
// derived from the random schema and dropped on teardown.
describe('introspect functions — inherited CREATE through a superuser role (§3.2)', () => {
  let db: DatabaseHandle;
  let su: string;
  let mem: string;
  let hijackSchema: string;
  let functions: RawFunction[];

  beforeAll(async () => {
    db = await setupDatabase();
    su = `${db.schema}_su`;
    mem = `${db.schema}_mem`;
    hijackSchema = `${db.schema}_h`;
    const client = new pkg.Client({ connectionString: db.connectionString });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${db.schema}"`);
      await client.query(`CREATE SCHEMA "${hijackSchema}"`);
      await client.query(`CREATE ROLE "${su}" SUPERUSER NOLOGIN`);
      await client.query(`CREATE ROLE "${mem}" NOLOGIN INHERIT`);
      // mem inherits su's object privileges (but not its superuser attribute).
      await client.query(`GRANT "${su}" TO "${mem}" WITH INHERIT TRUE`);
      // The CREATE grant lands on the superuser role; mem reaches it by inheritance.
      await client.query(`GRANT CREATE ON SCHEMA "${hijackSchema}" TO "${su}"`);
      await client.query(
        `CREATE FUNCTION "${db.schema}".settle_inherited(invoice_id uuid) RETURNS void ` +
          `LANGUAGE sql SECURITY DEFINER SET search_path = "${hijackSchema}", pg_temp AS $$ SELECT $$`,
      );
    } finally {
      await client.end();
    }
    const raw = await introspect({ connection: db.connectionString, schemas: [db.schema] });
    functions = raw.functions;
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    const client = new pkg.Client({ connectionString: db.connectionString });
    await client.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS "${hijackSchema}" CASCADE`);
      await client.query(`DROP SCHEMA IF EXISTS "${db.schema}" CASCADE`);
      await client.query(`DROP ROLE IF EXISTS "${mem}"`);
      await client.query(`DROP ROLE IF EXISTS "${su}"`);
    } finally {
      await client.end();
    }
    await db.cleanup();
  });

  it('flags the schema as writable by others (inherited grant is not lost)', () => {
    const fn = functions.find((f) => f.name === 'settle_inherited')!;
    const el = fn.searchPath!.find((e) => e.schema === hijackSchema);
    expect(el?.writableByOthers).toBe(true);
  });
});
