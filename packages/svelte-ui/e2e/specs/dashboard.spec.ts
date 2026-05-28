// Dashboard smoke: the entry page loads, lists every table from the
// fixture schema, and lists the single VIEW. Targets are selected by
// `href` so cosmetic copy changes (e.g. label casing) do not break the
// suite.

import { expect, test } from '@playwright/test';

test('dashboard lists fixture tables and views by qualified name', async ({
  page,
}) => {
  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: 'Dashboard' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Tables' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Views' }),
  ).toBeVisible();

  // Four fixture tables.
  await expect(
    page.locator('a[href="/tables/public.authors"]'),
  ).toBeVisible();
  await expect(
    page.locator('a[href="/tables/public.books"]'),
  ).toBeVisible();
  await expect(
    page.locator('a[href="/tables/public.editions"]'),
  ).toBeVisible();
  await expect(
    page.locator('a[href="/tables/public.inventory_items"]'),
  ).toBeVisible();

  // Single fixture view.
  await expect(
    page.locator('a[href="/views/public.vw_inventory_for_sale"]'),
  ).toBeVisible();
});
