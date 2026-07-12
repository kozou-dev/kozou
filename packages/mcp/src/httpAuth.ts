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
  /** Permit plaintext `http:` resource / authorization-server URLs on
   *  non-loopback hosts. Default false: loopback (localhost, 127.0.0.0/8,
   *  ::1) is always fine for local development, but any other plaintext
   *  URL is a startup error — these URLs are advertised to clients and
   *  carry bearer tokens, which must not cross a network unencrypted
   *  (OAuth 2.1). Opting in logs a startup warning; it exists for isolated
   *  test networks, never production. */
  allowInsecureHttp?: boolean;
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
  /** Non-loopback plaintext http URLs the operator explicitly waved through
   *  with `allowInsecureHttp` — surfaced so the server logs a warning. */
  insecureHttpUrls: string[];
  /** The configured role allowlist, surfaced for the dispatch-level check in
   *  `createMcpServer` (the authenticator already enforces it per request). */
  allowedRoles?: string[];
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

  // Both the resource and the advertised authorization servers carry bearer
  // tokens (and are handed to third-party clients via the PRM document), so
  // plaintext http is refused outside loopback unless the operator opts in.
  const insecureHttpUrls: string[] = [];
  const requireSecureTransport = (url: URL, what: string): void => {
    if (url.protocol !== 'http:' || isLoopbackUrl(url)) return;
    if (opts.allowInsecureHttp === true) {
      insecureHttpUrls.push(url.href);
      return;
    }
    throw new Error(
      `${errorContext}: ${what} "${url.href}" is plaintext http on a non-loopback host — ` +
        `bearer tokens would cross the network unencrypted. Use https, or set ` +
        `auth.allowInsecureHttp: true for an isolated test network.`,
    );
  };
  requireSecureTransport(resource, 'auth.resource');

  if (opts.authorizationServers.length === 0) {
    throw new Error(`${errorContext}: auth.authorizationServers must list at least one issuer URL.`);
  }
  for (const issuer of opts.authorizationServers) {
    let issuerUrl: URL;
    try {
      issuerUrl = new URL(issuer);
    } catch {
      throw new Error(
        `${errorContext}: auth.authorizationServers entry "${issuer}" is not a valid URL.`,
      );
    }
    if (issuerUrl.protocol !== 'https:' && issuerUrl.protocol !== 'http:') {
      throw new Error(
        `${errorContext}: auth.authorizationServers entry "${issuer}" must be an http(s) URL.`,
      );
    }
    requireSecureTransport(issuerUrl, 'auth.authorizationServers entry');
  }

  // The default audience is the canonical resource URI. NOTE the deliberate
  // absence of defaultRole / anonRole in the config passed down: this surface
  // rejects tokens without a role claim and requests without a token.
  const jwt: AuthConfig['jwt'] = { ...opts.jwt };
  if (jwt.audience === undefined) jwt.audience = opts.resource;
  // Bind the accepted token issuer to the advertised authorization server(s):
  // we publish `authorizationServers` in the protected-resource metadata, so a
  // token must actually come from one of them. Without this, a config that
  // omits `jwt.issuer` would accept any token signed by the configured key /
  // JWKS regardless of `iss` — an issuer-confusion path when key material is
  // shared across realms. An explicit `jwt.issuer` still wins (an operator who
  // sets it means it); otherwise the advertised servers become the expected
  // issuer (jose accepts a string[] and matches any). Either way `iss` is
  // always verified.
  if (jwt.issuer === undefined) {
    jwt.issuer =
      opts.authorizationServers.length === 1
        ? opts.authorizationServers[0]
        : opts.authorizationServers;
  }
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
    insecureHttpUrls,
    ...(opts.allowedRoles === undefined ? {} : { allowedRoles: opts.allowedRoles }),
  };
}

/** Loopback per the RFC 8252 native-app convention: `localhost`, any
 *  127.0.0.0/8 address, and `::1` (a WHATWG URL keeps IPv6 brackets in
 *  `hostname`, so they are stripped first). */
function isLoopbackUrl(url: URL): boolean {
  const host =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname;
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
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
