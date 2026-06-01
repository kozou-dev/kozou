// JWT verification for the read/write path. Pure over (Authorization header,
// config): verifies the token, resolves the database role to assume, and
// returns the claims. The caller (startApiServer) then opens a transaction,
// runs `SET LOCAL ROLE <role>`, and exposes the claims to PostgreSQL so the
// schema author's own row-level-security policies decide what each request
// can see — kozou authenticates and switches role; it never writes policies.
//
// No node:http and no pg here, so this unit-tests with a signed token alone.

import {
  importSPKI,
  importJWK,
  jwtVerify,
  errors as joseErrors,
  type JWTPayload,
  type JWTVerifyOptions,
} from 'jose';
import { unauthorized, forbidden } from './errors.js';

export type JwtAlgorithm = 'HS256' | 'RS256';

export type AuthConfig = {
  jwt: {
    /** Shared secret for HS256. Provide exactly one of secret / publicKey. */
    secret?: string;
    /** Verification key for RS256: a PEM (SPKI) string or a JWK JSON string. */
    publicKey?: string;
    /** Accepted algorithms. Defaults to ['HS256'] or ['RS256'] by key type. */
    algorithms?: JwtAlgorithm[];
    /** Expected `iss`. When set, a mismatch is rejected. */
    issuer?: string;
    /** Expected `aud`. When set, a mismatch is rejected. */
    audience?: string | string[];
  };
  /** Claim that names the database role to assume. Default: 'role'. */
  roleClaim?: string;
  /** Allowlist of assumable roles. When set, any other role is forbidden. */
  allowedRoles?: string[];
  /** Role used when the token carries no role claim. */
  defaultRole?: string;
  /** Runtime setting the claims are published under. Default 'request.jwt.claims'. */
  claimsGuc?: string;
};

export type AuthContext = { role: string; claims: JWTPayload };

export type Authenticator = {
  roleClaim: string;
  claimsGuc: string;
  /** Verify a raw `Authorization` header value and resolve the role.
   *  Throws a 401 KozouApiError for any token problem, 403 for a role one. */
  authenticate(authorizationHeader: string | undefined): Promise<AuthContext>;
};

/** Validate config (throws a plain Error at startup on misconfiguration),
 *  import the key once, and return a verifier closure. */
export function createAuthenticator(config: AuthConfig): Authenticator {
  const { jwt } = config;
  const hasSecret = typeof jwt.secret === 'string' && jwt.secret.length > 0;
  const hasPublicKey = typeof jwt.publicKey === 'string' && jwt.publicKey.length > 0;
  if (hasSecret === hasPublicKey) {
    throw new Error(
      '@kozou/api auth: configure exactly one of jwt.secret (HS256) or jwt.publicKey (RS256).',
    );
  }

  const algorithms = jwt.algorithms ?? (hasSecret ? ['HS256'] : ['RS256']);
  const roleClaim = config.roleClaim ?? 'role';
  const claimsGuc = config.claimsGuc ?? 'request.jwt.claims';

  const verifyOptions: JWTVerifyOptions = { algorithms };
  if (jwt.issuer !== undefined) verifyOptions.issuer = jwt.issuer;
  if (jwt.audience !== undefined) verifyOptions.audience = jwt.audience;

  // Resolve key material once; reused for every request.
  const keyPromise: Promise<CryptoKey | Uint8Array> = hasSecret
    ? Promise.resolve(new TextEncoder().encode(jwt.secret))
    : importPublicKey(jwt.publicKey as string, algorithms[0] ?? 'RS256');

  return {
    roleClaim,
    claimsGuc,
    async authenticate(header) {
      const token = extractBearer(header);
      if (token === undefined) {
        throw unauthorized('Missing or malformed Authorization header.');
      }
      let payload: JWTPayload;
      try {
        const key = await keyPromise;
        ({ payload } = await jwtVerify(token, key, verifyOptions));
      } catch (err) {
        // Any verification failure (signature, expiry, nbf, iss, aud, alg)
        // is a 401 with a generic message — never leak which check failed.
        if (err instanceof joseErrors.JOSEError) {
          throw unauthorized('Invalid or expired token.');
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
    throw forbidden('Token does not specify a role and no default role is configured.');
  }
  if (config.allowedRoles !== undefined && !config.allowedRoles.includes(role)) {
    throw forbidden(`Role "${role}" is not permitted.`);
  }
  return role;
}
