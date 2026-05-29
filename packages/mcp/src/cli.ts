#!/usr/bin/env node
import { SchemaCache } from './schemaCache.js';
import { startStdioServer } from './startStdioServer.js';
import { startHttpServer } from './startHttpServer.js';

function parseEnvNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`[@kozou/mcp] invalid env number "${value}", fallback to ${fallback}`);
    return fallback;
  }
  return n;
}

type CliMode = 'stdio' | 'http';

type CliArgs = {
  mode: CliMode;
  port?: number;
  host?: string;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { mode: 'stdio' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--http':
        args.mode = 'http';
        break;
      case '--stdio':
        args.mode = 'stdio';
        break;
      case '--port':
        args.port = Number(argv[++i]);
        break;
      case '--host':
        args.host = argv[++i];
        break;
      default:
        if (arg.startsWith('--port=')) {
          args.port = Number(arg.slice('--port='.length));
        } else if (arg.startsWith('--host=')) {
          args.host = arg.slice('--host='.length);
        }
        // Unknown flags are ignored so adopters can pass through extras.
    }
  }
  return args;
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

  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'http') {
    if (args.port !== undefined && (!Number.isFinite(args.port) || args.port < 0)) {
      console.error(`[@kozou/mcp] invalid --port "${args.port}"`);
      process.exit(1);
    }
    await startHttpServer(cache, { port: args.port, host: args.host });
    return;
  }
  await startStdioServer(cache);
}

main().catch((err) => {
  console.error('[@kozou/mcp] fatal:', err);
  process.exit(1);
});
