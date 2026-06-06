// Composite-primary-key CRUD loop (Kozou v1.0 dev spec §3.6 / §3.7). The
// Admin UI addresses a row by a two-column key (order_lines: order_id,
// line_no) the whole way through: the list row link, the detail / edit
// routes, and the create redirect all carry the comma-joined `id` segment,
// and the adapter expands it into per-column filters. Mirrors the
// single-key crud-loop.spec.ts; the loop creates then deletes its row so
// the seeded three lines are restored.

import { expect, test } from '@playwright/test';

const TABLE = 'public.order_lines';
const CREATE_PRODUCT = 'E2E Line';
const EDIT_PRODUCT = 'E2E Line (edited)';

// order_id=300, line_no=1 -> the `300,1` composite id segment.
const DETAIL_URL = /\/tables\/public\.order_lines\/300,1$/;
const EDIT_URL = /\/tables\/public\.order_lines\/300,1\/edit$/;

test('Admin UI runs a full CRUD loop against a composite primary key', async ({
  page,
}) => {
  // --- Read: the seeded composite-key rows render ---------------------
  await page.goto(`/tables/${TABLE}`);
  await expect(page.getByRole('cell', { name: 'Widget' })).toBeVisible();
  await expect(page.getByText(/3 total/)).toBeVisible();

  // --- Create --------------------------------------------------------
  await page.getByRole('link', { name: '+ New' }).click();
  await page.waitForURL(`**/tables/${TABLE}/new`);
  await page.getByRole('spinbutton', { name: 'Order Id' }).fill('300');
  await page.getByRole('spinbutton', { name: 'Line No' }).fill('1');
  await page.getByRole('textbox', { name: 'Product' }).fill(CREATE_PRODUCT);
  await page.getByRole('spinbutton', { name: 'Qty' }).fill('7');
  await page.getByRole('button', { name: 'Save' }).click();

  // The create redirect targets the composite id segment `300,1`.
  await page.waitForURL(DETAIL_URL);
  await expect(page.getByText(CREATE_PRODUCT)).toBeVisible();

  // --- Update: edit by the same composite id -------------------------
  await page.getByRole('link', { name: 'Edit' }).click();
  await page.waitForURL(EDIT_URL);
  const productInput = page.getByRole('textbox', { name: 'Product' });
  await expect(productInput).toHaveValue(CREATE_PRODUCT);
  await productInput.fill(EDIT_PRODUCT);
  await page.getByRole('button', { name: 'Save' }).click();

  await page.waitForURL(DETAIL_URL);
  await expect(page.getByText(EDIT_PRODUCT)).toBeVisible();

  // --- Delete --------------------------------------------------------
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.waitForURL(`**/tables/${TABLE}`);

  // The created line is gone; the three seeded lines remain.
  await expect(page.getByText(EDIT_PRODUCT)).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'Widget' })).toBeVisible();
  await expect(page.getByText(/3 total/)).toBeVisible();
});
