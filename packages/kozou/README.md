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

- `kozou` - the main multi-command CLI (`inspect` / `docs` / `mcp` / `dev`)
- `create-kozou` - scaffolds a project directory with
  `docker-compose.yml`, `kozou.config.yaml`, `ui-hints.yaml`,
  `env.example`, and a starter migration

## Commands

### `kozou inspect`

Introspects the configured PostgreSQL database and emits a Schema
Context to stdout (or `--output <path>`):

```bash
DATABASE_URL=postgres://kozou:kozou@localhost:5432/kozou \
  kozou inspect --format yaml > schema.yaml
```

### `kozou docs`

Generates a single Markdown schema document from the database DDL +
`COMMENT` metadata to stdout (or `--output <path>`):

```bash
DATABASE_URL=postgres://kozou:kozou@localhost:5432/kozou \
  kozou docs --output schema.md
```

### `kozou mcp --stdio`

Starts an MCP server over stdio so Claude Code / other AI agents
can call the introspect / describe-table tools:

```bash
DATABASE_URL=postgres://kozou:kozou@localhost:5432/kozou \
  npx kozou mcp --stdio
```

The `${DATABASE_URL}` placeholder inside the bundled
`kozou.config.yaml` template is what consumes that env var; the
`kozou` CLI does not honor `KOZOU_DATABASE_URL` directly (an alias
is on the roadmap). HTTP transport is available via
`kozou mcp --http` (`--port` / `--host` configure the listener;
stdio stays the default).

### `kozou dev`

Runs the bundled `@kozou/svelte-ui` Admin UI (adapter-node)
alongside an MCP HTTP server, both wired up from
`kozou.config.yaml`. The Admin UI listens on port 3333 and the MCP
HTTP server on 3334 by default (override via `server.ui` /
`server.mcp.http` in the config); `Ctrl-C` (SIGINT / SIGTERM)
tears both down. This is the command behind the `kozou` service in
the scaffolded `docker-compose.yml`.

### `create-kozou <dir>`

Scaffolds a project directory at `<dir>` from the templates
bundled in `dist/templates/`:

```bash
npx -p kozou create-kozou my-project
cd my-project
cp .env.example .env
docker compose up
```

The generated `docker-compose.yml` brings up PostgreSQL, PostgREST,
and a `kozou` service that runs `kozou dev` to host the Admin UI +
MCP HTTP server.

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

### Authentication (experimental, `--adapter api`)

> **Experimental, optional companion.** The in-house `@kozou/api` backend is
> published to npm as an experimental preview (the API and wire format may
> change without notice). It is **not** bundled with the `kozou` CLI, so
> install it alongside `kozou` (`npm install kozou @kozou/api`) — or run from
> a source/workspace checkout. Without it, `kozou dev --adapter api` exits
> with an explicit error telling you to install it. The default `kozou dev`
> (PostgREST adapter) is unaffected.

By default the in-house `@kozou/api` backend (`kozou dev --adapter api`)
runs **unauthenticated** on loopback. Add an `auth` section to require a
signed JWT on every API request: kozou verifies the token, then runs each
request under `SET LOCAL ROLE <role-from-claim>` with the claims published
to PostgreSQL, so **your own row-level-security policies** decide what each
request can read and write.

```yaml
auth:
  jwt:
    secret: ${KOZOU_JWT_SECRET}        # HS256 — or publicKey (RS256), or jwksUri
    # publicKey: ${KOZOU_JWT_PUBLIC_KEY}
    # jwksUri: https://your-idp/.well-known/jwks.json  # Auth0 / Clerk / Supabase
    algorithms: [HS256]
    issuer: my-issuer                  # optional
    audience: my-api                   # optional
  roleClaim: role                      # claim naming the DB role (default: role)
  allowedRoles: [app_reader, app_admin] # only these roles may be assumed
  defaultRole: app_reader              # role when the token omits roleClaim
  anonRole: web_anon                   # role for requests with no token (else 401)
  ui:
    role: app_admin                    # role the bundled Admin UI runs as (HS256)
    # token: ${KOZOU_ADAPTER_TOKEN}    # RS256 / external IdP: supply a token instead
```

Provide exactly one of `jwt.secret` (HS256), `jwt.publicKey` (RS256), or
`jwt.jwksUri` (a provider's remote JWKS endpoint — keys are selected by `kid`,
cached, and refreshed on rotation).

With no `auth:` block, the section is built instead from
`KOZOU_JWT_SECRET` / `KOZOU_JWT_PUBLIC_KEY` / `KOZOU_JWT_JWKS_URI` /
`KOZOU_JWT_ALGORITHMS` / `KOZOU_JWT_ISSUER` / `KOZOU_JWT_AUDIENCE` /
`KOZOU_JWT_ROLE_CLAIM` / `KOZOU_JWT_ALLOWED_ROLES` / `KOZOU_JWT_DEFAULT_ROLE` /
`KOZOU_JWT_ANON_ROLE` / `KOZOU_UI_ROLE` / `KOZOU_ADAPTER_TOKEN` (algorithms
and roles are comma-separated). A role outside `allowedRoles` gets `403`. A request with
no token gets `401` unless `anonRole` is set, in which case it runs under
that role and your RLS policies decide what it sees (a present but invalid
token is always `401`). The login role of `database.url` must be `GRANT`ed
membership in every allowed role, and in `anonRole` when set.

#### The bundled Admin UI

The Admin UI calls `@kozou/api` server-side, so when `auth` is on it must
send a token too. Under **HS256** the CLI mints one for the UI claiming
`auth.ui.role` (or, if unset, no role — the API then applies `defaultRole`);
set `auth.ui.role` to the role the console should run as. Under **RS256**
or an external identity provider the CLI cannot mint, so supply a
ready-made token via `auth.ui.token` (or the `KOZOU_ADAPTER_TOKEN` env);
without it the UI is rejected with `401` and the CLI logs how to fix it.
The minted role must satisfy `allowedRoles` or the UI gets `403`.

## License

Apache 2.0. See [LICENSE](../../LICENSE) at the repository root.
