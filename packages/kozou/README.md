# kozou

CLI entry point for [Kozou](https://kozou.org): scaffolding,
schema introspection, and MCP server hand-off. See *Kozou v0.1
design spec* §9 for the command surface.

## Install

```bash
# Global, so the bin entries are on PATH
npm install -g kozou

# Or use npx without installing
npx kozou inspect --help
npx create-kozou my-project
```

The package publishes through `./dist/`. `bin` exposes two entries:

- `kozou` - the main multi-command CLI (`inspect` / `mcp` / `dev`)
- `create-kozou` - scaffolds a project directory with
  `docker-compose.yml`, `kozou.config.yaml`, `ui-hints.yaml`,
  `env.example`, and a starter migration

## Commands

### `kozou inspect`

Introspects the configured PostgreSQL database and emits a Schema
Context to stdout (or `--output <path>`):

```bash
KOZOU_DATABASE_URL=postgres://kozou:kozou@localhost:5432/kozou \
  kozou inspect --format yaml > schema.yaml
```

### `kozou mcp --stdio`

Starts an MCP server over stdio so Claude Code / other AI agents
can call the introspect / describe-table tools:

```bash
KOZOU_DATABASE_URL=postgres://kozou:kozou@localhost:5432/kozou \
  npx kozou mcp --stdio
```

HTTP transport (`--http`) is reserved for v0.1.1.

### `kozou dev`

Reserved for v0.1.1. In v0.1 the command prints a hand-off message
pointing at `docker compose up` for now; in v0.1.1 it will spawn
the bundled `@kozou/svelte-ui` Admin UI + an MCP HTTP server.

### `create-kozou <dir>`

Scaffolds a project directory at `<dir>` from the templates
bundled in `dist/templates/`:

```bash
npx create-kozou my-project
cd my-project
cp .env.example .env
docker compose up
```

The generated `docker-compose.yml` wires up PostgreSQL +
PostgREST + the kozou Admin UI image
(`ghcr.io/kozou-dev/kozou:v0.1.0`).

## Configuration

`kozou.config.yaml` (template in `dist/templates/`) drives every
command:

```yaml
database:
  url: ${KOZOU_DATABASE_URL}
adapter:
  type: postgrest
  url: ${KOZOU_ADAPTER_URL}
schemas:
  - public
ui_hints:
  path: ./ui-hints.yaml
```

`${VAR}` and `${VAR:-default}` are expanded from the environment.

## License

Apache 2.0. See [LICENSE](../../LICENSE) at the repository root.
