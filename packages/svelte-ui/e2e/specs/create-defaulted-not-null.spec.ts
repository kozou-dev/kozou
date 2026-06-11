// A NOT NULL column with a database DEFAULT must be creatable EMPTY: the
// schema accepts the empty value and the payload drops it so the default
// applies, and the rendered form must match (no required marker, an empty
// option offered). Regression for the required-field predicate ignoring
// DB-supplied columns — inventory_items.visibility is
// `text NOT NULL DEFAULT 'public'`.

import { expect, test } from '@playwright/test';

const TABLE = 'public.inventory_items';
const EDITION_ID = '00000000-0000-0000-0000-000000000020';

const DETAIL_URL = /\/tables\/public\.inventory_items\/[0-9a-f-]{36}$/;

test('a defaulted NOT NULL column can be left empty and takes the DB default', async ({
  page,
}) => {
  await page.goto(`/tables/${TABLE}/new`);

  // The defaulted NOT NULL enum renders non-required, with the empty option.
  const visibility = page.getByRole('combobox', { name: 'Visibility' });
  await expect(visibility).not.toHaveAttribute('required', '');
  await expect(visibility).toHaveValue('');

  // Fill only what the database genuinely needs from the operator.
  await page.getByRole('textbox', { name: 'Edition Id' }).fill(EDITION_ID);
  await page
    .getByRole('combobox', { name: 'Status' })
    .selectOption({ label: 'for_sale' });
  await page.getByRole('button', { name: 'Save' }).click();

  // The DB default applied.
  await page.waitForURL(DETAIL_URL);
  await expect(page.getByText('public', { exact: true })).toBeVisible();

  // On EDIT the same column is required again: an update cannot express
  // "reset to DEFAULT", so the form must not offer a clear that would be
  // silently dropped.
  await page.getByRole('link', { name: 'Edit' }).click();
  await page.waitForURL(/\/edit$/);
  const editVisibility = page.getByRole('combobox', { name: 'Visibility' });
  await expect(editVisibility).toHaveAttribute('required', '');
  await expect(editVisibility).toHaveValue('public');
  await page.getByRole('link', { name: 'Cancel' }).click();
  await page.waitForURL(DETAIL_URL);

  // Restore the fixture.
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.waitForURL(`**/tables/${TABLE}`);
});
