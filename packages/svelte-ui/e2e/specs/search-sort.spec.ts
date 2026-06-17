// Search + sort smoke on the table list route, driven through the
// Admin UI as an operator would. Both flows are read-only, so this spec
// never mutates the fixture and is safe to run in any order alongside
// the row-count assertions in the other specs.
//
// The fixture seeds three authors:
//   Margaret Atwood / Ursula K. Le Guin / Octavia Butler (insertion order)
// `display_name` is the first display column, so the list's first cell
// of each row carries the author name. Tracks Playwright E2E list search + sort.

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

// Accessibility (issue #179): the search field carries a real accessible name
// (not just a placeholder) and sortable headers expose their sort state via
// `aria-sort`, so a screen-reader user can find the field and hear which
// column is sorted in which direction.
test('the search input and sortable headers expose their state to assistive tech', async ({
  page,
}) => {
  await page.goto(`/tables/${TABLE}`);

  // The field is reachable by its accessible name, not the placeholder text.
  await expect(page.getByRole('textbox', { name: 'Search rows' })).toBeVisible();

  // No explicit sort yet (the list defaults to primary-key order), so every
  // sortable header announces `none`.
  await expect(page.getByRole('columnheader', { name: /Display Name/ })).toHaveAttribute(
    'aria-sort',
    'none',
  );

  // Sorting ascending then descending updates `aria-sort` on the active header.
  await page.getByRole('link', { name: /Display Name/ }).click();
  await page.waitForURL(/sort=display_name%3Aasc/);
  await expect(page.getByRole('columnheader', { name: /Display Name/ })).toHaveAttribute(
    'aria-sort',
    'ascending',
  );

  await page.getByRole('link', { name: /Display Name/ }).click();
  await page.waitForURL(/sort=display_name%3Adesc/);
  await expect(page.getByRole('columnheader', { name: /Display Name/ })).toHaveAttribute(
    'aria-sort',
    'descending',
  );
});

// The URL contract accepts a multi-column sort, but ARIA expects at most one
// active `aria-sort` per table. Only the primary (first) sort column announces
// a direction; the rest read `none`.
test('a multi-column sort URL marks only the primary column with aria-sort', async ({
  page,
}) => {
  await page.goto(`/tables/${TABLE}?sort=display_name:asc,id:desc`);

  await expect(page.getByRole('columnheader', { name: /Display Name/ })).toHaveAttribute(
    'aria-sort',
    'ascending',
  );
  // Exactly one header is actively sorted; any secondary sort reads `none`.
  await expect(page.locator('th[aria-sort="ascending"], th[aria-sort="descending"]')).toHaveCount(
    1,
  );
});

// A degenerate URL repeating one field must not let the visual arrow and
// `aria-sort` disagree: first occurrence wins for both (and matches the
// database, where the leading ORDER BY key dominates).
test('duplicate sort tokens keep the visual arrow and aria-sort in agreement', async ({
  page,
}) => {
  await page.goto(`/tables/${TABLE}?sort=display_name:asc,display_name:desc`);

  const header = page.getByRole('columnheader', { name: /Display Name/ });
  await expect(header).toHaveAttribute('aria-sort', 'ascending');
  // The aria-hidden ↑ indicator agrees with the announced ascending sort.
  await expect(header).toContainText('↑');
});
