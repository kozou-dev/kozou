# kozou

**Give your AI agent the *meaning* of your PostgreSQL database, not just its columns.**

Point an MCP-capable agent (Claude Code, Claude Desktop, Cursor) at a real
business database and ask it a simple question — *"what was our revenue last
quarter?"* — and it will confidently write a **plausible, wrong query**. Not
because the model is weak, but because the answer isn't in the column types.
It's in the business rules around them: which column is authoritative, what a
status really means, which rows don't count, which view is the source of truth.

Kozou reads that knowledge straight from your schema — `COMMENT ON` text, view
definitions, and type information — and hands it to the agent over
[MCP](https://modelcontextprotocol.io). Same model, same question, correct
answer.

## See it: the demo

A small online-store schema where the obvious revenue query is off by **4.8×**:

| Query an agent writes from… | Result |
| --- | --- |
| the raw DDL (`sum(amount_total)` over paid orders) | **575.00** ❌ — a deprecated cache that includes a test order and soft-deleted rows |
| the raw DDL, "carefully" (recompute from current `list_price`) | **580.00** ❌ — values old orders at today's price |
| **Kozou's context** (`sum(net_revenue)` from `vw_recognized_revenue`) | **120.00** ✅ — the view encapsulates every recognition rule |

The numbers are real and reproducible. Walk through the full before/after — and
*why* each wrong answer is the natural one — in
**[`examples/quickstart`](examples/quickstart)**.

## Quickstart

**Try the demo** (requires Docker):

```bash
git clone https://github.com/kozou-dev/kozou
cd kozou/examples/quickstart
cp .env.example .env
docker compose up
```

This brings up PostgreSQL (seeded with the demo schema) plus `kozou dev` — the
Admin UI on <http://localhost:3333> and an MCP server on
<http://localhost:3334/mcp>. Point your agent at the MCP endpoint and ask it
about revenue. See [`examples/quickstart/README.md`](examples/quickstart/README.md)
for the walkthrough.

**Start your own project:**

```bash
# Scaffold a project (docker-compose + kozou.config.yaml + ui-hints.yaml).
# create-kozou ships as a secondary bin of the kozou package, so npx needs
# -p kozou to find it on a clean machine.
npx -p kozou create-kozou my-project
cd my-project
cp .env.example .env
docker compose up
```

Add your tables and `COMMENT ON ...` text to `migrations/`, and the same context
flows to your agent.

**Kozou is migration-tool-agnostic.** Kozou never runs DDL or owns migration
state — it reads the schema your migrations *produce* and compiles it into
faithful forms. Manage schema change (including zero-downtime rollouts) with a
dedicated tool — [pgroll](https://github.com/xataio/pgroll), graphile-migrate,
Atlas, Sqitch, Flyway, or plain SQL files — and Kozou compiles the result. The
two are complementary, not competing.

## How it works

Kozou reads a PostgreSQL schema **once** and produces every form a modern team
and its AI need from it. The `COMMENT ON` conventions (`@ai`, `@policy`,
`@example`, `@widget`) are the single place you write down what the schema
*means*; Kozou compiles them into:

- **MCP context** for AI agents (`@kozou/mcp`) — the differentiator above.
- A reference **Admin UI** (`@kozou/svelte-ui`).
- **REST + OpenAPI** (`@kozou/api`, the default `kozou dev` backend).
- **Markdown docs** (`kozou docs`) — including a Mermaid entity-relationship
  diagram that draws the views and the `@ai` / `@policy` meaning, not just a
  foreign-key graph — and **TypeScript types** (`@kozou/codegen`).

One source, no duplicate definitions, no drift. The CLI, the MCP server (stdio +
HTTP, with an opt-in `call` tool that *executes* `@expose: rpc` actions, not just
describes them), and `@kozou/api` are published on npm; the runtime ships as a
multi-arch image on GHCR (`ghcr.io/kozou-dev/kozou`, linux/amd64 + arm64).

**Opt-in: what a role may touch.** Point Kozou at a role
(`introspection.respectPrivileges`) and the MCP describe tools and `kozou docs`
also tell the agent the role's effective GRANTs — that it may read a table but
not write it — so it knows its limits before it acts. A query layer that
enforces but doesn't explain (PostgREST, Hasura) can't give an agent that.
Advisory only: enforcement stays in PostgreSQL (GRANTs + your RLS). See
[`examples/quickstart`](examples/quickstart#bonus-what-the-agent-may-touch).

Use the runtime image directly:

```bash
docker pull ghcr.io/kozou-dev/kozou:v1.16.0
docker run --rm ghcr.io/kozou-dev/kozou:v1.16.0 mcp --help
```

Or install the packages for library / embedded use:

```bash
npm install kozou @kozou/core @kozou/introspect @kozou/mcp @kozou/svelte-ui
```

`@kozou/api` is bundled with `kozou` (no separate install). The experimental
`@kozou/codegen` ships as an optional companion (`npm install kozou @kozou/codegen`).

## Security

Kozou introspects `COMMENT ON` text, view definitions, and type information from
PostgreSQL, then hands them **verbatim** to AI agents through `@kozou/mcp`. This
relies on an important assumption: **schema authors (the principals with
permission to edit DB schema) are trusted**. We call this the trust boundary.

Designs where tenants in a multi-tenant SaaS can edit DB COMMENT text are
**discouraged** (prompt-injection risk). See [docs/security.md](docs/security.md)
for the threat model and mitigation plans, and [SECURITY.md](SECURITY.md) if you
need to report a vulnerability privately.

On the access-control axis, **Kozou is a resource server and enforcement layer,
not an identity provider**: with auth enabled it verifies the JWT on each request
that carries one — with an optional anonymous-role path for tokenless requests —
and runs each under a PostgreSQL role so your own RLS policies decide access.
Identity provision (registration, login, passwords and OAuth, token issuance) is
delegated to an external provider — Supabase Auth (recommended), Auth0 / Clerk
via JWKS, or a minimal self-hosted issuer. See
[docs/security.md](docs/security.md#authentication-and-authorization).

The same posture extends to hosted AI clients: the MCP HTTP endpoint can run as
an **OAuth 2.1 resource server** (`server.mcp.http.auth`) per the MCP
authorization spec — Kozou advertises your IdP via RFC 9728 protected-resource
metadata, verifies each request's bearer token, gates the tools on the token's
scopes, and runs execution (the `call` tool) as the token's role. Deliberately
stricter than REST: no anonymous access, no default role. See the deployment guide on kozou.org —
[Remote MCP with OAuth](https://kozou.org/guides/mcp-oauth/) — plus the
[Keycloak](https://kozou.org/guides/mcp-oauth-keycloak/) and
[Auth0](https://kozou.org/guides/mcp-oauth-auth0/) recipes.

If no agent will ever connect, you can also **not serve the endpoint at all**:
`server.mcp.http.enabled: false` — or `KOZOU_MCP_HTTP_ENABLED=false`, which the
scaffolded compose stack forwards, since that stack has no config file to edit.
`kozou dev` then brings up the Admin UI and REST alone with no MCP listener,
`kozou mcp --http` refuses rather than contradicting the config, and the Admin
UI drops its "Connect an AI agent" page. Adding authentication needs an
authorization server; declining to run an endpoint needs nothing, so for a
runtime that only ever serves the Admin UI this is the cheaper posture.

## Requirements

Runtime requirements for v1.16.0:

- **PostgreSQL 16 or later** — the canonical source of truth
- **Docker 24 or later** (optional) — recommended for the `docker compose up` stack, which brings up PostgreSQL and a `kozou` service running `kozou dev` (the bundled Admin UI + MCP HTTP server, plus Kozou's in-house REST backend served in-process) from `ghcr.io/kozou-dev/kozou` (a multi-arch image, native on linux/amd64 and linux/arm64). The default stack needs **no separate REST container**; to opt out and use an external PostgREST instead, set `adapter.type: postgrest` and add the (commented) service in the scaffold's `docker-compose.yml`.
- **Node.js 20 or later** — for running the npm-published packages directly (`npx kozou …`)

Contributors additionally need **pnpm 9 or later**. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development environment setup.

## Roadmap

- v0.1.0 (shipped): schema introspection, MCP server (stdio), reference Admin UI, `create-kozou` scaffold, PostgREST adapter
- v0.1.1 (shipped): MCP HTTP transport, `kozou dev` host integration, multi-arch Docker image (linux/amd64 + linux/arm64), Playwright E2E for the Admin UI, CodeQL reactivation, zod 4 / TypeScript 6 migration
- v0.2.0 (shipped): `kozou docs` Markdown schema documents; `@policy` advisory metadata surfaced to AI agents through the MCP server
- v0.2.1 (shipped): multi-line `@ai` / `@policy` COMMENT blocks are now captured in full (not just the first line) in the MCP describe tools and `@kozou/api` OpenAPI; the experimental `@kozou/api` REST layer — with multi-hop relation embedding and opt-in JWT + Postgres RLS — and `@kozou/codegen` TypeScript row types are now published to npm as optional companions, exercised via `kozou dev --adapter api` and `kozou codegen`
- v1.0.0 (shipped): `@kozou/api`, Kozou's in-house REST backend, is now the default `kozou dev` data layer and ships bundled with the CLI; PostgREST drops to an opt-out adapter (`adapter.type: postgrest`). Its REST wire format and OpenAPI are a stable contract. Composite primary keys are addressable end to end, and list filters gain PostgREST-compatible operators (`eq`/`neq`/`gt`/`gte`/`lt`/`lte`/`like`/`ilike`/`in`/`is`). See the scope table in the `@kozou/api` README for which relational-REST features the default backend covers and which to keep PostgREST for.
- v1.1.0 (shipped): composite foreign keys become first-class — they embed as relations (multi-column joins, `x-kozou-embeds` hints carrying the foreign-key column set, MCP / `kozou docs` visibility), the relation-select endpoint serves composite-key targets (array option ids), and the Admin UI's create/edit forms gain a relation picker: single-column FKs get a searchable picker, and an eligible composite FK becomes one picker that fills every key column at once, with a non-enhanced (no-JS) form path. See the `@kozou/svelte-ui` README for the picker's eligibility rules and known limitations. The OpenAPI document is also faithful to runtime request bodies and modes.
- v1.1.1 (shipped): a patch release of fixes from v1.0/v1.1 field reports. The scaffold's docker-compose now forwards the documented `KOZOU_JWT_*` auth variables (they previously never reached the container, leaving auth silently off) and `kozou dev` prints an unambiguous `api auth:` state line at startup. `@kozou/api` maps database outcomes to stable HTTP statuses — privilege / row-level-security denials return 403, constraint conflicts 409/400 — with raw database text kept out of response bodies (see the Errors section of the `@kozou/api` README). The Admin UI can create rows that leave defaulted NOT NULL columns empty, two long-standing form bugs are fixed (defaulted non-text columns no longer 500 the create/edit forms; manual uuid entry submits again), and runtime warnings no longer carry stale version pins.
- v1.2.0 (shipped): the auto-minted Admin UI service token (the HS256 development convenience) can now carry custom JWT claims via `auth.ui.claims` (or the `KOZOU_UI_CLAIMS` environment variable), so RLS policies keyed on claims beyond `role` can be exercised from the bundled UI in local development. The `role` claim stays reserved — a colliding entry is dropped so a custom claim can never smuggle in a role — and `iat` is always set by the mint; a configured `iss` / `aud` wins over a custom one, while a custom temporal claim (`exp` / `nbf`) is passed through but warned about when it would make the token rejected. Schema introspection also warns when a known COMMENT tag (`@ai`, `@policy`, …) appears mid-line instead of at the start of a line — such tags are not parsed and would otherwise leak verbatim into the surrounding description.
- v1.3.0 (shipped): **opt-in privilege-aware introspection** (`introspection.respectPrivileges`, default off) makes the bundled Admin UI faithful to what the serving role may *do*, not just what the schema declares. A table or view the role cannot `SELECT` (gated by schema `USAGE`) is hidden from the nav; a column it cannot write renders read-only **per form mode** (no `INSERT` → read-only on create, no `UPDATE` → read-only on edit); and Delete is hidden where the role lacks it. The role evaluated is the Admin UI's (`auth.ui.role` / `auth.defaultRole`, or an explicit `introspection.role`). `@kozou/api` and the MCP server stay schema-wide.
- v1.4.0 (shipped): **opt-in RPC actions** — a Postgres function tagged `@expose: rpc` in its COMMENT is compiled into a callable action across all four surfaces at once: REST (`POST /rpc/<schema>.<fn>` with a named-args body), the COMMENT-native OpenAPI document, an MCP `describe_functions` tool, and an Admin UI "Actions" page. This recovers the verb-level capability the v1.0 default switch dropped, and lets the security model Kozou recommends (state changes funnelled through functions, table writes revoked) stay reachable. Exposure is opt-in and never silent: nothing is exposed by default; a function still granting `EXECUTE` to PUBLIC is hard-skipped unless deliberately opened (`@expose: rpc public` / `api.rpc.allowPublicExecute`); a `SECURITY DEFINER` function needs a config double opt-in (`api.rpc.allowDefiner`) **and** an owner-safe `search_path`; unsupported shapes are loudly skipped. Whether a caller may run an action is enforced by the PostgreSQL `EXECUTE` privilege under the request's role — a denial is 403, so exposure is not permission. The wire shape is experimental until dogfooding settles it. See the RPC actions section of the `@kozou/api` README.
- v1.4.1 (shipped): a patch release. `@kozou/api` now pre-flights two more client inputs — item id segments (`GET`/`PATCH`/`DELETE` `/<resource>/<id>`) and write-body values — so a malformed scalar (a non-uuid id, or a value of the wrong type for its column) returns a `400` up front instead of surfacing as a `500` (issue #110). The numeric pre-flight also accepts the non-finite literals (`NaN` / `±Infinity`) PostgreSQL allows for float types. Plus documentation and scaffold hygiene — the bundled Docker image tag and the default-stack docs track the release.
- v1.4.2 (shipped): a patch release of fixes. `@kozou/api` now resolves a DOMAIN column to its base type during introspection, so an invalid value for a domain-typed column returns a `400` up front instead of a `500` on list filters, item ids, and write bodies — and a domain-over-text column is now searchable (`?search=`) and relation-select-eligible (issue #85). An `in.(...)` filter value may contain a comma when double-quoted (`in.("a,b",c)`, with `\"` / `\\` escapes inside the quotes); unquoted lists are unchanged (issue #77). `parseCommentTags` no longer absorbs an indented `@ai` / `@policy` / … tag that follows the SQL of an `@example:` block — the tag is parsed normally instead of leaking into the example text and the surrounding description (issue #71). CI hardening: the npm artifact-integrity matrix now covers all seven published packages (issue #74), and the scaffolding CLI's npm publish is gated on the GHCR image it pins, so a freshly scaffolded stack never references an image tag that was not pushed (issue #105).
- v1.5.0 (shipped): **the MCP `call` execution tool** — the MCP server can now *run* an exposed RPC action, not just describe it (issue #103), completing describe → act. It is **opt-in and off by default**: enable `server.mcp.execution` (with a role) and the bundled `kozou mcp` lists a `call` tool that executes a function under a single operator-configured role through the same `SET LOCAL ROLE` + RLS envelope as the REST surface — so the `EXECUTE` privilege and the function's row-level security apply, the agent cannot choose the role (no self-elevation), raw database errors are never returned to the caller, and a `SECURITY DEFINER` action still needs the `allowDefiner` double opt-in. It runs as one service role (no per-caller identity), so it is unsuitable for multi-tenant per-user authorization — use the REST API for that. The wire shape is experimental. Internally, the role-transaction envelope and the RPC call core moved into `@kozou/core` so the REST and MCP surfaces share one enforcement path. See the RPC actions guide.
- v1.5.1 (shipped): a patch release. `@kozou/api`'s list-filter pre-flight now validates a `real` (float4) value by exact comparison against the float32 rounding thresholds instead of `Math.fround`, which double-rounded (decimal → binary64 → binary32) and falsely rejected (400) a decimal just inside the underflow (`2^-150`) or overflow (`2^128 − 2^103`) boundary that PostgreSQL accepts (issue #85). No value PostgreSQL rejects is now accepted, so this only turns prior false-400s into the correct 200 — never a 500. Verified against PostgreSQL 16 via `pg_input_is_valid`.
- v1.6.0 (shipped): the **opt-in RPC actions wire is now a stable contract**. The REST `POST /rpc/<schema>.<fn>` endpoint (named-arguments body + the return-shape mapping), the COMMENT-native OpenAPI function metadata, and the MCP `call` execution tool — all compiled from `@expose: rpc` — shipped experimental-first in v1.4.0 (describe) and v1.5.0 (execute, issue #103). After end-to-end validation against a realistic schema (a least-privilege execution role, RLS read/write enforcement, `SECURITY DEFINER`, no-leak errors, the allowlist, and the full return-shape matrix), the wire joins the table/view CRUD surface under the stability guarantee: it will not change incompatibly without a major release. Documentation/contract-declaration only — no behavior change. See the `@kozou/api` README Stability section and the RPC actions guide.
- v1.7.0 (shipped): the framework-agnostic read-path of the reference Admin UI is extracted into a new published package, **`@kozou/ui-core`**, which `@kozou/svelte-ui` now depends on. The two `DataAdapter` implementations, list-parameter parsing, view-column heuristics, cell formatting, foreign-key label resolution, resource-id handling, and the schema / FK-row caches move out of the SvelteKit app unchanged, so the same logic can drive more than one UI framework. This is the structural step of the React UI exploration: a minimal React (Next.js) read spike renders list + detail by consuming `@kozou/ui-core` verbatim, with no change to the shared core — evidence that the read-path abstraction is framework-agnostic. (The spike is an internal example, not a published second UI; `@kozou/svelte-ui` stays the reference Admin UI.) Also: `@kozou/api` now rejects a malformed, non-empty JSON request body with a `400` instead of treating it as an empty body (issue #145). The `@kozou/svelte-ui` public API is unchanged.
- v1.8.0 (shipped): **opt-in privilege-aware AI context** — point Kozou at a role (`introspection.respectPrivileges`) and the MCP `describe_table` / `describe_view` tools and `kozou docs` now also tell the agent what that role may *touch*: each relation is annotated with the role's effective GRANTs (relation-level `SELECT`/`INSERT`/`UPDATE`/`DELETE`, plus per-column `insertable` / `updatable` on tables), and `kozou docs` grows a per-table "Security" section. Unlike the Admin UI's privilege mode, the AI surfaces **annotate rather than hide** — a table the role cannot `SELECT` still appears, marked `select: false`, so the agent is told its limits rather than left guessing. It reuses the existing privilege introspection (no new queries) and is advisory only: enforcement stays in PostgreSQL (GRANTs + your RLS). When the MCP `call` execution tool is enabled, the annotated role is tied to the execution role so describe and act never disagree. Default off ⇒ every surface stays schema-wide. `kozou docs` also now renders per-column `@ai` / `@policy` notes. See [`examples/quickstart`](examples/quickstart).
- v1.8.1 (shipped): a security-hardening patch. The unauthenticated MCP HTTP server gains **DNS-rebinding protection** — it validates the request `Host` / `Origin` against an allowlist before handling it, so a page in the operator's browser cannot drive it by rebinding a hostname to loopback — and a **request-body size limit** (both the MCP server and `@kozou/api` reject an over-large body with `413`, and a non-JSON body with `415`, instead of buffering it unbounded). Read requests (`GET`) now run in a `READ ONLY` transaction, so a read cannot commit a write regardless of the role's grants. The bundled dev stack is **loopback by default**: the Admin UI and MCP HTTP server bind `127.0.0.1` (set `KOZOU_UI_HOST` / `KOZOU_MCP_HTTP_HOST` to expose them inside a container), and the scaffold and quickstart `docker-compose` files publish every port (Admin UI, MCP, database) on `127.0.0.1` only. See the repository's security advisory.
- v1.9.0 (shipped): field-report fixes for the introspection and REST surfaces. Native PostgreSQL `ENUM` columns are now recognized — a column typed as a native enum gets the `enum-select` widget, a string-literal union in the generated client, and an `enum` in OpenAPI / the MCP context, matching how the same type already resolved as a function argument. Declarative **partitioned parent tables** and **materialized views** are now introspected (the parent is surfaced and reads like a normal table while its leaf partitions stay hidden; a materialized view appears as a read-only view) — previously both were silently absent from every surface. A list query with an explicit `sort` on a non-unique column now appends the primary key as a tiebreaker, so `LIMIT`/`OFFSET` pagination is stable across pages. And `kozou mcp --http` honours `server.mcp.http.{port,host}` from `kozou.config.yaml`, matching `kozou dev`.
- v1.9.1 (shipped): field-report fixes for the reference Admin UI and the external REST adapter. A create / update / delete that the database rejects (a unique / foreign-key / check violation, or a privilege / row-level-security denial) now re-renders the form with the user's input and a readable message instead of a generic 500 that discarded it. And free-text search under the external REST (PostgREST) opt-out now quotes the term, so a value containing reserved characters (`,` `(` `)` `.`) is matched literally instead of corrupting the query. Also bumps a transitive dependency for a published security advisory.
- v1.10.0 (shipped): list-endpoint scaling and developer-experience improvements, all additive. **`@kozou/api` list pagination** gains two opt-in controls: a `?count=exact|estimated|none` mode (the default `exact` count is unchanged; `estimated` uses the planner's O(1) row estimate; `none` skips the count and returns `total: null`), and **keyset (cursor) pagination** via `?after=` / `?before=` that pages by the list's effective order (sort + primary-key tiebreaker) in O(page) instead of walking a deep `OFFSET`. Cursors are opaque, round-trip every column type losslessly, and order correctly across composite-key, mixed-direction, and nullable sorts; offset paging is unchanged. The **MCP `list_tables` / `list_views`** tools now return `sourceSchemas` and `outOfScope`, so an agent can tell a schema outside the introspection scope from one that is simply empty (the no-op `includeSystem` input is retired from the tool). The reference Admin UI's **list table is more accessible**: the search field has a real accessible name and sortable column headers expose `aria-sort`. Plus minor cleanups — UI Hints keyed by schema-qualified name so same-named relations in different schemas no longer collide, array-aware codegen enum types, and an MCP tool-dispatch error that no longer echoes raw internal text.
- v1.11.0 (shipped): an authorization-aware addition to the AI context, additive. **MCP `describe_table` and `kozou docs` now surface a row-level-security signal.** A table protected by row-level security is reported with whether RLS is `enabled`, whether it is `forced` (applies to the table owner too), and whether any policy exists, plus an advisory note telling the agent the rows it sees may be filtered and a write may be rejected — a table with RLS enabled but no policy is flagged default-deny. The signal is **on by default** (a role-independent structural fact about the table, not the opt-in per-role privilege mode) and reported on **tables only** (a view carries no RLS flag of its own, and whether it masks its underlying tables depends on `security_invoker`). Kozou reads only the booleans — never the policy expressions (`USING` / `WITH CHECK`) — so your authorization logic stays in the database and out of the agent's context; knowing a table is row-filtered never bypasses the filter, which PostgreSQL enforces regardless.
- v1.12.0 (shipped): `kozou docs` now emits a **Mermaid entity-relationship diagram** as a schema overview, built entirely from the existing schema context (read-only, stateless, no new introspection). It is meaning-laden, not a bare foreign-key graph: tables *and* views are entities (views are Kozou's named business concepts, linked by a dotted "derives from" edge to the tables they are built on), columns are attributes with `PK` / `FK` markers, foreign keys are crow's-foot edges whose cardinality reflects NOT NULL / uniqueness, and a legend plus an entity-level `@ai` / `@policy` notes block sits under the diagram, so a source-of-truth view and the schema's meaning are co-located with the structure. The README and docs also now state that **Kozou is migration-tool-agnostic** — it compiles the schema your migrations produce and never runs DDL or owns migration state.
- v1.12.1 (shipped): documentation and dependency hygiene. The scaffolded `migrations/0001_init.sql` now ships a worked example of the COMMENT conventions — an `orders` table and a `vw_recognized_revenue` view exercising `@ai` / `@widget` / `@policy` / `@example` and the view-as-domain-concept pattern — instead of a single-line stub, so a freshly scaffolded project shows how to encode schema meaning from the start. Also pins a transitive dev/test-only dependency (`undici`) to a patched line for a published security advisory; no runtime dependency of any published package changes.
- v1.12.2 (shipped): a patch release of input-validation hardening, all back-compatible. `@kozou/api` pre-flights two more client-mistake classes to a `400` up front instead of letting them reach PostgreSQL as a data exception (a `500`): a value outside a **native `ENUM`** column's labels — on every path (list filter, `in.(...)`, write body, item-id segment, and a forged pagination cursor) — and an **out-of-range pagination offset** (a `page` so large the computed `OFFSET` overflows). CHECK-constraint columns (text / date / …) are deliberately left to PostgreSQL: their value set is not exhaustive, so a predicate outside it (`status=eq.legacy`, `like.…`, a date range) stays a valid query, not a 400. The same change also stops an **empty-string text filter** (`?col=eq.`) being wrongly 400'd, since `''` is a valid value. Plus dependency hygiene: a transitive dependency (`ts-deepmerge`, reached through `sveltekit-superforms` in `@kozou/svelte-ui`) is pinned for an OSV-Scanner advisory. The pin is a workspace-local `pnpm.overrides` entry, so no published package's declared dependencies change — but `@kozou/svelte-ui` publishes a bundle with those dependencies inlined, so the pinned version is the one that ships: this release replaces the vulnerable copy inside that bundle with the patched one.
- v1.12.3 (shipped): a patch release of reference Admin UI and cold-start fixes, all back-compatible. The Dashboard's **Tables** list now shows the table name as the title and its `COMMENT` as the description — a commented table previously rendered the comment in both slots and never showed the name, while the **Views** list already did the right thing; the table detail / list / new / edit headings shared the same label and are fixed too (`@kozou/core`). Plus onramp papercuts found running the scaffold end to end: the scaffolded `.env.example` no longer carries a redundant `DATABASE_URL` line that silently desynced from `POSTGRES_PASSWORD` (a first-run auth failure), and a bad or missing argument to the MCP `describe_table` / `describe_view` tools now returns an actionable message naming the argument instead of a generic tool-failed error.
- v1.12.4 (shipped): reference Admin UI improvements from operator feedback, all additive. A new **"Connect an AI agent" page** turns the Admin UI into an on-ramp to the MCP layer: it shows the live MCP Streamable HTTP endpoint `kozou dev` already serves and copy-paste client config for Claude Desktop / Cursor (an `mcpServers` HTTP entry — no `DATABASE_URL` or any secret) and Claude Code (`claude mcp add --transport http`), reachable from a dashboard card and a header link. So an operator who lives in the Admin UI finds their way to the AI context layer — kozou's actual value — instead of hunting through docs. Plus navigation papercuts: a top-of-page back link on the table detail / new / edit pages (the way back to the list no longer requires scrolling to the bottom), and a full-width desktop layout so wide list tables use the viewport instead of a centered column.
- v1.13.0 (shipped): **remote MCP with OAuth** — the MCP Streamable HTTP endpoint can run as an **OAuth 2.1 resource server** (`server.mcp.http.auth`, per the [MCP authorization spec, revision 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)). Kozou advertises the operator's own IdP via RFC 9728 protected-resource metadata, verifies each request's bearer token (issuer / audience / scopes), gates the describe and execute tool facets on the token's scopes, and runs the `call` tool as **each verified token's PostgreSQL role** — per-caller identity with the same `SET LOCAL ROLE` + RLS enforcement as the REST surface. Deliberately stricter than REST: no anonymous access, no default role, execution requires an explicit `allowedRoles` allowlist, and plaintext http outside loopback is refused at startup. Verified end to end against real IdPs: a real-Keycloak testcontainers suite in CI, plus live claude.ai / ChatGPT / Claude Code connections through Keycloak and Auth0. Operator guides (deployment + Keycloak / Auth0 recipes) on kozou.org. Internals: JWT verification moved to a shared `@kozou/core/auth` subpath, consumed by both REST and MCP — REST wire behavior unchanged.
- v1.14.0 (shipped): sharper join context for views, back-compatible. The MCP `get_concept_context` **join suggestions are now derived from the real foreign keys** among a view's underlying tables — actual `ON` conditions (composite keys joined with `AND`) instead of the previous unresolved `<fk_column> = <pk_column>` placeholder, and a view whose underlying tables share no foreign key returns no suggestions rather than a misleading guess. Each suggestion also carries the **foreign key's `COMMENT` as its purpose**, so an agent gets the documented meaning of a join, not just its mechanics (the `purpose` field, previously always empty, is now populated). Built entirely from the existing schema context — no new introspection, and the `{ table, on }` shape is unchanged.
- v1.15.0 (shipped): **MCP `search_schema`** — a read-only metadata search tool, the discovery primitive between `list_*` (which return everything) and `describe_*` (one named object). It answers *"which tables, columns, views, functions, or enums relate to X?"* without enumerating the whole catalog, so an agent's context budget scales with the question, not the size of the schema. It searches object names, labels, COMMENT bodies, `@ai` / `@policy` notes, and enum members (native `ENUM` types and CHECK-derived value sets), and returns **ranked hits** — each `{ kind, ref, label, matchedField, snippet, score }`, where `ref` (`schema.table`, `schema.relation.column`, `schema.view`, `schema.function`, `schema.enumtype`) is the identifier to feed the next `describe_*` call. Hits are ranked best-match first — an object's name and label outrank matches in its prose (COMMENT / `@ai` / `@policy`), and a cleaner match (a whole field or a prefix) outranks an incidental mid-word one — with one hit per object (its best-matching field). Callers can scope the search with optional `schema` / `kinds` filters and bound it with a `limit` (default 20, capped at 100) that sets a `truncated` flag when more matched. The exact ranking weights are advisory and may change between releases — not a contract to compute against. It is a pure function over the already-built schema context — no row data, no new introspection, zero database footprint — and additive: no existing tool's input or output changes, and it is gated by the existing `describe` scope in OAuth resource-server mode.
- v1.15.1 (shipped): a documentation patch. The MCP `search_schema` tool description now states its concept scope — a concept (business view) is found as a `view` hit, but text unique to a concept (its example queries and join meanings) is not searched there, so an agent is pointed to `list_concepts` / `get_concept_context` for that. Description-only; no behavior change.
- v1.16.0 (shipped): **opt-in provenance on MCP results** — set `server.mcp.provenance` (default off) and every read/describe MCP tool result carries a small `provenance` object so an agent can explain *which database version and schema build produced an answer*: `databaseVersion` (the PostgreSQL server version, reduced to `major.minor` so it cannot fingerprint the OS / patch build), `kozouVersion` (the MCP server build that compiled the answer), and `builtAt` (when the schema context was introspected). It is **emit-only and additive**: the values come straight from the already-built schema context — no new introspection, no state, no database writes — the stamp is applied uniformly to the eight read/describe tools (the `call` execution tool shapes its own result and is not stamped), and with the flag off existing consumers' output is byte-for-byte unchanged. Plus dependency hygiene: several transitive dependencies (`brace-expansion`, `js-yaml`, `protobufjs`, `body-parser`) are pinned to their patched versions for published OSV-Scanner advisories.
- Beyond v1.16: React UI exploration — optional write-path parity (a second UI driving create / edit / delete across both adapters)

## Name

**Kozou** carries three meanings in three syllables:

- *kozō* (calf) — the young elephant walking beside PostgreSQL's mascot Slonik
- *kōzō* (structure) — the structural transformation a compiler performs
- *kozō* (apprentice) — the quiet figure who serves something larger than itself

## License

Apache 2.0
