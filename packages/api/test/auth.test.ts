// Adapter-contract tests. The verification and role-resolution semantics
// are tested exhaustively in @kozou/core (test/auth.test.ts); what this
// file pins is the REST wire contract of the adapter in src/auth.ts —
// KozouAuthError kinds mapped to KozouApiError statuses/codes, the exact
// stable error messages, and the '@kozou/api …' startup error prefixes.

import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { createAuthenticator, signServiceToken, type AuthConfig } from '../src/auth.js';
import { KozouApiError } from '../src/errors.js';

const SECRET = 'test-secret-do-not-use';
const secretKey = new TextEncoder().encode(SECRET);

async function sign(
  payload: Record<string, unknown>,
  opts: { exp?: number } = {},
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '1h')
    .sign(secretKey);
}

const hs = (extra: Partial<AuthConfig> = {}): AuthConfig => ({ jwt: { secret: SECRET }, ...extra });

async function expectApiError(
  fn: () => Promise<unknown>,
  status: number,
  code: string,
  message?: string,
): Promise<void> {
  try {
    await fn();
    expect.unreachable('should have thrown');
  } catch (err) {
    expect(err).toBeInstanceOf(KozouApiError);
    expect((err as KozouApiError).status).toBe(status);
    expect((err as KozouApiError).code).toBe(code);
    if (message !== undefined) expect((err as KozouApiError).message).toBe(message);
  }
}

describe('createAuthenticator (adapter) — happy path', () => {
  it('verifies a valid token and returns role + claims', async () => {
    const a = createAuthenticator(hs());
    const ctx = await a.authenticate(`Bearer ${await sign({ role: 'app_reader', sub: 'ada' })}`);
    expect(ctx.role).toBe('app_reader');
    expect(ctx.claims.sub).toBe('ada');
  });

  it('defaults roleClaim and claimsGuc', () => {
    const a = createAuthenticator(hs());
    expect(a.roleClaim).toBe('role');
    expect(a.claimsGuc).toBe('request.jwt.claims');
  });

  it('assumes anonRole with empty claims when the header is absent', async () => {
    const a = createAuthenticator(hs({ anonRole: 'web_anon' }));
    const ctx = await a.authenticate(undefined);
    expect(ctx.role).toBe('web_anon');
    expect(ctx.claims).toEqual({});
  });
});

describe('createAuthenticator (adapter) — 401 mapping (wire-stable)', () => {
  it('maps a missing header to 401 unauthorized with the stable message', async () => {
    const a = createAuthenticator(hs());
    await expectApiError(
      () => a.authenticate(undefined),
      401,
      'unauthorized',
      'Missing or malformed Authorization header.',
    );
  });

  it('maps a malformed header to 401 unauthorized', async () => {
    const a = createAuthenticator(hs());
    await expectApiError(() => a.authenticate('Basic abc123'), 401, 'unauthorized');
  });

  it('maps an expired token to 401 unauthorized with the generic message', async () => {
    const a = createAuthenticator(hs());
    const token = await sign({ role: 'app_reader' }, { exp: Math.floor(Date.now() / 1000) - 60 });
    await expectApiError(
      () => a.authenticate(`Bearer ${token}`),
      401,
      'unauthorized',
      'Invalid or expired token.',
    );
  });
});

describe('createAuthenticator (adapter) — 403 mapping (wire-stable)', () => {
  it('maps a missing role claim (no default) to 403 forbidden with the stable message', async () => {
    const a = createAuthenticator(hs());
    const token = await sign({ sub: 'x' });
    await expectApiError(
      () => a.authenticate(`Bearer ${token}`),
      403,
      'forbidden',
      'Token does not specify a role and no default role is configured.',
    );
  });

  it('maps an unreadable role claim to 403 forbidden with the stable message', async () => {
    // Present-but-unreadable is its own refusal: it does not borrow the
    // missing-claim message, and it is not silently answered by defaultRole.
    const a = createAuthenticator(hs({ defaultRole: 'app_reader' }));
    const token = await sign({ role: ['app_reader'] });
    await expectApiError(
      () => a.authenticate(`Bearer ${token}`),
      403,
      'forbidden',
      'Token\'s "role" claim is a list, not a role name.',
    );
  });

  it('maps an allowlist violation to 403 forbidden with the stable message', async () => {
    const a = createAuthenticator(hs({ allowedRoles: ['app_reader'] }));
    const token = await sign({ role: 'evil' });
    await expectApiError(
      () => a.authenticate(`Bearer ${token}`),
      403,
      'forbidden',
      'Role "evil" is not permitted.',
    );
  });
});

describe('createAuthenticator (adapter) — startup errors keep the @kozou/api prefix', () => {
  it('config validation errors', () => {
    expect(() => createAuthenticator({ jwt: {} })).toThrow(/^@kozou\/api auth: .*exactly one/);
  });

  it('reserved roleClaim errors', () => {
    expect(() => createAuthenticator(hs({ roleClaim: 'exp' }))).toThrow(
      /^@kozou\/api auth: .*registered JWT claim/,
    );
  });
});

describe('signServiceToken (adapter)', () => {
  it('mints a token the matching authenticator accepts, carrying the role', async () => {
    const token = await signServiceToken({ secret: SECRET, role: 'app_admin' });
    const ctx = await createAuthenticator(hs()).authenticate(`Bearer ${token}`);
    expect(ctx.role).toBe('app_admin');
  });

  it('keeps the @kozou/api prefix on an empty secret', async () => {
    await expect(signServiceToken({ secret: '', role: 'r' })).rejects.toThrow(
      /^@kozou\/api signServiceToken: .*secret/,
    );
  });

  it('keeps the @kozou/api prefix on a reserved roleClaim', async () => {
    await expect(
      signServiceToken({ secret: SECRET, roleClaim: 'aud', role: 'r' }),
    ).rejects.toThrow(/^@kozou\/api signServiceToken: .*registered JWT claim/);
  });
});
