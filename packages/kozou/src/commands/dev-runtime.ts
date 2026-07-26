// Pure wiring helpers for `kozou dev` (see commands/dev.ts).
//
// Kept separate from the spawn / lifecycle shell in dev.ts so the
// config -> child-process-env / origin / entry-path mapping can be unit
// tested without launching any servers.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { KozouConfig } from '../config.js';
import { resolvePrivilegeRole } from '../config.js';

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

// Resolve the privilege role for privilege-aware introspection in `kozou dev`,
// honouring the ready-made-token guard: a supplied token (config auth.ui.token
// or an inherited KOZOU_ADAPTER_TOKEN) only gates role resolution on the
// in-house API path, since the external-REST opt-out clears the token and the
// UI never forwards it. Used for BOTH the Admin UI child's KOZOU_INTROSPECTION_
// ROLE and the in-process MCP server's privilege annotation, so the two reflect
// the same role. Returns undefined when the feature is off; can throw (via
// resolvePrivilegeRole) when on but no role is resolvable.
export function resolveDevPrivilegeRole(
  config: KozouConfig,
  opts: { apiActive: boolean; env: NodeJS.ProcessEnv },
): string | undefined {
  const suppliedToken =
    opts.apiActive &&
    ((config.auth?.ui?.token !== undefined && config.auth.ui.token.length > 0) ||
      (opts.env.KOZOU_ADAPTER_TOKEN !== undefined && opts.env.KOZOU_ADAPTER_TOKEN.length > 0));
  return resolvePrivilegeRole(config, { suppliedToken });
}

// Build the child-process environment for the Admin UI server. Keeping
// it pure makes the wiring unit-testable without spawning anything.
//
// When `apiAdapterUrl` is given (the default in-house @kozou/api backend),
// the UI is pointed at that server via KOZOU_ADAPTER_KIND=api; otherwise (the
// external REST opt-out) it uses the adapter URL from config and leaves
// KOZOU_ADAPTER_KIND unset, so the UI falls back to its REST adapter. On the
// api path `apiToken` (when present) is exposed as KOZOU_ADAPTER_TOKEN so the
// UI attaches it as a Bearer token; any inherited value is cleared so a stray
// env var cannot leak in.
export function buildAdminUiEnv(
  config: KozouConfig,
  origin: string,
  baseEnv: NodeJS.ProcessEnv,
  apiAdapterUrl?: string,
  apiToken?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    DATABASE_URL: config.database.url,
    PORT: String(config.server.ui.port),
    HOST: config.server.ui.host,
    ORIGIN: origin,
    NODE_ENV: 'production',
  };
  // JWT verifier / signing inputs and minting inputs are a CLI-process
  // concern. The network-facing UI child only ever consumes KOZOU_ADAPTER_*,
  // so the HS256 secret (or key / JWKS settings) and the UI token inputs
  // (role name, claim values — which can carry tenant identifiers) must not
  // extend into it — with the scaffold compose forwarding these variables
  // they are present in the parent environment on the default path.
  for (const key of Object.keys(env)) {
    if (key.startsWith('KOZOU_JWT_') || key === 'KOZOU_UI_ROLE' || key === 'KOZOU_UI_CLAIMS') {
      delete env[key];
    }
  }
  // The MCP Streamable HTTP server (commands/dev.ts) comes up alongside the UI
  // unless server.mcp.http.enabled turns it off. When it runs, pass its port so
  // the Admin UI's "Connect an AI agent" page can show a copy-paste config
  // pointing at the live endpoint — the host comes from the UI's request URL
  // (ORIGIN-bound), never a secret. Authoritative from config so a stray
  // inherited value can't misstate the port.
  //
  // When it does not run, say so explicitly rather than by omission: the page
  // falls back to the documented default port when none is passed (it supports
  // being run standalone), so dropping the port alone would leave it
  // advertising 3334 with nothing listening.
  //
  // KOZOU_UI_MCP_LINK, deliberately not KOZOU_MCP_HTTP_ENABLED: this is a
  // CLI-to-UI-child channel, not a config override. The KOZOU_MCP_HTTP_*
  // namespace belongs to the operator — loadConfig honours those — and a name
  // sitting in it that the config loader ignored would fail silently for anyone
  // who set it in a compose file, which is the failure mode this feature exists
  // to remove.
  //
  // Both are set authoritatively: the off-flag is deleted when the endpoint is
  // on, so a stray inherited value cannot hide the page for an endpoint that is
  // in fact serving.
  if (config.server.mcp.http.enabled) {
    env.KOZOU_MCP_HTTP_PORT = String(config.server.mcp.http.port);
    delete env.KOZOU_UI_MCP_LINK;
  } else {
    env.KOZOU_UI_MCP_LINK = 'off';
    delete env.KOZOU_MCP_HTTP_PORT;
  }
  // Privilege-aware introspection (issue #99): pass the resolved role through to
  // the UI child so its introspection reflects what that role may do (hide
  // unreadable tables, lock non-updatable columns). Set it authoritatively from
  // config — delete any inherited value when the feature is off, so a stray
  // parent KOZOU_INTROSPECTION_ROLE cannot silently turn it on.
  // The ready-made-token guard only applies on the in-house API path (see
  // resolveDevPrivilegeRole). Resolve via the shared helper so the in-process
  // MCP server (commands/dev.ts) annotates the same role.
  const privilegeRole = resolveDevPrivilegeRole(config, {
    apiActive: apiAdapterUrl !== undefined,
    env: baseEnv,
  });
  if (privilegeRole !== undefined) {
    env.KOZOU_INTROSPECTION_ROLE = privilegeRole;
  } else {
    delete env.KOZOU_INTROSPECTION_ROLE;
  }
  if (apiAdapterUrl !== undefined) {
    // In-house @kozou/api backend: point the UI at it and attach the token
    // when one was resolved, clearing any inherited stale token otherwise.
    env.KOZOU_ADAPTER_KIND = 'api';
    env.KOZOU_ADAPTER_URL = apiAdapterUrl;
    if (apiToken !== undefined && apiToken.length > 0) {
      env.KOZOU_ADAPTER_TOKEN = apiToken;
    } else {
      delete env.KOZOU_ADAPTER_TOKEN;
    }
    // RPC exposure config (issue #103): forward the operator's api.rpc
    // allowlists so the UI's "Actions" surface exposes the same functions the
    // API serves (including the SECURITY DEFINER / public ones opted in). Set
    // authoritatively from config so a stray inherited value cannot widen it.
    env.KOZOU_RPC_ALLOW_DEFINER = config.api.rpc.allowDefiner.join(',');
    env.KOZOU_RPC_ALLOW_PUBLIC_EXECUTE = config.api.rpc.allowPublicExecute.join(',');
  } else {
    // External REST opt-out: the UI uses its REST adapter at the config url.
    // Clear any inherited KOZOU_ADAPTER_KIND / token so a stray value in the
    // parent environment cannot flip the UI onto the api adapter (or leak a
    // token) — the opt-out selection must be authoritative. The REST adapter
    // has no callFunction, so the Actions surface stays hidden; clear the RPC
    // allowlists too so an inherited value cannot list functions there.
    delete env.KOZOU_ADAPTER_KIND;
    delete env.KOZOU_ADAPTER_TOKEN;
    delete env.KOZOU_RPC_ALLOW_DEFINER;
    delete env.KOZOU_RPC_ALLOW_PUBLIC_EXECUTE;
    env.KOZOU_ADAPTER_URL = config.adapter.url;
  }
  return env;
}

// Strip anything that could carry a credential out of a URL before it is
// written to a log: userinfo (https://user:pass@host/...), query (?token=...)
// and fragment. Keeps scheme + host + path, which is enough to recognize
// the endpoint.
function redactUrlForLog(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '<invalid URL>';
  }
}

// One unambiguous startup line about the in-house API's auth state, so a
// stack whose auth never reached the process (for instance env vars a
// compose file did not forward) is visible immediately instead of
// failing open silently. Never includes secret material: only the
// verification mode and the role configuration (the JWKS URL is redacted
// to scheme + host + path in case it embeds a credential).
export function describeApiAuth(auth: KozouConfig['auth']): string {
  if (auth === undefined) {
    return 'disabled (no JWT verification configured; requests run as the connection role)';
  }
  const mode =
    auth.jwt.secret !== undefined && auth.jwt.secret.length > 0
      ? 'HS256 (shared secret)'
      : auth.jwt.jwksUri !== undefined && auth.jwt.jwksUri.length > 0
        ? `JWKS (${redactUrlForLog(auth.jwt.jwksUri)})`
        : auth.jwt.publicKey !== undefined && auth.jwt.publicKey.length > 0
          ? 'static public key'
          : 'misconfigured (auth set but no secret / publicKey / jwksUri)';
  const parts = [mode];
  if (auth.allowedRoles !== undefined && auth.allowedRoles.length > 0) {
    parts.push(`allowedRoles=[${auth.allowedRoles.join(', ')}]`);
  }
  if (auth.defaultRole !== undefined) parts.push(`defaultRole=${auth.defaultRole}`);
  if (auth.anonRole !== undefined) parts.push(`anonRole=${auth.anonRole}`);
  if (auth.ui?.role !== undefined) parts.push(`ui role=${auth.ui.role}`);
  else if (auth.ui?.token !== undefined) parts.push('ui token=supplied');
  if (auth.ui?.claims !== undefined) {
    // Key names only — values can carry tenant identifiers.
    parts.push(`ui claims=[${Object.keys(auth.ui.claims).join(', ')}]`);
  }
  return parts.join(', ');
}

// How a publicly bound Admin UI exposes the data behind it. Decided from
// what was actually resolved at startup (not just whether auth is
// configured), so the non-loopback warning never overstates protection:
//   - 'unauthenticated': no JWT verification (or an external adapter whose
//     auth kozou does not manage) — the UI is an open door to the data;
//   - 'service-token':   the UI holds a usable token, so every visitor acts
//     with it;
//   - 'anon-role':       auth is on but the UI holds no token; the API runs
//     its requests as the configured anonymous role (anonRole applies only
//     to requests with no Authorization header, so a present-but-rejected
//     token never falls back to it);
//   - 'rejected':        the API answers the UI with 401/403 — either no
//     token and no anonRole, or a token the resolver already knows the API
//     will reject — but the UI port itself stays reachable.
export type AdminUiExposure = 'unauthenticated' | 'service-token' | 'anon-role' | 'rejected';

export function classifyAdminUiExposure(
  auth: KozouConfig['auth'],
  tokenResult: AdminUiTokenResult | undefined,
  inhouseApi: boolean,
): AdminUiExposure {
  if (!inhouseApi || auth === undefined) return 'unauthenticated';
  const token = tokenResult?.token;
  if (token !== undefined && token.length > 0) {
    return tokenResult?.knownRejected === true ? 'rejected' : 'service-token';
  }
  if (auth.anonRole !== undefined && auth.anonRole.length > 0) return 'anon-role';
  return 'rejected';
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
    claims?: Record<string, unknown>;
  }): Promise<string>;
};

export type AdminUiTokenResult = {
  /** Bearer token the Admin UI should send, when one could be obtained. */
  token?: string;
  /** Operator-facing reason the UI will be rejected, when no usable token. */
  warning?: string;
  /** The resolver already knows the API will reject this token with 403
   *  (minted with no role and no defaultRole, or a role outside
   *  allowedRoles). Lets the exposure classification below stay honest. */
  knownRejected?: boolean;
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

  const claims = auth.ui?.claims;

  const supplied = auth.ui?.token ?? env.KOZOU_ADAPTER_TOKEN;
  if (supplied !== undefined && supplied.length > 0) {
    // claims only apply to a token the CLI mints itself.
    const warning =
      claims !== undefined
        ? 'auth.ui.claims is ignored because a ready-made token is supplied ' +
          '(auth.ui.token / KOZOU_ADAPTER_TOKEN); put the claims in that token instead.'
        : undefined;
    return warning !== undefined ? { token: supplied, warning } : { token: supplied };
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
      claims,
    });
    const warnings: string[] = [];
    const reserved = reservedClaimCollisions(auth, claims);
    if (reserved.length > 0) {
      warnings.push(
        `auth.ui.claims key(s) ${reserved.map((k) => `"${k}"`).join(', ')} are ` +
          'reserved and overridden by the auth config (the role claim, iat, ' +
          'and iss/aud when configured).',
      );
    }
    // exp/nbf pass through (an intentionally expiring UI token is allowed),
    // but a value that provably fails verification — expired, not yet
    // valid, or not a number — would 401 every UI request from the start.
    const temporalWarning = temporalClaimsWarning(claims);
    if (temporalWarning !== undefined) warnings.push(temporalWarning);
    const roleWarning = mintedRoleWarning(auth, role);
    if (roleWarning !== undefined) warnings.push(roleWarning);
    if (warnings.length === 0) return { token };
    return {
      token,
      warning: warnings.join(' '),
      ...(roleWarning !== undefined || temporalWarning !== undefined
        ? { knownRejected: true }
        : {}),
    };
  }

  const claimsNote =
    claims !== undefined
      ? ' (auth.ui.claims is also unusable on this path — the CLI cannot mint)'
      : '';
  return {
    warning:
      'auth uses an RS256 public key, so the CLI cannot mint a token for the ' +
      'bundled Admin UI; it will be rejected with 401. Set auth.ui.token (or ' +
      'KOZOU_ADAPTER_TOKEN) to a token from your identity provider, or use an ' +
      `HS256 secret so the CLI can mint one${claimsNote}.`,
  };
}

// Keys in auth.ui.claims that the mint will override (or drop): the role
// claim is always reserved, `iat` is always set, and `iss`/`aud` are set
// when the auth config declares an issuer/audience. Surfaced as a startup
// warning so a colliding key is never a silent override.
function reservedClaimCollisions(
  auth: NonNullable<KozouConfig['auth']>,
  claims: Record<string, unknown> | undefined,
): string[] {
  if (claims === undefined) return [];
  const reserved = new Set<string>([auth.roleClaim ?? 'role', 'iat']);
  if (auth.jwt.issuer !== undefined) reserved.add('iss');
  if (auth.jwt.audience !== undefined) reserved.add('aud');
  return Object.keys(claims).filter((k) => reserved.has(k));
}

// `exp` / `nbf` in auth.ui.claims that provably make the minted token fail
// verification: already expired, not valid yet, or not a number (the
// verifier rejects malformed temporal claims). A well-formed future `exp`
// is intentional (an expiring UI token) and passes silently.
function temporalClaimsWarning(
  claims: Record<string, unknown> | undefined,
): string | undefined {
  if (claims === undefined) return undefined;
  const now = Math.floor(Date.now() / 1000);
  // Finite numbers only: YAML parses `.nan` / `.inf` to NaN / Infinity,
  // which survive a typeof check, serialize to null in the JWT payload,
  // and fail verification.
  if ('exp' in claims) {
    const exp = claims.exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) {
      return 'auth.ui.claims.exp is not a finite number (UNIX seconds), so ' +
        'the API rejects the minted Admin UI token (401).';
    }
    if (exp <= now) {
      return 'auth.ui.claims.exp is already in the past, so the API rejects ' +
        'the minted Admin UI token (401).';
    }
  }
  if ('nbf' in claims) {
    const nbf = claims.nbf;
    if (typeof nbf !== 'number' || !Number.isFinite(nbf)) {
      return 'auth.ui.claims.nbf is not a finite number (UNIX seconds), so ' +
        'the API rejects the minted Admin UI token (401).';
    }
    if (nbf > now) {
      return 'auth.ui.claims.nbf is in the future, so the API rejects the ' +
        'minted Admin UI token (401) until that time.';
    }
  }
  return undefined;
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
