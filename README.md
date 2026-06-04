# kozou

PostgreSQL compiler. One source, many faithful forms.

Kozou reads a PostgreSQL schema once and produces every form a modern team and its AI need from it — admin UI, MCP context, TypeScript types, GraphQL endpoints, and documentation. No duplicate definitions. No drift.

## Status

v0.2.1 (latest release). The CLI, schema introspection, MCP server (stdio + HTTP), reference Admin UI, and Markdown schema-document generation (`kozou docs`) are all available on npm; the runtime image lives on GHCR as a multi-arch manifest (linux/amd64 + linux/arm64). Releases land via the workflow in `.github/workflows/release.yml`.

## Quickstart

```bash
# Scaffold a project (docker-compose + kozou.config.yaml + ui-hints.yaml).
# `create-kozou` ships as a secondary bin of the `kozou` package, so npx
# needs `-p kozou` to find it on a clean machine.
npx -p kozou create-kozou my-project
cd my-project

# Bring up PostgreSQL, the REST layer, and the Admin UI. The
# scaffold's docker-compose includes a `kozou` service that runs
# `kozou dev` (the bundled SvelteKit Admin UI + MCP HTTP server),
# so `docker compose up` brings the full stack online.
cp .env.example .env
docker compose up
```

Or pull the CLI runtime image directly:

```bash
docker pull ghcr.io/kozou-dev/kozou:v0.2.1
docker run --rm ghcr.io/kozou-dev/kozou:v0.2.1 inspect --help
docker run --rm ghcr.io/kozou-dev/kozou:v0.2.1 mcp --help
```

For library use (custom hosts, embedded MCP), install the workspace packages from npm:

```bash
npm install kozou @kozou/core @kozou/introspect @kozou/mcp @kozou/svelte-ui
```

The experimental `@kozou/api` REST layer and `@kozou/codegen` TypeScript codegen ship as optional companions (the wire format and output may change without notice). Install them alongside `kozou` only when you want `kozou dev --adapter api` or `kozou codegen`:

```bash
npm install kozou @kozou/api @kozou/codegen
```

## Security

Kozou introspects `COMMENT ON` text, view definitions, and type information from PostgreSQL, then hands them **verbatim** to AI agents through `@kozou/mcp`. This relies on an important assumption: **schema authors (the principals with permission to edit DB schema) are trusted**. We call this the trust boundary.

Designs where tenants in a multi-tenant SaaS can edit DB COMMENT text are **discouraged in v0.1** (prompt-injection risk). See [docs/security.md](docs/security.md) for the threat model and mitigation plans, and [SECURITY.md](SECURITY.md) if you need to report a vulnerability privately.

## Requirements

Runtime requirements for v0.2.1:

- **PostgreSQL 16 or later** — the canonical source of truth
- **Docker 24 or later** (optional) — recommended for the `docker compose up` stack, which brings up PostgreSQL, PostgREST, and a `kozou` service running `kozou dev` (the bundled Admin UI + MCP HTTP server) from `ghcr.io/kozou-dev/kozou:v0.2.1` (a multi-arch image, native on linux/amd64 and linux/arm64). PostgREST stays a side-by-side container and is **not** bundled inside the Kozou image.
- **Node.js 20 or later** — for running the npm-published packages directly (`npx kozou …`)

Contributors additionally need **pnpm 9 or later**. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development environment setup.

## Roadmap

- v0.1.0 (shipped): schema introspection, MCP server (stdio), reference Admin UI, `create-kozou` scaffold, PostgREST adapter
- v0.1.1 (shipped): MCP HTTP transport, `kozou dev` host integration, multi-arch Docker image (linux/amd64 + linux/arm64), Playwright E2E for the Admin UI, CodeQL reactivation, zod 4 / TypeScript 6 migration
- v0.2.0 (shipped): `kozou docs` Markdown schema documents; `@policy` advisory metadata surfaced to AI agents through the MCP server
- v0.2.1 (shipped): multi-line `@ai` / `@policy` COMMENT blocks are now captured in full (not just the first line) in the MCP describe tools and `@kozou/api` OpenAPI; the experimental `@kozou/api` REST layer — with multi-hop relation embedding and opt-in JWT + Postgres RLS — and `@kozou/codegen` TypeScript row types are now published to npm as optional companions, exercised via `kozou dev --adapter api` and `kozou codegen`
- v1.0: make `@kozou/api` the default and drop the PostgREST dependency; React UI exploration

## Name

**Kozou** carries three meanings in three syllables:

- *kozō* (calf) — the young elephant walking beside PostgreSQL's mascot Slonik
- *kōzō* (structure) — the structural transformation a compiler performs
- *kozō* (apprentice) — the quiet figure who serves something larger than itself

## License

Apache 2.0
