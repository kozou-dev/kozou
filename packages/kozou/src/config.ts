// kozou.config.yaml loader.
//
// Reads the YAML config file, expands ${VAR} / ${VAR:-default} placeholders
// against the process environment, fills in defaults, and validates the
// result with zod. Every field has a default so kozou can run with only the
// DATABASE_URL environment variable set, per the Kozou v0.1 design spec §9.2.
//
// A literal `$$` escapes to a single `$`, so `$${VAR}` produces the literal
// text `${VAR}` instead of expanding it. Expansion is single-level by design:
// a value substituted from the environment is never re-scanned, so a secret
// that legitimately contains `${...}` (e.g. inside a DATABASE_URL password) is
// preserved rather than mistaken for a placeholder. See expandEnvVars below.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { parse as parseYAML } from 'yaml';
import { z } from 'zod';

// ---- Schema ---------------------------------------------------------------

// Nested sections use `.prefault({})` rather than `.default({})`: in zod 4
// `.default(v)` short-circuits to `v` as-is when the input is undefined (so
// it would need the fully-populated object), whereas `.prefault(v)` feeds
// `v` back through the schema so each field's own `.default(...)` still
// applies. `.prefault({})` therefore reproduces the zod 3 behaviour of
// "absent section -> object filled entirely from inner defaults".

const uiServerSchema = z
  .object({
    port: z.number().int().min(0).max(65_535).default(3333),
    host: z.string().min(1).default('0.0.0.0'),
  })
  .prefault({});

const mcpHttpServerSchema = z
  .object({
    port: z.number().int().min(0).max(65_535).default(3334),
    host: z.string().min(1).default('0.0.0.0'),
  })
  .prefault({});

const mcpServerSchema = z
  .object({
    http: mcpHttpServerSchema,
    stdio: z.boolean().default(false),
  })
  .prefault({});

const serverSchema = z
  .object({
    ui: uiServerSchema,
    mcp: mcpServerSchema,
  })
  .prefault({});

// The adapter kinds the Admin UI can run against: the bundled in-house REST
// backend (`api`, the v1.0 default) or the external PostgREST opt-out. This is
// the single source of the kind names; the CLI references the list and selects
// by `=== 'api'` so the opt-out value is never hard-coded outside this module.
export const ADAPTER_KINDS = ['api', 'postgrest'] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

const adapterSchema = z
  .object({
    type: z.enum(ADAPTER_KINDS).default('api'),
    // Only consumed by the PostgREST opt-out (`type: postgrest`); ignored by
    // the in-house `api` backend, which serves REST in-process.
    url: z.string().min(1).default('http://postgrest:3000'),
  })
  .prefault({});

const uiHintsSchema = z
  .object({
    path: z.string().nullable().default(null),
  })
  .prefault({});

const cacheSchema = z
  .object({
    ttlMs: z.number().int().min(0).default(60_000),
  })
  .prefault({});

const databaseSchema = z.object({
  url: z.string().min(1, 'database.url is required (set DATABASE_URL or kozou.config.yaml)'),
  schemas: z.array(z.string().min(1)).default(['public']),
});

// Opt-in JWT auth for the in-house @kozou/api backend (`kozou dev --adapter
// api`). Absent -> the API stays unauthenticated and loopback-only. The
// "exactly one of secret / publicKey" rule is enforced by @kozou/api at
// server start, so it is intentionally not duplicated here.
const jwtAuthSchema = z.object({
  secret: z.string().min(1).optional(),
  publicKey: z.string().min(1).optional(),
  jwksUri: z.string().min(1).optional(),
  algorithms: z.array(z.enum(['HS256', 'RS256'])).optional(),
  issuer: z.string().min(1).optional(),
  audience: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
});

// How the bundled Admin UI authenticates to @kozou/api when auth is on. This
// is a CLI-only concern (not part of @kozou/api's AuthConfig): under HS256 the
// CLI mints a token claiming `role` plus the optional `claims` (for RLS
// policies that read request.jwt.claims beyond the role, e.g. a tenant id);
// for RS256 / an external IdP it cannot mint, so `token` carries a
// ready-made one through to the UI instead.
const authUiSchema = z.object({
  role: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
  claims: z.record(z.string(), z.unknown()).optional(),
});

const authSchema = z.object({
  jwt: jwtAuthSchema,
  roleClaim: z.string().min(1).optional(),
  allowedRoles: z.array(z.string().min(1)).optional(),
  defaultRole: z.string().min(1).optional(),
  anonRole: z.string().min(1).optional(),
  claimsGuc: z.string().min(1).optional(),
  ui: authUiSchema.optional(),
});

const configSchema = z.object({
  database: databaseSchema,
  server: serverSchema,
  adapter: adapterSchema,
  uiHints: uiHintsSchema,
  cache: cacheSchema,
  auth: authSchema.optional(),
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

// Matches either an escaped `$$` (which becomes a literal `$`) or a
// `${VAR}` / `${VAR:-default}` placeholder. `$$` is listed first so the
// alternation consumes it before the placeholder branch can see a stray `$`.
const ENV_TOKEN_RE = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

function expandEnvVars(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') {
    return value.replace(
      ENV_TOKEN_RE,
      (match, name: string | undefined, fallback?: string) => {
        // `$$` -> literal `$`. So `$${VAR}` yields the literal `${VAR}`:
        // the trailing `{VAR}` is left untouched because it no longer has
        // a `$` prefix to start a placeholder.
        if (match === '$$') return '$';
        // Otherwise `match` is a `${...}` placeholder and `name` is its
        // (always-present) variable name. The substituted value is taken
        // verbatim and never re-scanned (single-level expansion), so a
        // value containing `${...}` is preserved as-is.
        const v = env[name as string];
        if (v !== undefined) return v;
        if (fallback !== undefined) return fallback;
        return '';
      },
    );
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

function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

// Build the optional `auth` section from KOZOU_JWT_* env vars when the config
// file did not declare one. Runs AFTER ${VAR} expansion so an env-provided
// secret / key is taken verbatim and is never re-scanned for placeholders.
function injectAuthFromEnv(raw: unknown, env: NodeJS.ProcessEnv): unknown {
  if (raw === null || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;
  if (obj.auth !== undefined) return obj; // an explicit config section wins

  const secret = env.KOZOU_JWT_SECRET;
  const publicKey = env.KOZOU_JWT_PUBLIC_KEY;
  const jwksUri = env.KOZOU_JWT_JWKS_URI;
  if (!secret && !publicKey && !jwksUri) return obj; // no auth env -> stay unauthenticated

  const jwt: Record<string, unknown> = {};
  if (secret) jwt.secret = secret;
  if (publicKey) jwt.publicKey = publicKey;
  if (jwksUri) jwt.jwksUri = jwksUri;
  const algorithms = splitList(env.KOZOU_JWT_ALGORITHMS);
  if (algorithms) jwt.algorithms = algorithms;
  if (env.KOZOU_JWT_ISSUER) jwt.issuer = env.KOZOU_JWT_ISSUER;
  if (env.KOZOU_JWT_AUDIENCE) jwt.audience = env.KOZOU_JWT_AUDIENCE;

  const auth: Record<string, unknown> = { jwt };
  if (env.KOZOU_JWT_ROLE_CLAIM) auth.roleClaim = env.KOZOU_JWT_ROLE_CLAIM;
  const allowedRoles = splitList(env.KOZOU_JWT_ALLOWED_ROLES);
  if (allowedRoles) auth.allowedRoles = allowedRoles;
  if (env.KOZOU_JWT_DEFAULT_ROLE) auth.defaultRole = env.KOZOU_JWT_DEFAULT_ROLE;
  if (env.KOZOU_JWT_ANON_ROLE) auth.anonRole = env.KOZOU_JWT_ANON_ROLE;
  if (env.KOZOU_JWT_CLAIMS_GUC) auth.claimsGuc = env.KOZOU_JWT_CLAIMS_GUC;

  // How the bundled Admin UI authenticates: KOZOU_UI_ROLE names the role the
  // CLI mints an HS256 token for; KOZOU_UI_CLAIMS is a JSON object of extra
  // claims to mint into it; KOZOU_ADAPTER_TOKEN supplies a ready-made token
  // (RS256 / external IdP, where the CLI cannot mint).
  const ui: Record<string, unknown> = {};
  if (env.KOZOU_UI_ROLE) ui.role = env.KOZOU_UI_ROLE;
  if (env.KOZOU_UI_CLAIMS) ui.claims = parseUiClaimsEnv(env.KOZOU_UI_CLAIMS);
  if (env.KOZOU_ADAPTER_TOKEN) ui.token = env.KOZOU_ADAPTER_TOKEN;
  if (Object.keys(ui).length > 0) auth.ui = ui;
  return { ...obj, auth };
}

// KOZOU_UI_CLAIMS must be a JSON object. A malformed value fails loudly at
// startup — silently minting a token without the expected claims would be
// the same silent-misconfiguration class as unforwarded auth env vars
// (every RLS policy keyed on a claim would just see nothing).
function parseUiClaimsEnv(raw: string): Record<string, unknown> {
  // The CLI surfaces only the top-level error message, so the actionable
  // detail (which env var, what is wrong with it) must live there — not
  // just in the structured issues.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const detail = `KOZOU_UI_CLAIMS is not valid JSON: ${message}`;
    throw new KozouConfigError(`Invalid kozou config: ${detail}`, null, [
      { path: 'auth.ui.claims', message: detail },
    ]);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const detail = 'KOZOU_UI_CLAIMS must be a JSON object, e.g. {"tenant_id":"acme"}.';
    throw new KozouConfigError(`Invalid kozou config: ${detail}`, null, [
      { path: 'auth.ui.claims', message: detail },
    ]);
  }
  return parsed as Record<string, unknown>;
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
  // Build `auth` from KOZOU_JWT_* env after expansion (env secrets verbatim).
  const withAuth = injectAuthFromEnv(expanded, env);

  try {
    return configSchema.parse(withAuth);
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
