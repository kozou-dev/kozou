import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

export type DatabaseHandle = {
  connectionString: string;
  schema: string;
  cleanup: () => Promise<void>;
};

export async function setupDatabase(): Promise<DatabaseHandle> {
  const schema = `kozou_mcp_test_${randomBytes(4).toString('hex')}`;

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
