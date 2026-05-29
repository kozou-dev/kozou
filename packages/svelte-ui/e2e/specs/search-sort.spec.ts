// Search + sort smoke on the table list route, driven through the
// Admin UI as an operator would. Both flows are read-only, so this spec
// never mutates the fixture and is safe to run in any order alongside
// the row-count assertions in the other specs.
//
// The fixture seeds three authors:
//   Margaret Atwood / Ursula K. Le Guin / Octavia Butler (insertion order)
// `display_name` is the first display column, so the list's first cell
// of each row carries the author name. Tracks Kozou v0.1 design spec
// §8.3.2 / §16.1.1 B (Playwright E2E list search + sort).

import { expect, test } from '@playwright/test';

const TABLE = 'public.authors';

// First-column text (display_name) of every rendered data row, in order.
async function nameColumn(page: import('@playwright/test').Page) {
  return page.locator('tbody tr td:first-child').allTextContents();
}

test('search filters the authors list to matching rows', async ({ page }) => {
  await page.goto(`/tables/${TABLE}`);
  await expect(page.getByText(/3 total/)).toBeVisible();

  await page.getByPlaceholder('Search…').fill('Atwood');
  await page.getByRole('button', { name: 'Search' }).click();

  await page.waitForURL(/[?&]q=Atwood/);
  await expect(page.getByRole('cell', { name: 'Margaret Atwood' })).toBeVisible();
  await expect(page.getByText('Ursula K. Le Guin')).toHaveCount(0);
  await expect(page.getByText('Octavia Butler')).toHaveCount(0);
  await expect(page.getByText(/1 total/)).toBeVisible();
});

test('sorting by display_name toggles ascending and descending order', async ({
  page,
}) => {
  await page.goto(`/tables/${TABLE}`);

  // First click sorts ascending: Margaret / Octavia / Ursula.
  await page.getByRole('link', { name: /Display Name/ }).click();
  await page.waitForURL(/sort=display_name%3Aasc/);
  await expect(async () => {
    expect(await nameColumn(page)).toEqual([
      'Margaret Atwood',
      'Octavia Butler',
      'Ursula K. Le Guin',
    ]);
  }).toPass();

  // Clicking the same header again flips to descending.
  await page.getByRole('link', { name: /Display Name/ }).click();
  await page.waitForURL(/sort=display_name%3Adesc/);
  await expect(async () => {
    expect(await nameColumn(page)).toEqual([
      'Ursula K. Le Guin',
      'Octavia Butler',
      'Margaret Atwood',
    ]);
  }).toPass();
});
