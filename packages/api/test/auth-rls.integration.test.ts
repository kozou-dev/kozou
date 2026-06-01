import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
import { SignJWT } from 'jose';
import { introspect } from '@kozou/introspect';
import { buildSchemaContext } from '@kozou/core';
import { setupDatabase, type DatabaseHandle, GENERIC_FIXTURE_SQL } from '@kozou/test-utils';
import { startApiServer, type ApiServerHandle, type Queryable } from '../src/index.js';

// End-to-end proof that JWT auth + Postgres row-level security cooperate:
// the server verifies a token, runs each request in a transaction under
// `SET LOCAL ROLE` with the claims published, and the database's own RLS
// policy filters rows by the `sub` claim.

const SECRET = 'test-secret-do-not-use';
const secretKey = new TextEncoder().encode(SECRET);

async function token(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(secretKey);
}

type ListBody = { rows: Array<Record<string, unknown>>; total: number; page: number; pageSize: number };

describe('@kozou/api JWT + RLS (generic fixture)', () => {
  let db: DatabaseHandle;
  let pool: pkg.Pool;
  let server: ApiServerHandle;
  let base: string;

  beforeAll(async () => {
    db = await setupDatabase();

    const admin = new pkg.Client({ connectionString: db.connectionString });
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA "${db.schema}"`);
      await admin.query(`SET search_path TO "${db.schema}"`);
      await admin.query(GENERIC_FIXTURE_SQL);

      // An owner column the RLS policy keys on, plus seed rows.
      await admin.query(`ALTER TABLE authors ADD COLUMN owner text NOT NULL DEFAULT 'unknown'`);
      await admin.query(
        `INSERT INTO authors (display_name, owner)
         VALUES ('Ada Lovelace', 'ada'), ('Augusta Ada', 'ada'), ('Alan Turing', 'turing')`,
      );

      // Two non-login roles; the connection's login role must be able to assume them.
      await admin.query(`CREATE ROLE app_reader`);
      await admin.query(`CREATE ROLE app_other`);
      await admin.query(`GRANT USAGE ON SCHEMA "${db.schema}" TO app_reader, app_other`);
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${db.schema}" TO app_reader, app_other`,
      );
      await admin.query(`GRANT app_reader, app_other TO CURRENT_USER`);

      // RLS: a row is visible only when its owner matches the JWT `sub` claim.
      await admin.query(`ALTER TABLE authors ENABLE ROW LEVEL SECURITY`);
      await admin.query(
        `CREATE POLICY authors_owner ON authors
         USING (owner = current_setting('request.jwt.claims', true)::jsonb ->> 'sub')`,
      );
    } finally {
      await admin.end();
    }

    const raw = await introspect({ connection: db.connectionString, schemas: [db.schema] });
    const schema = await buildSchemaContext({ raw });

    pool = new pkg.Pool({ connectionString: db.connectionString, max: 2 });
    const queryable: Queryable = {
      query: (text: string, values?: unknown[]) => pool.query(text, values),
    };
    server = await startApiServer({
      schema,
      db: queryable,
      pool,
      auth: { jwt: { secret: SECRET }, allowedRoles: ['app_reader'], defaultRole: 'app_reader' },
      host: '127.0.0.1',
      port: 0,
      version: '0.0.0-test',
    });
    base = `http://127.0.0.1:${server.port}`;
  }, 120_000);

  afterAll(async () => {
    if (server) await server.close();
    if (pool) await pool.end();
    if (db) await db.cleanup();
  });

  const getAuthed = async <T>(path: string, jwt?: string): Promise<{ status: number; body: T }> => {
    const headers: Record<string, string> = jwt ? { Authorization: `Bearer ${jwt}` } : {};
    const r = await fetch(`${base}${path}`, { headers });
    return { status: r.status, body: (await r.json()) as T };
  };

  it('filters list rows (and the count) by the JWT sub claim via RLS', async () => {
    const { status, body } = await getAuthed<ListBody>(
      '/authors',
      await token({ sub: 'ada', role: 'app_reader' }),
    );
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.rows).toHaveLength(2);
    expect(body.rows.every((row) => row.owner === 'ada')).toBe(true);
  });

  it('a different sub sees a different row set', async () => {
    const { body } = await getAuthed<ListBody>(
      '/authors',
      await token({ sub: 'turing', role: 'app_reader' }),
    );
    expect(body.total).toBe(1);
    expect(body.rows[0].owner).toBe('turing');
  });

  it('rejects a request with no token (401)', async () => {
    const { status } = await getAuthed('/authors');
    expect(status).toBe(401);
  });

  it('rejects a garbage token (401)', async () => {
    const { status } = await getAuthed('/authors', 'not-a-jwt');
    expect(status).toBe(401);
  });

  it('rejects a token whose role is not in the allowlist (403)', async () => {
    const { status } = await getAuthed('/authors', await token({ sub: 'ada', role: 'app_other' }));
    expect(status).toBe(403);
  });

  it('falls back to the default role when the token has no role claim', async () => {
    const { status, body } = await getAuthed<ListBody>('/authors', await token({ sub: 'ada' }));
    expect(status).toBe(200);
    expect(body.total).toBe(2);
  });

  it('releases connections on every path (pool not exhausted)', async () => {
    // pool max is 2; a missing release would hang by the 3rd successful request.
    for (let i = 0; i < 8; i += 1) {
      const ok = await getAuthed<ListBody>(
        '/authors',
        await token({ sub: 'ada', role: 'app_reader' }),
      );
      expect(ok.status).toBe(200);
      const denied = await getAuthed('/authors');
      expect(denied.status).toBe(401);
    }
  });
});
