// Detail-page FK label resolution smoke: navigating to a books row
// resolves the `author_id` foreign key into the referenced authors
// row's display_name, surfaced as a clickable link with the raw FK
// value as a subtle annotation. Tracks Kozou v0.1 design spec
// §16.1.1 B (FK label resolution / Step 6-K).

import { expect, test } from '@playwright/test';

// The fixture seeds `The Handmaid's Tale` (Margaret Atwood) under a
// deterministic UUID so the detail URL stays stable across runs.
const HANDMAIDS_TALE_ID = '00000000-0000-0000-0000-000000000010';
const MARGARET_ATWOOD_ID = '00000000-0000-0000-0000-000000000001';

test('book detail page resolves author_id FK to the author display_name', async ({
  page,
}) => {
  await page.goto(`/tables/public.books/${HANDMAIDS_TALE_ID}`);

  // Subtitle below <h1> always carries qualifiedName + id.
  await expect(
    page.getByText(`public.books / ${HANDMAIDS_TALE_ID}`),
  ).toBeVisible();

  // The FK label appears as a clickable link to the authors detail
  // page, with the raw UUID rendered as a subtle annotation.
  const authorLink = page.getByRole('link', { name: 'Margaret Atwood' });
  await expect(authorLink).toBeVisible();
  await expect(authorLink).toHaveAttribute(
    'href',
    `/tables/public.authors/${MARGARET_ATWOOD_ID}`,
  );

  // The raw FK value is still visible in the annotation so an
  // operator can copy it when debugging.
  await expect(page.getByText(MARGARET_ATWOOD_ID)).toBeVisible();
});
