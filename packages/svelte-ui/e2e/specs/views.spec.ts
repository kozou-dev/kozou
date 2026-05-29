// VIEW browsing smoke: /views/public.vw_inventory_for_sale only surfaces
// inventory items with status='for_sale' AND visibility='public'. The
// fixture seeds three items: two for_sale (The Handmaid's Tale /
// The Left Hand of Darkness) and one reserved (Kindred). The reserved
// row must be filtered out by the underlying VIEW definition.
//
// `book_title` is part of the first 5 display columns for the view
// (pickViewDisplayColumns); `author_name` is not, so assertions target
// titles rather than authors.

import { expect, test } from '@playwright/test';

test('vw_inventory_for_sale hides reserved items and shows for_sale ones', async ({
  page,
}) => {
  await page.goto('/views/public.vw_inventory_for_sale');

  await expect(
    page.getByRole('cell', { name: "The Handmaid's Tale" }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'The Left Hand of Darkness' }),
  ).toBeVisible();

  // The reserved inventory item is omitted by the WHERE clause inside
  // CREATE VIEW vw_inventory_for_sale.
  await expect(page.getByText('Kindred')).toHaveCount(0);

  // 2 visible rows total (one row per for_sale + public item).
  await expect(page.getByText(/2 total/)).toBeVisible();
});

test('vw_inventory_for_sale renders sortable display column headers', async ({
  page,
}) => {
  await page.goto('/views/public.vw_inventory_for_sale');

  // Column labels are humanized from the view's columns; `book_title`
  // is among the first display columns, so its header is rendered as a
  // sort link (views share the table list's sortable-header markup).
  const bookTitleHeader = page.getByRole('link', { name: /Book Title/ });
  await expect(bookTitleHeader).toBeVisible();
  await expect(bookTitleHeader).toHaveAttribute('href', /sort=book_title%3A/);
});
