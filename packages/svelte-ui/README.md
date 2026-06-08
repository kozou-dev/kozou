# @kozou/svelte-ui

SvelteKit + Svelte 5 Admin UI for [Kozou](https://kozou.org). Reads
a `SchemaContext` from [`@kozou/core`](../core) and talks to a
backend through the `DataAdapter` interface defined there. Used
standalone, its default adapter speaks PostgREST; under `kozou dev`
the default is Kozou's bundled in-house REST backend (`@kozou/api`).

> **Status:** published to npm as `@kozou/svelte-ui`. The package
> ships only the adapter-node `build/` artifact; host integration
> via `kozou dev` shipped in v0.1.1.

## Stack

| Layer | Pick |
|-------|------|
| Framework | SvelteKit 2.6+ / Svelte 5.55+ |
| Adapter | `@sveltejs/adapter-node` |
| Styling | Tailwind v4 + shadcn-svelte design tokens |
| Forms | `sveltekit-superforms` + `formsnap` + `zod` (4.4) |
| Tables | `@tanstack/table-core` (Svelte 5 wrapper internalised) |
| HTTP | `fetch` via the `DataAdapter` interface from `@kozou/core` |

## Routes

| Path | Purpose |
|------|---------|
| `/` | Dashboard — list every table + view in the introspected schema |
| `/tables/[table]` | Table listing with URL-driven search / sort / pagination |
| `/tables/[table]/new` | Create record — zod-validated form, superforms-backed |
| `/tables/[table]/[id]` | Detail view + `?/delete` form action |
| `/tables/[table]/[id]/edit` | Edit record |
| `/views/[view]` | Read-only view listing |

Query parameters on the list / view routes:

- `?q=<text>` — case-insensitive search across the resolved
  text-like columns.
- `?sort=col:asc,col2:desc` — one or more sort segments.
- `?page=<n>` — 1-based; defaults to 1.
- `?pageSize=<m>` — defaults to 50.

## Local development

Required environment variables (Node 20+, pnpm 9+):

- `DATABASE_URL` — PostgreSQL connection string. Used by
  `hooks.server.ts` to introspect the schema on first request.
- `KOZOU_ADAPTER_URL` — base URL of the backend the `DataAdapter`
  talks to (default `http://localhost:3000`).

```bash
# from the monorepo root
pnpm install

# build the SvelteKit production bundle (Node + client artifacts)
pnpm --filter @kozou/svelte-ui run build

# unit + integration tests
pnpm --filter @kozou/svelte-ui run test

# start the dev server
DATABASE_URL=postgres://kozou:kozou@localhost:5432/kozou \
  KOZOU_ADAPTER_URL=http://localhost:3000 \
  pnpm --filter @kozou/svelte-ui run dev
```

Building before running `pnpm test` exercises the smoke case in
`test/smoke/build.test.ts`; the case is skipped (not failed) when
the build artifacts are absent so a fresh checkout still gets a
green `pnpm test` run.

## Manual smoke checklist (Step 6 Definition of Done)

Run end-to-end against a real PostgreSQL + PostgREST stack
(`docker compose up -d` from a `create-kozou` scaffold works):

1. `pnpm --filter @kozou/svelte-ui run dev` — open
   `http://localhost:5173/`.
2. Dashboard lists every table + view with description excerpts.
3. Click into a table. The listing renders with search, sortable
   column anchors, and Prev / Next pagination.
4. Use the search box (`?q=…`) — the URL updates and rows narrow.
5. Click a sortable column twice — sort toggles `asc` → `desc`,
   `?sort=` updates in the URL.
6. Click **+ New** — fill the form, submit. The browser lands on
   the detail page of the new row.
7. From the detail page, click **Edit**, change a field, save.
   The detail page reflects the change.
8. Click **Delete** — the row vanishes and the URL returns to
   `/tables/[table]`.
9. Visit `/views/[view]` — listing renders with no
   New / Edit / Delete controls (read-only).

## Adapter boundary

Route code (`src/routes/**`) never imports `PostgrestDataAdapter`
directly. The eslint config in the repository root
(`.eslintrc.cjs`) enforces this: routes that try to hardcode a
PostgREST URL, dereference a `PGRST_*` env var, or reference
PostgREST by name fail lint. Routes go through `getAdapter()` in
`src/lib/server/adapter.ts`, which constructs the configured
adapter from `KOZOU_ADAPTER_URL` (default `http://localhost:3000`).

## License

Apache 2.0. See [LICENSE](../../LICENSE) at the repository root.
