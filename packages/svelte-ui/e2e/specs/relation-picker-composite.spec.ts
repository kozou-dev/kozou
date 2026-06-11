// Composite foreign-key relation picker, end-to-end against the REST backend
// (the default Playwright suite). One picker drives BOTH key columns of
// bin_assignments (aisle, shelf) -> warehouse_bins: the create form picks a
// bin (filling both components at once), the detail page resolves the
// composite key to the bin's display label, and the edit form rehydrates the
// current bin before switching to another. The loop creates then deletes its
// row, leaving the seeded bins untouched.

import { expect, test } from '@playwright/test';

const TABLE = 'public.bin_assignments';
const PICKER = 'Aisle, Shelf';
const CREATE_NOTE = 'E2E Composite Note';
const FIRST_BIN = 'Bin A1-S2'; // (aisle 1, shelf 2)
const SECOND_BIN = 'Bin A2-S1'; // (aisle 2, shelf 1)

const DETAIL_URL = /\/tables\/public\.bin_assignments\/[0-9a-f-]{36}$/;

test('Admin UI creates and edits a row through the composite FK relation picker', async ({
  page,
}) => {
  await page.goto(`/tables/${TABLE}`);

  // --- Create: one picker fills both key columns ---------------------------
  await page.getByRole('link', { name: '+ New' }).click();
  await page.waitForURL(`**/tables/${TABLE}/new`);
  // The component columns are replaced by the single composite picker.
  await expect(page.getByRole('combobox', { name: PICKER })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Aisle' })).toHaveCount(0);
  await expect(page.getByRole('spinbutton', { name: 'Shelf' })).toHaveCount(0);
  await page
    .getByRole('combobox', { name: PICKER })
    .selectOption({ label: FIRST_BIN });
  await page.getByRole('textbox', { name: 'Note' }).fill(CREATE_NOTE);
  await page.getByRole('button', { name: 'Save' }).click();

  // --- Detail: the composite key resolves to the bin's label --------------
  await page.waitForURL(DETAIL_URL);
  await expect(page.getByText(CREATE_NOTE)).toBeVisible();
  const binLink = page.getByRole('link', { name: FIRST_BIN });
  await expect(binLink).toBeVisible();
  await expect(binLink).toHaveAttribute(
    'href',
    '/tables/public.warehouse_bins/1,2',
  );
  const createdId = page.url().split('/').pop() ?? '';

  // --- Edit: the picker rehydrates the current bin, then switches it ------
  await page.getByRole('link', { name: 'Edit' }).click();
  await page.waitForURL(`**/tables/${TABLE}/${createdId}/edit`);
  // The select's value is the canonical encoded composite id.
  await expect(page.getByRole('combobox', { name: PICKER })).toHaveValue('1,2');
  await page
    .getByRole('combobox', { name: PICKER })
    .selectOption({ label: SECOND_BIN });
  await page.getByRole('button', { name: 'Save' }).click();

  await page.waitForURL(`**/tables/${TABLE}/${createdId}`);
  await expect(page.getByRole('link', { name: SECOND_BIN })).toBeVisible();
  await expect(page.getByRole('link', { name: SECOND_BIN })).toHaveAttribute(
    'href',
    '/tables/public.warehouse_bins/2,1',
  );

  // --- Delete: restore the fixture -----------------------------------------
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.waitForURL(`**/tables/${TABLE}`);
  await expect(page.getByText(CREATE_NOTE)).toHaveCount(0);
});
