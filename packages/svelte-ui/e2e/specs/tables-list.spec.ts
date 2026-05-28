// Tables list smoke: navigating to /tables/public.authors renders the
// list page with all three seeded authors. The `<h1>` text is derived
// from the table's COMMENT first line (see @kozou/core
// buildSchemaContext), so the heading is asserted via the qualified
// name that the template prints just below it - that path stays stable
// across UI Hints / COMMENT edits.

import { expect, test } from '@playwright/test';

test('authors list renders the seeded display_name rows', async ({ page }) => {
  await page.goto('/tables/public.authors');

  // The subtitle below <h1> always renders the qualified name.
  await expect(page.getByText('public.authors')).toBeVisible();

  await expect(
    page.getByRole('cell', { name: 'Margaret Atwood' }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'Ursula K. Le Guin' }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'Octavia Butler' }),
  ).toBeVisible();

  // Pagination footer reports the row total straight from the adapter.
  await expect(page.getByText(/3 total/)).toBeVisible();
});
