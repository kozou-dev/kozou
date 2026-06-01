// `kozou dev --adapter api` with JWT auth enabled: the bundled Admin UI is
// served RLS-filtered rows. This exercises the assembled authenticated path
// end to end — the CLI mints an HS256 token for the UI, injects it, the UI
// attaches it, @kozou/api verifies it and runs each request under
// `SET LOCAL ROLE app_admin`, and the database's RLS policy hides the rows
// app_admin may not see.
//
// The fixture seeds three authors with owner='admin' (visible) plus one
// 'Hidden Author' with owner='other'. The policy exposes only owner='admin',
// so the UI must show the three and never the hidden one.

import { expect, test } from '@playwright/test';

const TABLE = 'public.authors';

test('the Admin UI shows only RLS-permitted rows under kozou dev --adapter api auth', async ({
  page,
}) => {
  await page.goto(`/tables/${TABLE}`);

  // The three owner='admin' rows are served (token minted, verified, role set).
  await expect(page.getByRole('cell', { name: 'Margaret Atwood' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Ursula K. Le Guin' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Octavia Butler' })).toBeVisible();

  // The owner='other' row is filtered out by RLS — never visible to the UI.
  await expect(page.getByRole('cell', { name: 'Hidden Author' })).toHaveCount(0);

  // The count reflects the RLS-filtered set, not the full table (4 rows).
  await expect(page.getByText(/3 total/)).toBeVisible();
});
