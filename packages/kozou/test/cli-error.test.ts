// What the operator actually reads when a command dies. The regression these
// cover: for the schema path a KozouConfigError's message is only a count, so a
// CLI that printed the message alone told the operator that something was wrong
// and nothing about what.

import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('omits the location when no file was loaded', () => {
    const err = new KozouConfigError('Invalid KOZOU_MCP_HTTP_ENABLED: …', null, []);
    expect(formatCliError(err)).toBe('Invalid KOZOU_MCP_HTTP_ENABLED: …');
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

describe('the CLI entry point renders errors through this formatter', () => {
  // cli.ts is a process-exit shell with no harness of its own (vitest coverage
  // excludes it), so a top-level catch that went back to printing err.message
  // would drop every issue again with nothing failing. This is the only thing
  // that binds the two.
  const cli = () => readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

  it('passes the thrown value to formatCliError', () => {
    expect(cli()).toMatch(/formatCliError\(\s*err\s*\)/);
  });

  it('does not print a bare message instead', () => {
    expect(cli()).not.toContain('err instanceof Error ? err.message');
  });
});
