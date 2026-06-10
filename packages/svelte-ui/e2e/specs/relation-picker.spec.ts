// Foreign-key relation picker, end-to-end against the REST backend (the
// default Playwright suite). The same Admin UI build drives a single-column
// FK (books.author_id -> authors) through the create + edit forms: the
// relation-select picker loads its options from the `/relation-options`
// endpoint, the create form picks an author, and the edit form keeps the
// existing author so the NOT NULL key is not dropped. The loop creates then
// deletes its row, leaving the three seeded books.

import { expect, test } from '@playwright/test';

const TABLE = 'public.books';
const CREATE_TITLE = 'E2E Relation Book';
const EDIT_TITLE = 'E2E Relation Book (edited)';
const AUTHOR = 'Margaret Atwood';
const AUTHOR_ID = '00000000-0000-0000-0000-000000000001';

const DETAIL_URL = /\/tables\/public\.books\/[0-9a-f-]{36}$/;

test('Admin UI creates and edits a row through the FK relation picker', async ({
  page,
}) => {
  await page.goto(`/tables/${TABLE}`);
  await expect(
    page.getByRole('cell', { name: "The Handmaid's Tale" }),
  ).toBeVisible();

  // --- Create: pick the author through the relation-select picker ---------
  await page.getByRole('link', { name: '+ New' }).click();
  await page.waitForURL(`**/tables/${TABLE}/new`);
  await page.getByRole('textbox', { name: 'Title' }).fill(CREATE_TITLE);
  // The picker's options are server-rendered, so the seeded author is
  // selectable without typing into the search box.
  await page
    .getByRole('combobox', { name: 'Author Id' })
    .selectOption({ label: AUTHOR });
  await page.getByRole('button', { name: 'Save' }).click();

  await page.waitForURL(DETAIL_URL);
  await expect(page.getByText(CREATE_TITLE)).toBeVisible();
  // The FK resolves to the author the picker selected.
  await expect(page.getByRole('link', { name: AUTHOR })).toBeVisible();
  const createdId = page.url().split('/').pop() ?? '';

  // --- Edit: change only the title. The picker must rehydrate the existing
  // author so saving does not drop the NOT NULL foreign key (the redirect to
  // the detail page is the proof — an empty author_id would fail the update).
  await page.getByRole('link', { name: 'Edit' }).click();
  await page.waitForURL(`**/tables/${TABLE}/${createdId}/edit`);
  await expect(page.getByRole('combobox', { name: 'Author Id' })).toHaveValue(
    AUTHOR_ID,
  );
  await page.getByRole('textbox', { name: 'Title' }).fill(EDIT_TITLE);
  await page.getByRole('button', { name: 'Save' }).click();

  await page.waitForURL(`**/tables/${TABLE}/${createdId}`);
  await expect(page.getByText(EDIT_TITLE)).toBeVisible();
  await expect(page.getByRole('link', { name: AUTHOR })).toBeVisible();

  // --- Delete: restore the fixture to its three seeded books --------------
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.waitForURL(`**/tables/${TABLE}`);
  await expect(page.getByText(EDIT_TITLE)).toHaveCount(0);
  await expect(
    page.getByRole('cell', { name: "The Handmaid's Tale" }),
  ).toBeVisible();
});
