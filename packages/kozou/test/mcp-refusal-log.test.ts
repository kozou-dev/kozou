// What an operator reads on stderr when `kozou mcp --http` refuses a token in
// OAuth mode: one line per refusal naming the check, and nothing copied from
// the request. Run as a real process, because the property is about the
// process's stderr — a library-level spy cannot see what the CLI wires (the
// prefix, the config inheritance) or what actually leaves the process.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { refusalCases, startJwksServer, SENTINEL, type JwksServer } from '@kozou/test-utils';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SECRET = 'cli-refusal-log-secret-0123456789abcdef';
const RESOURCE = 'http://127.0.0.1:3334/mcp';
const ISSUER = 'http://127.0.0.1:9/realms/kozou';
const ROLE = 'mcp_viewer';
const PREFIX = '[kozou mcp]';

async function writeConfig(jwt: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kozou-refusal-log-'));
  const file = join(dir, 'kozou.config.yaml');
  await writeFile(
    file,
    [
      'database:',
      // Never dialed: every request here is refused before the schema is read.
      '  url: postgres://u:p@127.0.0.1:1/app',
      'server:',
      '  mcp:',
      '    http:',
      '      auth:',
      `        resource: ${RESOURCE}`,
      '        authorizationServers:',
      `          - ${ISSUER}`,
      '        jwt:',
      ...jwt.map((line) => `          ${line}`),
      '        allowedRoles:',
      `          - ${ROLE}`,
      '',
    ].join('\n'),
    'utf8',
  );
  return file;
}

type Cli = { port: number; stderr: () => string; stop: () => Promise<void> };

async function waitFor(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function startCli(config: string): Promise<Cli> {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ['--import', 'tsx', CLI, 'mcp', '--http', '--port', '0', '--config', config],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, DATABASE_URL: '' },
    },
  );
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const listening = /MCP HTTP listening on http:\/\/127\.0\.0\.1:(\d+)/;
  try {
    await waitFor(() => listening.test(stderr) || child.exitCode !== null, 'the listening line');
  } catch (err) {
    child.kill('SIGKILL');
    throw err;
  }
  const match = listening.exec(stderr);
  if (match === null) throw new Error(`kozou mcp --http did not start:\n${stderr}${stdout}`);
  return {
    port: Number(match[1]),
    stderr: () => stderr + stdout,
    stop: async () => {
      child.kill('SIGTERM');
      await exited;
    },
  };
}

function post(port: number, authorization: string | undefined): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/mcp',
        headers: authorization === undefined ? {} : { authorization },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const authLines = (text: string): string[] =>
  text.split('\n').filter((line) => line.startsWith(`${PREFIX} auth `));

/** Send one request and wait for the line it should produce. */
async function refuse(cli: Cli, authorization: string | undefined): Promise<number> {
  const before = authLines(cli.stderr()).length;
  const status = await post(cli.port, authorization);
  await waitFor(() => authLines(cli.stderr()).length > before, 'a refusal line');
  return status;
}

describe('kozou mcp --http in OAuth mode logs why it refused, as a process', () => {
  let cli: Cli;
  const cases = refusalCases({ secret: SECRET, issuer: ISSUER, audience: RESOURCE, allowedRole: ROLE });

  beforeAll(async () => {
    cli = await startCli(await writeConfig([`secret: ${SECRET}`]));
  }, 60_000);

  afterAll(async () => {
    if (cli) await cli.stop();
  });

  it('writes exactly one line per refusal, naming its status and reason, in order', async () => {
    for (const c of cases) {
      expect(await refuse(cli, c.authorization)).toBe(c.status);
    }
    // Let anything still in the pipe arrive before counting.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const lines = authLines(cli.stderr());
    expect(lines.map((line) => line.slice(0, line.indexOf(':')))).toEqual(
      cases.map((c) => `${PREFIX} auth ${c.status} ${c.code}`),
    );
    // Each line explains itself; the role claim is named by its configured name.
    const roleMissing = lines.find((line) => line.includes(' role_missing: '));
    expect(roleMissing).toContain('no "role" claim');
    expect(roleMissing).not.toMatch(/defaultRole/);
    expect(lines.find((line) => line.includes(' no_token: '))).toMatch(/normal start of a connection/);
  });

  it('never copies a token, a header, or a claim value onto stderr', () => {
    const all = cli.stderr();
    for (const value of Object.values(SENTINEL)) expect(all).not.toContain(value);
    for (const c of cases) {
      if (c.authorization === undefined) continue;
      expect(all).not.toContain(c.authorization);
      const token = c.authorization.slice(c.authorization.indexOf(' ') + 1);
      for (const segment of token.split('.')) {
        if (segment.length >= 8) expect(all).not.toContain(segment);
      }
    }
    expect(all).not.toContain(SECRET);
  });
});

describe('kozou mcp --http in OAuth mode against a JWKS, as a process', () => {
  let jwks: JwksServer;
  let cli: Cli;

  beforeAll(async () => {
    jwks = await startJwksServer();
    cli = await startCli(await writeConfig([`jwksUri: ${jwks.jwksUri}`]));
  }, 60_000);

  afterAll(async () => {
    if (cli) await cli.stop();
    if (jwks) await jwks.close();
  });

  it('tells an unreadable key set, an unpublished kid and an ambiguous one apart', async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = { iss: ISSUER, aud: RESOURCE, role: ROLE, scope: 'mcp:describe', sub: SENTINEL.subject, exp: now + 600 };

    // The failing fetch first: once a fetch succeeds, the key set is cached.
    jwks.failing = true;
    const published = jwks.sign(payload);
    expect(await refuse(cli, `Bearer ${published}`)).toBe(401);
    jwks.failing = false;
    const unpublished = jwks.sign(payload, 'k-unpublished');
    expect(await refuse(cli, `Bearer ${unpublished}`)).toBe(401);
    // No kid at all, against a set of two RS256 keys.
    const kidless = jwks.sign(payload, null);
    expect(await refuse(cli, `Bearer ${kidless}`)).toBe(401);

    await new Promise((resolve) => setTimeout(resolve, 200));
    const lines = authLines(cli.stderr());
    expect(lines.map((line) => line.slice(0, line.indexOf(':')))).toEqual([
      `${PREFIX} auth 401 jwks_unavailable`,
      `${PREFIX} auth 401 unknown_key`,
      `${PREFIX} auth 401 ambiguous_key`,
    ]);
    const all = cli.stderr();
    for (const token of [published, unpublished, kidless]) {
      for (const segment of token.split('.')) expect(all).not.toContain(segment);
    }
    expect(all).not.toContain(SENTINEL.subject);
  });
});
