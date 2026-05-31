// The Kozou v0.2 DoD: the same Admin UI build, with only the DataAdapter
// swapped to the in-house @kozou/api server (KOZOU_ADAPTER_KIND=api, wired
// in global-setup), drives a full CRUD loop end-to-end through a real
// browser — list (read) -> + New -> Save (create) -> Edit -> Save (update)
// -> Delete. No UI code differs from the sibling e2e/ suite; only the backend.
//
// The loop creates and then deletes its row, so the shared fixture DB is
// left in its seeded state (three authors incl. Margaret Atwood).

import { expect, test } from '@playwright/test';

const TABLE = 'public.authors';
const CREATE_NAME = 'E2E API Author';
const EDIT_NAME = 'E2E API Author (edited)';

const DETAIL_URL = new RegExp(`/tables/${TABLE.replace('.', '\\.')}/[0-9a-f-]{36}$`);

test('Admin UI runs a full CRUD loop against @kozou/api', async ({ page }) => {
  // --- Read: the list page renders the seeded rows through @kozou/api ---
  await page.goto(`/tables/${TABLE}`);
  await expect(page.getByRole('cell', { name: 'Margaret Atwood' })).toBeVisible();
  await expect(page.getByText(/3 total/)).toBeVisible();

  // --- Create ---------------------------------------------------------
  await page.getByRole('link', { name: '+ New' }).click();
  await page.waitForURL(`**/tables/${TABLE}/new`);
  await page.getByRole('textbox', { name: 'Display Name' }).fill(CREATE_NAME);
  await page.getByRole('button', { name: 'Save' }).click();

  await page.waitForURL(DETAIL_URL);
  await expect(page.getByText(CREATE_NAME)).toBeVisible();
  const createdId = page.url().split('/').pop() ?? '';
  expect(createdId).toMatch(/^[0-9a-f-]{36}$/);

  // --- Update ---------------------------------------------------------
  await page.getByRole('link', { name: 'Edit' }).click();
  await page.waitForURL(`**/tables/${TABLE}/${createdId}/edit`);
  const nameInput = page.getByRole('textbox', { name: 'Display Name' });
  await expect(nameInput).toHaveValue(CREATE_NAME);
  await nameInput.fill(EDIT_NAME);
  await page.getByRole('button', { name: 'Save' }).click();

  await page.waitForURL(`**/tables/${TABLE}/${createdId}`);
  await expect(page.getByText(EDIT_NAME)).toBeVisible();

  // --- Delete ---------------------------------------------------------
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.waitForURL(`**/tables/${TABLE}`);

  // The row is gone and the listing is back to the three seeded authors,
  // proving create + delete round-tripped through @kozou/api cleanly.
  await expect(page.getByText(EDIT_NAME)).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'Margaret Atwood' })).toBeVisible();
  await expect(page.getByText(/3 total/)).toBeVisible();
});
