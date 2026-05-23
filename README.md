# kozou

PostgreSQL compiler. One source, many faithful forms.

Kozou reads a PostgreSQL schema once and produces every form a modern team and its AI need from it — admin UI, MCP context, TypeScript types, GraphQL endpoints, and documentation. No duplicate definitions. No drift.

## Status

Pre-release (v0.0.x). Core architecture and public API are being designed. Source code and documentation will land in this package as development proceeds.

## Security

Kozou introspects `COMMENT ON` text, view definitions, and type information from PostgreSQL, then hands them **verbatim** to AI agents through `@kozou/mcp`. This relies on an important assumption: **schema authors (the principals with permission to edit DB schema) are trusted**. We call this the trust boundary.

Designs where tenants in a multi-tenant SaaS can edit DB COMMENT text are **discouraged in v0.1** (prompt-injection risk). See [docs/security.md](docs/security.md) for details and mitigation plans.

## Requirements

When Kozou v0.1 lands, the runtime requirements will be:

- **PostgreSQL 16 or later** — the canonical source of truth
- **Docker 24 or later** — recommended for the bundled `docker compose up` stack (PostgreSQL + PostgREST + Kozou); PostgREST is run as a side-by-side container and is **not** bundled inside the Kozou image
- **Node.js 20 or later** — only when running Kozou directly from npm rather than the prebuilt Docker image

Contributors additionally need **pnpm 9 or later**. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development environment setup.

## Roadmap

- v0.1: schema reader (DDL + comments + constraints)
- v0.2: TypeScript type emitter
- v0.3: MCP context emitter
- v0.4: admin UI scaffolder
- v0.5: GraphQL endpoint emitter
- v0.6: documentation emitter

## Name

**Kozou** carries three meanings in three syllables:

- *kozō* (calf) — the young elephant walking beside PostgreSQL's mascot Slonik
- *kōzō* (structure) — the structural transformation a compiler performs
- *kozō* (apprentice) — the quiet figure who serves something larger than itself

## License

Apache 2.0
