# kozou

PostgreSQL compiler. One source, many faithful forms.

Kozou reads a PostgreSQL schema once and produces every form a modern team and its AI need from it — admin UI, MCP context, TypeScript types, GraphQL endpoints, and documentation. No duplicate definitions. No drift.

## Status

v0.1.0 (initial public release). The CLI, schema introspection, MCP server, and reference Admin UI are all available on npm; the runtime image lives on GHCR. Subsequent v0.1.x releases land via the workflow in `.github/workflows/release.yml`.

## Quickstart

```bash
# Scaffold a project (docker-compose + kozou.config.yaml + ui-hints.yaml).
# `create-kozou` ships as a secondary bin of the `kozou` package, so npx
# needs `-p kozou` to find it on a clean machine.
npx -p kozou create-kozou my-project
cd my-project

# Bring up PostgreSQL + PostgREST. The Admin UI host integration
# (`kozou dev` spawning the bundled SvelteKit + MCP HTTP server)
# lands in v0.1.1, so the scaffold's docker-compose currently only
# brings the database + REST layer online and the `kozou` service
# block is commented out.
cp .env.example .env
docker compose up
```

Or pull the CLI runtime image directly:

```bash
docker pull ghcr.io/kozou-dev/kozou:v0.1.0
docker run --rm ghcr.io/kozou-dev/kozou:v0.1.0 inspect --help
docker run --rm ghcr.io/kozou-dev/kozou:v0.1.0 mcp --help
```

For library use (custom hosts, embedded MCP), install the workspace packages from npm:

```bash
npm install kozou @kozou/core @kozou/introspect @kozou/mcp @kozou/svelte-ui
```

## Security

Kozou introspects `COMMENT ON` text, view definitions, and type information from PostgreSQL, then hands them **verbatim** to AI agents through `@kozou/mcp`. This relies on an important assumption: **schema authors (the principals with permission to edit DB schema) are trusted**. We call this the trust boundary.

Designs where tenants in a multi-tenant SaaS can edit DB COMMENT text are **discouraged in v0.1** (prompt-injection risk). See [docs/security.md](docs/security.md) for details and mitigation plans.

## Requirements

Runtime requirements for v0.1.0:

- **PostgreSQL 16 or later** — the canonical source of truth
- **Docker 24 or later** (optional) — recommended for the v0.1.0 `docker compose up` stack, which currently brings up PostgreSQL + PostgREST. The Kozou CLI ships separately as `ghcr.io/kozou-dev/kozou:v0.1.0`; the scaffold's `kozou` compose service is intentionally commented out until `kozou dev` host integration lands in v0.1.1. PostgREST stays a side-by-side container and is **not** bundled inside the Kozou image.
- **Node.js 20 or later** — for running the npm-published packages directly (`npx kozou …`)

Contributors additionally need **pnpm 9 or later**. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development environment setup.

## Roadmap

- v0.1 (shipped): schema introspection, MCP server (stdio), reference Admin UI, `create-kozou` scaffold, PostgREST adapter
- v0.1.1: MCP HTTP transport, `kozou dev` host integration, Playwright E2E for the Admin UI, CodeQL reactivation
- v0.2: `@kozou/api` (in-house REST), COMMENT tag policy hardening, TypeScript type generation, React UI exploration
- v1.0: drop the PostgREST dependency, ship JWT + RLS integration, multi-hop relation embedding, business-document emitters (Markdown / HTML)

## Name

**Kozou** carries three meanings in three syllables:

- *kozō* (calf) — the young elephant walking beside PostgreSQL's mascot Slonik
- *kōzō* (structure) — the structural transformation a compiler performs
- *kozō* (apprentice) — the quiet figure who serves something larger than itself

## License

Apache 2.0
