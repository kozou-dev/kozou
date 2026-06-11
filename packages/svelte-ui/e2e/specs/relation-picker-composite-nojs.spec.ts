// Composite relation picker without JavaScript: the native (non-enhanced)
// form path. The picker's <select> submits the picked row's encoded id under
// a synthetic name and the server decodes it ahead of validation; hidden
// baseline inputs preserve the current components on an untouched save.
// This drives the real browser with JS disabled, so the whole chain —
// SSR-selected option, native POST, readFormWithCompositePicks, validation,
// payload — is exercised end to end.

import { expect, test } from '@playwright/test';

test.use({ javaScriptEnabled: false });

const SEEDED = '00000000-0000-0000-0000-000000000040';
const TABLE = 'public.bin_assignments';

test('a no-JS untouched edit save preserves the composite foreign key', async ({
  page,
}) => {
  await page.goto(`/tables/${TABLE}/${SEEDED}/edit`);
  // The current bin is the SSR-selected option.
  await expect(
    page.getByRole('combobox', { name: 'Aisle, Shelf' }),
  ).toHaveValue('1,1');

  await page.getByRole('button', { name: 'Save' }).click();

  await page.waitForURL(`**/tables/${TABLE}/${SEEDED}`);
  // The relation survived the untouched native round-trip.
  const binLink = page.getByRole('link', { name: 'Bin A1-S1' });
  await expect(binLink).toBeVisible();
  await expect(binLink).toHaveAttribute(
    'href',
    '/tables/public.warehouse_bins/1,1',
  );
});

test('a no-JS edit can pick a different bin through the native select', async ({
  page,
}) => {
  await page.goto(`/tables/${TABLE}/${SEEDED}/edit`);
  await page
    .getByRole('combobox', { name: 'Aisle, Shelf' })
    .selectOption({ label: 'Bin A2-S1' });
  await page.getByRole('button', { name: 'Save' }).click();

  await page.waitForURL(`**/tables/${TABLE}/${SEEDED}`);
  await expect(page.getByRole('link', { name: 'Bin A2-S1' })).toBeVisible();

  // Restore the fixture for the sibling spec.
  await page.goto(`/tables/${TABLE}/${SEEDED}/edit`);
  await page
    .getByRole('combobox', { name: 'Aisle, Shelf' })
    .selectOption({ label: 'Bin A1-S1' });
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForURL(`**/tables/${TABLE}/${SEEDED}`);
  await expect(page.getByRole('link', { name: 'Bin A1-S1' })).toBeVisible();
});
