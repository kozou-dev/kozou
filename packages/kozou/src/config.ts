// kozou.config.yaml loader.
//
// Reads the YAML config file, expands ${VAR} / ${VAR:-default} placeholders
// against the process environment, fills in defaults, and validates the
// result with zod. Every field has a default so kozou can run with only the
// DATABASE_URL environment variable set, per the Kozou v0.1 design spec §9.2.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { parse as parseYAML } from 'yaml';
import { z } from 'zod';

// ---- Schema ---------------------------------------------------------------

const uiServerSchema = z
  .object({
    port: z.number().int().min(0).max(65_535).default(3333),
    host: z.string().min(1).default('0.0.0.0'),
  })
  .default({});

const mcpHttpServerSchema = z
  .object({
    port: z.number().int().min(0).max(65_535).default(3334),
    host: z.string().min(1).default('0.0.0.0'),
  })
  .default({});

const mcpServerSchema = z
  .object({
    http: mcpHttpServerSchema,
    stdio: z.boolean().default(false),
  })
  .default({});

const serverSchema = z
  .object({
    ui: uiServerSchema,
    mcp: mcpServerSchema,
  })
  .default({});

const adapterSchema = z
  .object({
    type: z.literal('postgrest').default('postgrest'),
    url: z.string().min(1).default('http://postgrest:3000'),
  })
  .default({});

const uiHintsSchema = z
  .object({
    path: z.string().nullable().default(null),
  })
  .default({});

const cacheSchema = z
  .object({
    ttlMs: z.number().int().min(0).default(60_000),
  })
  .default({});

const databaseSchema = z.object({
  url: z.string().min(1, 'database.url is required (set DATABASE_URL or kozou.config.yaml)'),
  schemas: z.array(z.string().min(1)).default(['public']),
});

const configSchema = z.object({
  database: databaseSchema,
  server: serverSchema,
  adapter: adapterSchema,
  uiHints: uiHintsSchema,
  cache: cacheSchema,
});

export type KozouConfig = z.infer<typeof configSchema>;

// ---- Errors --------------------------------------------------------------

export type KozouConfigIssue = { path: string; message: string };

export class KozouConfigError extends Error {
  readonly issues: KozouConfigIssue[];
  readonly filePath: string | null;
  constructor(message: string, filePath: string | null, issues: KozouConfigIssue[]) {
    super(message);
    this.name = 'KozouConfigError';
    this.filePath = filePath;
    this.issues = issues;
  }
}

// ---- Loader --------------------------------------------------------------

const DEFAULT_CONFIG_PATH = 'kozou.config.yaml';

export type LoadConfigOptions = {
  /** Path to kozou.config.yaml. Default: ./kozou.config.yaml relative to cwd. */
  path?: string;
  /** Environment variables for ${VAR} expansion. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * If true, do not read any file from disk; only honor explicit options and
   * environment variables. Useful for unit tests.
   */
  skipFile?: boolean;
};

const ENV_VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

function expandEnvVars(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_VAR_RE, (_match, name: string, fallback?: string) => {
      const v = env[name];
      if (v !== undefined) return v;
      if (fallback !== undefined) return fallback;
      return '';
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandEnvVars(v, env));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnvVars(v, env);
    }
    return out;
  }
  return value;
}

function injectDatabaseUrlFromEnv(raw: unknown, env: NodeJS.ProcessEnv): unknown {
  if (raw === null || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;
  const envUrl = env.DATABASE_URL;
  if (envUrl === undefined || envUrl === '') return obj;

  const existing = obj.database;
  if (existing === undefined) {
    return { ...obj, database: { url: envUrl } };
  }
  if (existing !== null && typeof existing === 'object') {
    const db = existing as Record<string, unknown>;
    if (db.url === undefined || db.url === '') {
      return { ...obj, database: { ...db, url: envUrl } };
    }
  }
  return obj;
}

export async function loadConfig(opts: LoadConfigOptions = {}): Promise<KozouConfig> {
  const env = opts.env ?? process.env;
  const requestedPath = opts.path ?? DEFAULT_CONFIG_PATH;
  const absPath = isAbsolute(requestedPath)
    ? requestedPath
    : resolve(process.cwd(), requestedPath);

  let raw: unknown = {};
  let fileLoaded: string | null = null;
  if (!opts.skipFile && existsSync(absPath)) {
    const content = await readFile(absPath, 'utf8');
    try {
      raw = parseYAML(content) ?? {};
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new KozouConfigError(
        `Failed to parse kozou config: ${message}`,
        absPath,
        [{ path: '<yaml>', message }],
      );
    }
    fileLoaded = absPath;
  }

  // Fall back to DATABASE_URL env if database.url is not set in the file.
  const withDbDefault = injectDatabaseUrlFromEnv(raw, env);
  const expanded = expandEnvVars(withDbDefault, env);

  try {
    return configSchema.parse(expanded);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new KozouConfigError(
        `Invalid kozou config: ${err.issues.length} issue(s)`,
        fileLoaded,
        err.issues.map((i) => ({
          path: i.path.join('.') || '<root>',
          message: i.message,
        })),
      );
    }
    throw err;
  }
}
