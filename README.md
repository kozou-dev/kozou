# kozou

PostgreSQL compiler. One source, many faithful forms.

Kozou reads a PostgreSQL schema once and produces every form a modern team and its AI need from it — admin UI, MCP context, TypeScript types, REST endpoints, and documentation. No duplicate definitions. No drift.

## Status

v1.4.0 (latest release). The CLI, schema introspection, MCP server (stdio + HTTP), reference Admin UI (now with opt-in RPC actions — a Postgres function tagged `@expose: rpc` is compiled into a callable form across REST, OpenAPI, MCP, and an Admin UI "Actions" page), Markdown schema-document generation (`kozou docs`), and Kozou's in-house REST backend (`@kozou/api`, the default `kozou dev` data layer) are all available on npm; the runtime image lives on GHCR as a multi-arch manifest (linux/amd64 + linux/arm64). Releases land via the workflow in `.github/workflows/release.yml`.

## Quickstart

```bash
# Scaffold a project (docker-compose + kozou.config.yaml + ui-hints.yaml).
# `create-kozou` ships as a secondary bin of the `kozou` package, so npx
# needs `-p kozou` to find it on a clean machine.
npx -p kozou create-kozou my-project
cd my-project

# Bring up PostgreSQL and the Admin UI. The scaffold's docker-compose
# runs a `kozou` service (`kozou dev`: the bundled SvelteKit Admin UI,
# MCP HTTP server, and Kozou's in-house REST backend, all in-process),
# so `docker compose up` brings the full stack online — no separate REST
# container by default.
cp .env.example .env
docker compose up
```

Or pull the CLI runtime image directly:

```bash
docker pull ghcr.io/kozou-dev/kozou:v1.4.0
docker run --rm ghcr.io/kozou-dev/kozou:v1.4.0 inspect --help
docker run --rm ghcr.io/kozou-dev/kozou:v1.4.0 mcp --help
```

For library use (custom hosts, embedded MCP), install the workspace packages from npm:

```bash
npm install kozou @kozou/core @kozou/introspect @kozou/mcp @kozou/svelte-ui
```

`@kozou/api` (Kozou's in-house REST layer — its wire format and OpenAPI are a stable contract as of v1.0) is the default `kozou dev` backend and is bundled with `kozou`, so no separate install is needed. The experimental `@kozou/codegen` TypeScript codegen ships as an optional companion — install it alongside `kozou` when you want `kozou codegen`:

```bash
npm install kozou @kozou/codegen
```

## Security

Kozou introspects `COMMENT ON` text, view definitions, and type information from PostgreSQL, then hands them **verbatim** to AI agents through `@kozou/mcp`. This relies on an important assumption: **schema authors (the principals with permission to edit DB schema) are trusted**. We call this the trust boundary.

Designs where tenants in a multi-tenant SaaS can edit DB COMMENT text are **discouraged** (prompt-injection risk). See [docs/security.md](docs/security.md) for the threat model and mitigation plans, and [SECURITY.md](SECURITY.md) if you need to report a vulnerability privately.

On the access-control axis, **Kozou is a resource server and enforcement layer, not an identity provider**: with auth enabled it verifies the JWT on each request that carries one — with an optional anonymous-role path for tokenless requests — and runs each under a PostgreSQL role so your own RLS policies decide access. Identity provision (registration, login, passwords and OAuth, token issuance) is delegated to an external provider — Supabase Auth (recommended), Auth0 / Clerk via JWKS, or a minimal self-hosted issuer. See [docs/security.md](docs/security.md#authentication-and-authorization).

## Requirements

Runtime requirements for v1.4.0:

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
- Beyond v1.4: the MCP `call` (execution) tool — letting an AI agent *run* an exposed action, not just describe it; React UI exploration

## Name

**Kozou** carries three meanings in three syllables:

- *kozō* (calf) — the young elephant walking beside PostgreSQL's mascot Slonik
- *kōzō* (structure) — the structural transformation a compiler performs
- *kozō* (apprentice) — the quiet figure who serves something larger than itself

## License

Apache 2.0
