# @kozou/api

> **Stable (Kozou v1.0).** The REST wire format, query grammar, and OpenAPI
> extensions documented below are a stable contract: they will not change
> incompatibly without a major release. The one part still evolving is the
> composite-foreign-key relation shape — see [Stability](#stability).

Kozou's own REST layer. Given a `SchemaContext` (from `@kozou/introspect`
+ `@kozou/core`) and a PostgreSQL connection, it serves the tables and
views of your database as a REST API, driven entirely by your DDL and
`COMMENT` metadata — no hand-written route code.

This is the in-house data layer that Kozou v1.0 makes the default backend.
The Admin UI talks to it through the same `DataAdapter` seam (`@kozou/core`)
it already uses, so swapping the data layer is not a breaking change for UI
code.

## API

### Service

- `GET /` — service info (name, version) and the list of available resources.
- `GET /openapi.json` — an OpenAPI 3.1 document for the whole API
  (see [OpenAPI](#openapi)).

### Reading

- `GET /<resource>` — list rows of a table or view. Returns
  `{ rows, total, page, pageSize }`. Supports:
  - **pagination** — `page` (1-based) and `pageSize` (`LIMIT` / `OFFSET`, capped);
  - **sort** — `sort=field.asc,other.desc`;
  - **filter** — `<column>=<op>.<value>` (see [Filtering](#filtering));
  - **free-text search** — `search=<text>` (`ILIKE` across text columns);
  - **embedding** — `embed=<relation-chain>` (see [Embedding](#embedding)).
- `GET /<resource>/<id>` — fetch a single table row by primary key. For a
  composite primary key, `<id>` is the key columns in declaration order,
  comma-joined in one path segment (`/order_lines/42,3`); `embed` is
  supported here too. Returns the row, or `404`.
- `GET /<resource>?as=options&label=<col>&fields=<a,b>&q=<text>&limit=<n>`
  — lightweight relation-select lookup. Returns `{ options: [{ id, label }] }`.

### Writing

- `POST /<resource>` — create a row from a JSON body; returns `201` + the
  created row. An empty body inserts a row of column defaults.
- `PATCH /<resource>/<id>` — update the supplied columns; returns the row,
  or `404`.
- `DELETE /<resource>/<id>` — delete by primary key; returns the deleted
  row, or `404`.

Writes are rejected on views (`405`) and on unknown columns (`400`).

### Filtering

List filters use a `<column>=<op>.<value>` grammar:

| operator | meaning |
|---|---|
| `eq` / `neq` | equal / not equal |
| `gt` / `gte` / `lt` / `lte` | range comparisons |
| `like` / `ilike` | pattern match (`*` is the wildcard) |
| `in` | membership — `in.(a,b,c)` |
| `is` | `is.null` / `is.notnull` / `is.true` / `is.false` |

A bare value (`status=paid`) is shorthand for `eq` and stays backward
compatible. Repeating a column ANDs its filters (e.g. a `gte` + `lt` range).
A value that itself looks like an operator can be forced to equality with an
explicit `eq.` prefix (`name=eq.gt.5`). Operators are a fixed allowlist, the
column is checked against the schema, and every value is passed as a bound
parameter — nothing is interpolated into SQL text. Values for the common
scalar families (integer, numeric / float, boolean) are validated up front
and rejected with a `400`; values for other types are enforced by
PostgreSQL.

### Embedding

`embed=<relation-chain>` inlines related rows as nested JSON, on both list
and item reads:

- forward (to-one) and reverse (to-many) relations, mixed in one request;
- dot-separated chains up to 5 deep (`embed=order.customer.region`);
- comma-separated for several relations (`embed=customer,lines`);
- up to 25 distinct relations per request, and up to 100 child rows inlined
  per parent for a to-many relation.

To-many embeds are rendered as a JSON array ordered by the child's primary
key. Many-to-many is expressed by naming the junction explicitly
(`embed=link.far`); there is no automatic flattening of junction tables.

### OpenAPI

`GET /openapi.json` returns an OpenAPI 3.1 document generated from the
schema. Database `COMMENT`s drive it: table / view / column descriptions
become schema `description`s, CHECK / ENUM members become `enum`, and
Kozou's `@`-annotations become vendor extensions:

- `@ai:` notes → `x-kozou-ai`
- the resolved widget → `x-kozou-widget`
- `@policy:` advisories → `x-kozou-policy`
- embeddable relations → `x-kozou-embeds` (with `cardinality`)

The document models the schema, the `x-kozou-*` metadata, and the list /
item / CRUD surface. A few runtime behaviors are enforced by the server but
not yet fully modeled in the generated document: create accepts an empty body
(column defaults) and `PATCH` accepts a partial column subset, the
`as=options` relation-select mode shares the collection path, and ambiguous
embeds are rejected at request time. These are being refined; the wire
behavior itself is stable.

## Stability

Stable as of Kozou v1.0 (covered by semantic versioning — no incompatible
change without a major release):

- the REST envelopes — the list `{ rows, total, page, pageSize }`, the item
  shape, and the create / update / delete return shapes;
- the query grammar — pagination, `sort`, the `<column>=<op>.<value>` filter
  grammar, `as=options`, and `embed`;
- the `GET /openapi.json` document — OpenAPI 3.1 plus the `x-kozou-ai` /
  `x-kozou-widget` / `x-kozou-policy` / `x-kozou-embeds` extensions;
- the auth boundary — JWT claims mapped to `SET LOCAL ROLE` (see below).

Still evolving (not yet covered by the stability guarantee):

- the **composite-foreign-key relation shape**. A composite FK is surfaced
  as a `BuildIssue` rather than silently dropped, but embedding and
  relation-select over a composite FK are a fast-follow, so the relation
  shape they will take is not frozen yet.
- the **`@kozou/codegen`** output (a separate package, still experimental).

## Scope: default coverage vs PostgREST opt-out

`@kozou/api` covers the relational REST surface most schemas need; Kozou
v1.0 makes it the default backend. Deployments that need a feature in the
"opt-out" column can stay on (or switch back to) the PostgREST adapter
(`adapter: postgrest`) — see the migration notes in the `kozou` package. The
intent is no silent gap: the in-house backend by default, PostgREST as a
deliberate opt-out.

| Capability | `@kozou/api` (v1.0 default) | Notes |
|---|---|---|
| Table CRUD | ✅ (incl. composite primary keys) | item routes (get/update/delete by id) need a primary key — single or composite; a primary-key-less table gets list + create only |
| Views | ✅ read-only / list | no item-by-id, writes are `405`, no embedding from a view |
| Embed 1:1 / many-to-1 / 1-to-many | ✅ `embed=` (mixed direction, multi-hop) | forward to-one + reverse to-many |
| Many-to-many | △ name the junction and chain (`embed=link.far`) | no automatic junction flattening |
| Relation-select | ✅ `as=options&label=&q=` | composite PK / FK support is a fast-follow |
| Filter operators | ✅ `eq` / `neq` / `gt` / `gte` / `lt` / `lte` / `like` / `ilike` / `in` / `is` | |
| Sort / pagination | ✅ | `sort`, `page` / `pageSize` |
| COMMENT-native OpenAPI 3.1 (`x-kozou-*`) | ✅ | **Kozou's differentiator** — PostgREST treats COMMENTs as opaque text |
| JWT + RLS (`SET LOCAL ROLE`) | ✅ | |
| RPC (Postgres functions) | ❌ opt-out | |
| Full-text search (fts) | ❌ opt-out | approximate with `ilike` |
| Vertical select (column projection) | ❌ opt-out | always returns all columns |
| Writable views (`INSTEAD OF`) | ❌ opt-out | views are read-only |
| Upsert / bulk insert | ❌ opt-out | |
| Automatic M:N flattening | ❌ opt-out | name the junction instead |

## Security boundary

By default the API ships with **no authentication** and binds to
`127.0.0.1` (like the MCP HTTP server); it prints a
loud warning when bound to a non-loopback host. Run the unauthenticated
server only inside a trusted boundary (local dev, a docker-compose network).

**Opt-in JWT + row-level security.** Pass an `auth` config (and a `pool`)
to `startApiServer` to require a signed JWT on every request. Kozou verifies
the token (an HS256 shared secret, an RS256 public key, or a provider's
remote JWKS endpoint — exactly one), then runs each request
inside a transaction on a dedicated connection under
`SET LOCAL ROLE <role-from-claim>`, with the claims published via
`set_config('request.jwt.claims', …, true)` — so **your own Postgres RLS
policies** decide what each request can read and write. Kozou authenticates
and switches role; it does not generate policies. A missing or invalid token
gets `401`; a token whose role is not permitted gets `403`.

Set `auth.anonRole` to allow **anonymous access**: a request that carries no
`Authorization` header runs under that role (with empty claims) so your RLS
policies decide what an anonymous caller sees, instead of a `401`. Only a
fully absent header is anonymous — a present but invalid/expired token is
still `401`, never silently downgraded. The login role must be `GRANT`ed
membership in the anonymous role.

Set `auth.jwt.jwksUri` to verify against a provider's **remote JWKS endpoint**
(Auth0, Clerk, Supabase, …) instead of a static key: the verification key is
selected by the token's `kid`, fetched once, cached, and refreshed when the
provider rotates keys.

For a trusted same-host caller that has no end user to obtain a token from
(the bundled Admin UI under `kozou dev`), `signServiceToken` mints an HS256
token claiming a given role, signed with the same secret the server verifies.

## Safety

- Table / view / column identifiers are validated against the introspected
  `SchemaContext` (an allowlist) before any query is built, and are quoted
  defensively.
- All user-supplied values are passed as parameterized query arguments;
  values are never interpolated into SQL text.

## License

Apache 2.0
