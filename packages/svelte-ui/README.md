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

## Relation pickers

The create / edit forms render a searchable picker for foreign-key columns:

- a **single-column FK** gets a picker when it references the target's
  single-column primary key and the target's label column is
  text-searchable; otherwise the column stays a plain scalar input the
  operator types.
- a **composite (multi-column) FK** becomes ONE picker that fills every key
  column at once, when it references the target's primary key (any column
  order), the target's label is text-searchable, and none of its columns is
  shared with another foreign key. Ineligible relations keep scalar inputs.
- the forms also work without JavaScript: the picker submits natively and an
  untouched save keeps the current values.

Known limitation: a key containing an **empty-string component** cannot be
picked or round-tripped through the form — `''` is the picker contract's
unselected sentinel (shared with the single-column picker). Such rows remain
manageable through the API.

Picker eligibility and the all-or-nothing composite write are **UI-level
conveniences, not an enforcement boundary**: the form actions validate
per-column shapes and forward the payload through the configured adapter
(including service-token mode under `kozou dev`), and the same composite
component columns are individually editable wherever the relation is not
picker-eligible. Row-level invariants belong to PostgreSQL constraints and
RLS — the project's enforcement posture.

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

Optional, both concerning the "Connect an AI agent" page:

- `KOZOU_MCP_HTTP_PORT` — port the co-located MCP Streamable HTTP
  server listens on, used to build the copy-paste client config
  (default `3334`). `kozou dev` sets this from its own config.
- `KOZOU_UI_MCP_POSTURE` — how the MCP endpoint runs, which decides
  whether the connection page exists and what it says about
  authentication. `kozou dev` sets it from its own config on every run:
  - `off` — no listener (`server.mcp.http.enabled: false`). The page
    404s and both links to it (the header link and the dashboard card)
    are gone, so nothing advertises an endpoint that is not listening.
    Set this yourself when you run this server standalone next to no
    MCP endpoint.
  - `local` — serving with no authentication (the loopback default).
  - `oauth` — serving as an OAuth 2.1 protected resource
    (`server.mcp.http.auth`). The config snippets keep the same shape —
    one URL, no client secret, since a client discovers the
    authorization server from the endpoint itself — but the URL comes
    from `KOZOU_UI_MCP_RESOURCE` rather than the request host.

  Absent reads as `local`, which is the posture a standalone UI is in.
  A value this build does not recognize (a typo, or a newer CLI) still
  offers the page, with the request-derived URL, but says nothing about
  authentication rather than guessing.

- `KOZOU_UI_MCP_RESOURCE` — the canonical resource URI
  (`server.mcp.http.auth.resource`) to hand out in the `oauth` posture,
  used verbatim including its path. `kozou dev` sets it whenever that
  block exists. Without it the page builds the endpoint from the
  browser's request host and the MCP port, which is wrong behind the
  proxy or tunnel that makes `resource` necessary in the first place.
  Ignored in the other postures, where nothing declared a canonical URI.

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

## Manual smoke checklist

Run the standalone dev server end-to-end against a real PostgreSQL and a
REST backend at `KOZOU_ADAPTER_URL` (default `http://localhost:3000`).
Standalone, this package's default adapter speaks PostgREST, so bring up
a PostgreSQL and a PostgREST pointed at it:

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
