import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pkg from 'pg';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  SchemaCache,
  startHttpServer,
  isLoopbackHost,
  type HttpServerHandle,
} from '../src/index.js';
import { buildRebindingGuard, validateRebindingHeaders } from '../src/startHttpServer.js';

/** Write a handcrafted request over a bare socket and return its status. Used
 *  for header shapes Node's http client refuses to emit verbatim (an empty
 *  `Host:`, which it replaces with its own). */
function rawSocketStatus(port: number, raw: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: '127.0.0.1', port }, () => socket.write(raw));
    let buf = '';
    socket.on('data', (chunk) => {
      buf += String(chunk);
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
      if (match) {
        resolve(Number(match[1]));
        socket.destroy();
      }
    });
    socket.on('error', reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error('raw socket timed out'));
    });
  });
}

/** Send a raw HTTP request so we can set the Host / Origin headers freely
 *  (undici's fetch refuses to override Host). Resolves with the status code. */
function rawRequest(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path ?? '/',
        headers: opts.headers,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
import {
  setupDatabase,
  type DatabaseHandle,
  MINIMAL_FIXTURE_SQL,
} from '@kozou/test-utils';

describe('isLoopbackHost', () => {
  it('recognises loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
  });

  it('rejects non-loopback hosts', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
  });
});

describe('buildRebindingGuard', () => {
  it('always accepts loopback hostnames (port-agnostic) for a loopback bind', () => {
    const guard = buildRebindingGuard('127.0.0.1');
    expect([...guard.hostnames].sort()).toEqual(['127.0.0.1', '::1', 'localhost']);
    expect(guard.allowedOrigins).toBeUndefined();
  });

  it('adds the bound hostname for a specific non-loopback bind', () => {
    const guard = buildRebindingGuard('mcp.internal');
    expect(guard.hostnames.has('mcp.internal')).toBe(true);
    // Loopback names are still accepted.
    expect(guard.hostnames.has('localhost')).toBe(true);
  });

  it('keeps loopback hostnames for a bind-all address (still guards rebinding)', () => {
    // 0.0.0.0 cannot be enumerated, but loopback hostnames stay allowed so the
    // common (Docker-mapped) loopback access works while attacker hostnames are
    // still refused.
    expect([...buildRebindingGuard('0.0.0.0').hostnames].sort()).toEqual([
      '127.0.0.1',
      '::1',
      'localhost',
    ]);
    expect([...buildRebindingGuard('::').hostnames].sort()).toEqual(['127.0.0.1', '::1', 'localhost']);
  });

  it('adds allowedHosts hostnames and takes an exact allowedOrigins list', () => {
    const guard = buildRebindingGuard('0.0.0.0', {
      allowedHosts: ['mcp.example.com:3334'],
      allowedOrigins: ['https://app.example.com'],
    });
    expect(guard.hostnames.has('mcp.example.com')).toBe(true);
    expect([...(guard.allowedOrigins ?? [])]).toEqual(['https://app.example.com']);
  });
});

describe('validateRebindingHeaders', () => {
  const asReq = (headers: Record<string, string>): Parameters<typeof validateRebindingHeaders>[0] =>
    ({ headers }) as unknown as Parameters<typeof validateRebindingHeaders>[0];

  it('refuses an empty Host even when the guard set holds the empty string', () => {
    // `assertUsableAllowedHosts` keeps such an entry out of a configured server,
    // so this is the case that stays reachable only if guard construction
    // regresses — asserted here rather than assumed, since the request-path
    // test cannot produce it.
    const guard = buildRebindingGuard('127.0.0.1', { allowedHosts: [''] });
    expect(guard.hostnames.has('')).toBe(true);
    expect(validateRebindingHeaders(asReq({ host: '' }), guard)).toBe(
      'Host header is not allowed for this server.',
    );
  });

  it('refuses a missing Host header', () => {
    const guard = buildRebindingGuard('127.0.0.1');
    expect(validateRebindingHeaders(asReq({}), guard)).toBe(
      'Host header is not allowed for this server.',
    );
  });

  it('allows an allowed Host', () => {
    const guard = buildRebindingGuard('127.0.0.1');
    expect(validateRebindingHeaders(asReq({ host: 'localhost:3334' }), guard)).toBeNull();
  });
});

describe('startHttpServer routing (no database required)', () => {
  let handle: HttpServerHandle;
  let cache: SchemaCache;
  let baseUrl: string;

  beforeAll(async () => {
    // The routing assertions below never reach SchemaCache.get(), so a
    // connection string that is never dialed is sufficient.
    cache = new SchemaCache({ connection: 'postgres://invalid:5432/none' });
    handle = await startHttpServer(cache, { port: 0, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${handle.port}`;
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  it('POST /admin/refresh invalidates the cache and returns ok', async () => {
    const spy = vi.spyOn(cache, 'invalidate');
    const res = await fetch(`${baseUrl}/admin/refresh`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('GET /admin/refresh is rejected (POST only)', async () => {
    const res = await fetch(`${baseUrl}/admin/refresh`, { method: 'GET' });
    expect(res.status).toBe(405);
  });

  it('returns 404 for an unknown path', async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });

  it('rejects a request whose Host header is not allowed (DNS-rebinding guard)', async () => {
    // A rebound page reaches the loopback port but still carries the
    // attacker-controlled hostname in the Host header. The guard runs before
    // routing, so even POST /admin/refresh is refused with 403.
    const status = await rawRequest(handle.port, {
      method: 'POST',
      path: '/admin/refresh',
      headers: { host: 'attacker.example:1234' },
    });
    expect(status).toBe(403);
  });

  it('rejects a request with a valid Host but a disallowed Origin', async () => {
    const status = await rawRequest(handle.port, {
      method: 'POST',
      path: '/admin/refresh',
      headers: { host: `127.0.0.1:${handle.port}`, origin: 'http://attacker.example' },
    });
    expect(status).toBe(403);
  });

  it('allows a request with a valid Host and no Origin (a non-browser client)', async () => {
    const status = await rawRequest(handle.port, {
      method: 'POST',
      path: '/admin/refresh',
      headers: { host: `127.0.0.1:${handle.port}` },
    });
    expect(status).toBe(200);
  });

  it('accepts a valid Host case-insensitively (hostnames are not case-sensitive)', async () => {
    const status = await rawRequest(handle.port, {
      method: 'POST',
      path: '/admin/refresh',
      headers: { host: `LOCALHOST:${handle.port}` },
    });
    expect(status).toBe(200);
  });

  it('rejects an MCP request without a session id that is not initialize', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('startHttpServer OAuth advertise-vs-verify startup warning', () => {
  const SECRET = 'startup-warning-secret-0123456789abcdef';
  const RESOURCE = 'http://127.0.0.1:3334/mcp';
  const AUTHORIZATION_SERVER = 'http://127.0.0.1:8080/realms/kozou';

  /** Start (and immediately stop) a resource-server-mode server, returning
   *  everything it wrote to stderr while booting. */
  async function bootStderr(jwt: {
    secret: string;
    issuer?: string | string[];
    audience?: string | string[];
  }): Promise<string> {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const cache = new SchemaCache({ connection: 'postgres://invalid:5432/none' });
    let handle: HttpServerHandle;
    try {
      handle = await startHttpServer(cache, {
        port: 0,
        host: '127.0.0.1',
        auth: { resource: RESOURCE, authorizationServers: [AUTHORIZATION_SERVER], jwt },
      });
    } finally {
      spy.mockRestore();
    }
    await handle.close();
    return writes.join('');
  }

  it('stays quiet when the accepted issuer and audience are the advertised ones', async () => {
    const out = await bootStderr({ secret: SECRET });
    expect(out).not.toContain('WARNING: the token issuer/audience');
    expect(out).not.toContain('NOTE: this server accepts an audience');
  });

  it('warns about an issuer divergence, and says what to align', async () => {
    const out = await bootStderr({ secret: SECRET, issuer: 'http://127.0.0.1:9999/realms/other' });
    expect(out).toContain(
      'WARNING: the token issuer/audience this server accepts is not the one it',
    );
    // Both values, so an operator does not have to re-read the config.
    expect(out).toContain('http://127.0.0.1:9999/realms/other');
    expect(out).toContain(AUTHORIZATION_SERVER);
    // The closing instruction is the actionable half of the block; without it
    // the operator is told there is a problem and nothing else. It must not
    // name a side, either: one of the bullets above tells the operator to
    // change the advertised list rather than auth.jwt, and a footer that says
    // "align auth.jwt with the advertised values" contradicts it.
    expect(out).toContain('Make auth.jwt and the advertised values agree');
    expect(out).toContain('unless every line above is deliberate');
  });

  it('prints the note alongside a warning, not instead of it', async () => {
    // An escape-hatch deployment that also has an issuer divergence must not
    // silently lose the note it boots with every day.
    const out = await bootStderr({
      secret: SECRET,
      issuer: 'http://127.0.0.1:9999/realms/other',
      audience: 'rest-client-id',
    });
    expect(out).toContain('WARNING: the token issuer/audience');
    expect(out).toContain('NOTE: this server accepts an audience other than the resource URI it');
    expect(out).toContain('the supported shape when an IdP cannot mint that URI as `aud`');
  });

  it('prints a lone divergence too — one bullet is already wrong', async () => {
    // Accepts everything advertised plus one more, so exactly one bullet is
    // produced. Nothing about the block may depend on there being several.
    const out = await bootStderr({
      secret: SECRET,
      issuer: [AUTHORIZATION_SERVER, 'http://127.0.0.1:9999/realms/other'],
    });
    expect(out).toContain('WARNING: the token issuer/audience');
    expect(out).toContain('http://127.0.0.1:9999/realms/other');
  });

  it('prints the documented audience escape hatch as a NOTE, with no warning', async () => {
    // The single-divergence path, and the one an operator following the guide
    // actually lands on: a WARNING here would fire on every boot of a
    // supported deployment.
    const out = await bootStderr({ secret: SECRET, audience: 'rest-client-id' });
    expect(out).toContain('NOTE: this server accepts an audience other than the resource URI it');
    // Both header lines: the second one carries the reassurance that this is
    // a supported shape, which is the reason it is a NOTE at all.
    expect(out).toContain('advertises — the supported shape when an IdP cannot mint that URI');
    expect(out).toContain('rest-client-id');
    expect(out).toContain(RESOURCE);
    expect(out).not.toContain('WARNING: the token issuer/audience');
  });

  it('carries no documentation URL into a library log line', async () => {
    const out = await bootStderr({
      secret: SECRET,
      issuer: 'http://127.0.0.1:9999/realms/other',
      audience: 'rest-client-id',
    });
    // Nothing else this package logs at runtime links out, and an embedder
    // ships these lines inside a product that is not kozou.org.
    expect(out).not.toContain('kozou.org');
    expect(out).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
  });
});

describe('startHttpServer DNS-rebinding guard on a bind-all address', () => {
  let handle: HttpServerHandle;

  beforeAll(async () => {
    // Bound to 0.0.0.0 (the shipped `kozou dev` default inside a container).
    // The guard must still refuse an attacker Host while allowing loopback.
    const cache = new SchemaCache({ connection: 'postgres://invalid:5432/none' });
    handle = await startHttpServer(cache, { port: 0, host: '0.0.0.0' });
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  it('refuses an attacker-controlled Host even when bound to 0.0.0.0', async () => {
    const status = await rawRequest(handle.port, {
      method: 'POST',
      path: '/admin/refresh',
      headers: { host: 'attacker.example:1234' },
    });
    expect(status).toBe(403);
  });

  it('still allows loopback access (the Docker-mapped client path)', async () => {
    const status = await rawRequest(handle.port, {
      method: 'POST',
      path: '/admin/refresh',
      headers: { host: `localhost:${handle.port}` },
    });
    expect(status).toBe(200);
  });
});

describe('startHttpServer advertisedUrl feeds the rebinding guard', () => {
  // The declared reachable address is exactly the Host a tunnel or a
  // Host-preserving reverse proxy forwards. Without it a loopback-bound server
  // behind one refuses every request, which is the deployment advertisedUrl
  // exists to serve.
  const ADVERTISED = 'https://mcp.example.com/mcp';

  async function boot(opts: {
    advertisedUrl?: string;
    allowedHosts?: string[];
  }): Promise<HttpServerHandle> {
    const cache = new SchemaCache({ connection: 'postgres://invalid:5432/none' });
    return startHttpServer(cache, { port: 0, host: '127.0.0.1', ...opts });
  }

  const refresh = (port: number, host: string): Promise<number> =>
    rawRequest(port, { method: 'POST', path: '/admin/refresh', headers: { host } });

  it('accepts the advertised hostname', async () => {
    const handle = await boot({ advertisedUrl: ADVERTISED });
    try {
      expect(await refresh(handle.port, 'mcp.example.com')).toBe(200);
      // Port-agnostic, like every other entry in the guard.
      expect(await refresh(handle.port, 'mcp.example.com:8443')).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it('still refuses a Host it was never told about', async () => {
    const handle = await boot({ advertisedUrl: ADVERTISED });
    try {
      expect(await refresh(handle.port, 'attacker.example:1234')).toBe(403);
    } finally {
      await handle.close();
    }
  });

  it('refuses the same hostname when advertisedUrl is not set (the control)', async () => {
    const handle = await boot({});
    try {
      expect(await refresh(handle.port, 'mcp.example.com')).toBe(403);
    } finally {
      await handle.close();
    }
  });

  it('admits a second external path through allowedHosts', async () => {
    // What derivation cannot cover: one declared address, two real paths.
    const handle = await boot({ advertisedUrl: ADVERTISED, allowedHosts: ['tunnel.example.com'] });
    try {
      expect(await refresh(handle.port, 'tunnel.example.com')).toBe(200);
      expect(await refresh(handle.port, 'mcp.example.com')).toBe(200);
      expect(await refresh(handle.port, 'attacker.example')).toBe(403);
    } finally {
      await handle.close();
    }
  });
});

describe('startHttpServer guard host normalisation', () => {
  const refresh = (port: number, host: string): Promise<number> =>
    rawRequest(port, { method: 'POST', path: '/admin/refresh', headers: { host } });

  it('never accepts an empty Host header', async () => {
    // The sharp end of an unusable allowedHosts entry: a guard set holding the
    // empty string would admit a request naming no host at all. Sent over a raw
    // socket because Node's http client substitutes its own Host for an empty
    // one, so the case is unreachable through `rawRequest`.
    const cache = new SchemaCache({ connection: 'postgres://invalid:5432/none' });
    const handle = await startHttpServer(cache, {
      port: 0,
      host: '127.0.0.1',
      // Even asked for explicitly, via the library, it must not be admitted.
      allowedHosts: ['mcp.example.com'],
    });
    try {
      expect(await rawSocketStatus(handle.port, 'POST /admin/refresh HTTP/1.1\r\nHost:\r\n\r\n')).toBe(
        403,
      );
    } finally {
      await handle.close();
    }
  });

  it('accepts a bracketed IPv6 Host for a loopback bind', async () => {
    // hostnameOf strips the brackets; without that branch `[::1]:port` reads as
    // "[" and the guard refuses a client that reached it over IPv6 loopback.
    const cache = new SchemaCache({ connection: 'postgres://invalid:5432/none' });
    const handle = await startHttpServer(cache, { port: 0, host: '127.0.0.1' });
    try {
      expect(await refresh(handle.port, `[::1]:${handle.port}`)).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it('matches a trailing-dot advertisedUrl against the dotless Host', async () => {
    const cache = new SchemaCache({ connection: 'postgres://invalid:5432/none' });
    const handle = await startHttpServer(cache, {
      port: 0,
      host: '127.0.0.1',
      advertisedUrl: 'https://mcp.example.com./mcp',
    });
    try {
      expect(await refresh(handle.port, 'mcp.example.com')).toBe(200);
      expect(await refresh(handle.port, 'mcp.example.com.')).toBe(200);
    } finally {
      await handle.close();
    }
  });
});

describe('startHttpServer allowedHosts startup refusals', () => {
  const cache = (): SchemaCache =>
    new SchemaCache({ connection: 'postgres://invalid:5432/none' });

  const boot = (allowedHosts: string[]): Promise<HttpServerHandle> =>
    startHttpServer(cache(), { port: 0, host: '127.0.0.1', allowedHosts });

  it('refuses a URL, the shape the sibling key takes', async () => {
    await expect(boot(['https://tunnel.example.com'])).rejects.toThrow(/is a URL or carries a path/);
  });

  it('refuses an entry carrying a path', async () => {
    await expect(boot(['tunnel.example.com/mcp'])).rejects.toThrow(/is a URL or carries a path/);
  });

  it('refuses an entry no hostname can be read from', async () => {
    await expect(boot([':3334'])).rejects.toThrow(/no hostname can be read from it/);
    await expect(boot([''])).rejects.toThrow(/no hostname can be read from it/);
  });

  it('accepts a bare hostname and a host:port', async () => {
    const handle = await boot(['tunnel.example.com', 'mcp.internal:3334']);
    await handle.close();
  });
});

describe('startHttpServer notes a plaintext listener in OAuth mode', () => {
  // The bind warning is suppressed in OAuth mode because its "NO
  // authentication" line would be false there. Suppressing it also removed the
  // one hazard OAuth mode adds: the socket is still plain http, so a token sent
  // straight to the port is not encrypted.
  const AUTH = {
    resource: 'https://mcp.example.com/mcp',
    authorizationServers: ['https://idp.example.com/realms/kozou'],
    jwt: { secret: 'x'.repeat(32) },
  };

  async function bootChunks(opts: Record<string, unknown>): Promise<string[]> {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const cache = new SchemaCache({ connection: 'postgres://invalid:5432/none' });
    let handle: HttpServerHandle;
    try {
      handle = await startHttpServer(cache, { port: 0, logPrefix: '[test]', ...opts });
    } finally {
      spy.mockRestore();
    }
    await handle.close();
    return writes;
  }

  const NOTE = 'NOTE: OAuth mode bound to non-loopback host';

  /** The note's own lines, prefix stripped. Asserted as exact prose: the message
   *  is the whole product, so a dropped line or a lost prefix is the defect. */
  async function noteLines(opts: Record<string, unknown>): Promise<string[]> {
    const chunk = (await bootChunks(opts)).find((written) => written.includes(NOTE));
    if (chunk === undefined) return [];
    return chunk
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        expect(line.startsWith('[test] '), `every line carries the log prefix: ${line}`).toBe(true);
        return line.slice('[test] '.length);
      });
  }

  it('renders exactly this for a bind-all listener in OAuth mode', async () => {
    // 0.0.0.0 is what both shipped Compose stacks set, so this is the message
    // the containerised OAuth deployment actually gets.
    expect(await noteLines({ host: '0.0.0.0', auth: AUTH })).toEqual([
      'NOTE: OAuth mode bound to non-loopback host "0.0.0.0". This listener',
      'speaks plaintext http — kozou terminates no TLS of its own — so a bearer',
      'token sent straight to this port crosses the network unencrypted, whatever',
      'scheme the advertised resource URI uses.',
      'Terminate TLS in front of it, and let nothing reach this port except',
      'through that path.',
    ]);
  });

  it('names the host it was actually bound to', async () => {
    // A second bindable non-loopback address, so the host is read from the
    // option rather than hardcoded. A hostname that does not resolve locally
    // cannot be bound at all, so it cannot be used to test this.
    const lines = await noteLines({ host: '::', auth: AUTH });
    expect(lines[0]).toContain('"::"');
  });

  it('is a NOTE, not a WARNING, and does not claim the endpoint is unauthenticated', async () => {
    // A warning would fire on the sanctioned containerised shape every time.
    const out = (await bootChunks({ host: '0.0.0.0', auth: AUTH })).join('');
    expect(out).toContain(NOTE);
    expect(out).not.toContain('WARNING: MCP HTTP server bound to non-loopback host');
    expect(out).not.toContain('has NO authentication');
  });

  it('stays quiet for a loopback bind in OAuth mode', async () => {
    expect((await bootChunks({ host: '127.0.0.1', auth: AUTH })).join('')).not.toContain(NOTE);
  });

  it('stays quiet without auth, where the bind warning speaks instead', async () => {
    // No bearer token exists to be exposed there, and the existing warning
    // already names that deployment's hazard. The two are exclusive.
    const out = (await bootChunks({ host: '0.0.0.0' })).join('');
    expect(out).not.toContain(NOTE);
    expect(out).toContain('WARNING: MCP HTTP server bound to non-loopback host');
  });

  it('is unaffected by allowInsecureHttp, which is about advertised values', async () => {
    // Waiving the plaintext refusal for an advertised URL says nothing about
    // whether the socket itself is encrypted.
    const out = (await bootChunks({
      host: '0.0.0.0',
      auth: {
        resource: 'http://mcp.example.com/mcp',
        authorizationServers: ['http://idp.example.com/realms/kozou'],
        jwt: { secret: 'x'.repeat(32) },
        allowInsecureHttp: true,
      },
    })).join('');
    expect(out).toContain(NOTE);
  });
});

describe('startHttpServer warns about a declared off-box address with no auth', () => {
  // The bind-address warning cannot reach this deployment: a tunnel or proxy
  // binds loopback, so the endpoint most exposed to the internet was the one
  // that said nothing at all.
  /** Every chunk written to stderr while booting. Kept as chunks, not joined:
   *  the warning is one write, so its own boundaries are what make an exact
   *  assertion on it possible. */
  async function bootChunks(opts: Record<string, unknown>): Promise<string[]> {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const cache = new SchemaCache({ connection: 'postgres://invalid:5432/none' });
    let handle: HttpServerHandle;
    try {
      handle = await startHttpServer(cache, { port: 0, host: '127.0.0.1', ...opts });
    } finally {
      spy.mockRestore();
    }
    await handle.close();
    return writes;
  }

  const bootStderr = async (opts: Record<string, unknown>): Promise<string> =>
    (await bootChunks(opts)).join('');

  const NEEDLE = 'declared reachable at';

  /** The warning's own lines, in order, with the log prefix stripped. */
  async function warningLines(opts: Record<string, unknown>): Promise<string[]> {
    const chunk = (await bootChunks({ logPrefix: '[test]', ...opts })).find((written) =>
      written.includes(NEEDLE),
    );
    if (chunk === undefined) return [];
    return chunk
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        expect(line.startsWith('[test] '), `every line carries the log prefix: ${line}`).toBe(true);
        return line.slice('[test] '.length);
      });
  }

  // Asserted as exact prose, not substrings: a warning is the whole product
  // here, so a dropped line, a lost prefix, a collapsed newline or a reordering
  // is the defect, and every one of those survives a `toContain` check.
  it('renders exactly this, for a public https address with no execution', async () => {
    expect(await warningLines({ advertisedUrl: 'https://mcp.example.com/mcp' })).toEqual([
      'WARNING: this endpoint is declared reachable at "https://mcp.example.com/mcp",',
      'which is not a local address, and it runs no authentication of its own.',
      "Anyone who can reach it can read this database's schema metadata",
      'and force a schema re-read (POST /admin/refresh is open in this mode).',
      'To authenticate each caller: move this address to auth.resource, drop',
      'advertisedUrl (the two are refused together) and configure',
      'server.mcp.http.auth. Otherwise keep the address private, or front it',
      'with a layer that authenticates before kozou sees the request — over',
      'https, since credentials would then cross this address too.',
    ]);
  });

  it('names the remedy that actually boots', async () => {
    // "Add auth" alone would send the operator into a startup error, because
    // advertisedUrl and auth are refused together. The address has to move.
    const out = await bootStderr({ advertisedUrl: 'https://mcp.example.com/mcp' });
    expect(out).toContain('move this address to auth.resource');
    expect(out).toContain('drop');
    expect(out).toContain('refused together');
  });

  it('adds plaintext lines for an http address, and asks for https in the remedy', async () => {
    const lines = await warningLines({ advertisedUrl: 'http://mcp.example.com/mcp' });
    expect(lines).toContain('The advertised address is plaintext http, so requests and');
    expect(lines).toContain('responses cross the network unencrypted.');
    expect(lines).toContain('https, since credentials would then cross this address too.');
  });

  it('says nothing about plaintext for an https address', async () => {
    const out = await bootStderr({ advertisedUrl: 'https://mcp.example.com/mcp' });
    expect(out).not.toContain('plaintext');
    expect(out).not.toContain('unencrypted');
  });

  it('escalates for execution, and drops the metadata-only wording', async () => {
    const lines = await warningLines({
      advertisedUrl: 'https://mcp.example.com/mcp',
      execution: {
        pool: {
          connect: async () => ({
            query: async () => ({ rows: [], rowCount: 0 }),
            release: () => {},
          }),
        },
        role: 'kozou_agent',
        claimsGuc: 'request.jwt.claims',
      },
    });
    expect(lines).toEqual([
      'WARNING: this endpoint is declared reachable at "https://mcp.example.com/mcp",',
      'which is not a local address, and it runs no authentication of its own.',
      'The `call` execution tool is ENABLED: anyone who can reach it can',
      'execute exposed database functions as the "kozou_agent" role,',
      'which is the single identity every caller shares here, and can force',
      'a schema re-read (POST /admin/refresh is open in this mode).',
      'To authenticate each caller: move this address to auth.resource, drop',
      'advertisedUrl (the two are refused together) and configure',
      'server.mcp.http.auth. Otherwise keep the address private, or front it',
      'with a layer that authenticates before kozou sees the request — over',
      'https, since credentials would then cross this address too.',
    ]);
  });

  it('does not claim execution when there is none', async () => {
    // The role lines must be gated, not appended: ungated they would print
    // `as the "undefined" role` on a describe-only deployment.
    const out = await bootStderr({ advertisedUrl: 'https://mcp.example.com/mcp' });
    expect(out).not.toContain('execution tool is ENABLED');
    expect(out).not.toContain('single identity');
    expect(out).not.toContain('undefined');
  });

  it('fires alongside the bind-address warning, which is a different fact', async () => {
    const out = await bootStderr({
      host: '0.0.0.0',
      advertisedUrl: 'https://mcp.example.com/mcp',
    });
    expect(out).toContain('bound to non-loopback host');
    expect(out).toContain(NEEDLE);
  });

  it('stays quiet for a loopback declared address, however it is spelled', async () => {
    // The scaffolded Compose stack's ordinary shape is a published-port remap on
    // localhost. The trailing-dot and IPv4-mapped forms name the same machine,
    // and the guard's own Host matching already treats them that way.
    for (const url of [
      'http://localhost:4334/mcp',
      'http://localhost.:4334/mcp',
      'http://127.0.0.1:4334/mcp',
      'http://127.0.0.5:4334/mcp',
      'http://[::1]:4334/mcp',
      'http://[::ffff:127.0.0.1]:4334/mcp',
    ]) {
      expect(await bootStderr({ advertisedUrl: url }), url).not.toContain(NEEDLE);
    }
  });

  it('still warns for an off-box name with a trailing dot', async () => {
    expect(await bootStderr({ advertisedUrl: 'https://mcp.example.com./mcp' })).toContain(NEEDLE);
  });

  it('stays quiet when no address is declared', async () => {
    expect(await bootStderr({})).not.toContain(NEEDLE);
  });

  it('never fires from an auth block, whose public resource URI is sanctioned', async () => {
    // auth and advertisedUrl are mutually exclusive, so the risk is a future
    // change feeding auth.resource into this warning. Pinned from that side.
    const out = await bootStderr({
      auth: {
        resource: 'https://mcp.example.com/mcp',
        authorizationServers: ['https://idp.example.com/realms/kozou'],
        jwt: { secret: 'x'.repeat(32) },
      },
    });
    expect(out).not.toContain(NEEDLE);
    expect(out).not.toContain('runs no authentication of its own');
  });
});

describe('startHttpServer advertisedUrl startup refusals', () => {
  const cache = (): SchemaCache =>
    new SchemaCache({ connection: 'postgres://invalid:5432/none' });

  it('refuses advertisedUrl alongside auth (both declare the address)', async () => {
    await expect(
      startHttpServer(cache(), {
        port: 0,
        host: '127.0.0.1',
        advertisedUrl: 'https://mcp.example.com/mcp',
        auth: {
          resource: 'https://mcp.example.com/mcp',
          authorizationServers: ['https://idp.example.com/realms/kozou'],
          jwt: { secret: 'x'.repeat(32) },
        },
      }),
    ).rejects.toThrow(/advertisedUrl is set alongside auth/);
  });

  it('refuses a relative advertisedUrl', async () => {
    await expect(
      startHttpServer(cache(), { port: 0, host: '127.0.0.1', advertisedUrl: '/mcp' }),
    ).rejects.toThrow(/is not an absolute URL/);
  });

  it('refuses a bind-all declared address', async () => {
    // Not somewhere a client can connect, so handing it out is the failure this
    // key exists to prevent — and it would have drawn a security warning
    // claiming it "is not a local address".
    for (const url of ['http://0.0.0.0:4334/mcp', 'http://[::]:4334/mcp']) {
      await expect(
        startHttpServer(cache(), { port: 0, host: '127.0.0.1', advertisedUrl: url }),
      ).rejects.toThrow(/bind-all address/);
    }
  });

  it('refuses userinfo, and does not echo it', async () => {
    const attempt = startHttpServer(cache(), {
      port: 0,
      host: '127.0.0.1',
      advertisedUrl: 'https://user:secret@mcp.example.com/mcp',
    });
    await expect(attempt).rejects.toThrow(/carries userinfo/);
    // Repeating the credential into the log is the leak the refusal prevents.
    await expect(attempt).rejects.not.toThrow(/secret/);
  });

  it('refuses a query, a fragment and a wrong path, as the CLI config does', async () => {
    for (const url of [
      'https://mcp.example.com/mcp?t=1',
      'https://mcp.example.com/mcp#f',
      'https://mcp.example.com/',
      'https://mcp.example.com/api/mcp',
    ]) {
      await expect(
        startHttpServer(cache(), { port: 0, host: '127.0.0.1', advertisedUrl: url }),
        url,
      ).rejects.toThrow();
    }
  });

  it('refuses a non-http(s) advertisedUrl', async () => {
    await expect(
      startHttpServer(cache(), {
        port: 0,
        host: '127.0.0.1',
        advertisedUrl: 'ws://mcp.example.com/mcp',
      }),
    ).rejects.toThrow(/must be an http\(s\) URL/);
  });
});

describe('startHttpServer guard startup line', () => {
  it('advises the fully-qualified config key, and lists the derived hostname', async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const cache = new SchemaCache({ connection: 'postgres://invalid:5432/none' });
    let handle: HttpServerHandle;
    try {
      handle = await startHttpServer(cache, {
        port: 0,
        host: '127.0.0.1',
        advertisedUrl: 'https://mcp.example.com/mcp',
      });
    } finally {
      spy.mockRestore();
    }
    await handle.close();
    const out = writes.join('');
    expect(out).toContain('add more with server.mcp.http.allowedHosts');
    // The bare option name is what kozou.config.yaml rejects, so the line must
    // not advertise it on its own.
    expect(out).not.toContain('set allowedHosts to add more');
    expect(out).toContain('mcp.example.com');
  });
});

describe('startHttpServer request body limits', () => {
  let handle: HttpServerHandle;
  let cache: SchemaCache;
  let baseUrl: string;

  beforeAll(async () => {
    cache = new SchemaCache({ connection: 'postgres://invalid:5432/none' });
    // A tiny cap so a modest body trips the limit.
    handle = await startHttpServer(cache, { port: 0, host: '127.0.0.1', maxBodyBytes: 64 });
    baseUrl = `http://127.0.0.1:${handle.port}`;
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  it('rejects an over-sized body with 413 (declared Content-Length)', async () => {
    const big = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'x',
      params: { pad: 'a'.repeat(200) },
    });
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: big,
    });
    expect(res.status).toBe(413);
  });

  it('rejects an over-sized body while streaming with 413', async () => {
    // A raw request whose body exceeds the cap; the streaming guard trips
    // regardless of how the size is framed on the wire.
    const status = await rawRequest(handle.port, {
      method: 'POST',
      path: '/mcp',
      headers: { host: `127.0.0.1:${handle.port}`, 'content-type': 'application/json' },
      body: 'x'.repeat(500),
    });
    expect(status).toBe(413);
  });

  it('rejects a non-JSON Content-Type with 415', async () => {
    const status = await rawRequest(handle.port, {
      method: 'POST',
      path: '/mcp',
      headers: { host: `127.0.0.1:${handle.port}`, 'content-type': 'text/plain' },
      body: 'hello',
    });
    expect(status).toBe(415);
  });
});

describe('startHttpServer existing-session body cap', () => {
  let handle: HttpServerHandle;
  let baseUrl: string;

  beforeAll(async () => {
    // The MCP handshake is transport-level (no SchemaCache.get), so an
    // un-dialed connection is enough to open a session. The cap is large enough
    // to admit the initialize body but small enough to trip on a modest POST.
    const cache = new SchemaCache({ connection: 'postgres://invalid:5432/none' });
    handle = await startHttpServer(cache, { port: 0, host: '127.0.0.1', maxBodyBytes: 4096 });
    baseUrl = `http://127.0.0.1:${handle.port}`;
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  it('enforces the cap on an established session (chunked, no Content-Length) → 413', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: 'kozou-test', version: '0.0.0' });
    try {
      await client.connect(transport);
      const sessionId = transport.sessionId;
      expect(sessionId).toBeTruthy();

      // A POST to the live session whose body exceeds the cap. The Content-
      // Length short-circuit and the streaming guard both target this; the
      // request must be refused before the SDK transport buffers it.
      const status = await rawRequest(handle.port, {
        method: 'POST',
        path: '/mcp',
        headers: {
          host: `127.0.0.1:${handle.port}`,
          'content-type': 'application/json',
          'mcp-session-id': sessionId as string,
        },
        body: 'x'.repeat(8000),
      });
      expect(status).toBe(413);
    } finally {
      await client.close();
    }
  });
});

describe('startHttpServer MCP over HTTP (generic fixture)', () => {
  let db: DatabaseHandle;
  let handle: HttpServerHandle;

  beforeAll(async () => {
    db = await setupDatabase();
    const client = new pkg.Client({ connectionString: db.connectionString });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${db.schema}"`);
      await client.query(`SET search_path TO "${db.schema}"`);
      await client.query(MINIMAL_FIXTURE_SQL);
    } finally {
      await client.end();
    }

    const cache = new SchemaCache({
      connection: db.connectionString,
      schemas: [db.schema],
      ttlMs: 60_000,
    });
    handle = await startHttpServer(cache, { port: 0, host: '127.0.0.1' });
  }, 120_000);

  afterAll(async () => {
    if (handle) await handle.close();
    if (db) await db.cleanup();
  });

  it('serves the MCP tool list + a list_tables call over HTTP', async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
    );
    const client = new Client({ name: 'kozou-test', version: '0.0.0' });
    try {
      await client.connect(transport);

      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain('list_tables');
      expect(names).toContain('describe_table');

      const result = await client.callTool({
        name: 'list_tables',
        arguments: { schema: db.schema },
      });
      const content = result.content as Array<{ type: string; text: string }>;
      const payload = JSON.parse(content[0].text) as {
        tables: Array<{ qualifiedName: string }>;
      };
      const qualified = payload.tables.map((t) => t.qualifiedName).sort();
      expect(qualified).toEqual([`${db.schema}.authors`, `${db.schema}.books`]);
    } finally {
      await client.close();
    }
  });
});
