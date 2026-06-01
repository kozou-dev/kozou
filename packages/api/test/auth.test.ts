import { describe, it, expect } from 'vitest';
import { SignJWT, generateKeyPair, exportSPKI } from 'jose';
import { createAuthenticator, signServiceToken, type AuthConfig } from '../src/auth.js';
import { KozouApiError } from '../src/errors.js';

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

async function expectError(fn: () => Promise<unknown>, status: number, codeRe?: RegExp): Promise<void> {
  try {
    await fn();
    expect.unreachable('should have thrown');
  } catch (err) {
    expect(err).toBeInstanceOf(KozouApiError);
    expect((err as KozouApiError).status).toBe(status);
    if (codeRe) expect((err as KozouApiError).code).toMatch(codeRe);
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
  it('defaults roleClaim and claimsGuc', () => {
    const a = createAuthenticator(hs());
    expect(a.roleClaim).toBe('role');
    expect(a.claimsGuc).toBe('request.jwt.claims');
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

  it('rejects an expired token (401)', async () => {
    const a = createAuthenticator(hs());
    const token = await sign({ role: 'app_reader' }, { exp: Math.floor(Date.now() / 1000) - 60 });
    await expectError(() => a.authenticate(`Bearer ${token}`), 401, /unauthorized/);
  });

  it('rejects a bad signature (401)', async () => {
    const a = createAuthenticator(hs());
    const token = await sign({ role: 'app_reader' }, { key: new TextEncoder().encode('other-secret') });
    await expectError(() => a.authenticate(`Bearer ${token}`), 401);
  });

  it('rejects a not-yet-valid token (401)', async () => {
    const a = createAuthenticator(hs());
    const token = await sign({ role: 'app_reader' }, { nbf: Math.floor(Date.now() / 1000) + 3600 });
    await expectError(() => a.authenticate(`Bearer ${token}`), 401);
  });

  it('rejects an issuer mismatch (401)', async () => {
    const a = createAuthenticator(hs({ jwt: { secret: SECRET, issuer: 'expected' } }));
    const token = await sign({ role: 'app_reader' }, { iss: 'other' });
    await expectError(() => a.authenticate(`Bearer ${token}`), 401);
  });

  it('rejects an audience mismatch (401)', async () => {
    const a = createAuthenticator(hs({ jwt: { secret: SECRET, audience: 'aud-a' } }));
    const token = await sign({ role: 'app_reader' }, { aud: 'aud-b' });
    await expectError(() => a.authenticate(`Bearer ${token}`), 401);
  });

  it('rejects a disallowed algorithm (401)', async () => {
    const a = createAuthenticator(hs({ jwt: { secret: SECRET, algorithms: ['HS256'] } }));
    const token = await sign({ role: 'app_reader' }, { alg: 'HS384' });
    await expectError(() => a.authenticate(`Bearer ${token}`), 401);
  });

  it('rejects a missing / malformed Authorization header (401)', async () => {
    const a = createAuthenticator(hs());
    await expectError(() => a.authenticate(undefined), 401);
    await expectError(() => a.authenticate('Bearer'), 401);
    await expectError(() => a.authenticate('Basic abc123'), 401);
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

  it('rejects a token signed by a different key (401)', async () => {
    const { publicKey } = await generateKeyPair('RS256');
    const other = await generateKeyPair('RS256');
    const spki = await exportSPKI(publicKey);
    const a = createAuthenticator({ jwt: { publicKey: spki } });
    const token = await sign({ role: 'app_reader' }, { alg: 'RS256', key: other.privateKey });
    await expectError(() => a.authenticate(`Bearer ${token}`), 401);
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

  it('forbids when no role claim and no default (403)', async () => {
    const a = createAuthenticator(hs());
    const token = await sign({ sub: 'x' });
    await expectError(() => a.authenticate(`Bearer ${token}`), 403, /forbidden/);
  });

  it('forbids a role outside the allowlist (403)', async () => {
    const a = createAuthenticator(hs({ allowedRoles: ['app_reader'] }));
    const token = await sign({ role: 'evil' });
    await expectError(() => a.authenticate(`Bearer ${token}`), 403, /forbidden/);
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

  it('still rejects an absent header with 401 when no anonRole is set', async () => {
    const a = createAuthenticator(hs());
    await expectError(() => a.authenticate(undefined), 401, /unauthorized/);
  });

  it('does not downgrade a malformed header to anonymous (401)', async () => {
    const a = createAuthenticator(hs({ anonRole: 'web_anon' }));
    await expectError(() => a.authenticate('Basic abc'), 401, /unauthorized/);
    await expectError(() => a.authenticate('Bearer '), 401, /unauthorized/);
  });

  it('does not downgrade an invalid token to anonymous (401)', async () => {
    const a = createAuthenticator(hs({ anonRole: 'web_anon' }));
    await expectError(() => a.authenticate('Bearer not-a-jwt'), 401, /unauthorized/);
  });

  it('does not apply allowedRoles to the anonymous role', async () => {
    const a = createAuthenticator(hs({ anonRole: 'web_anon', allowedRoles: ['app_reader'] }));
    const ctx = await a.authenticate(undefined);
    expect(ctx.role).toBe('web_anon');
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
    await expectError(() => a.authenticate(`Bearer ${token}`), 401, /unauthorized/);
  });

  it('does not set an expiry (no exp claim)', async () => {
    const token = await signServiceToken({ secret: SECRET, role: 'app_reader' });
    const ctx = await createAuthenticator(hs()).authenticate(`Bearer ${token}`);
    expect(ctx.claims.exp).toBeUndefined();
    expect(ctx.claims.iat).toBeTypeOf('number');
  });

  it('throws on an empty secret', async () => {
    await expect(signServiceToken({ secret: '', role: 'r' })).rejects.toThrow(/secret/);
  });
});
