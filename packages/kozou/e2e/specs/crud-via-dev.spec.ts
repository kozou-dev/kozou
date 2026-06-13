// Smoke CRUD through the Admin UI that `kozou dev` brings up.
//
// The point is the wiring, not re-testing the UI's full CRUD matrix
// (that lives in the @kozou/svelte-ui suite). A single create -> delete
// loop proves the things only `kozou dev` is responsible for:
//   - the Admin UI server is up on the configured UI port;
//   - it reaches the database through the REST adapter (KOZOU_ADAPTER_URL
//     wired from config.adapter.url), so the seeded list renders and the
//     create writes through;
//   - ORIGIN was propagated to the UI child, so the plain-http form POST
//     is accepted instead of being rejected by the CSRF guard with a 403.
//
// The created row is deleted again so the shared fixture is left in its
// original three-author state for re-runs.

import { expect, test } from '@playwright/test';

const TABLE = 'public.authors';
const CREATE_NAME = 'E2E (kozou dev) Author';

// A uuid detail URL: /tables/public.authors/<uuid>
const DETAIL_URL = new RegExp(
  `/tables/${TABLE.replace('.', '\\.')}/[0-9a-f-]{36}$`,
);

test('create then delete an authors row through the kozou dev Admin UI', async ({
  page,
}) => {
  // --- List renders seeded rows (read path via the REST adapter) ------
  await page.goto(`/tables/${TABLE}`);
  await expect(page.getByRole('cell', { name: 'Margaret Atwood' })).toBeVisible();

  // --- Create (write path + ORIGIN/CSRF wiring) ----------------------
  await page.getByRole('link', { name: '+ New' }).click();
  await page.waitForURL(`**/tables/${TABLE}/new`);

  await page.getByRole('textbox', { name: 'Display Name' }).fill(CREATE_NAME);
  await page.getByRole('button', { name: 'Save' }).click();

  // On success the new route redirects (303) to the freshly-created row's
  // detail page, whose id segment is the DB-generated uuid.
  await page.waitForURL(DETAIL_URL);
  await expect(page.getByText(CREATE_NAME)).toBeVisible();
  const createdId = page.url().split('/').pop() ?? '';
  expect(createdId).toMatch(/^[0-9a-f-]{36}$/);

  // --- Delete (restore the fixture) ----------------------------------
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.waitForURL(`**/tables/${TABLE}`);

  // The created row is gone and the listing is back to the three seeded
  // authors, proving the loop left the fixture untouched.
  await expect(page.getByText(CREATE_NAME)).toHaveCount(0);
  await expect(page.getByText(/3 total/)).toBeVisible();
});
