// What the operator actually reads when a command dies. The regression these
// cover: for the schema path a KozouConfigError's message is only a count, so a
// CLI that printed the message alone told the operator that something was wrong
// and nothing about what.

import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { formatCliError } from '../src/cli-error.js';
import { KozouConfigError, loadConfig } from '../src/config.js';

async function writeConfig(lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kozou-cli-error-'));
  const file = join(dir, 'kozou.config.yaml');
  await writeFile(file, [...lines, ''].join('\n'), 'utf8');
  return file;
}

describe('formatCliError', () => {
  it('prints every issue the error carries, under the message', () => {
    const err = new KozouConfigError('Invalid kozou config: 2 issue(s)', null, [
      { path: 'server.mcp.http.port', message: 'Too big: expected number to be <=65535' },
      { path: 'database.url', message: 'Required' },
    ]);
    expect(formatCliError(err)).toBe(
      [
        'Invalid kozou config: 2 issue(s)',
        '  server.mcp.http.port — Too big: expected number to be <=65535',
        '  database.url — Required',
      ].join('\n'),
    );
  });

  it('reports the config file as where the config was loaded from', () => {
    const err = new KozouConfigError('Invalid kozou config: 1 issue(s)', '/srv/kozou.config.yaml', [
      { path: 'database.url', message: 'Required' },
    ]);
    const out = formatCliError(err);
    // Last line, and phrased as provenance: environment variables feed the same
    // validation, so this must not read as "the mistake is in this file".
    expect(out.split('\n').at(-1)).toBe('loaded from: /srv/kozou.config.yaml');
  });

  it('omits the location when nothing identifiable fed the config', () => {
    const err = new KozouConfigError('Invalid KOZOU_MCP_HTTP_ENABLED: …', null, []);
    expect(formatCliError(err)).toBe('Invalid KOZOU_MCP_HTTP_ENABLED: …');
  });

  it('names the environment variables that fed the config, next to the file', () => {
    // Without this the operator is sent to a file whose contents refute the
    // message: it says `enabled: true`, the env var turned the endpoint off.
    const err = new KozouConfigError(
      'Invalid kozou config: 1 issue(s)',
      '/srv/kozou.config.yaml',
      [{ path: 'server.mcp.http.auth', message: 'auth is set while the endpoint is disabled' }],
      ['KOZOU_MCP_HTTP_ENABLED'],
    );
    expect(formatCliError(err).split('\n').at(-1)).toBe(
      'loaded from: /srv/kozou.config.yaml, with values from KOZOU_MCP_HTTP_ENABLED',
    );
  });

  it('reports the environment alone when there is no file (the container case)', () => {
    const err = new KozouConfigError(
      'Invalid kozou config: 1 issue(s)',
      null,
      [{ path: 'auth.jwt.algorithms.0', message: 'Invalid option: expected one of "HS256"|"RS256"' }],
      ['KOZOU_JWT_SECRET', 'KOZOU_JWT_ALGORITHMS'],
    );
    expect(formatCliError(err).split('\n').at(-1)).toBe(
      'loaded from: the environment (KOZOU_JWT_SECRET, KOZOU_JWT_ALGORITHMS)',
    );
  });

  it('keeps an issue whose message is empty, and prints no dangling separator', () => {
    // `'anything'.includes('')` is true, so the dedupe below would have dropped
    // this issue and left the operator with the count alone.
    const err = new KozouConfigError('Invalid kozou config: 1 issue(s)', null, [
      { path: 'database.url', message: '' },
    ]);
    expect(formatCliError(err)).toBe('Invalid kozou config: 1 issue(s)\n  database.url');
  });

  it('prints a pathless issue as its message alone', () => {
    const err = new KozouConfigError('Invalid kozou config: 1 issue(s)', null, [
      { path: '', message: 'Required' },
    ]);
    expect(formatCliError(err)).toBe('Invalid kozou config: 1 issue(s)\n  Required');
  });

  it('does not repeat an issue the message already states', () => {
    // Several error sites duplicate their detail into the message so consumers
    // that only report the message stay useful; printing both would stutter.
    const detail = 'KOZOU_UI_CLAIMS is not valid JSON: Unexpected end of JSON input';
    const err = new KozouConfigError(`Invalid kozou config: ${detail}`, null, [
      { path: 'auth.ui.claims', message: detail },
    ]);
    expect(formatCliError(err)).toBe(`Invalid kozou config: ${detail}`);
  });

  it('passes an ordinary Error through as its message', () => {
    expect(formatCliError(new Error('connection refused'))).toBe('connection refused');
  });

  it('stringifies a non-Error throw rather than printing nothing', () => {
    expect(formatCliError('plain string')).toBe('plain string');
    expect(formatCliError(undefined)).toBe('undefined');
  });
});

describe('formatCliError on the errors loadConfig actually throws', () => {
  it('turns "N issue(s)" into something the operator can act on', async () => {
    // The reproduction from the report: a port the schema refuses. Before this,
    // the whole message was "Invalid kozou config: 1 issue(s)".
    const file = await writeConfig([
      'database:',
      '  url: postgres://u:p@db:5432/app',
      'server:',
      '  mcp:',
      '    http:',
      '      port: 99999',
    ]);

    let thrown: unknown;
    try {
      await loadConfig({ path: file, env: {} });
    } catch (err) {
      thrown = err;
    }
    const out = formatCliError(thrown);
    expect(out).toContain('Invalid kozou config: 1 issue(s)');
    expect(out).toContain('server.mcp.http.port');
    expect(out).toContain('65535');
    expect(out).toContain(`loaded from: ${file}`);
  });

  it('names DATABASE_URL when no url reached the loader at all', async () => {
    // The first error a new adopter meets: no `database` block, no env var. The
    // schema's own message must be what they read — before, the `database`
    // section had no prefault, so it failed at the object level and printed
    // "expected object, received undefined" with DATABASE_URL never mentioned.
    const file = await writeConfig(['server:', '  ui:', '    port: 3333']);
    let thrown: unknown;
    try {
      await loadConfig({ path: file, env: {} });
    } catch (err) {
      thrown = err;
    }
    const out = formatCliError(thrown);
    expect(out).toContain('database.url — database.url is required (set DATABASE_URL');
  });

  it('does not call a present-but-wrong url "required"', async () => {
    const file = await writeConfig(['database:', '  url: [a, b]']);
    let thrown: unknown;
    try {
      await loadConfig({ path: file, env: {} });
    } catch (err) {
      thrown = err;
    }
    const out = formatCliError(thrown);
    expect(out).toContain('database.url — database.url must be a connection string');
    expect(out).not.toContain('is required');
  });

  it('never attributes an environment fault to the config file', async () => {
    const file = await writeConfig(['database:', '  url: postgres://u:p@db:5432/app']);

    let thrown: unknown;
    try {
      await loadConfig({ path: file, env: { KOZOU_MCP_HTTP_ENABLED: 'yes' } });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(KozouConfigError);
    // The file was read (it is where database.url came from) but says nothing
    // about this variable, so pointing at it sends the operator to the wrong
    // place — including through the location line this formatter now prints.
    expect((thrown as KozouConfigError).filePath).toBeNull();
    const out = formatCliError(thrown);
    expect(out).toContain('KOZOU_MCP_HTTP_ENABLED');
    expect(out).not.toContain('loaded from:');
    expect(out).not.toContain(file);
  });
});

describe('the CLI entry point, run as a process', () => {
  // cli.ts is a process-exit shell with no harness of its own (vitest coverage
  // excludes it). Asserting on its *source* — that it mentions formatCliError,
  // that it lacks the old expression — proved worthless: printing only the first
  // line of the formatted text, wrapping the message in String(), or a prettier
  // reflow all satisfy such assertions while restoring the original defect. So
  // run the thing and read its stderr instead. That also covers the two
  // properties no source check can see: the channel and the exit code.
  //
  // Runs the TypeScript entry point through tsx rather than dist/cli.js: a stale
  // build would otherwise fail (or pass) for reasons that have nothing to do
  // with the working tree.
  const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

  function runInspect(config: string, extraEnv: NodeJS.ProcessEnv = {}) {
    return spawnSync(process.execPath, ['--import', 'tsx', CLI, 'inspect', '--config', config], {
      encoding: 'utf8',
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, DATABASE_URL: '', ...extraEnv },
    });
  }

  it('prints the issue paths and reasons, on stderr, exit 1', async () => {
    const file = await writeConfig([
      'database:',
      '  url: postgres://u:p@db:5432/app',
      'server:',
      '  mcp:',
      '    http:',
      '      port: 99999',
    ]);
    const run = runInspect(file);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('Invalid kozou config: 1 issue(s)');
    expect(run.stderr).toContain('server.mcp.http.port');
    expect(run.stderr).toContain('65535');
    expect(run.stderr.trimEnd().split('\n').at(-1)).toBe(`loaded from: ${file}`);
  });

  it('names the environment variable that fed a failing config', async () => {
    // The report's case: the file says `enabled: true`, the env turned it off,
    // and the refusal is about the combination. Naming the file alone sent the
    // operator to a file whose contents refute the message.
    const file = await writeConfig([
      'database:',
      '  url: postgres://u:p@db:5432/app',
      'server:',
      '  mcp:',
      '    http:',
      '      enabled: true',
      '      auth:',
      '        resource: https://mcp.example.com/mcp',
      '        authorizationServers:',
      '          - https://as.example.com',
      '        jwt:',
      '          jwksUri: https://as.example.com/jwks',
    ]);
    const run = runInspect(file, { KOZOU_MCP_HTTP_ENABLED: 'false' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('server.mcp.http.auth');
    expect(run.stderr).toContain(`loaded from: ${file}, with values from KOZOU_MCP_HTTP_ENABLED`);
  });
});
