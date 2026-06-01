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

## Security boundary

By default the API ships with **no authentication** and binds to
`127.0.0.1` (like the MCP HTTP server, Kozou v0.1 spec §18.5); it prints a
loud warning when bound to a non-loopback host. Run the unauthenticated
server only inside a trusted boundary (local dev, a docker-compose network).

**Opt-in JWT + row-level security.** Pass an `auth` config (and a `pool`)
to `startApiServer` to require a signed JWT on every request. Kozou verifies
the token (HS256 shared secret or RS256 public key), then runs each request
inside a transaction on a dedicated connection under
`SET LOCAL ROLE <role-from-claim>`, with the claims published via
`set_config('request.jwt.claims', …, true)` — so **your own Postgres RLS
policies** decide what each request can read and write. Kozou authenticates
and switches role; it does not generate policies. A missing or invalid token
gets `401`; a token whose role is not permitted gets `403`.

For a trusted same-host caller that has no end user to obtain a token from
(the bundled Admin UI under `kozou dev`), `signServiceToken` mints an HS256
token claiming a given role, signed with the same secret the server verifies.

Not yet covered (follow-ups): an anonymous role for unauthenticated access,
and fetching verification keys from a remote JWKS URL.

## Safety

- Table / view / column identifiers are validated against the introspected
  `SchemaContext` (an allowlist) before any query is built, and are quoted
  defensively.
- All user-supplied values are passed as parameterized query arguments;
  values are never interpolated into SQL text.

## License

Apache 2.0
