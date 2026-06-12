# kozou

PostgreSQL compiler. One source, many faithful forms.

Kozou reads a PostgreSQL schema once and produces every form a modern team and its AI need from it — admin UI, MCP context, TypeScript types, GraphQL endpoints, and documentation. No duplicate definitions. No drift.

## Status

v1.1.1 (latest release). The CLI, schema introspection, MCP server (stdio + HTTP), reference Admin UI (now with composite-foreign-key support, including a composite relation picker in the create/edit forms), Markdown schema-document generation (`kozou docs`), and Kozou's in-house REST backend (`@kozou/api`, the default `kozou dev` data layer) are all available on npm; the runtime image lives on GHCR as a multi-arch manifest (linux/amd64 + linux/arm64). Releases land via the workflow in `.github/workflows/release.yml`.

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
docker pull ghcr.io/kozou-dev/kozou:v1.1.1
docker run --rm ghcr.io/kozou-dev/kozou:v1.1.1 inspect --help
docker run --rm ghcr.io/kozou-dev/kozou:v1.1.1 mcp --help
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

Runtime requirements for v1.1.1:

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
- Beyond v1.1: React UI exploration

## Name

**Kozou** carries three meanings in three syllables:

- *kozō* (calf) — the young elephant walking beside PostgreSQL's mascot Slonik
- *kōzō* (structure) — the structural transformation a compiler performs
- *kozō* (apprentice) — the quiet figure who serves something larger than itself

## License

Apache 2.0
