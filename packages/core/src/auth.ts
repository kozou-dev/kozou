// JWT verification shared by Kozou's authenticated surfaces (the REST API
// today; other transports can reuse it the same way). Pure over
// (Authorization header, config): verifies the token, resolves the database
// role to assume, and returns the claims. The caller then opens a
// transaction, runs `SET LOCAL ROLE <role>`, and exposes the claims to
// PostgreSQL so the schema author's own row-level-security policies decide
// what each request can see — kozou authenticates and switches role; it
// never writes policies.
//
// Transport-neutral: failures are thrown as KozouAuthError with a `kind`
// ('unauthorized' | 'forbidden') and each transport maps the kind to its own
// error shape (the REST layer maps to its 401/403 JSON bodies). This module
// is exported as `@kozou/core/auth` — a separate entry point so that
// browser-side consumers of `@kozou/core` never load jose.
//
// No node:http and no pg here, so this unit-tests with a signed token alone.

import {
  importSPKI,
  importJWK,
  jwtVerify,
  createRemoteJWKSet,
  SignJWT,
  errors as joseErrors,
  type JWTPayload,
  type JWTVerifyOptions,
  type JWTVerifyGetKey,
} from 'jose';

export type AuthErrorKind = 'unauthorized' | 'forbidden';

/** Authentication/authorization failure, independent of transport. `kind`
 *  is 'unauthorized' for any token problem (missing, malformed, expired,
 *  bad signature, …) and 'forbidden' for a role one; the message is safe
 *  to return to the caller (it never names which verification check
 *  failed). */
export class KozouAuthError extends Error {
  readonly kind: AuthErrorKind;

  constructor(kind: AuthErrorKind, message: string) {
    super(message);
    this.name = 'KozouAuthError';
    this.kind = kind;
  }
}

export type JwtAlgorithm = 'HS256' | 'RS256';

export type AuthConfig = {
  jwt: {
    /** Shared secret for HS256. Provide exactly one of secret / publicKey / jwksUri. */
    secret?: string;
    /** Verification key for RS256: a PEM (SPKI) string or a JWK JSON string. */
    publicKey?: string;
    /** URL of the provider's JWKS endpoint (Auth0 / Clerk / Supabase, …). The
     *  key is selected by the token's `kid`, fetched once, cached, and
     *  refreshed on rotation. Provide exactly one of secret / publicKey / jwksUri. */
    jwksUri?: string;
    /** Accepted algorithms. Defaults to ['HS256'] or ['RS256'] by key type. */
    algorithms?: JwtAlgorithm[];
    /** Expected `iss`. When set, a mismatch is rejected. A list accepts a
     *  token from any one of the issuers (jose matches any). */
    issuer?: string | string[];
    /** Expected `aud`. When set, a mismatch is rejected. */
    audience?: string | string[];
  };
  /** Claim that names the database role to assume. Default: 'role'. */
  roleClaim?: string;
  /** Allowlist of assumable roles. When set, any other role is forbidden. */
  allowedRoles?: string[];
  /** Role used when the token carries no role claim. */
  defaultRole?: string;
  /** Role assumed when a request carries NO Authorization header at all, so
   *  the database's RLS policies decide what an anonymous caller may see.
   *  Unset (default): a request with no token is rejected with 401. A present
   *  but invalid/expired token is always 401 — only a fully absent header is
   *  treated as anonymous (it is not subject to `allowedRoles`). */
  anonRole?: string;
  /** Runtime setting the claims are published under. Default 'request.jwt.claims'. */
  claimsGuc?: string;
};

export type AuthContext = { role: string; claims: JWTPayload };

export type Authenticator = {
  roleClaim: string;
  claimsGuc: string;
  /** Verify a raw `Authorization` header value and resolve the role.
   *  Throws a KozouAuthError: kind 'unauthorized' for any token problem,
   *  'forbidden' for a role one. */
  authenticate(authorizationHeader: string | undefined): Promise<AuthContext>;
};

// Registered JWT claims with temporal / issuer semantics the verifier (and
// the service-token mint) actively control. Naming one of these as the role
// claim cannot work — the role value would be validated as a timestamp or
// overridden by the mint — so it fails fast instead of failing per request.
const RESERVED_ROLE_CLAIMS: ReadonlySet<string> = new Set(['exp', 'nbf', 'iat', 'iss', 'aud']);

function assertUsableRoleClaim(roleClaim: string, context: string): void {
  if (RESERVED_ROLE_CLAIMS.has(roleClaim)) {
    throw new Error(
      `${context}: roleClaim "${roleClaim}" is a registered JWT claim ` +
        '("exp", "nbf", "iat", "iss", "aud") and cannot carry the role.',
    );
  }
}

/** Validate config (throws a plain Error at startup on misconfiguration),
 *  import the key once, and return a verifier closure. `errorContext`
 *  prefixes startup error messages so each consumer's operators see which
 *  surface is misconfigured (e.g. '@kozou/api auth'). */
export function createAuthenticator(
  config: AuthConfig,
  errorContext = 'kozou auth',
): Authenticator {
  const { jwt } = config;
  const hasSecret = typeof jwt.secret === 'string' && jwt.secret.length > 0;
  const hasPublicKey = typeof jwt.publicKey === 'string' && jwt.publicKey.length > 0;
  const hasJwksUri = typeof jwt.jwksUri === 'string' && jwt.jwksUri.length > 0;
  if ([hasSecret, hasPublicKey, hasJwksUri].filter(Boolean).length !== 1) {
    throw new Error(
      `${errorContext}: configure exactly one of jwt.secret (HS256), ` +
        'jwt.publicKey (RS256), or jwt.jwksUri (remote JWKS).',
    );
  }

  const algorithms = jwt.algorithms ?? (hasSecret ? ['HS256'] : ['RS256']);
  const roleClaim = config.roleClaim ?? 'role';
  assertUsableRoleClaim(roleClaim, errorContext);
  const claimsGuc = config.claimsGuc ?? 'request.jwt.claims';

  const verifyOptions: JWTVerifyOptions = { algorithms };
  if (jwt.issuer !== undefined) verifyOptions.issuer = jwt.issuer;
  if (jwt.audience !== undefined) verifyOptions.audience = jwt.audience;

  // Resolve the key once into a getKey function jose calls per token. A remote
  // JWKS resolves the key by `kid` (fetched + cached); a secret / static public
  // key is imported once and wrapped so the verify call is uniform.
  const getKey: Promise<JWTVerifyGetKey> = hasJwksUri
    ? Promise.resolve(createRemoteJWKSet(new URL(jwt.jwksUri as string)))
    : (hasSecret
        ? Promise.resolve(new TextEncoder().encode(jwt.secret))
        : importPublicKey(jwt.publicKey as string, algorithms[0] ?? 'RS256')
      ).then((key): JWTVerifyGetKey => () => Promise.resolve(key));

  return {
    roleClaim,
    claimsGuc,
    async authenticate(header) {
      const token = extractBearer(header);
      if (token === undefined) {
        // Only a fully absent header is anonymous. A present-but-malformed
        // header ("Basic …", "Bearer "} is a failed auth attempt, never
        // silently downgraded to the anonymous role.
        if (header === undefined && config.anonRole !== undefined) {
          return { role: config.anonRole, claims: {} };
        }
        throw new KozouAuthError('unauthorized', 'Missing or malformed Authorization header.');
      }
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, await getKey, verifyOptions));
      } catch (err) {
        // Any verification failure (signature, expiry, nbf, iss, aud, alg)
        // is 'unauthorized' with a generic message — never leak which check
        // failed.
        if (err instanceof joseErrors.JOSEError) {
          throw new KozouAuthError('unauthorized', 'Invalid or expired token.');
        }
        throw err;
      }
      return { role: resolveRole(payload, roleClaim, config), claims: payload };
    },
  };
}

function extractBearer(header: string | undefined): string | undefined {
  // Linear parse (no regex) to avoid backtracking on adversarial input:
  // split on the first space into "<scheme> <token>".
  if (header === undefined) return undefined;
  const trimmed = header.trim();
  const space = trimmed.indexOf(' ');
  if (space === -1) return undefined;
  if (trimmed.slice(0, space).toLowerCase() !== 'bearer') return undefined;
  const token = trimmed.slice(space + 1).trim();
  return token.length > 0 ? token : undefined;
}

async function importPublicKey(
  publicKey: string,
  algorithm: JwtAlgorithm,
): Promise<CryptoKey | Uint8Array> {
  const trimmed = publicKey.trim();
  if (trimmed.startsWith('-----BEGIN')) {
    return importSPKI(trimmed, algorithm);
  }
  return importJWK(JSON.parse(trimmed) as Record<string, unknown>, algorithm);
}

function resolveRole(payload: JWTPayload, roleClaim: string, config: AuthConfig): string {
  const claimed = payload[roleClaim];
  const role =
    typeof claimed === 'string' && claimed.length > 0 ? claimed : config.defaultRole;
  if (role === undefined || role.length === 0) {
    throw new KozouAuthError(
      'forbidden',
      'Token does not specify a role and no default role is configured.',
    );
  }
  if (config.allowedRoles !== undefined && !config.allowedRoles.includes(role)) {
    throw new KozouAuthError('forbidden', `Role "${role}" is not permitted.`);
  }
  return role;
}

export type ServiceTokenOptions = {
  /** HS256 shared secret used to sign. Must match the verifier's secret. */
  secret: string;
  /** Claim that names the database role. Default: 'role'. */
  roleClaim?: string;
  /** Role to assume. When omitted, no role claim is set and the verifier
   *  falls back to its configured defaultRole. */
  role?: string;
  /** `iss` to set; required when the verifier expects a matching issuer. */
  issuer?: string;
  /** `aud` to set; required when the verifier expects a matching audience. */
  audience?: string | string[];
  /** Extra claims merged into the payload (flat, shallow) — for RLS
   *  policies that read `request.jwt.claims` beyond the role, e.g. a
   *  tenant id. The role claim is always controlled by `role`/`roleClaim`
   *  (a colliding key here is dropped, even when no role is set); `iat`
   *  is always set by the mint; `iss`/`aud` win when `issuer`/`audience`
   *  are given. */
  claims?: Record<string, unknown>;
};

/**
 * Mint an HS256 service token for a trusted same-host caller — the bundled
 * Admin UI under `kozou dev`, which has no end user to obtain a token from.
 * The token is signed with the same HS256 secret the API verifies against
 * and carries the role claim the authenticator reads, so the caller runs
 * under that role with the schema author's own RLS policies applied.
 *
 * No `exp` is set: the token lives only for the lifetime of the dev process
 * that mints it and is passed in-process to the UI, never persisted. Minting
 * needs the shared secret, so it is HS256-only — an RS256 deployment must
 * supply a token from its identity provider instead.
 */
export async function signServiceToken(
  opts: ServiceTokenOptions,
  errorContext = 'kozou signServiceToken',
): Promise<string> {
  if (typeof opts.secret !== 'string' || opts.secret.length === 0) {
    throw new Error(`${errorContext}: a non-empty HS256 secret is required.`);
  }
  const roleClaim = opts.roleClaim ?? 'role';
  assertUsableRoleClaim(roleClaim, errorContext);
  // Extra claims first, so the explicit settings below always win. The
  // role claim is reserved unconditionally: dropping a colliding key even
  // when no `role` is set keeps the role decision in `role`/`defaultRole`
  // (a claims entry must not smuggle one in).
  const payload: JWTPayload = { ...(opts.claims ?? {}) };
  delete payload[roleClaim];
  if (typeof opts.role === 'string' && opts.role.length > 0) {
    payload[roleClaim] = opts.role;
  }
  let jwt = new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).setIssuedAt();
  if (opts.issuer !== undefined) jwt = jwt.setIssuer(opts.issuer);
  if (opts.audience !== undefined) jwt = jwt.setAudience(opts.audience);
  return jwt.sign(new TextEncoder().encode(opts.secret));
}
