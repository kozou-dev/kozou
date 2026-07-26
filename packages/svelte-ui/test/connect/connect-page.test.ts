// The two server loads that decide whether the "Connect an AI agent" surface
// exists at all. Component rendering is not unit-tested in this package (no
// component-test harness exists here), so these cover the values the templates
// branch on: the layout's `mcpEnabled` gates the header link and the dashboard
// card, and the route's own load gates direct navigation.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { load as layoutLoad } from '../../src/routes/+layout.server.js';
import { load as connectLoad } from '../../src/routes/connect/+page.server.js';

const ENV_KEY = 'KOZOU_UI_MCP_POSTURE';

// Resolved from the package root the way test/smoke/build.test.ts does: a
// relative `new URL(..., import.meta.url)` is not a file URL in this
// environment.
const TEMPLATE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src/routes/connect/+page.svelte',
);

let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

const layoutEvent = () =>
  ({ locals: { schema: { tables: [], views: [] } } }) as never;

const connectEvent = () => ({ url: new URL('http://localhost:3333/connect') }) as never;

describe('+layout.server.ts mcpEnabled', () => {
  it('is true when nothing opts out, so the links stay as they were', () => {
    const data = layoutLoad(layoutEvent()) as { mcpEnabled: boolean };
    expect(data.mcpEnabled).toBe(true);
  });

  it('is true for an authenticated endpoint — auth is not absence', () => {
    process.env[ENV_KEY] = 'oauth';
    const data = layoutLoad(layoutEvent()) as { mcpEnabled: boolean };
    expect(data.mcpEnabled).toBe(true);
  });

  it('is false when kozou dev reports the endpoint off', () => {
    process.env[ENV_KEY] = 'off';
    const data = layoutLoad(layoutEvent()) as { mcpEnabled: boolean };
    // Both entry points to /connect read this one value, so a single false
    // hides the header link and the dashboard card together.
    expect(data.mcpEnabled).toBe(false);
  });
});

describe('connect page load', () => {
  it('serves the connection info when the endpoint is on', () => {
    const data = connectLoad(connectEvent()) as { connection: { httpUrl: string } };
    expect(data.connection.httpUrl).toBe('http://localhost:3334/mcp');
  });

  it('describes the posture the CLI reported, not a fixed one', () => {
    process.env[ENV_KEY] = 'oauth';
    const oauth = connectLoad(connectEvent()) as {
      connection: { httpUrl: string; authNote: string };
    };
    // Same endpoint the local posture serves...
    expect(oauth.connection.httpUrl).toBe('http://localhost:3334/mcp');
    // ...described as what it is. Before the posture channel existed, this
    // page told an OAuth deployment it had no authentication.
    expect(oauth.connection.authNote).toContain('OAuth 2.1 protected resource');
    expect(oauth.connection.authNote).not.toContain('no authentication');
  });

  it('404s when the MCP HTTP endpoint is turned off', () => {
    process.env[ENV_KEY] = 'off';
    // Hiding the two links is not enough: this URL is reachable directly, from
    // a bookmark or a shared link. Handing over copy-paste config for a
    // listener that is not running is a worse failure than the page's absence.
    let thrown: unknown;
    try {
      connectLoad(connectEvent());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { status?: number }).status).toBe(404);
    expect(String((thrown as { body?: { message?: string } }).body?.message)).toContain(
      'server.mcp.http.enabled',
    );
  });
});

describe('the connect template states no posture of its own', () => {
  // The defect this replaced was a hardcoded "no authentication" sentence in
  // the template, which no unit test could see. With the wording in $lib the
  // template must bind it — and must not grow a claim of its own again.
  const template = () => readFileSync(TEMPLATE_PATH, 'utf8');

  it('binds the resolved auth note', () => {
    expect(template()).toContain('data.connection.authNote');
  });

  it('asserts nothing about authentication itself', () => {
    expect(template()).not.toContain('no authentication');
  });
});
