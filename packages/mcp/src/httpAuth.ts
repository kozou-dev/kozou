// OAuth 2.1 resource-server support for the MCP Streamable HTTP transport
// (MCP authorization, 2025-11-25 spec). kozou is a *resource server only*:
// it verifies bearer tokens issued by the operator's own authorization
// server and advertises that server via RFC 9728 protected-resource
// metadata. It never issues tokens, hosts a login/consent UI, or registers
// clients — those belong to the operator's IdP.
//
// Verification reuses the shared JWT layer in `@kozou/core/auth` (the same
// semantics as the REST surface), with two deliberate divergences for the
// MCP surface:
//   - No anonymous access: a request without a token is always 401. There
//     is no anonRole equivalent (describe metadata is worth protecting).
//   - No default role: a verified token whose role claim is missing is
//     rejected. Applying a default here would silently grant a role to
//     any authenticated principal the IdP admin has not explicitly
//     assigned one (e.g. a federated first-time user), which is an
//     implicit elevation. Role assignment stays an explicit IdP action.

import type { IncomingMessage } from 'node:http';

import {
  createAuthenticator,
  type AuthConfig,
  type Authenticator,
  type AuthContext,
} from '@kozou/core/auth';

/** Scope names used when the operator does not rename them. The `scopes`
 *  map exists so a deployment whose IdP prefixes scope names (e.g.
 *  `api://kozou-mcp/mcp.describe`) can declare the expected names; the
 *  token's scopes are matched against these exactly. */
export const DEFAULT_DESCRIBE_SCOPE = 'mcp:describe';
export const DEFAULT_EXECUTE_SCOPE = 'mcp:execute';
export const DEFAULT_ADMIN_SCOPE = 'mcp:admin';

const WELL_KNOWN_PATH = '/.well-known/oauth-protected-resource';

export type McpHttpAuthOptions = {
  /** Canonical resource URI of this MCP server (RFC 8707 / RFC 9728).
   *  Always configured explicitly — never derived from the Host header
   *  (header-derived identities are exactly what the DNS-rebinding guard
   *  exists to distrust). Behind a tunnel / reverse proxy this is the
   *  public URL, e.g. `https://mcp.example.com/mcp`. It is also the
   *  default expected `aud` of every accepted token. */
  resource: string;
  /** Authorization-server issuer URLs advertised in the protected-resource
   *  metadata. Clients discover the IdP from this list. */
  authorizationServers: string[];
  /** JWT verification config (one of jwksUri / publicKey / secret, plus
   *  issuer / algorithms). When `audience` is omitted it defaults to
   *  `resource` — note this is deliberately NOT the REST surface's
   *  audience (a client id); the MCP resource is its own audience. */
  jwt: AuthConfig['jwt'];
  /** Claim that names the database role. Default: 'role'. A token without
   *  this claim is rejected (there is no default role on this surface). */
  roleClaim?: string;
  /** Allowlist of assumable roles. When set, any other role is forbidden. */
  allowedRoles?: string[];
  /** Expected scope names, matched exactly against the token's `scope` /
   *  `scp` claim. Defaults: mcp:describe / mcp:execute / mcp:admin. */
  scopes?: { describe?: string; execute?: string; admin?: string };
  /** Extra scope names appended to the advertised `scopes_supported`.
   *  Clients treat the PRM scope list as "what to request from the AS"
   *  (some echo it verbatim into dynamic client registration), so list
   *  everything a client should ask for — e.g. `offline_access` when the
   *  AS requires it for refresh tokens (Keycloak). These are advertised
   *  only; kozou itself never requires them. */
  extraScopesSupported?: string[];
  /** Keep `POST /admin/refresh` reachable in auth mode, gated on a valid
   *  token carrying the admin scope. Default false: the route is disabled
   *  (404, indistinguishable from an unknown path). */
  adminRefresh?: boolean;
};

/** The verified per-request identity handed to the MCP layer. */
export type McpAuthContext = {
  role: string;
  claims: AuthContext['claims'];
  scopes: Set<string>;
  token: string;
};

/** Resolved resource-server state, built once at startup. */
export type McpHttpAuth = {
  authenticator: Authenticator;
  resource: URL;
  scopes: { describe: string; execute: string; admin: string };
  /** Serialized RFC 9728 protected-resource metadata document. */
  prmBody: string;
  /** Local paths that serve the metadata document: the root well-known
   *  form plus the path-insertion form(s). Real clients derive either
   *  form from the endpoint URL they were given, so both are served. */
  prmPaths: Set<string>;
  /** Absolute metadata URL used in WWW-Authenticate challenges. */
  resourceMetadataUrl: string;
  adminRefresh: boolean;
};

/** Validate the auth options and build the resolved resource-server state.
 *  Throws a plain Error at startup on misconfiguration (never per request). */
export function resolveMcpHttpAuth(opts: McpHttpAuthOptions, mcpPath: string): McpHttpAuth {
  const errorContext = '@kozou/mcp auth';

  let resource: URL;
  try {
    resource = new URL(opts.resource);
  } catch {
    throw new Error(`${errorContext}: auth.resource "${opts.resource}" is not a valid URL.`);
  }
  if (resource.protocol !== 'https:' && resource.protocol !== 'http:') {
    throw new Error(`${errorContext}: auth.resource must be an http(s) URL.`);
  }
  if (resource.hash !== '' || resource.search !== '') {
    throw new Error(
      `${errorContext}: auth.resource must not carry a query or fragment (RFC 8707 canonical URI).`,
    );
  }

  if (opts.authorizationServers.length === 0) {
    throw new Error(`${errorContext}: auth.authorizationServers must list at least one issuer URL.`);
  }
  for (const issuer of opts.authorizationServers) {
    try {
      new URL(issuer);
    } catch {
      throw new Error(
        `${errorContext}: auth.authorizationServers entry "${issuer}" is not a valid URL.`,
      );
    }
  }

  // The default audience is the canonical resource URI. NOTE the deliberate
  // absence of defaultRole / anonRole in the config passed down: this surface
  // rejects tokens without a role claim and requests without a token.
  const jwt: AuthConfig['jwt'] = { ...opts.jwt };
  if (jwt.audience === undefined) jwt.audience = opts.resource;
  const authenticator = createAuthenticator(
    {
      jwt,
      ...(opts.roleClaim === undefined ? {} : { roleClaim: opts.roleClaim }),
      ...(opts.allowedRoles === undefined ? {} : { allowedRoles: opts.allowedRoles }),
    },
    errorContext,
  );

  const scopes = {
    describe: opts.scopes?.describe ?? DEFAULT_DESCRIBE_SCOPE,
    execute: opts.scopes?.execute ?? DEFAULT_EXECUTE_SCOPE,
    admin: opts.scopes?.admin ?? DEFAULT_ADMIN_SCOPE,
  };

  // scopes_supported advertises what an MCP client should request from the
  // AS. The admin scope is intentionally NOT advertised: it gates an
  // operator-facing endpoint, and clients that echo this list into their
  // registration would otherwise request an admin grant they never need.
  const scopesSupported = [scopes.describe, scopes.execute, ...(opts.extraScopesSupported ?? [])];
  const prmBody = JSON.stringify({
    resource: opts.resource,
    authorization_servers: opts.authorizationServers,
    scopes_supported: scopesSupported,
    bearer_methods_supported: ['header'],
  });

  // Serve the metadata on the root well-known path and on the
  // path-insertion forms for both the canonical resource path and the
  // locally served MCP path (they can differ behind a proxy).
  const prmPaths = new Set<string>([WELL_KNOWN_PATH]);
  const resourcePath = trimTrailingSlash(resource.pathname);
  if (resourcePath !== '') prmPaths.add(WELL_KNOWN_PATH + resourcePath);
  const localPath = trimTrailingSlash(mcpPath);
  if (localPath !== '') prmPaths.add(WELL_KNOWN_PATH + localPath);

  const resourceMetadataUrl =
    resource.origin + (resourcePath !== '' ? WELL_KNOWN_PATH + resourcePath : WELL_KNOWN_PATH);

  return {
    authenticator,
    resource,
    scopes,
    prmBody,
    prmPaths,
    resourceMetadataUrl,
    adminRefresh: opts.adminRefresh ?? false,
  };
}

function trimTrailingSlash(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  return trimmed === '' || trimmed === '/' ? '' : trimmed;
}

/** Collect the token's scopes from the `scope` claim (space-delimited
 *  string, RFC 8693 / RFC 6749) and the `scp` claim (Entra ID: string;
 *  some IdPs: array). Matching against the configured names is exact. */
export function extractScopes(claims: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    for (const s of value.split(' ')) {
      if (s.length > 0) out.add(s);
    }
  };
  add(claims['scope']);
  const scp = claims['scp'];
  if (Array.isArray(scp)) {
    for (const s of scp) add(s);
  } else {
    add(scp);
  }
  return out;
}

/** Verify the request's bearer token and resolve the caller's identity.
 *  Throws KozouAuthError ('unauthorized' for token problems, 'forbidden'
 *  for role ones) — the HTTP layer maps these onto 401 / 403. */
export async function authenticateRequest(
  auth: McpHttpAuth,
  req: IncomingMessage,
): Promise<McpAuthContext> {
  const header = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  const ctx = await auth.authenticator.authenticate(header);
  return {
    role: ctx.role,
    claims: ctx.claims,
    scopes: extractScopes(ctx.claims),
    token: bearerToken(header),
  };
}

/** The raw token portion of a Bearer Authorization header. Only called after
 *  the authenticator accepted the header, so the fallbacks never trigger in
 *  practice; they keep this total. */
function bearerToken(header: string | undefined): string {
  if (header === undefined) return '';
  const trimmed = header.trim();
  const space = trimmed.indexOf(' ');
  return space === -1 ? '' : trimmed.slice(space + 1).trim();
}
