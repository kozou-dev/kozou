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

# `create-kozou` is a secondary bin shipped by the `kozou` package
# (not a standalone npm package), so npx needs `-p kozou` to find
# it on a machine that has not installed kozou globally yet.
npx -p kozou create-kozou my-project
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
npx -p kozou create-kozou my-project
cd my-project
cp .env.example .env
docker compose up
```

The generated `docker-compose.yml` brings up PostgreSQL + PostgREST.
The `kozou` service block (which would host the Admin UI + MCP HTTP
server) is commented out in v0.1.0; it gets reactivated in v0.1.1
once `kozou dev` ships as a real implementation rather than a
hand-off placeholder.

## Configuration

`kozou.config.yaml` (template in `dist/templates/`) drives every
command:

```yaml
database:
  url: ${DATABASE_URL}
  schemas: [public]

adapter:
  type: postgrest
  url: ${KOZOU_ADAPTER_URL:-http://postgrest:3000}

uiHints:
  path: ./ui-hints.yaml
```

The full schema also accepts `server.ui.{port,host}`,
`server.mcp.http.{port,host}`, `server.mcp.stdio`, and
`cache.ttlMs` overrides; defaults match the template that
`create-kozou` writes. `${VAR}` and `${VAR:-default}` are
expanded from the process environment at load time.

## License

Apache 2.0. See [LICENSE](../../LICENSE) at the repository root.
