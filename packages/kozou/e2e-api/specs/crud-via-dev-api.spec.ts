// The Kozou v0.2 CLI integration headline: a single `kozou dev
// --adapter api` brings up the Admin UI *and* the in-house @kozou/api
// data backend together (global-setup launches exactly that command),
// and the UI drives a full browser CRUD loop through @kozou/api — no
// separate data-backend container in the stack.
//
// The loop creates and then deletes its row, leaving the fixture in its
// seeded state (three authors incl. Margaret Atwood).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const TABLE = 'public.authors';
const CREATE_NAME = 'E2E Dev-API Author';
const EDIT_NAME = 'E2E Dev-API Author (edited)';

const DETAIL_URL = new RegExp(`/tables/${TABLE.replace('.', '\\.')}/[0-9a-f-]{36}$`);

test('kozou dev --adapter api serves a full CRUD loop through the Admin UI', async ({
  page,
}) => {
  // Read: the list renders the seeded rows, served by the in-house API.
  await page.goto(`/tables/${TABLE}`);
  await expect(page.getByRole('cell', { name: 'Margaret Atwood' })).toBeVisible();
  await expect(page.getByText(/3 total/)).toBeVisible();

  // Create.
  await page.getByRole('link', { name: '+ New' }).click();
  await page.waitForURL(`**/tables/${TABLE}/new`);
  await page.getByRole('textbox', { name: 'Display Name' }).fill(CREATE_NAME);
  await page.getByRole('button', { name: 'Save' }).click();

  await page.waitForURL(DETAIL_URL);
  await expect(page.getByText(CREATE_NAME)).toBeVisible();
  const createdId = page.url().split('/').pop() ?? '';
  expect(createdId).toMatch(/^[0-9a-f-]{36}$/);

  // Update.
  await page.getByRole('link', { name: 'Edit' }).click();
  await page.waitForURL(`**/tables/${TABLE}/${createdId}/edit`);
  const nameInput = page.getByRole('textbox', { name: 'Display Name' });
  await expect(nameInput).toHaveValue(CREATE_NAME);
  await nameInput.fill(EDIT_NAME);
  await page.getByRole('button', { name: 'Save' }).click();

  await page.waitForURL(`**/tables/${TABLE}/${createdId}`);
  await expect(page.getByText(EDIT_NAME)).toBeVisible();

  // Delete.
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.waitForURL(`**/tables/${TABLE}`);
  await expect(page.getByText(EDIT_NAME)).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'Margaret Atwood' })).toBeVisible();
  await expect(page.getByText(/3 total/)).toBeVisible();
});

// Issue #70: the in-house API advertises the kozou CLI version (not the
// 0.0.0 package default) in its OpenAPI `info.version`. It binds loopback
// on the port global-setup passes to `--api-port`.
const API_PORT = 3437; // keep in sync with e2e-api/setup/global-setup.ts
const KOZOU_VERSION = (
  JSON.parse(
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8'),
  ) as { version: string }
).version;

test('the in-house @kozou/api advertises the kozou version in its OpenAPI', async ({
  request,
}) => {
  const res = await request.get(`http://127.0.0.1:${API_PORT}/openapi.json`);
  expect(res.ok()).toBeTruthy();
  const doc = (await res.json()) as { info?: { version?: string } };
  expect(doc.info?.version).toBe(KOZOU_VERSION);
  expect(doc.info?.version).not.toBe('0.0.0');
});
