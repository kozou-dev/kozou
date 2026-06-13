// Pagination smoke on the table list route. The fixture seeds three
// authors, so a `?pageSize=2` URL splits them across two pages. The spec
// walks forward with "Next →" and back with "← Prev", asserting the page
// indicator and the rendered row count at each step. Read-only, so it
// leaves the fixture untouched. Tracks Playwright E2E list pagination.

import { expect, test } from '@playwright/test';

const TABLE = 'public.authors';

function dataRows(page: import('@playwright/test').Page) {
  return page.locator('tbody tr');
}

test('paginates the authors list with Next / Prev', async ({ page }) => {
  await page.goto(`/tables/${TABLE}?pageSize=2`);

  // Page 1 of 2: two rows, a Next link, no Prev link.
  await expect(page.getByText(/Page 1 of 2/)).toBeVisible();
  await expect(page.getByText(/3 total/)).toBeVisible();
  await expect(dataRows(page)).toHaveCount(2);
  await expect(page.getByRole('link', { name: /Prev/ })).toHaveCount(0);

  // Forward to page 2: the remaining single row.
  await page.getByRole('link', { name: /Next/ }).click();
  await page.waitForURL(/[?&]page=2/);
  await expect(page.getByText(/Page 2 of 2/)).toBeVisible();
  await expect(dataRows(page)).toHaveCount(1);
  await expect(page.getByRole('link', { name: /Next/ })).toHaveCount(0);

  // Back to page 1 via Prev.
  await page.getByRole('link', { name: /Prev/ }).click();
  await page.waitForURL(/\/tables\/public\.authors(\?(?!.*page=2).*)?$/);
  await expect(page.getByText(/Page 1 of 2/)).toBeVisible();
  await expect(dataRows(page)).toHaveCount(2);
});
