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
import { describeMcpAuth } from '../../src/lib/connect/mcp-connection.js';

/** Every posture whose wording reaches the page (`off` renders no page). */
const POSTURES = ['local', 'oauth', 'unknown'] as const;

/** A quantity next to the word "tool". Matched in both directions: the
 *  original defect put the number first ("seven read-only tools"), but
 *  "tools, eight of them" is the same claim and the likelier rewrite. The
 *  vocabulary goes past twelve and includes "dozen" for the same reason. A
 *  count in a separate sentence ("…tools. There are eight.") still slips
 *  through; that is the documented limit, and it takes deliberate effort. */
const COUNT = String.raw`(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|dozen)`;
const TOOL = String.raw`tools?|tooling`;
const QUANTIFIED_TOOLS = new RegExp(
  `\\b${COUNT}\\b[^.]{0,40}\\b(?:${TOOL})\\b|\\b(?:${TOOL})\\b[^.]{0,40}\\b${COUNT}\\b`,
  'i',
);

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

  // Tags stripped and whitespace collapsed before matching. A raw-source check
  // is defeated by markup: `no <strong>authentication</strong>` renders the
  // forbidden sentence while containing none of it — and emphasising a word in
  // that sentence is the likeliest edit anyone makes to it.
  const renderedText = () =>
    template()
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ');

  it('binds the resolved auth note', () => {
    expect(template()).toContain('data.connection.authNote');
  });

  it('asserts nothing about authentication or bind posture itself', () => {
    const text = renderedText();
    // Paraphrases too: the defect was a fixed claim, not a fixed wording.
    for (const claim of [
      'no authentication',
      'unauthenticated',
      'without authentication',
      'requires authentication',
      'protected resource',
      'loopback',
    ]) {
      expect(text).not.toContain(claim);
    }
  });

  it('does not count the MCP tools — that number belongs to another package', () => {
    // "seven read-only tools" outlived search_schema shipping in v1.15.0
    // because nothing here could see the count. This package does not depend
    // on @kozou/mcp and should not start to for a sentence, so the fix is to
    // state no number: a claim that cannot be made cannot go stale.
    //
    // Checked over everything the page renders, not just the template: the
    // resolved auth note is interpolated into the same paragraph flow, so a
    // count added there would reach the same reader with nothing to catch it.
    for (const text of [renderedText(), ...POSTURES.map((p) => describeMcpAuth(p))]) {
      expect(text).not.toMatch(QUANTIFIED_TOOLS);
    }
  });
});

describe('connect page load: the OAuth address', () => {
  const RESOURCE_KEY = 'KOZOU_UI_MCP_RESOURCE';
  let savedResource: string | undefined;

  beforeEach(() => {
    savedResource = process.env[RESOURCE_KEY];
    delete process.env[RESOURCE_KEY];
  });

  afterEach(() => {
    if (savedResource === undefined) delete process.env[RESOURCE_KEY];
    else process.env[RESOURCE_KEY] = savedResource;
  });

  it('hands over the canonical resource URI the CLI reported, not the request host', () => {
    process.env[ENV_KEY] = 'oauth';
    process.env[RESOURCE_KEY] = 'https://mcp.example.com/mcp';
    const data = connectLoad(connectEvent()) as {
      connection: { httpUrl: string; jsonConfig: string; claudeCodeCommand: string };
    };
    // connectEvent() requests http://localhost:3333/connect, so before this the
    // page handed out http://localhost:3334/mcp for an endpoint published at
    // mcp.example.com — a config that cannot connect.
    expect(data.connection.httpUrl).toBe('https://mcp.example.com/mcp');
    expect(data.connection.jsonConfig).toContain('https://mcp.example.com/mcp');
    expect(data.connection.claudeCodeCommand).toContain('https://mcp.example.com/mcp');
  });

  it('keeps the request-derived URL when the endpoint declared no resource', () => {
    process.env[ENV_KEY] = 'local';
    process.env[RESOURCE_KEY] = 'https://stale.example.com/mcp';
    const data = connectLoad(connectEvent()) as { connection: { httpUrl: string } };
    expect(data.connection.httpUrl).toBe('http://localhost:3334/mcp');
  });
});
