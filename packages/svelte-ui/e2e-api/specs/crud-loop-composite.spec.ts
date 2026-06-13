// Composite-primary-key CRUD loop against the in-house @kozou/api server
// (KOZOU_ADAPTER_KIND=api, wired in global-setup). The same Admin UI build
// drives a two-column key (order_lines: order_id, line_no) end-to-end: the
// item path is the comma-joined `300,1` segment, which the API splits back
// into per-column key filters. Mirrors the
// single-key crud-loop.spec.ts; only the backend differs from the sibling
// e2e/ suite. The loop creates then deletes its row, leaving the three
// seeded lines.

import { expect, test } from '@playwright/test';

const TABLE = 'public.order_lines';
const CREATE_PRODUCT = 'E2E API Line';
const EDIT_PRODUCT = 'E2E API Line (edited)';

const DETAIL_URL = /\/tables\/public\.order_lines\/300,1$/;
const EDIT_URL = /\/tables\/public\.order_lines\/300,1\/edit$/;

test('Admin UI runs a composite-key CRUD loop against @kozou/api', async ({
  page,
}) => {
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

  await page.waitForURL(DETAIL_URL);
  await expect(page.getByText(CREATE_PRODUCT)).toBeVisible();

  // --- Update --------------------------------------------------------
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

  await expect(page.getByText(EDIT_PRODUCT)).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'Widget' })).toBeVisible();
  await expect(page.getByText(/3 total/)).toBeVisible();
});
