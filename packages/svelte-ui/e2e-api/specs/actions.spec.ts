// The Admin UI "Actions" surface (issue #103) end-to-end
// against the in-house @kozou/api server: the dashboard lists the exposed
// function, its argument form runs it through POST /rpc/<schema>.<fn>, and the
// result is shown. The fixture exposes `double_it(n integer)` (invoker, PUBLIC
// EXECUTE revoked). Verified both with JavaScript (the superForm-enhanced path)
// and without (the native form POST), since the Actions form must work no-JS.

import { expect, test } from '@playwright/test';

const FN = 'public.double_it';

async function runDoubleIt(page: import('@playwright/test').Page, n: string, expected: string) {
  // The dashboard surfaces the function under "Actions" (only when the backend
  // serves /rpc/, which @kozou/api does).
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Actions' })).toBeVisible();
  await page.locator(`a[href="/actions/${FN}"]`).click();
  await page.waitForURL(`**/actions/${FN}`);

  // The COMMENT @ai advisory rides along for the operator (its own box; the
  // phrase also appears inline in the description, so target the box heading).
  await expect(page.getByText('AI notes', { exact: true })).toBeVisible();

  await page.getByRole('spinbutton', { name: 'N' }).fill(n);
  await page.getByRole('button', { name: 'Run action' }).click();

  // The result is rendered after the call returns.
  await expect(page.getByText('Result')).toBeVisible();
  await expect(page.getByText(expected, { exact: true })).toBeVisible();
}

test('runs an exposed function from the Actions form and shows the result', async ({ page }) => {
  await runDoubleIt(page, '21', '42');
});

test.describe('without JavaScript (native form POST)', () => {
  test.use({ javaScriptEnabled: false });

  test('runs the action through a native submission', async ({ page }) => {
    await runDoubleIt(page, '13', '26');
  });

  test('omits a DEFAULTed argument so the database default applies', async ({ page }) => {
    // bump_total(base, bonus DEFAULT 100): leaving the defaulted numeric `bonus`
    // empty must drop it (the DB applies 100), not send 0 / '' / 500. This is
    // the no-JS defaulted-union path that needs FormData -> object conversion.
    await page.goto('/actions/public.bump_total');
    await page.getByRole('spinbutton', { name: 'Base' }).fill('5');
    // Leave Bonus empty.
    await page.getByRole('button', { name: 'Run action' }).click();
    await expect(page.getByText('Result')).toBeVisible();
    await expect(page.getByText('105', { exact: true })).toBeVisible();
  });
});
