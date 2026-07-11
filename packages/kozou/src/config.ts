// kozou.config.yaml loader.
//
// Reads the YAML config file, expands ${VAR} / ${VAR:-default} placeholders
// against the process environment, fills in defaults, and validates the
// result with zod. Every field has a default so kozou can run with only the
// DATABASE_URL environment variable set.
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
import type { McpHttpAuthOptions } from '@kozou/mcp';

// ---- Schema ---------------------------------------------------------------

// Nested sections use `.prefault({})` rather than `.default({})`: in zod 4
// `.default(v)` short-circuits to `v` as-is when the input is undefined (so
// it would need the fully-populated object), whereas `.prefault(v)` feeds
// `v` back through the schema so each field's own `.default(...)` still
// applies. `.prefault({})` therefore reproduces the zod 3 behaviour of
// "absent section -> object filled entirely from inner defaults".

// The Admin UI and MCP HTTP server have no authentication of their own, so they
// default to loopback — reachable only from the machine running `kozou dev`. To
// bind all interfaces (e.g. inside a container so a port mapping can reach it),
// set KOZOU_UI_HOST / KOZOU_MCP_HTTP_HOST=0.0.0.0 (honoured in loadConfig) and
// publish the host port on loopback — see the docker-compose template.
const uiServerSchema = z
  .object({
    port: z.number().int().min(0).max(65_535).default(3333),
    host: z.string().min(1).default('127.0.0.1'),
  })
  .prefault({});

// JWT verification config shared by the REST auth block and the MCP
// resource-server block. The "exactly one of secret / publicKey / jwksUri"
// rule is enforced by the consuming server at start, so it is intentionally
// not duplicated here.
const jwtAuthSchema = z.object({
  secret: z.string().min(1).optional(),
  publicKey: z.string().min(1).optional(),
  jwksUri: z.string().min(1).optional(),
  algorithms: z.array(z.enum(['HS256', 'RS256'])).optional(),
  issuer: z.string().min(1).optional(),
  audience: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
});

// Scope names the OAuth resource-server mode expects on tokens, matched
// exactly. Renaming exists for IdPs that force a prefix onto scope names
// (e.g. `api://kozou-mcp/mcp.describe`); the defaults are the plain names.
const mcpAuthScopesSchema = z
  .object({
    describe: z.string().min(1).default('mcp:describe'),
    execute: z.string().min(1).default('mcp:execute'),
    admin: z.string().min(1).default('mcp:admin'),
  })
  .prefault({});

// OAuth 2.1 resource-server mode for the MCP HTTP endpoint (the MCP
// authorization spec). Presence of this block turns it on: the server
// advertises `authorizationServers` via RFC 9728 protected-resource
// metadata, verifies each request's bearer token, and the `call` tool runs
// as the *token's* role (per-caller identity) instead of a fixed execution
// role. kozou stays a resource server only — the authorization server is
// the operator's own IdP.
//
// `resource` is the canonical resource URI (RFC 8707) — always explicit,
// never derived from the Host header; behind a tunnel / reverse proxy it is
// the public URL. It is also the default expected token audience — note
// this is deliberately different from the REST `auth.jwt.audience` (a
// client id), which is therefore never inherited.
//
// `jwt` / `roleClaim` / `allowedRoles` inherit from the top-level `auth`
// block when omitted. `defaultRole` / `anonRole` deliberately do NOT exist
// here: a request without a token is always 401, and a token without a
// role claim is rejected — a default would silently grant a role to any
// authenticated principal the IdP admin never assigned one (implicit
// elevation), e.g. a federated first-time user.
//
// `extraScopesSupported` extends the advertised scope list (clients treat
// it as "what to request from the AS" — add e.g. `offline_access` when the
// AS needs it for refresh tokens). `adminRefresh` opts POST /admin/refresh
// back in, gated on the admin scope (default: the route is disabled).
const mcpAuthSchema = z.object({
  resource: z.string().min(1),
  authorizationServers: z.array(z.string().min(1)).min(1),
  jwt: jwtAuthSchema.optional(),
  roleClaim: z.string().min(1).optional(),
  allowedRoles: z.array(z.string().min(1)).optional(),
  scopes: mcpAuthScopesSchema,
  extraScopesSupported: z.array(z.string().min(1)).optional(),
  adminRefresh: z.boolean().default(false),
});

const mcpHttpServerSchema = z
  .object({
    port: z.number().int().min(0).max(65_535).default(3334),
    host: z.string().min(1).default('127.0.0.1'),
    auth: mcpAuthSchema.optional(),
  })
  .prefault({});

// Opt-in execution for the MCP `call` tool (issue #103, Beyond v1.4). Default
// OFF (describe-only). When enabled, the bundled `kozou mcp` server exposes a
// `call` tool that runs the exposed RPC functions (api.rpc). Identity depends
// on the auth posture: without `server.mcp.http.auth`, calls run under the
// single operator-configured `role` (required then; a dedicated
// least-privilege role is strongly advised — not the owner / a superuser) and
// there is no per-caller identity, so that mode is unsuitable for
// multi-tenant per-user authorization. With the OAuth resource-server block,
// calls run as each verified token's role and `role` / `claims` here are
// ignored. `claims` are fixed claims published for row-level security;
// `allow` is an optional allowlist of schema-qualified function names
// (`schema.fn`); omitted = every exposed function may be called.
const mcpExecutionSchema = z
  .object({
    enabled: z.boolean().default(false),
    role: z.string().min(1).optional(),
    claims: z.record(z.string(), z.unknown()).optional(),
    allow: z.array(z.string().min(1)).optional(),
  })
  .prefault({});

const mcpServerSchema = z
  .object({
    http: mcpHttpServerSchema,
    stdio: z.boolean().default(false),
    execution: mcpExecutionSchema,
  })
  .prefault({})
  .superRefine((server, ctx) => {
    // Execution without the OAuth resource-server block needs its fixed role;
    // with the block the role is per-token and a configured one is ignored.
    if (server.execution.enabled && server.execution.role === undefined && server.http.auth === undefined) {
      ctx.addIssue({
        code: 'custom',
        message:
          'server.mcp.execution.role is required when server.mcp.execution.enabled is true ' +
          'without server.mcp.http.auth (no OAuth = calls need a fixed execution role)',
        path: ['execution', 'role'],
      });
    }
  });

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

// Opt-in privilege-aware introspection (issue #99). When on, the generated
// surfaces reflect what the serving role may actually do, each in the way that
// fits it:
//   - Admin UI: hides tables the role cannot SELECT, drops columns it cannot
//     INSERT from create forms, renders ones it cannot UPDATE read-only.
//   - MCP describe_table / describe_view and `kozou docs`: do NOT hide — they
//     keep every relation and *annotate* it with the role's effective GRANTs
//     (relation-level SELECT/INSERT/UPDATE/DELETE, plus per-column
//     insertable/updatable on tables; a "Security" section in docs), so an AI
//     agent is told what it may touch. (Views expose relation-level privileges
//     only; PostgreSQL does not track per-column write grants on a view.)
// Default off = current (schema-faithful) behaviour. The role evaluated
// defaults to the Admin UI's role (auth.ui.role, else auth.defaultRole);
// `role` overrides it explicitly. Enforcement always stays in PostgreSQL.
const introspectionSchema = z
  .object({
    respectPrivileges: z.boolean().default(false),
    role: z.string().min(1).optional(),
  })
  .prefault({});

const databaseSchema = z.object({
  url: z.string().min(1, 'database.url is required (set DATABASE_URL or kozou.config.yaml)'),
  schemas: z.array(z.string().min(1)).default(['public']),
});

// Opt-in RPC exposure of Postgres functions (issue #103). A function is exposed
// only when its COMMENT carries `@expose: rpc`; these lists are the additional
// deploy-time opt-in the riskier cases require, and hold schema-qualified names
// (`schema.function`). `allowDefiner`: SECURITY DEFINER functions (which run as
// their owner and can bypass RLS) need this in ADDITION to the tag and an
// owner-safe search_path. `allowPublicExecute`: functions that intentionally
// keep EXECUTE granted to PUBLIC (anon-callable); without it, a function still
// granting PUBLIC EXECUTE is hard-skipped. Both default to empty (nothing extra
// is exposed).
const rpcSchema = z
  .object({
    allowDefiner: z.array(z.string().min(1)).default([]),
    allowPublicExecute: z.array(z.string().min(1)).default([]),
  })
  .prefault({});

const apiSchema = z
  .object({
    rpc: rpcSchema,
  })
  .prefault({});

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

// Opt-in JWT auth for the in-house @kozou/api backend (`kozou dev --adapter
// api`). Absent -> the API stays unauthenticated and loopback-only.
const authSchema = z.object({
  jwt: jwtAuthSchema,
  roleClaim: z.string().min(1).optional(),
  allowedRoles: z.array(z.string().min(1)).optional(),
  defaultRole: z.string().min(1).optional(),
  anonRole: z.string().min(1).optional(),
  claimsGuc: z.string().min(1).optional(),
  ui: authUiSchema.optional(),
});

/** The full kozou.config.yaml schema. Exported so docs tooling can enumerate
 *  the config surface from the source of truth — e.g. kozou-site's `gen:docs`
 *  asserts every top-level block here is documented in the config reference, so
 *  a newly added block (like `introspection` was) cannot ship undocumented.
 *  `Object.keys(configSchema.shape)` yields the top-level block names. */
export const configSchema = z.object({
  database: databaseSchema,
  server: serverSchema,
  adapter: adapterSchema,
  api: apiSchema,
  uiHints: uiHintsSchema,
  cache: cacheSchema,
  introspection: introspectionSchema,
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

/**
 * Resolve the role whose privileges privilege-aware introspection (issue #99)
 * should evaluate, or `undefined` when the feature is off. The role defaults to
 * the Admin UI's role (`auth.ui.role`, else `auth.defaultRole`); an explicit
 * `introspection.role` overrides. Throws when the feature is on but no role can
 * be resolved — privileges are role-relative, so there is nothing to evaluate.
 */
export function resolvePrivilegeRole(
  config: KozouConfig,
  opts: { suppliedToken?: boolean } = {},
): string | undefined {
  if (!config.introspection.respectPrivileges) return undefined;
  // A ready-made token (auth.ui.token or the KOZOU_ADAPTER_TOKEN env — the
  // RS256 / external-IdP path) carries its own role claim that the CLI does not
  // mint and cannot reliably read, and it takes precedence over minting. The
  // auth-derived fallback (auth.ui.role / defaultRole) could therefore evaluate
  // a *different* role than the UI actually uses — hiding/locking the wrong
  // things. Require an explicit introspection.role whenever such a token is
  // actually in play (the caller decides: only the in-house API path forwards a
  // token; the PostgREST opt-out clears it, so it does not gate there).
  if (config.introspection.role === undefined && opts.suppliedToken === true) {
    throw new KozouConfigError(
      'introspection.respectPrivileges is on with a ready-made token (auth.ui.token / ' +
        'KOZOU_ADAPTER_TOKEN), whose role the CLI cannot infer. Set introspection.role to the ' +
        'role that token assumes so privilege-aware introspection evaluates the same role the ' +
        'Admin UI runs as.',
      null,
      [{ path: 'introspection.role', message: 'required when a ready-made token is supplied' }],
    );
  }
  const role = config.introspection.role ?? config.auth?.ui?.role ?? config.auth?.defaultRole;
  if (role === undefined || role.length === 0) {
    throw new KozouConfigError(
      'introspection.respectPrivileges is on but no role to evaluate could be resolved. ' +
        'Set introspection.role explicitly, or configure auth.ui.role / auth.defaultRole ' +
        '(the role the Admin UI assumes).',
      null,
      [{ path: 'introspection.role', message: 'no privilege role could be resolved' }],
    );
  }
  return role;
}

/** Whether a ready-made UI token is configured (`auth.ui.token`) or inherited
 *  from the environment (`KOZOU_ADAPTER_TOKEN`). Such a token carries its own
 *  role claim that the CLI does not mint and cannot reliably read, so a
 *  privilege-aware surface must not guess the role from `auth.ui.role` /
 *  `auth.defaultRole`. Callers that resolve a role purely to *describe* it
 *  (e.g. `kozou docs`, `kozou mcp` describe-only) pass this as
 *  `resolvePrivilegeRole`'s `suppliedToken` so they require an explicit
 *  `introspection.role` rather than documenting a role that may not be in use.
 *  (`kozou dev` uses the more nuanced api-path-gated check in
 *  `resolveDevPrivilegeRole`.) */
export function hasReadyMadeToken(config: KozouConfig, env: NodeJS.ProcessEnv): boolean {
  return (
    (config.auth?.ui?.token !== undefined && config.auth.ui.token.length > 0) ||
    (env.KOZOU_ADAPTER_TOKEN !== undefined && env.KOZOU_ADAPTER_TOKEN.length > 0)
  );
}

/** Resolve the effective OAuth resource-server options for the MCP HTTP
 *  endpoint from `server.mcp.http.auth`, or undefined when the block is
 *  absent (the no-auth loopback mode).
 *
 *  Inheritance (the usual single-IdP deployment): `jwt`, `roleClaim`, and
 *  `allowedRoles` fall back to the top-level `auth` block — EXCEPT
 *  `jwt.audience`, which never inherits: the REST audience is a client id
 *  while the MCP token audience is the canonical resource URI (the
 *  downstream default when unset), and inheriting the REST value would
 *  accept REST-audience tokens on the MCP surface. `defaultRole` /
 *  `anonRole` never carry over — the option type has no such fields, so a
 *  role-claim-less token and a token-less request stay rejections. */
export function resolveMcpAuthOptions(config: KozouConfig): McpHttpAuthOptions | undefined {
  const mcpAuth = config.server.mcp.http.auth;
  if (mcpAuth === undefined) return undefined;

  let jwt = mcpAuth.jwt;
  if (jwt === undefined && config.auth?.jwt !== undefined) {
    const { audience: _restAudience, ...inherited } = config.auth.jwt;
    jwt = inherited;
  }
  if (jwt === undefined || (jwt.secret === undefined && jwt.publicKey === undefined && jwt.jwksUri === undefined)) {
    throw new Error(
      'server.mcp.http.auth requires JWT verification config: set server.mcp.http.auth.jwt ' +
        '(or a top-level auth.jwt to inherit) with one of jwksUri / publicKey / secret.',
    );
  }

  const roleClaim = mcpAuth.roleClaim ?? config.auth?.roleClaim;
  const allowedRoles = mcpAuth.allowedRoles ?? config.auth?.allowedRoles;
  return {
    resource: mcpAuth.resource,
    authorizationServers: mcpAuth.authorizationServers,
    jwt,
    ...(roleClaim === undefined ? {} : { roleClaim }),
    ...(allowedRoles === undefined ? {} : { allowedRoles }),
    scopes: mcpAuth.scopes,
    ...(mcpAuth.extraScopesSupported === undefined
      ? {}
      : { extraScopesSupported: mcpAuth.extraScopesSupported }),
    adminRefresh: mcpAuth.adminRefresh,
  };
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

// Bind-host overrides from the environment for the no-auth dev surfaces. They
// default to loopback (see uiServerSchema / mcpHttpServerSchema); a container
// sets KOZOU_UI_HOST / KOZOU_MCP_HTTP_HOST to 0.0.0.0 so a (loopback-published)
// port mapping can reach them. Honoured even when there is no config file —
// `${VAR}` expansion only reaches values written in the YAML.
function injectServerHostsFromEnv(raw: unknown, env: NodeJS.ProcessEnv): unknown {
  const uiHost = env.KOZOU_UI_HOST;
  const mcpHost = env.KOZOU_MCP_HTTP_HOST;
  if (!uiHost && !mcpHost) return raw;
  const asObj = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' ? { ...(v as Record<string, unknown>) } : {};

  const obj = asObj(raw);
  const server = asObj(obj.server);
  if (uiHost) {
    const ui = asObj(server.ui);
    ui.host = uiHost;
    server.ui = ui;
  }
  if (mcpHost) {
    const mcp = asObj(server.mcp);
    const http = asObj(mcp.http);
    http.host = mcpHost;
    mcp.http = http;
    server.mcp = mcp;
  }
  obj.server = server;
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
  // Apply KOZOU_UI_HOST / KOZOU_MCP_HTTP_HOST overrides (e.g. a container that
  // needs to bind 0.0.0.0), even with no config file.
  const withHosts = injectServerHostsFromEnv(withAuth, env);

  try {
    return configSchema.parse(withHosts);
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
