// Pure wiring helpers for `kozou dev` (see commands/dev.ts).
//
// Kept separate from the spawn / lifecycle shell in dev.ts so the
// config -> child-process-env / origin / entry-path mapping can be unit
// tested without launching any servers.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { KozouConfig } from '../config.js';

// Resolve the Admin UI's adapter-node standalone server entry. The
// `build/` directory ships in @kozou/svelte-ui's published `files`, and
// resolving the package's own package.json works whether kozou runs from
// a flat node_modules tree (Docker / npm install) or a workspace symlink
// (local dev).
export function resolveAdminUiEntry(): string {
  const require = createRequire(import.meta.url);
  const pkgJsonPath = require.resolve('@kozou/svelte-ui/package.json');
  return join(dirname(pkgJsonPath), 'build', 'index.js');
}

// The browser-facing origin the Admin UI must accept form posts from.
// An explicit ORIGIN / KOZOU_ORIGIN wins; otherwise default to localhost
// on the UI port (host stays 0.0.0.0 for binding, but browsers reach it
// as localhost in the common single-host case).
export function resolveOrigin(config: KozouConfig, env: NodeJS.ProcessEnv): string {
  return env.ORIGIN ?? env.KOZOU_ORIGIN ?? `http://localhost:${config.server.ui.port}`;
}

// Build the child-process environment for the Admin UI server. Keeping
// it pure makes the wiring unit-testable without spawning anything.
//
// When `apiAdapterUrl` is given (`kozou dev --adapter api`), the UI is
// pointed at the in-house @kozou/api server via KOZOU_ADAPTER_KIND=api;
// otherwise it uses the default REST adapter URL from config. On the api
// path `apiToken` (when present) is exposed as KOZOU_ADAPTER_TOKEN so the
// UI attaches it as a Bearer token; any inherited value is cleared so a
// stray env var cannot leak in.
export function buildAdminUiEnv(
  config: KozouConfig,
  origin: string,
  baseEnv: NodeJS.ProcessEnv,
  apiAdapterUrl?: string,
  apiToken?: string,
): NodeJS.ProcessEnv {
  const adapter =
    apiAdapterUrl !== undefined
      ? { KOZOU_ADAPTER_KIND: 'api', KOZOU_ADAPTER_URL: apiAdapterUrl }
      : { KOZOU_ADAPTER_URL: config.adapter.url };
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    DATABASE_URL: config.database.url,
    ...adapter,
    PORT: String(config.server.ui.port),
    HOST: config.server.ui.host,
    ORIGIN: origin,
    NODE_ENV: 'production',
  };
  if (apiAdapterUrl !== undefined) {
    if (apiToken !== undefined && apiToken.length > 0) {
      env.KOZOU_ADAPTER_TOKEN = apiToken;
    } else {
      delete env.KOZOU_ADAPTER_TOKEN;
    }
  }
  return env;
}

// The slice of @kozou/api that resolveAdminUiToken needs, declared locally
// so the resolver unit-tests with a stub instead of the real module.
export type ServiceTokenMinter = {
  signServiceToken(opts: {
    secret: string;
    roleClaim?: string;
    role?: string;
    issuer?: string;
    audience?: string | string[];
  }): Promise<string>;
};

export type AdminUiTokenResult = {
  /** Bearer token the Admin UI should send, when one could be obtained. */
  token?: string;
  /** Operator-facing reason the UI will be rejected, when no usable token. */
  warning?: string;
};

// Decide what token (if any) the bundled Admin UI should send to @kozou/api,
// given the resolved config. Pure except for the injected minter:
//   (a) an explicit token (auth.ui.token / KOZOU_ADAPTER_TOKEN) is passed
//       through — the path for RS256 / an external IdP, where the CLI cannot
//       mint;
//   (b) otherwise, with an HS256 secret, the CLI mints a token claiming the
//       configured role (auth.ui.role; absent -> the API's defaultRole);
//   (c) otherwise (an RS256 key with no supplied token) no token is returned
//       and a warning explains how to supply one.
export async function resolveAdminUiToken(
  config: KozouConfig,
  minter: ServiceTokenMinter,
  env: NodeJS.ProcessEnv,
): Promise<AdminUiTokenResult> {
  const auth = config.auth;
  if (auth === undefined) return {}; // no auth -> the UI sends no token (unchanged)

  const supplied = auth.ui?.token ?? env.KOZOU_ADAPTER_TOKEN;
  if (supplied !== undefined && supplied.length > 0) {
    return { token: supplied };
  }

  const secret = auth.jwt.secret;
  if (secret !== undefined && secret.length > 0) {
    const role = auth.ui?.role;
    const token = await minter.signServiceToken({
      secret,
      roleClaim: auth.roleClaim,
      role,
      issuer: auth.jwt.issuer,
      audience: auth.jwt.audience,
    });
    const warning = mintedRoleWarning(auth, role);
    return warning !== undefined ? { token, warning } : { token };
  }

  return {
    warning:
      'auth uses an RS256 public key, so the CLI cannot mint a token for the ' +
      'bundled Admin UI; it will be rejected with 401. Set auth.ui.token (or ' +
      'KOZOU_ADAPTER_TOKEN) to a token from your identity provider, or use an ' +
      'HS256 secret so the CLI can mint one.',
  };
}

// A minted Admin UI token will be rejected with 403 unless the API can
// resolve an allowed role for it. Surface that as a warning at startup
// rather than letting the UI fail opaquely.
function mintedRoleWarning(
  auth: NonNullable<KozouConfig['auth']>,
  role: string | undefined,
): string | undefined {
  const effective = role !== undefined && role.length > 0 ? role : auth.defaultRole;
  if (effective === undefined || effective.length === 0) {
    return 'auth.ui.role is unset and no defaultRole is configured, so the ' +
      'minted Admin UI token carries no role and the API will reject it with ' +
      '403. Set auth.ui.role to the role the Admin UI should assume.';
  }
  if (auth.allowedRoles !== undefined && !auth.allowedRoles.includes(effective)) {
    return `the Admin UI token's role "${effective}" is not in allowedRoles, so ` +
      'the API will reject it with 403. Add it to allowedRoles or change ' +
      'auth.ui.role.';
  }
  return undefined;
}
