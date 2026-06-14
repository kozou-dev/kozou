# @kozou/ui-core

Framework-agnostic UI logic for Kozou reference Admin UIs.

Kozou compiles a PostgreSQL schema (DDL + `COMMENT`) into a
`SchemaContext` and talks to a backend through the `DataAdapter`
interface (both defined in [`@kozou/core`](https://www.npmjs.com/package/@kozou/core)).
This package holds the **read-path** logic that turns those two inputs
into the data a list/detail view renders, with **no Svelte, SvelteKit,
React, or any UI-framework runtime dependency**.

It exists so more than one UI can share the exact same behaviour instead
of re-implementing (and re-acquiring the bugs of) list parsing, FK label
resolution, composite-key handling, and so on. The reference
[`@kozou/svelte-ui`](https://www.npmjs.com/package/@kozou/svelte-ui)
consumes it; a renderer in another framework can consume the same logic.

## What's here

- **DataAdapter implementations** — two pure HTTP clients (the in-house
  `@kozou/api` adapter and the external-REST adapter). They do no DB
  introspection; they speak a wire format.
- **List params** — URL ⇄ `ListParams` (pagination, sort, filter, search).
- **List href helpers** — build sort/pagination links and format list cells.
- **View columns** — display/search column heuristics for a `ViewContext`.
- **Detail** — cell formatting and foreign-key label resolution
  (loader-injected, so it is pure and testable).
- **Resource id** — composite-key segment encode / decode / parse.
- **Caches** — TTL + dedup caches for the `SchemaContext` and FK target
  rows (clock- and loader-injected; no Node-only dependency).

## Stability

The surface here tracks the reference Admin UI it was extracted from.
It is published so reference UIs can depend on it; it is not yet a
documented public contract for third-party UIs.

## License

Apache-2.0.
