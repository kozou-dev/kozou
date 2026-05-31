# @kozou/api

> **Experimental (Kozou v0.2).** Not published to npm yet. API and wire
> format may change without notice while the package is stabilising.

Kozou's own REST layer. Given a `SchemaContext` (from `@kozou/introspect`
+ `@kozou/core`) and a PostgreSQL connection, it serves the tables and
views of your database as a REST API, driven entirely by your DDL and
`COMMENT` metadata — no hand-written route code.

This is the in-house data layer that Kozou v1.0 will make the default
(see the Kozou v0.2 design spec, §1–§4). The Admin UI talks to it through
the same `DataAdapter` seam (`@kozou/core`) it already uses, so swapping
the data layer is not a breaking change for UI code.

## Status (v0.2 Phase 1–3 — read + write + OpenAPI)

Implemented:

- `GET /` — service info + the list of available resources.
- `GET /<resource>` — list rows of a table or view, with:
  - `page` (1-based) / `pageSize` pagination,
  - `sort=field.asc,other.desc` ordering,
  - `search=<text>` free-text `ILIKE` across text columns,
  - `<column>=<value>` equality filters.
  Returns `{ rows, total, page, pageSize }`.
- `GET /<resource>?as=options&label=<col>&fields=<a,b>&q=<text>&limit=<n>`
  — lightweight relation-select lookup. Returns `{ options: [{ id, label }] }`.
- `GET /<resource>/<id>` — fetch a single table row by its single-column
  primary key. Returns the row, or `404`.
- `POST /<resource>` — create a row from a JSON body; returns `201` + the
  created row. An empty body inserts a row of column defaults.
- `PATCH /<resource>/<id>` — update the supplied columns; returns the row,
  or `404`.
- `DELETE /<resource>/<id>` — delete by primary key; returns the deleted
  row, or `404`.
- `GET /openapi.json` — an OpenAPI 3.1 document for the whole API.
  Descriptions, `enum`s, and AI notes are sourced from the database
  `COMMENT`s: table/view/column descriptions become schema `description`s,
  `@ai:` notes become `x-kozou-ai`, CHECK / ENUM members become `enum`,
  and the resolved widget becomes `x-kozou-widget`.

Writes are rejected on views (`405`) and on unknown columns (`400`).

Deferred to later phases (Kozou v0.2 design spec §4):

- Phase 4: a `KozouApiDataAdapter` so the Admin UI can run against this
  server, plus CLI integration.

## Security boundary (v0.2)

Like the MCP HTTP server (Kozou v0.1 spec §18.5), the v0.2 API ships with
**no authentication** and binds to `127.0.0.1` by default. It prints a
loud warning when bound to a non-loopback host. Run it only inside a
trusted boundary (local dev, a docker-compose network) until JWT + RLS
land in v1.0.

## Safety

- Table / view / column identifiers are validated against the introspected
  `SchemaContext` (an allowlist) before any query is built, and are quoted
  defensively.
- All user-supplied values are passed as parameterized query arguments;
  values are never interpolated into SQL text.

## License

Apache 2.0
