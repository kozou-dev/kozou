// `server.mcp.http.enabled: false` end to end.
//
// The opt-out has three observable effects in a running `kozou dev`, and
// each half was covered on its own: the CLI's skip branch is excluded from
// unit coverage, `buildAdminUiEnv`'s projection is unit-tested in
// test/dev.test.ts, and the page loader is unit-tested in the svelte-ui
// package. What none of them saw is the join — that a real `kozou dev` with
// the endpoint off produces a UI child whose /connect is gone and whose nav
// agrees. That join is where the feature actually lives.
//
// The stack under test is globalSetup's second `kozou dev`, differing from
// the first in `server.mcp.http.enabled` and in the ports it must not
// collide on. Its ports arrive from the setup rather than being repeated
// here: a copied literal that drifted would leave the listener probe passing
// against an unrelated free port — silently, since a free port refuses
// connections exactly like a disabled one.

import { connect } from 'node:net';

import { expect, test } from '@playwright/test';

const HOST = '127.0.0.1';

/** The enabled stack's MCP port, from playwright.config.ts's baseURL family. */
const MCP_PORT_SERVED = 3434;

function portFromEnv(name: string): number {
  const raw = process.env[name];
  const port = Number(raw);
  // Thrown at module load rather than asserted in a test: without these the
  // assertions below would be measuring some other stack, or nothing at all.
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      `${name} is not a port (${String(raw)}). globalSetup publishes it; this spec ` +
        'cannot run without knowing which stack it is talking to.',
    );
  }
  return port;
}

const UI_PORT_MCP_OFF = portFromEnv('KOZOU_E2E_MCP_OFF_UI_PORT');
const MCP_PORT_MCP_OFF = portFromEnv('KOZOU_E2E_MCP_OFF_MCP_PORT');
const ORIGIN_MCP_OFF = `http://${HOST}:${UI_PORT_MCP_OFF}`;

/** Resolve to the connection error code, or 'connected' if something answered. */
function probe(port: number, timeoutMs = 3_000): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host: HOST, port });
    const done = (result: string) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done('timeout'));
    socket.on('connect', () => done('connected'));
    socket.on('error', (err: NodeJS.ErrnoException) => done(err.code ?? 'error'));
  });
}

test('no MCP listener is started for the port the config names', async () => {
  // The port comes from the generated config, so this is not a probe of an
  // arbitrary free port: it is the port a served endpoint would be on.
  expect(await probe(MCP_PORT_MCP_OFF)).toBe('ECONNREFUSED');
  // ...and the instrument works. A probe() that always answered
  // ECONNREFUSED — wrong host, swallowed error code — would make the line
  // above vacuous, and nothing else in the file would notice.
  expect(await probe(MCP_PORT_SERVED)).toBe('connected');
});

test('/connect 404s instead of handing out config for a listener that is not running', async ({
  page,
}) => {
  const response = await page.goto(`${ORIGIN_MCP_OFF}/connect`);
  expect(response?.status()).toBe(404);
  // The page is reachable from a bookmark or a shared link, so hiding the
  // nav entry is not enough — and the 404 names the key to flip back.
  await expect(page.locator('body')).toContainText('server.mcp.http.enabled');
});

test('the Admin UI drops its MCP entry while staying otherwise usable', async ({ page }) => {
  await page.goto(`${ORIGIN_MCP_OFF}/`);
  await expect(page.locator('a[href="/connect"]')).toHaveCount(0);
  // Not a blank page: everything else is unaffected by the opt-out, which is
  // the point of having one rather than turning the stack off.
  await page.goto(`${ORIGIN_MCP_OFF}/tables/public.authors`);
  await expect(page.getByRole('cell', { name: 'Margaret Atwood' })).toBeVisible();
});

test('the same Admin UI build serves /connect when the endpoint is on', async ({ page }) => {
  // The control for both assertions above: same build, same database, same
  // code path — only the config differs. Without the 200, a regression that
  // 404s /connect in *every* posture leaves this whole file green, which is
  // the "each half covered on its own" failure the header describes.
  const served = await page.goto('/connect');
  expect(served?.status()).toBe(200);
  // Asserted as "at least one", not a count: the dashboard reaches /connect
  // from both the header nav and a card, and pinning how many entry points
  // exist would be the same stale-number defect guarded against elsewhere.
  // What matters is that the opt-out takes them all (the test above asserts
  // exactly zero) and that they are here otherwise.
  await page.goto('/');
  expect(await page.locator('a[href="/connect"]').count()).toBeGreaterThan(0);
});
