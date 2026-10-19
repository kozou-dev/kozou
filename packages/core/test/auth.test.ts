import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CompactSign, SignJWT, generateKeyPair, exportSPKI, exportJWK } from 'jose';
import {
  createAuthenticator,
  signServiceToken,
  KozouAuthError,
  type AuthConfig,
  type AuthErrorKind,
  type AuthFailureReason,
} from '../src/auth.js';

const SECRET = 'test-secret-do-not-use';
const secretKey = new TextEncoder().encode(SECRET);

type SignOpts = {
  alg?: string;
  key?: Uint8Array | CryptoKey;
  exp?: string | number | false;
  nbf?: string | number;
  iss?: string;
  aud?: string;
};

async function sign(payload: Record<string, unknown>, opts: SignOpts = {}): Promise<string> {
  let jwt = new SignJWT(payload).setProtectedHeader({ alg: opts.alg ?? 'HS256' }).setIssuedAt();
  if (opts.exp !== false) jwt = jwt.setExpirationTime(opts.exp ?? '1h');
  if (opts.nbf !== undefined) jwt = jwt.setNotBefore(opts.nbf);
  if (opts.iss !== undefined) jwt = jwt.setIssuer(opts.iss);
  if (opts.aud !== undefined) jwt = jwt.setAudience(opts.aud);
  return jwt.sign(opts.key ?? secretKey);
}

const hs = (extra: Partial<AuthConfig> = {}): AuthConfig => ({ jwt: { secret: SECRET }, ...extra });

async function expectError(
  fn: () => Promise<unknown>,
  kind: AuthErrorKind,
  message?: string | RegExp,
): Promise<void> {
  try {
    await fn();
    expect.unreachable('should have thrown');
  } catch (err) {
    expect(err).toBeInstanceOf(KozouAuthError);
    expect((err as KozouAuthError).kind).toBe(kind);
    if (message !== undefined) {
      if (typeof message === 'string') {
        expect((err as KozouAuthError).message).toBe(message);
      } else {
        expect((err as KozouAuthError).message).toMatch(message);
      }
    }
  }
}

describe('createAuthenticator — config validation', () => {
  it('throws when both secret and publicKey are set', () => {
    expect(() => createAuthenticator({ jwt: { secret: 's', publicKey: 'p' } })).toThrow(
      /exactly one/,
    );
  });
  it('throws when neither secret nor publicKey is set', () => {
    expect(() => createAuthenticator({ jwt: {} })).toThrow(/exactly one/);
  });
  it('throws when secret and jwksUri are both set', () => {
    expect(() =>
      createAuthenticator({ jwt: { secret: 's', jwksUri: 'https://idp.example/jwks' } }),
    ).toThrow(/exactly one/);
  });
  it('accepts jwksUri as the sole key source', () => {
    expect(() =>
      createAuthenticator({ jwt: { jwksUri: 'https://idp.example/jwks' } }),
    ).not.toThrow();
  });
  it('defaults roleClaim and claimsGuc', () => {
    const a = createAuthenticator(hs());
    expect(a.roleClaim).toBe('role');
    expect(a.claimsGuc).toBe('request.jwt.claims');
  });
  it('prefixes startup errors with the default error context', () => {
    expect(() => createAuthenticator({ jwt: {} })).toThrow(/^kozou auth: /);
  });
  it("prefixes startup errors with the caller's error context", () => {
    expect(() => createAuthenticator({ jwt: {} }, '@kozou/api auth')).toThrow(
      /^@kozou\/api auth: /,
    );
    expect(() => createAuthenticator(hs({ roleClaim: 'exp' }), '@kozou/api auth')).toThrow(
      /^@kozou\/api auth: /,
    );
  });
});

describe('authenticate — HS256', () => {
  it('verifies a valid token and returns role + claims', async () => {
    const a = createAuthenticator(hs());
    const token = await sign({ role: 'app_reader', sub: 'ada' });
    const ctx = await a.authenticate(`Bearer ${token}`);
    expect(ctx.role).toBe('app_reader');
    expect(ctx.claims.sub).toBe('ada');
  });

  it('rejects an expired token (unauthorized)', async () => {
    const a = createAuthenticator(hs());
    const token = await sign({ role: 'app_reader' }, { exp: Math.floor(Date.now() / 1000) - 60 });
    await expectError(() => a.authenticate(`Bearer ${token}`), 'unauthorized');
  });

  it('rejects a bad signature (unauthorized)', async () => {
    const a = createAuthenticator(hs());
    const token = await sign({ role: 'app_reader' }, { key: new TextEncoder().encode('other-secret') });
    await expectError(() => a.authenticate(`Bearer ${token}`), 'unauthorized');
  });

  it('rejects a not-yet-valid token (unauthorized)', async () => {
    const a = createAuthenticator(hs());
    const token = await sign({ role: 'app_reader' }, { nbf: Math.floor(Date.now() / 1000) + 3600 });
    await expectError(() => a.authenticate(`Bearer ${token}`), 'unauthorized');
  });

  it('rejects an issuer mismatch (unauthorized)', async () => {
    const a = createAuthenticator(hs({ jwt: { secret: SECRET, issuer: 'expected' } }));
    const token = await sign({ role: 'app_reader' }, { iss: 'other' });
    await expectError(() => a.authenticate(`Bearer ${token}`), 'unauthorized');
  });

  it('rejects an audience mismatch (unauthorized)', async () => {
    const a = createAuthenticator(hs({ jwt: { secret: SECRET, audience: 'aud-a' } }));
    const token = await sign({ role: 'app_reader' }, { aud: 'aud-b' });
    await expectError(() => a.authenticate(`Bearer ${token}`), 'unauthorized');
  });

  it('rejects a disallowed algorithm (unauthorized)', async () => {
    const a = createAuthenticator(hs({ jwt: { secret: SECRET, algorithms: ['HS256'] } }));
    const token = await sign({ role: 'app_reader' }, { alg: 'HS384' });
    await expectError(() => a.authenticate(`Bearer ${token}`), 'unauthorized');
  });

  it('rejects a missing / malformed Authorization header (unauthorized)', async () => {
    const a = createAuthenticator(hs());
    await expectError(() => a.authenticate(undefined), 'unauthorized');
    await expectError(() => a.authenticate('Bearer'), 'unauthorized');
    await expectError(() => a.authenticate('Basic abc123'), 'unauthorized');
  });

  it('never names the failed verification check (generic message)', async () => {
    const a = createAuthenticator(hs());
    const token = await sign({ role: 'app_reader' }, { exp: Math.floor(Date.now() / 1000) - 60 });
    try {
      await a.authenticate(`Bearer ${token}`);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as KozouAuthError).message).toBe('Invalid or expired token.');
    }
  });
});

describe('authenticate — RS256 (static public key)', () => {
  it('verifies a token signed with the matching private key', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const spki = await exportSPKI(publicKey);
    const a = createAuthenticator({ jwt: { publicKey: spki } });
    const token = await sign({ role: 'app_reader', sub: 'ada' }, { alg: 'RS256', key: privateKey });
    const ctx = await a.authenticate(`Bearer ${token}`);
    expect(ctx.role).toBe('app_reader');
  });

  it('rejects a token signed by a different key (unauthorized)', async () => {
    const { publicKey } = await generateKeyPair('RS256');
    const other = await generateKeyPair('RS256');
    const spki = await exportSPKI(publicKey);
    const a = createAuthenticator({ jwt: { publicKey: spki } });
    const token = await sign({ role: 'app_reader' }, { alg: 'RS256', key: other.privateKey });
    await expectError(() => a.authenticate(`Bearer ${token}`), 'unauthorized');
  });
});

describe('authenticate — remote JWKS', () => {
  // Serve a JWKS over loopback so the createRemoteJWKSet path is exercised
  // end to end without an external network.
  async function withJwksServer(
    jwks: unknown,
    run: (jwksUri: string) => Promise<void>,
  ): Promise<void> {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(jwks));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${port}/.well-known/jwks.json`);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  }

  async function rsJwk(): Promise<{ jwk: Record<string, unknown>; privateKey: CryptoKey }> {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = (await exportJWK(publicKey)) as Record<string, unknown>;
    jwk.kid = 'test-key';
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    return { jwk, privateKey };
  }

  it('verifies a token against the published JWKS', async () => {
    const { jwk, privateKey } = await rsJwk();
    await withJwksServer({ keys: [jwk] }, async (jwksUri) => {
      const a = createAuthenticator({ jwt: { jwksUri } });
      const token = await new SignJWT({ role: 'app_reader' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      const ctx = await a.authenticate(`Bearer ${token}`);
      expect(ctx.role).toBe('app_reader');
    });
  });

  it('rejects a token whose kid is absent from the JWKS (unauthorized)', async () => {
    const { jwk } = await rsJwk();
    const other = await generateKeyPair('RS256');
    await withJwksServer({ keys: [jwk] }, async (jwksUri) => {
      const a = createAuthenticator({ jwt: { jwksUri } });
      const token = await new SignJWT({ role: 'app_reader' })
        .setProtectedHeader({ alg: 'RS256', kid: 'other-key' })
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(other.privateKey);
      await expectError(() => a.authenticate(`Bearer ${token}`), 'unauthorized');
    });
  });
});

describe('authenticate — role resolution', () => {
  it('uses the role claim', async () => {
    const a = createAuthenticator(hs());
    const ctx = await a.authenticate(`Bearer ${await sign({ role: 'writer' })}`);
    expect(ctx.role).toBe('writer');
  });

  it('falls back to defaultRole when the claim is absent', async () => {
    const a = createAuthenticator(hs({ defaultRole: 'anon_reader' }));
    const ctx = await a.authenticate(`Bearer ${await sign({ sub: 'x' })}`);
    expect(ctx.role).toBe('anon_reader');
  });

  it('forbids when no role claim and no default (forbidden)', async () => {
    const a = createAuthenticator(hs());
    const token = await sign({ sub: 'x' });
    await expectError(() => a.authenticate(`Bearer ${token}`), 'forbidden');
  });

  // A claim that is present but cannot name a role means the role could not be
  // read — not that the token named none — so defaultRole must not answer for
  // it. A group mapper emitting a list is the ordinary way to get here.
  it('forbids a list-valued role claim instead of falling back to defaultRole', async () => {
    const a = createAuthenticator(hs({ defaultRole: 'anon_reader' }));
    const token = await sign({ role: ['app_admin', 'app_reader'] });
    await expectError(
      () => a.authenticate(`Bearer ${token}`),
      'forbidden',
      'Token\'s "role" claim is a list, not a role name.',
    );
  });

  it('forbids a list-valued role claim when the default is itself allowlisted', async () => {
    // Proves the refusal is not the allowlist doing the work: without this
    // rule the request would run as 'anon_reader', which the allowlist admits.
    const a = createAuthenticator(
      hs({ defaultRole: 'anon_reader', allowedRoles: ['anon_reader', 'app_reader'] }),
    );
    const token = await sign({ role: ['app_reader'] });
    await expectError(() => a.authenticate(`Bearer ${token}`), 'forbidden', /is a list/);
  });

  it('forbids an empty-string role claim', async () => {
    const a = createAuthenticator(hs({ defaultRole: 'anon_reader' }));
    const token = await sign({ role: '' });
    await expectError(
      () => a.authenticate(`Bearer ${token}`),
      'forbidden',
      'Token\'s "role" claim is an empty string, not a role name.',
    );
  });

  it('forbids a number-valued role claim', async () => {
    const a = createAuthenticator(hs({ defaultRole: 'anon_reader' }));
    const token = await sign({ role: 42 });
    await expectError(
      () => a.authenticate(`Bearer ${token}`),
      'forbidden',
      'Token\'s "role" claim is a number, not a role name.',
    );
  });

  it('forbids a null role claim', async () => {
    const a = createAuthenticator(hs({ defaultRole: 'anon_reader' }));
    const token = await sign({ role: null });
    await expectError(
      () => a.authenticate(`Bearer ${token}`),
      'forbidden',
      'Token\'s "role" claim is null, not a role name.',
    );
  });

  it('forbids an object-valued role claim', async () => {
    const a = createAuthenticator(hs({ defaultRole: 'anon_reader' }));
    const token = await sign({ role: { realm: 'app_reader' } });
    await expectError(
      () => a.authenticate(`Bearer ${token}`),
      'forbidden',
      'Token\'s "role" claim is an object, not a role name.',
    );
  });

  it('names the configured claim, not the default one, in the refusal', async () => {
    const a = createAuthenticator(hs({ roleClaim: 'https://kozou.org/role' }));
    const token = await sign({ 'https://kozou.org/role': ['a'] });
    await expectError(
      () => a.authenticate(`Bearer ${token}`),
      'forbidden',
      'Token\'s "https://kozou.org/role" claim is a list, not a role name.',
    );
  });

  it('forbids an empty list, the shape a mapper emits for "no roles assigned"', async () => {
    const a = createAuthenticator(hs({ defaultRole: 'anon_reader' }));
    const token = await sign({ role: [] });
    await expectError(
      () => a.authenticate(`Bearer ${token}`),
      'forbidden',
      'Token\'s "role" claim is a list, not a role name.',
    );
  });

  it('forbids a boolean role claim, either way round', async () => {
    const a = createAuthenticator(hs({ defaultRole: 'anon_reader' }));
    for (const value of [false, true]) {
      const token = await sign({ role: value });
      await expectError(
        () => a.authenticate(`Bearer ${token}`),
        'forbidden',
        'Token\'s "role" claim is a boolean, not a role name.',
      );
    }
  });

  it('still falls back to defaultRole when a different claim is present', async () => {
    // The rule keys on the role claim itself, not on the payload being sparse.
    const a = createAuthenticator(hs({ defaultRole: 'anon_reader' }));
    const ctx = await a.authenticate(`Bearer ${await sign({ groups: ['x'], sub: 'y' })}`);
    expect(ctx.role).toBe('anon_reader');
  });

  // The presence test is on own properties. Reading it off the prototype chain
  // would make a roleClaim named after an Object.prototype member read as
  // present on every token, refusing every request and naming a claim the
  // token does not carry.
  it.each(['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty'])(
    'falls back to defaultRole when the roleClaim is named %s and the token omits it',
    async (roleClaim) => {
      const a = createAuthenticator(hs({ roleClaim, defaultRole: 'anon_reader' }));
      const ctx = await a.authenticate(`Bearer ${await sign({ sub: 'x' })}`);
      expect(ctx.role).toBe('anon_reader');
    },
  );

  it('honours a prototype-named roleClaim the token actually carries', async () => {
    const a = createAuthenticator(hs({ roleClaim: 'toString', defaultRole: 'anon_reader' }));
    const ctx = await a.authenticate(`Bearer ${await sign({ toString: 'app_reader' })}`);
    expect(ctx.role).toBe('app_reader');
  });

  it('forbids when the claim is absent and defaultRole is an empty string', async () => {
    // An empty default is not a role; it must not reach SET LOCAL ROLE "".
    const a = createAuthenticator(hs({ defaultRole: '' }));
    const token = await sign({ sub: 'x' });
    await expectError(
      () => a.authenticate(`Bearer ${token}`),
      'forbidden',
      'Token does not specify a role and no default role is configured.',
    );
  });

  it('forbids a role outside the allowlist (forbidden)', async () => {
    const a = createAuthenticator(hs({ allowedRoles: ['app_reader'] }));
    const token = await sign({ role: 'evil' });
    await expectError(() => a.authenticate(`Bearer ${token}`), 'forbidden');
  });

  it('allows a role inside the allowlist', async () => {
    const a = createAuthenticator(hs({ allowedRoles: ['app_reader'] }));
    const ctx = await a.authenticate(`Bearer ${await sign({ role: 'app_reader' })}`);
    expect(ctx.role).toBe('app_reader');
  });

  it('honours a custom roleClaim', async () => {
    const a = createAuthenticator(hs({ roleClaim: 'kozou_role' }));
    const ctx = await a.authenticate(`Bearer ${await sign({ kozou_role: 'custom' })}`);
    expect(ctx.role).toBe('custom');
  });
});

describe('authenticate — anonymous role', () => {
  it('assumes anonRole with empty claims when the header is absent', async () => {
    const a = createAuthenticator(hs({ anonRole: 'web_anon' }));
    const ctx = await a.authenticate(undefined);
    expect(ctx.role).toBe('web_anon');
    expect(ctx.claims).toEqual({});
  });

  it('still rejects an absent header (unauthorized) when no anonRole is set', async () => {
    const a = createAuthenticator(hs());
    await expectError(() => a.authenticate(undefined), 'unauthorized');
  });

  it('does not downgrade a malformed header to anonymous (unauthorized)', async () => {
    const a = createAuthenticator(hs({ anonRole: 'web_anon' }));
    await expectError(() => a.authenticate('Basic abc'), 'unauthorized');
    await expectError(() => a.authenticate('Bearer '), 'unauthorized');
  });

  it('does not downgrade an invalid token to anonymous (unauthorized)', async () => {
    const a = createAuthenticator(hs({ anonRole: 'web_anon' }));
    await expectError(() => a.authenticate('Bearer not-a-jwt'), 'unauthorized');
  });

  it('does not apply allowedRoles to the anonymous role', async () => {
    const a = createAuthenticator(hs({ anonRole: 'web_anon', allowedRoles: ['app_reader'] }));
    const ctx = await a.authenticate(undefined);
    expect(ctx.role).toBe('web_anon');
  });
});

describe('authenticate — the refusal reason', () => {
  // The reason names the check that refused, for the server's own log. The
  // message the caller sees must stay what it was: a 401 never says which
  // check failed.
  async function refusal(
    fn: () => Promise<unknown>,
  ): Promise<{ kind: AuthErrorKind; message: string; reason: AuthFailureReason | undefined }> {
    try {
      await fn();
    } catch (err) {
      expect(err).toBeInstanceOf(KozouAuthError);
      const e = err as KozouAuthError;
      return { kind: e.kind, message: e.message, reason: e.reason };
    }
    return expect.unreachable('should have thrown');
  }

  const GENERIC = { kind: 'unauthorized', message: 'Invalid or expired token.' } as const;
  const now = (): number => Math.floor(Date.now() / 1000);

  /** A JWS over an arbitrary payload, which SignJWT would refuse to build. */
  async function signRaw(payload: unknown): Promise<string> {
    return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
      .setProtectedHeader({ alg: 'HS256' })
      .sign(secretKey);
  }

  it('keeps the reason out of a serialised error, like the message', async () => {
    // A handler that answers with the error object as it stands must not hand
    // the client the one part it is not meant to see.
    const a = createAuthenticator(hs());
    const token = await sign({ role: 'r' }, { key: new TextEncoder().encode('other-secret') });
    let caught: unknown;
    try {
      await a.authenticate(`Bearer ${token}`);
    } catch (err) {
      caught = err;
    }
    const err = caught as KozouAuthError;
    expect(err.reason).toBe('bad_signature');
    expect(JSON.stringify(err)).not.toContain('bad_signature');
    expect(JSON.stringify({ ...err })).not.toContain('bad_signature');
    expect(Object.keys(err)).not.toContain('reason');
    expect(new KozouAuthError('forbidden', 'x').reason).toBeUndefined();
  });

  it('no_token / malformed_header: an absent header and a non-Bearer one are told apart', async () => {
    const a = createAuthenticator(hs());
    const header = 'Missing or malformed Authorization header.';
    expect(await refusal(() => a.authenticate(undefined))).toEqual({
      kind: 'unauthorized',
      message: header,
      reason: 'no_token',
    });
    for (const value of ['Basic abc123', 'Bearer', 'Bearer   ']) {
      expect(await refusal(() => a.authenticate(value))).toEqual({
        kind: 'unauthorized',
        message: header,
        reason: 'malformed_header',
      });
    }
  });

  it('malformed_token: not a JWS, or a JWS whose payload is not a claims object', async () => {
    const a = createAuthenticator(hs());
    expect(await refusal(() => a.authenticate('Bearer not-a-jwt'))).toEqual({
      ...GENERIC,
      reason: 'malformed_token',
    });
    const notAnObject = await signRaw([1, 2]);
    expect(await refusal(() => a.authenticate(`Bearer ${notAnObject}`))).toEqual({
      ...GENERIC,
      reason: 'malformed_token',
    });
  });

  it('algorithm_not_allowed', async () => {
    const a = createAuthenticator(hs({ jwt: { secret: SECRET, algorithms: ['HS256'] } }));
    const token = await sign({ role: 'r' }, { alg: 'HS384' });
    expect(await refusal(() => a.authenticate(`Bearer ${token}`))).toEqual({
      ...GENERIC,
      reason: 'algorithm_not_allowed',
    });
  });

  it('bad_signature', async () => {
    const a = createAuthenticator(hs());
    const token = await sign({ role: 'r' }, { key: new TextEncoder().encode('other-secret') });
    expect(await refusal(() => a.authenticate(`Bearer ${token}`))).toEqual({
      ...GENERIC,
      reason: 'bad_signature',
    });
  });

  it('expired / not_yet_valid', async () => {
    const a = createAuthenticator(hs());
    const expired = await sign({ role: 'r' }, { exp: now() - 60 });
    expect(await refusal(() => a.authenticate(`Bearer ${expired}`))).toEqual({
      ...GENERIC,
      reason: 'expired',
    });
    const early = await sign({ role: 'r' }, { nbf: now() + 3600 });
    expect(await refusal(() => a.authenticate(`Bearer ${early}`))).toEqual({
      ...GENERIC,
      reason: 'not_yet_valid',
    });
  });

  it('issuer_mismatch / issuer_missing', async () => {
    const a = createAuthenticator(hs({ jwt: { secret: SECRET, issuer: 'expected' } }));
    const wrong = await sign({ role: 'r' }, { iss: 'other' });
    expect(await refusal(() => a.authenticate(`Bearer ${wrong}`))).toEqual({
      ...GENERIC,
      reason: 'issuer_mismatch',
    });
    const none = await sign({ role: 'r' });
    expect(await refusal(() => a.authenticate(`Bearer ${none}`))).toEqual({
      ...GENERIC,
      reason: 'issuer_missing',
    });
  });

  it('audience_mismatch / audience_missing', async () => {
    const a = createAuthenticator(hs({ jwt: { secret: SECRET, audience: 'aud-a' } }));
    const wrong = await sign({ role: 'r' }, { aud: 'aud-b' });
    expect(await refusal(() => a.authenticate(`Bearer ${wrong}`))).toEqual({
      ...GENERIC,
      reason: 'audience_mismatch',
    });
    const none = await sign({ role: 'r' });
    expect(await refusal(() => a.authenticate(`Bearer ${none}`))).toEqual({
      ...GENERIC,
      reason: 'audience_missing',
    });
  });

  it('names an absent claim before a wrong one', async () => {
    // jose checks presence of every required claim before comparing any value.
    const a = createAuthenticator(hs({ jwt: { secret: SECRET, issuer: 'expected', audience: 'aud-a' } }));
    const token = await sign({ role: 'r' }, { iss: 'other' });
    expect((await refusal(() => a.authenticate(`Bearer ${token}`))).reason).toBe('audience_missing');
  });

  it('claims_invalid: a time claim that is not a number', async () => {
    const a = createAuthenticator(hs());
    for (const claim of ['exp', 'nbf', 'iat']) {
      const token = await signRaw({ role: 'r', [claim]: 'soon' });
      expect(await refusal(() => a.authenticate(`Bearer ${token}`))).toEqual({
        ...GENERIC,
        reason: 'claims_invalid',
      });
    }
  });

  it('other_token_error: a verifier refusal outside the classified ones', async () => {
    // An unrecognised critical header parameter (JOSENotSupported).
    const a = createAuthenticator(hs());
    const token = await new SignJWT({ role: 'r' })
      .setProtectedHeader({ alg: 'HS256', crit: ['x-kozou-test'], 'x-kozou-test': 1 })
      .sign(secretKey, { crit: { 'x-kozou-test': true } });
    expect(await refusal(() => a.authenticate(`Bearer ${token}`))).toEqual({
      ...GENERIC,
      reason: 'other_token_error',
    });
  });

  it('role_missing / role_unreadable / role_not_allowed, with the messages unchanged', async () => {
    const a = createAuthenticator(hs({ allowedRoles: ['app_reader'] }));
    expect(await refusal(async () => a.authenticate(`Bearer ${await sign({ sub: 'x' })}`))).toEqual({
      kind: 'forbidden',
      message: 'Token does not specify a role and no default role is configured.',
      reason: 'role_missing',
    });
    expect(await refusal(async () => a.authenticate(`Bearer ${await sign({ role: ['a'] })}`))).toEqual({
      kind: 'forbidden',
      message: 'Token\'s "role" claim is a list, not a role name.',
      reason: 'role_unreadable',
    });
    expect(await refusal(async () => a.authenticate(`Bearer ${await sign({ role: 'evil' })}`))).toEqual({
      kind: 'forbidden',
      message: 'Role "evil" is not permitted.',
      reason: 'role_not_allowed',
    });
  });

  describe('against a remote JWKS', () => {
    async function withServer(
      respond: (res: import('node:http').ServerResponse) => void,
      run: (jwksUri: string) => Promise<void>,
    ): Promise<void> {
      const server = createServer((_req, res) => respond(res));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      try {
        await run(`http://127.0.0.1:${port}/jwks`);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        );
      }
    }
    const json = (body: unknown) => (res: import('node:http').ServerResponse) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    async function rsKey(kid: string) {
      const { publicKey, privateKey } = await generateKeyPair('RS256');
      const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
      return { jwk, privateKey };
    }

    it('unknown_key when no key matches the kid; ambiguous_key when more than one does', async () => {
      const k1 = await rsKey('k1');
      const k2 = await rsKey('k2');
      await withServer(json({ keys: [k1.jwk, k2.jwk] }), async (jwksUri) => {
        const a = createAuthenticator({ jwt: { jwksUri } });
        const other = await new SignJWT({ role: 'r' })
          .setProtectedHeader({ alg: 'RS256', kid: 'k3' })
          .sign(k1.privateKey);
        expect(await refusal(() => a.authenticate(`Bearer ${other}`))).toEqual({
          ...GENERIC,
          reason: 'unknown_key',
        });
        // No kid at all, and two RS256 keys: jose will not pick one.
        const kidless = await new SignJWT({ role: 'r' })
          .setProtectedHeader({ alg: 'RS256' })
          .sign(k1.privateKey);
        expect(await refusal(() => a.authenticate(`Bearer ${kidless}`))).toEqual({
          ...GENERIC,
          reason: 'ambiguous_key',
        });
      });
    });

    it('jwks_unavailable: a non-200 response, a body that is not JSON, a malformed key set', async () => {
      const k1 = await rsKey('k1');
      const token = await new SignJWT({ role: 'r' })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .sign(k1.privateKey);
      const responders = [
        (res: import('node:http').ServerResponse) => {
          res.writeHead(500);
          res.end();
        },
        (res: import('node:http').ServerResponse) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('not json');
        },
        json({ nokeys: true }),
      ];
      for (const respond of responders) {
        await withServer(respond, async (jwksUri) => {
          const a = createAuthenticator({ jwt: { jwksUri } });
          expect(await refusal(() => a.authenticate(`Bearer ${token}`))).toEqual({
            ...GENERIC,
            reason: 'jwks_unavailable',
          });
        });
      }
    });
  });
});

describe('signServiceToken', () => {
  it('mints a token the matching authenticator accepts, carrying the role', async () => {
    const token = await signServiceToken({ secret: SECRET, role: 'app_admin' });
    const ctx = await createAuthenticator(hs()).authenticate(`Bearer ${token}`);
    expect(ctx.role).toBe('app_admin');
  });

  it('omits the role claim when no role is given, falling back to defaultRole', async () => {
    const token = await signServiceToken({ secret: SECRET });
    const a = createAuthenticator(hs({ defaultRole: 'app_reader' }));
    const ctx = await a.authenticate(`Bearer ${token}`);
    expect(ctx.role).toBe('app_reader');
    expect(ctx.claims.role).toBeUndefined();
  });

  it('writes the role under a custom roleClaim', async () => {
    const token = await signServiceToken({
      secret: SECRET,
      roleClaim: 'kozou_role',
      role: 'custom',
    });
    const a = createAuthenticator(hs({ roleClaim: 'kozou_role' }));
    expect((await a.authenticate(`Bearer ${token}`)).role).toBe('custom');
  });

  it('sets issuer / audience so an authenticator that checks them accepts it', async () => {
    const token = await signServiceToken({
      secret: SECRET,
      role: 'app_reader',
      issuer: 'kozou',
      audience: 'kozou-api',
    });
    const a = createAuthenticator(hs({ jwt: { secret: SECRET, issuer: 'kozou', audience: 'kozou-api' } }));
    expect((await a.authenticate(`Bearer ${token}`)).role).toBe('app_reader');
  });

  it('is rejected by an authenticator expecting a different issuer', async () => {
    const token = await signServiceToken({ secret: SECRET, role: 'app_reader' });
    const a = createAuthenticator(hs({ jwt: { secret: SECRET, issuer: 'kozou' } }));
    await expectError(() => a.authenticate(`Bearer ${token}`), 'unauthorized');
  });

  it('does not set an expiry (no exp claim)', async () => {
    const token = await signServiceToken({ secret: SECRET, role: 'app_reader' });
    const ctx = await createAuthenticator(hs()).authenticate(`Bearer ${token}`);
    expect(ctx.claims.exp).toBeUndefined();
    expect(ctx.claims.iat).toBeTypeOf('number');
  });

  it('throws on an empty secret, prefixed with the default error context', async () => {
    await expect(signServiceToken({ secret: '', role: 'r' })).rejects.toThrow(
      /^kozou signServiceToken: .*secret/,
    );
  });

  it("prefixes errors with the caller's error context", async () => {
    await expect(
      signServiceToken({ secret: '', role: 'r' }, '@kozou/api signServiceToken'),
    ).rejects.toThrow(/^@kozou\/api signServiceToken: /);
  });

  it('rejects a registered JWT claim as the roleClaim (mint and verifier alike)', async () => {
    for (const reserved of ['exp', 'nbf', 'iat', 'iss', 'aud']) {
      await expect(
        signServiceToken({ secret: SECRET, roleClaim: reserved, role: 'r' }),
      ).rejects.toThrow(/registered JWT claim/);
      expect(() => createAuthenticator(hs({ roleClaim: reserved }))).toThrow(
        /registered JWT claim/,
      );
    }
  });

  it('merges extra claims into the payload (visible via request.jwt.claims)', async () => {
    const token = await signServiceToken({
      secret: SECRET,
      role: 'app_admin',
      claims: { tenant_id: 'acme', is_admin: true },
    });
    const ctx = await createAuthenticator(hs()).authenticate(`Bearer ${token}`);
    expect(ctx.role).toBe('app_admin');
    expect(ctx.claims.tenant_id).toBe('acme');
    expect(ctx.claims.is_admin).toBe(true);
  });

  it('the configured role always wins over a colliding claims key', async () => {
    const token = await signServiceToken({
      secret: SECRET,
      role: 'app_admin',
      claims: { role: 'smuggled' },
    });
    const ctx = await createAuthenticator(hs()).authenticate(`Bearer ${token}`);
    expect(ctx.role).toBe('app_admin');
    expect(ctx.claims.role).toBe('app_admin');
  });

  it('drops a role-claim key in claims even when no role is set (no smuggling)', async () => {
    const token = await signServiceToken({
      secret: SECRET,
      claims: { role: 'smuggled' },
    });
    // The token carries no role claim at all -> defaultRole applies.
    const a = createAuthenticator(hs({ defaultRole: 'app_reader' }));
    const ctx = await a.authenticate(`Bearer ${token}`);
    expect(ctx.role).toBe('app_reader');
    expect(ctx.claims.role).toBeUndefined();
  });

  it('drops a custom roleClaim key in claims the same way', async () => {
    const token = await signServiceToken({
      secret: SECRET,
      roleClaim: 'kozou_role',
      role: 'custom',
      claims: { kozou_role: 'smuggled', tenant_id: 't1' },
    });
    const a = createAuthenticator(hs({ roleClaim: 'kozou_role' }));
    const ctx = await a.authenticate(`Bearer ${token}`);
    expect(ctx.role).toBe('custom');
    expect(ctx.claims.tenant_id).toBe('t1');
  });

  it('the mint always controls iat, and iss/aud when configured', async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await signServiceToken({
      secret: SECRET,
      role: 'app_reader',
      issuer: 'kozou',
      audience: 'kozou-api',
      claims: { iat: 1, iss: 'forged', aud: 'forged' },
    });
    const a = createAuthenticator(
      hs({ jwt: { secret: SECRET, issuer: 'kozou', audience: 'kozou-api' } }),
    );
    const ctx = await a.authenticate(`Bearer ${token}`);
    expect(ctx.claims.iss).toBe('kozou');
    expect(ctx.claims.aud).toBe('kozou-api');
    expect(ctx.claims.iat as number).toBeGreaterThanOrEqual(before);
  });
});
