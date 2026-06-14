# @kozou/example-react

A **minimal React (Next.js App Router) read-only Admin UI** that renders a
table **list** and a row **detail** page by consuming **`@kozou/ui-core`
unchanged**.

This is the **Phase 1 read spike** of the React UI exploration. Its only
purpose is to *falsify* the claim that Kozou's read-path UI logic is
framework-agnostic: the same `DataAdapter`, list-param parsing, list-href +
cell formatting, FK-label resolution, and resource-id handling that drive the
reference Svelte Admin UI are imported here verbatim from `@kozou/ui-core`,
and the only React-specific code is routing + presentation. It is **not
published** and is **not** a production second UI.

(The table list's display/search column heuristics are route-local helpers,
exactly as in the Svelte reference's `+page.server.ts` — they are presentation
choices, not core logic. `@kozou/ui-core`'s `view/columns` helpers serve the
dedicated VIEW route, which this minimal spike does not build.)

## Architecture (mirrors the Svelte reference, framework swapped)

- **Node introspection (same pipeline as the Svelte UI):** a server module
  introspects `DATABASE_URL` via `@kozou/introspect`, builds a `SchemaContext`
  with `@kozou/core`, and caches it with `@kozou/ui-core`'s `SchemaCache`.
- **Data access:** `@kozou/ui-core`'s `KozouApiDataAdapter`, pointed at a
  running `@kozou/api` server (`KOZOU_ADAPTER_URL`).
- **Read path, unchanged from core:** `parseListParamsFromUrl`, `buildHref` /
  `buildSortHref` / `formatCell`, `formatCellValue`, `resolveFkLabels` (+
  `FkRowCache`), `rowIdSegment` / `parseResourceId` / `encodeResourceId`.
- **React-only code:** Next.js routes (`/tables/[table]`,
  `/tables/[table]/[id]`) and the table/detail components.

Read-only by design: no create / edit / delete (that is Phase 2). Server
components only — no client-side JavaScript is required for the read path.

## Run it

You need a running Postgres and a running `@kozou/api` server pointed at it
(for example via `kozou dev`, or the in-house API server directly).

```sh
export DATABASE_URL=postgres://...          # introspected for the schema
export KOZOU_ADAPTER_URL=http://localhost:3335   # the @kozou/api server
# export KOZOU_ADAPTER_TOKEN=...            # if the API has JWT auth enabled

pnpm --filter @kozou/example-react dev      # http://localhost:3000
```

There is intentionally no `build` script wired into the workspace
`pnpm -r run build`: this example is not published and should not inflate the
package build/release pipeline. Use `pnpm --filter @kozou/example-react next:build`
to produce a production build locally; `pnpm -r typecheck` does typecheck it.

## License

Apache-2.0.
