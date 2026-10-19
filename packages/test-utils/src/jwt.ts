// Bearer tokens for exercising the OAuth refusal paths, built with node:crypto
// alone so any package's suite can use them without a direct jose dependency.
// Every refusal a token can provoke is listed once, in `refusalCases`, so the
// @kozou/mcp library suite and the kozou CLI suite drive the same requests.

import { createHmac, generateKeyPairSync, sign as rsaSign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const b64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

/** An HMAC-signed JWS over an arbitrary header and payload — including
 *  shapes a JWT library would refuse to build. */
export function hsToken(
  payload: unknown,
  opts: { secret: string; alg?: 'HS256' | 'HS384'; header?: Record<string, unknown> },
): string {
  const alg = opts.alg ?? 'HS256';
  const signingInput = `${b64url(JSON.stringify({ alg, typ: 'JWT', ...opts.header }))}.${b64url(JSON.stringify(payload))}`;
  const digest = alg === 'HS256' ? 'sha256' : 'sha384';
  return `${signingInput}.${createHmac(digest, opts.secret).update(signingInput).digest('base64url')}`;
}

/** Values planted in the tokens below that a refusal log must never repeat.
 *  Each is distinctive enough that finding it in captured output can only
 *  mean it was copied there from a token. */
export const SENTINEL = {
  issuer: 'https://sentinel-issuer-5b1e.example/realms/x',
  audience: 'https://sentinel-audience-8d27.example/mcp',
  subject: 'sentinel-subject-c40f',
  outsiderRole: 'sentinel_outsider_role_e93a',
  listedRole: 'sentinel_listed_role_71b2',
  scope: 'sentinel:scope:2f6d',
  jti: 'sentinel-jti-a8c5',
} as const;

export type RefusalCase = {
  code: string;
  status: 401 | 403;
  /** The Authorization header to send; undefined sends none. */
  authorization: string | undefined;
};

/** One request per refusal reason that a token (or its absence) can provoke
 *  against a server configured with an HS256 `secret`, the given issuer and
 *  audience, and `allowedRoles: [allowedRole]`. */
export function refusalCases(opts: {
  secret: string;
  issuer: string;
  audience: string;
  allowedRole: string;
}): RefusalCase[] {
  const now = Math.floor(Date.now() / 1000);
  const base = {
    iss: opts.issuer,
    aud: opts.audience,
    sub: SENTINEL.subject,
    jti: SENTINEL.jti,
    role: opts.allowedRole,
    scope: 'mcp:describe',
    iat: now,
    exp: now + 600,
  };
  const without = (key: keyof typeof base): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...base };
    delete copy[key];
    return copy;
  };
  const bearer = (payload: unknown, extra: Omit<Parameters<typeof hsToken>[1], 'secret'> = {}) =>
    `Bearer ${hsToken(payload, { secret: opts.secret, ...extra })}`;

  return [
    { code: 'no_token', status: 401, authorization: undefined },
    { code: 'malformed_header', status: 401, authorization: `Basic ${b64url(SENTINEL.subject)}` },
    { code: 'malformed_token', status: 401, authorization: `Bearer ${SENTINEL.subject}` },
    { code: 'algorithm_not_allowed', status: 401, authorization: bearer(base, { alg: 'HS384' }) },
    {
      code: 'bad_signature',
      status: 401,
      authorization: `Bearer ${hsToken(base, { secret: `${opts.secret}-other` })}`,
    },
    { code: 'expired', status: 401, authorization: bearer({ ...base, exp: now - 60 }) },
    { code: 'not_yet_valid', status: 401, authorization: bearer({ ...base, nbf: now + 3600 }) },
    { code: 'issuer_mismatch', status: 401, authorization: bearer({ ...base, iss: SENTINEL.issuer }) },
    { code: 'issuer_missing', status: 401, authorization: bearer(without('iss')) },
    {
      code: 'audience_mismatch',
      status: 401,
      authorization: bearer({ ...base, aud: SENTINEL.audience }),
    },
    { code: 'audience_missing', status: 401, authorization: bearer(without('aud')) },
    { code: 'claims_invalid', status: 401, authorization: bearer({ ...base, exp: 'soon' }) },
    {
      // An unrecognised critical header parameter: refused by the verifier,
      // under none of the classified reasons.
      code: 'other_token_error',
      status: 401,
      authorization: bearer(base, { header: { crit: ['x-kozou-test'], 'x-kozou-test': 1 } }),
    },
    { code: 'role_missing', status: 403, authorization: bearer(without('role')) },
    {
      code: 'role_unreadable',
      status: 403,
      authorization: bearer({ ...base, role: [SENTINEL.listedRole] }),
    },
    {
      code: 'role_not_allowed',
      status: 403,
      authorization: bearer({ ...base, role: SENTINEL.outsiderRole }),
    },
    {
      code: 'insufficient_scope',
      status: 403,
      authorization: bearer({ ...base, scope: `openid ${SENTINEL.scope}` }),
    },
  ];
}

export type JwksServer = {
  jwksUri: string;
  /** An RS256 token signed with key "k1", under `kid` (null: no kid at all,
   *  which two published RS256 keys leave ambiguous). */
  sign(payload: unknown, kid?: string | null): string;
  /** While true, the key set answers 500. */
  failing: boolean;
  close(): Promise<void>;
};

/** A loopback JWKS endpoint publishing two RS256 keys, kids "k1" and "k2". */
export async function startJwksServer(): Promise<JwksServer> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const second = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = (key: KeyObject, kid: string) => ({
    ...(key.export({ format: 'jwk' }) as Record<string, unknown>),
    kid,
    alg: 'RS256',
    use: 'sig',
  });
  const keys = [jwk(publicKey, 'k1'), jwk(second.publicKey, 'k2')];
  const state = { failing: false };
  const server: Server = createServer((_req, res) => {
    if (state.failing) {
      res.writeHead(500);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    jwksUri: `http://127.0.0.1:${port}/jwks`,
    sign: (payload, kid = 'k1') => rsToken(payload, privateKey, kid),
    get failing() {
      return state.failing;
    },
    set failing(value: boolean) {
      state.failing = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function rsToken(payload: unknown, privateKey: KeyObject, kid: string | null): string {
  const header = kid === null ? { alg: 'RS256', typ: 'JWT' } : { alg: 'RS256', typ: 'JWT', kid };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${rsaSign('sha256', Buffer.from(signingInput), privateKey).toString('base64url')}`;
}
