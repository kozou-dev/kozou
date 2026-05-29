// Full CRUD loop on a base table, driven through the Admin UI exactly
// as an operator would: list → + New → fill form → Save → detail →
// Edit → change → Save → detail → Delete → back to list.
//
// The loop is intentionally self-contained: it creates a row and then
// deletes it again, so the shared fixture DB (one backend per suite,
// see playwright.config.ts) is left in its original state. That keeps
// the row-count assertions in the other specs (e.g. tables-list's
// "3 total") stable regardless of file execution order.
//
// `authors` is the simplest table to exercise: a single required,
// user-editable column (display_name). Its `id` is a uuid PRIMARY KEY
// with a `gen_random_uuid()` default, so the form renders it read-only
// and the database fills it in on insert. Tracks Kozou v0.1 design spec
// §8.3.3 / §8.3.5 / §16.1.1 B (Playwright E2E CRUD loop).

import { expect, test } from '@playwright/test';

const TABLE = 'public.authors';
const CREATE_NAME = 'E2E Test Author';
const EDIT_NAME = 'E2E Test Author (edited)';

// A uuid detail URL: /tables/public.authors/<uuid>
const DETAIL_URL = new RegExp(
  `/tables/${TABLE.replace('.', '\\.')}/[0-9a-f-]{36}$`,
);

test('create → edit → delete an authors row through the Admin UI', async ({
  page,
}) => {
  // --- Create -------------------------------------------------------
  await page.goto(`/tables/${TABLE}`);
  await page.getByRole('link', { name: '+ New' }).click();
  await page.waitForURL(`**/tables/${TABLE}/new`);

  await page.getByRole('textbox', { name: 'Display Name' }).fill(CREATE_NAME);
  await page.getByRole('button', { name: 'Save' }).click();

  // On success the new route redirects (303) to the freshly-created
  // row's detail page, whose id segment is the DB-generated uuid.
  await page.waitForURL(DETAIL_URL);
  await expect(page.getByText(CREATE_NAME)).toBeVisible();

  // Capture the generated id from the detail URL so later steps can
  // assert against the exact row.
  const createdId = page.url().split('/').pop() ?? '';
  expect(createdId).toMatch(/^[0-9a-f-]{36}$/);

  // --- Edit ---------------------------------------------------------
  await page.getByRole('link', { name: 'Edit' }).click();
  await page.waitForURL(`**/tables/${TABLE}/${createdId}/edit`);

  const nameInput = page.getByRole('textbox', { name: 'Display Name' });
  await expect(nameInput).toHaveValue(CREATE_NAME);
  await nameInput.fill(EDIT_NAME);
  await page.getByRole('button', { name: 'Save' }).click();

  // Update redirects back to the same detail page with the new value.
  await page.waitForURL(`**/tables/${TABLE}/${createdId}`);
  await expect(page.getByText(EDIT_NAME)).toBeVisible();

  // --- Delete -------------------------------------------------------
  await page.getByRole('button', { name: 'Delete' }).click();

  // Delete redirects back to the table listing.
  await page.waitForURL(`**/tables/${TABLE}`);

  // The edited row is gone and the listing is back to the three seeded
  // authors, proving the loop left the fixture untouched.
  await expect(page.getByText(EDIT_NAME)).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'Margaret Atwood' })).toBeVisible();
  await expect(page.getByText(/3 total/)).toBeVisible();
});
