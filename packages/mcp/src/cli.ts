#!/usr/bin/env node
import { SchemaCache } from './schemaCache.js';
import { startStdioServer } from './startStdioServer.js';

function parseEnvNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`[@kozou/mcp] invalid env number "${value}", fallback to ${fallback}`);
    return fallback;
  }
  return n;
}

async function main(): Promise<void> {
  const connectionString = process.env.KOZOU_DATABASE_URL;
  if (!connectionString) {
    console.error('[@kozou/mcp] KOZOU_DATABASE_URL environment variable is required');
    process.exit(1);
  }
  const cache = new SchemaCache({
    connection: connectionString,
    ttlMs: parseEnvNumber(process.env.KOZOU_CACHE_TTL_MS, 60_000),
  });
  await startStdioServer(cache);
}

main().catch((err) => {
  console.error('[@kozou/mcp] fatal:', err);
  process.exit(1);
});
