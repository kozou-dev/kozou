// The server-side record of why an OAuth-mode request was refused: one stderr
// line per refusal naming the check, never a value from the request, capped
// per reason. The client-facing side is covered in httpAuth.test.ts and must
// not change — a 401 still names no check.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';

import {
  hsToken,
  refusalCases,
  startJwksServer,
  SENTINEL,
  type JwksServer,
} from '@kozou/test-utils';

import { SchemaCache, startHttpServer, type HttpServerHandle } from '../src/index.js';
import { RefusalLog, describeRefusal, refusalStatus, type RefusalCode } from '../src/refusalLog.js';

const SECRET = 'refusal-log-test-secret-0123456789abcdef';
const RESOURCE = 'https://mcp.example.com/mcp';
const ISSUER = 'https://as.example.com/realms/kozou';
const ROLE = 'mcp_viewer';
const PREFIX = '[@kozou/mcp]';

function post(
  port: number,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: 'POST', path: '/mcp', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Capture stderr for the duration of a suite. */
function captureStderr(): { lines: () => string[]; text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  const text = () => chunks.join('');
  return {
    text,
    lines: () => text().split('\n').filter((line) => line.length > 0),
    restore: () => spy.mockRestore(),
  };
}

const authLines = (lines: string[]): string[] => lines.filter((l) => l.startsWith(`${PREFIX} auth `));

/** Every code the endpoint can log, and where this file provokes it. Keyed by
 *  the union, so a code that is missing here, or no longer exists, does not
 *  compile: a new reason cannot arrive without a request that provokes it. */
const EXERCISED: Record<RefusalCode, 'request table' | 'key set suite' | 'unreachable'> = {
  no_token: 'request table',
  malformed_header: 'request table',
  malformed_token: 'request table',
  algorithm_not_allowed: 'request table',
  bad_signature: 'request table',
  expired: 'request table',
  not_yet_valid: 'request table',
  issuer_mismatch: 'request table',
  issuer_missing: 'request table',
  audience_mismatch: 'request table',
  audience_missing: 'request table',
  claims_invalid: 'request table',
  other_token_error: 'request table',
  role_missing: 'request table',
  role_unreadable: 'request table',
  role_not_allowed: 'request table',
  insufficient_scope: 'request table',
  unknown_key: 'key set suite',
  ambiguous_key: 'key set suite',
  jwks_unavailable: 'key set suite',
  // Only an auth error that arrives without a reason; core attaches one to
  // every error it throws.
  unclassified: 'unreachable',
};
const codesIn = (where: (typeof EXERCISED)[RefusalCode]): string[] =>
  (Object.keys(EXERCISED) as RefusalCode[]).filter((code) => EXERCISED[code] === where).sort();

/** Everything a refusal line must never contain: the planted claim values,
 *  plus the token or header itself (and its signature segment on its own). */
function forbiddenIn(authorization: string | undefined): string[] {
  const values: string[] = Object.values(SENTINEL);
  if (authorization !== undefined) {
    values.push(authorization);
    const token = authorization.slice(authorization.indexOf(' ') + 1);
    values.push(token);
    const segments = token.split('.');
    if (segments.length === 3) values.push(...segments);
  }
  return values.filter((v) => v.length >= 8);
}

describe('refusal log: one line per reason, no value from the request', () => {
  let handle: HttpServerHandle;
  let port: number;
  let stderr: ReturnType<typeof captureStderr>;

  beforeAll(async () => {
    stderr = captureStderr();
    handle = await startHttpServer(new SchemaCache({ connection: 'postgres://invalid:5432/none' }), {
      port: 0,
      host: '127.0.0.1',
      auth: {
        resource: RESOURCE,
        authorizationServers: [ISSUER],
        jwt: { secret: SECRET },
        allowedRoles: [ROLE],
      },
    });
    port = handle.port;
  });

  afterAll(async () => {
    if (handle) await handle.close();
    stderr.restore();
  });

  const cases = refusalCases({ secret: SECRET, issuer: ISSUER, audience: RESOURCE, allowedRole: ROLE });

  it('sends one request for every code the inventory places in the request table', () => {
    expect(cases.map((c) => c.code).sort()).toEqual(codesIn('request table'));
  });

  for (const c of cases) {
    it(`${c.code}: ${c.status}, and exactly one line naming it`, async () => {
      const before = authLines(stderr.lines()).length;
      const res = await post(port, c.authorization === undefined ? {} : { authorization: c.authorization });
      expect(res.status).toBe(c.status);

      const added = authLines(stderr.lines()).slice(before);
      expect(added).toHaveLength(1);
      expect(added[0]).toBe(`${PREFIX} auth ${c.status} ${c.code}: ${describeRefusal(c.code as RefusalCode, {
        roleClaim: 'role',
        scope: 'mcp:describe',
      })}`);
      for (const value of forbiddenIn(c.authorization)) {
        expect(added[0]).not.toContain(value);
      }
    });
  }

  it('keeps the 401 body and challenge generic: the reason goes to the log only', async () => {
    for (const c of cases.filter((x) => x.status === 401)) {
      const res = await post(port, c.authorization === undefined ? {} : { authorization: c.authorization });
      // The challenge is RFC 6750's, and the same for every token problem.
      expect(res.headers['www-authenticate']).toBe(
        c.code === 'no_token'
          ? 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"'
          : 'Bearer error="invalid_token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
      );
      expect(JSON.parse(res.text)).toEqual({
        error:
          c.code === 'no_token' || c.code === 'malformed_header'
            ? 'Missing or malformed Authorization header.'
            : 'Invalid or expired token.',
      });
    }
  });

  it('answers a missing role without pointing at a default role, which this surface lacks', async () => {
    const c = cases.find((x) => x.code === 'role_missing');
    const res = await post(port, { authorization: c?.authorization ?? '' });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.text)).toEqual({ error: 'Token does not specify a role (no "role" claim).' });
    expect(res.text).not.toMatch(/default/i);
  });

  it('keeps the other 403 bodies as they were', async () => {
    const unreadable = cases.find((x) => x.code === 'role_unreadable');
    const outsider = cases.find((x) => x.code === 'role_not_allowed');
    expect(JSON.parse((await post(port, { authorization: unreadable?.authorization ?? '' })).text)).toEqual({
      error: 'Token\'s "role" claim is a list, not a role name.',
    });
    expect(JSON.parse((await post(port, { authorization: outsider?.authorization ?? '' })).text)).toEqual({
      error: `Role "${SENTINEL.outsiderRole}" is not permitted.`,
    });
  });

  it('logs the scope a tools/call lacked, by its configured name', async () => {
    // A valid describe-only token opens a session; `call` then needs execute.
    const now = Math.floor(Date.now() / 1000);
    const token = hsToken(
      { iss: ISSUER, aud: RESOURCE, role: ROLE, scope: 'mcp:describe', sub: SENTINEL.subject, exp: now + 600 },
      { secret: SECRET },
    );
    const headers = (sessionId?: string): Record<string, string> => ({
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
    });
    const init = await post(
      port,
      headers(),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    );
    expect(init.status).toBe(200);
    const sessionId = init.headers['mcp-session-id'] as string;

    const before = authLines(stderr.lines()).length;
    const call = await post(
      port,
      headers(sessionId),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'call', arguments: { function: 'public.whatever' } },
      }),
    );
    expect(call.status).toBe(403);
    const added = authLines(stderr.lines()).slice(before);
    expect(added).toEqual([
      `${PREFIX} auth 403 insufficient_scope: the token lacks the "mcp:execute" scope this request needs.`,
    ]);
    expect(added[0]).not.toContain(token);
    expect(added[0]).not.toContain(SENTINEL.subject);
  });

  it('never repeats a planted value anywhere on stderr', () => {
    const all = stderr.text();
    for (const value of Object.values(SENTINEL)) expect(all).not.toContain(value);
    for (const c of cases) {
      if (c.authorization !== undefined) expect(all).not.toContain(c.authorization);
    }
  });
});

describe('refusal log: the key-set reasons', () => {
  let jwks: JwksServer;
  let handle: HttpServerHandle;
  let stderr: ReturnType<typeof captureStderr>;

  beforeAll(async () => {
    jwks = await startJwksServer();
    stderr = captureStderr();
    handle = await startHttpServer(new SchemaCache({ connection: 'postgres://invalid:5432/none' }), {
      port: 0,
      host: '127.0.0.1',
      auth: {
        resource: RESOURCE,
        authorizationServers: [ISSUER],
        jwt: { jwksUri: jwks.jwksUri },
        allowedRoles: [ROLE],
      },
    });
  });

  afterAll(async () => {
    if (handle) await handle.close();
    stderr.restore();
    if (jwks) await jwks.close();
  });

  const payload = () => {
    const now = Math.floor(Date.now() / 1000);
    return { iss: ISSUER, aud: RESOURCE, role: ROLE, scope: 'mcp:describe', sub: SENTINEL.subject, exp: now + 600 };
  };

  it('jwks_unavailable while the key set answers 500, then unknown_key and ambiguous_key', async () => {
    // The failing fetch first: once a fetch succeeds, jose caches the set.
    jwks.failing = true;
    const token = jwks.sign(payload());
    let before = authLines(stderr.lines()).length;
    expect((await post(handle.port, { authorization: `Bearer ${token}` })).status).toBe(401);
    let added = authLines(stderr.lines()).slice(before);
    expect(added).toEqual([`${PREFIX} auth 401 jwks_unavailable: ${describeRefusal('jwks_unavailable', { roleClaim: 'role' })}`]);

    jwks.failing = false;
    const other = jwks.sign(payload(), 'k-unpublished');
    before = authLines(stderr.lines()).length;
    expect((await post(handle.port, { authorization: `Bearer ${other}` })).status).toBe(401);
    added = authLines(stderr.lines()).slice(before);
    expect(added).toEqual([`${PREFIX} auth 401 unknown_key: ${describeRefusal('unknown_key', { roleClaim: 'role' })}`]);

    // No kid at all, and the set publishes two RS256 keys.
    const kidless = jwks.sign(payload(), null);
    before = authLines(stderr.lines()).length;
    expect((await post(handle.port, { authorization: `Bearer ${kidless}` })).status).toBe(401);
    added = authLines(stderr.lines()).slice(before);
    expect(added).toEqual([`${PREFIX} auth 401 ambiguous_key: ${describeRefusal('ambiguous_key', { roleClaim: 'role' })}`]);
    expect(['jwks_unavailable', 'unknown_key', 'ambiguous_key'].sort()).toEqual(codesIn('key set suite'));

    // The published key still works, and logs nothing.
    before = authLines(stderr.lines()).length;
    const ok = await post(
      handle.port,
      { authorization: `Bearer ${jwks.sign(payload())}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    );
    expect(ok.status).toBe(200);
    expect(authLines(stderr.lines()).slice(before)).toEqual([]);

    for (const line of authLines(stderr.lines())) {
      for (const t of [token, other, kidless]) expect(line).not.toContain(t);
      expect(line).not.toContain(SENTINEL.subject);
    }
  });
});

describe('refusal log: the cap per reason', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function harness() {
    const lines: string[] = [];
    let now = 1_000_000;
    const timers: { at: number; fn: () => void; cleared: boolean }[] = [];
    const log = new RefusalLog({
      prefix: '[t]',
      write: (line) => lines.push(line),
      now: () => now,
      setTimer: (fn, ms) => {
        const timer = { at: now + ms, fn, cleared: false };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: (timer) => {
        (timer as unknown as { cleared: boolean }).cleared = true;
      },
    });
    /** Move the clock without firing anything — a timer that runs late. */
    const skip = (ms: number) => {
      now += ms;
    };
    const advance = (ms: number) => {
      now += ms;
      for (const t of timers) {
        if (!t.cleared && t.at <= now) {
          t.cleared = true;
          t.fn();
        }
      }
    };
    return { log, lines, advance, skip, timers };
  }

  const ctx = { roleClaim: 'role' };

  it('logs the first five per reason in a window, then one count when the window closes', () => {
    const { log, lines, advance } = harness();
    for (let i = 0; i < 12; i += 1) log.record('malformed_token', ctx);
    expect(lines).toHaveLength(5);
    advance(59_999);
    expect(lines).toHaveLength(5);
    advance(1);
    expect(lines).toHaveLength(6);
    expect(lines[5]).toBe('[t] auth 401 malformed_token: 7 more in the same 60s, not logged one by one.\n');
  });

  it('caps each reason separately, so a flood of one cannot hide another', () => {
    const { log, lines } = harness();
    for (let i = 0; i < 100; i += 1) log.record('malformed_token', ctx);
    log.record('role_missing', ctx);
    expect(lines.filter((l) => l.includes(' malformed_token: '))).toHaveLength(5);
    expect(lines.filter((l) => l.includes(' role_missing: '))).toHaveLength(1);
    expect(lines.at(-1)).toMatch(/^\[t\] auth 403 role_missing: /);
  });

  it('starts a fresh window after the last one closed', () => {
    const { log, lines, advance } = harness();
    for (let i = 0; i < 6; i += 1) log.record('expired', ctx);
    advance(60_000);
    expect(lines).toHaveLength(6); // five lines + the count of one
    for (let i = 0; i < 5; i += 1) log.record('expired', ctx);
    expect(lines).toHaveLength(11);
  });

  it('reports the count itself when a refusal arrives after the window closed but before its timer', () => {
    const { log, lines, skip, timers } = harness();
    for (let i = 0; i < 7; i += 1) log.record('expired', ctx);
    expect(timers).toHaveLength(1);
    skip(60_000);
    log.record('expired', ctx);
    expect(lines.slice(5)).toEqual([
      '[t] auth 401 expired: 2 more in the same 60s, not logged one by one.\n',
      `[t] auth 401 expired: ${describeRefusal('expired', ctx)}\n`,
    ]);
    // The late timer was cancelled, so the count is not written twice.
    expect(timers[0]?.cleared).toBe(true);
  });

  it('writes no count when nothing was held back, and close() reports what was', () => {
    const { log, lines, timers } = harness();
    for (let i = 0; i < 3; i += 1) log.record('expired', ctx);
    for (let i = 0; i < 8; i += 1) log.record('bad_signature', ctx);
    log.close();
    expect(lines.filter((l) => l.includes(' expired: '))).toHaveLength(3);
    expect(lines.at(-1)).toBe('[t] auth 401 bad_signature: 3 more in the same 60s, not logged one by one.\n');
    expect(timers.every((t) => t.cleared)).toBe(true);
  });

  it('does not keep the process alive for a pending count (the real timer is unref-ed)', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const lines: string[] = [];
    const log = new RefusalLog({ prefix: '[t]', write: (line) => lines.push(line) });
    try {
      for (let i = 0; i < 6; i += 1) log.record('expired', ctx);
      // The window-end timer, told apart from any other setTimeout by its delay.
      const index = spy.mock.calls.findIndex(([, ms]) => typeof ms === 'number' && ms > 59_000 && ms <= 60_000);
      expect(index).toBeGreaterThanOrEqual(0);
      const timer = spy.mock.results[index]?.value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);
    } finally {
      log.close();
      spy.mockRestore();
    }
    expect(lines.at(-1)).toBe('[t] auth 401 expired: 1 more in the same 60s, not logged one by one.\n');
  });

  it('measures windows on a clock a wall-clock step cannot move', () => {
    // Step the wall clock back an hour while a window is full, then let a
    // minute pass. On a monotonic clock the window has closed and the reason
    // speaks again; on the wall clock it would stay silent for the hour.
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    const lines: string[] = [];
    const log = new RefusalLog({ prefix: '[t]', write: (line) => lines.push(line) });
    try {
      for (let i = 0; i < 5; i += 1) log.record('expired', ctx);
      vi.setSystemTime(Date.now() - 3_600_000);
      vi.advanceTimersByTime(60_000);
      log.record('expired', ctx);
      expect(lines).toHaveLength(6);
      expect(lines[5]).toBe(`[t] auth 401 expired: ${describeRefusal('expired', ctx)}\n`);
    } finally {
      log.close();
    }
  });

  it('flushes the held-back count when the server closes', async () => {
    const stderr = captureStderr();
    try {
      const handle = await startHttpServer(new SchemaCache({ connection: 'postgres://invalid:5432/none' }), {
        port: 0,
        host: '127.0.0.1',
        auth: { resource: RESOURCE, authorizationServers: [ISSUER], jwt: { secret: SECRET } },
      });
      for (let i = 0; i < 7; i += 1) {
        await post(handle.port, { authorization: 'Bearer not-a-jwt' });
      }
      expect(authLines(stderr.lines())).toHaveLength(5);
      await handle.close();
      expect(authLines(stderr.lines()).at(-1)).toBe(
        `${PREFIX} auth 401 malformed_token: 2 more in the same 60s, not logged one by one.`,
      );
    } finally {
      stderr.restore();
    }
  });
});

describe('describeRefusal / refusalStatus', () => {
  it('answers 403 for the role and scope reasons and 401 for every other', () => {
    const forbidden: RefusalCode[] = ['role_missing', 'role_unreadable', 'role_not_allowed', 'insufficient_scope'];
    for (const code of forbidden) expect(refusalStatus(code)).toBe(403);
    expect(refusalStatus('no_token')).toBe(401);
    expect(refusalStatus('unclassified')).toBe(401);
  });

  it('names the configured role claim, and nothing about defaultRole as a remedy', () => {
    const text = describeRefusal('role_missing', { roleClaim: 'app_role' });
    expect(text).toContain('"app_role"');
    expect(text).not.toMatch(/defaultRole/);
  });

  it('says a lone tokenless request is the normal start of a connection, not a failure', () => {
    const text = describeRefusal('no_token', { roleClaim: 'role' });
    expect(text).toMatch(/normal/);
    expect(text).not.toMatch(/fail/i);
  });

  it('names settings where both the library and the kozou CLI find them, never the REST block', () => {
    // The CLI's top-level `auth` block is the REST surface's; its jwt.audience
    // never reaches this endpoint, so a line naming `auth.jwt.audience` would
    // send the operator to a key that changes nothing.
    for (const code of Object.keys(EXERCISED) as RefusalCode[]) {
      const text = describeRefusal(code, { roleClaim: 'role', scope: 'mcp:describe' });
      expect(text).not.toMatch(/\bauth\.(jwt|allowedRoles|resource|authorizationServers)\b/);
    }
    const audience = describeRefusal('audience_mismatch', { roleClaim: 'role' });
    expect(audience).toContain('jwt.audience in the MCP auth settings (server.mcp.http.auth for the kozou CLI)');
    expect(audience).toContain("The REST surface's audience never applies here.");
    for (const code of ['issuer_mismatch', 'algorithm_not_allowed', 'jwks_unavailable', 'role_not_allowed'] as const) {
      expect(describeRefusal(code, { roleClaim: 'role' })).toContain('server.mcp.http.auth for the kozou CLI');
    }
  });

  it('has an explanation for the catch-all', () => {
    expect(describeRefusal('unclassified', { roleClaim: 'role' })).toMatch(/does not classify/);
  });
});
