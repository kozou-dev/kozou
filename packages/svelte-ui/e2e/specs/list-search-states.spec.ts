// Search edge-state smoke on the table list route:
//   - a query with no matches renders the empty state ("No rows." + 0
//     total) instead of erroring;
//   - clearing the query and re-submitting restores the full list.
// Both flows are read-only and leave the fixture untouched.

import { expect, test } from '@playwright/test';

const TABLE = 'public.authors';

test('a no-match search renders the empty state', async ({ page }) => {
  await page.goto(`/tables/${TABLE}`);

  await page.getByPlaceholder('Search…').fill('zzz_no_such_author_zzz');
  await page.getByRole('button', { name: 'Search' }).click();

  await page.waitForURL(/[?&]q=zzz_no_such_author_zzz/);
  await expect(page.getByText('No rows.')).toBeVisible();
  await expect(page.getByText(/0 total/)).toBeVisible();
});

test('clearing the search restores the full list', async ({ page }) => {
  await page.goto(`/tables/${TABLE}`);

  // Narrow to a single row first.
  await page.getByPlaceholder('Search…').fill('Atwood');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.waitForURL(/[?&]q=Atwood/);
  await expect(page.getByText(/1 total/)).toBeVisible();

  // Clear the box and re-submit: all three authors come back.
  await page.getByPlaceholder('Search…').fill('');
  await page.getByRole('button', { name: 'Search' }).click();

  await expect(page.getByText(/3 total/)).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Margaret Atwood' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Ursula K. Le Guin' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Octavia Butler' })).toBeVisible();
});
