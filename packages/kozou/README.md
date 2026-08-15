# kozou

CLI entry point for [Kozou](https://kozou.org): scaffolding,
schema introspection, and MCP server hand-off. See the Commands
section below for the full command surface.

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
`server.mcp.http` in the config, or turn the MCP endpoint off with
`server.mcp.http.enabled: false`); `Ctrl-C` (SIGINT / SIGTERM)
tears them down. This is the command behind the `kozou` service in
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

The generated `docker-compose.yml` brings up PostgreSQL and a `kozou`
service that runs `kozou dev` to host the Admin UI, the MCP HTTP
server, and Kozou's in-house REST backend (in-process) — no separate
REST container by default. To opt out and use an external PostgREST
instead, set `adapter.type: postgrest` and enable the commented service
in the scaffold's `docker-compose.yml`.

## Configuration

`kozou.config.yaml` (template in `dist/templates/`) drives every
command:

```yaml
database:
  url: ${DATABASE_URL}
  schemas: [public]

adapter:
  # Default: Kozou's in-house REST backend, served in-process by
  # `kozou dev`. Set type: postgrest (with url) to use external PostgREST.
  type: api

uiHints:
  path: ./ui-hints.yaml
```

The full schema also accepts `server.ui.{port,host}`,
`server.mcp.http.{enabled,port,host,advertisedUrl}`, `server.mcp.stdio`,
and `cache.ttlMs` overrides; defaults match the template that
`create-kozou` writes. `server.mcp.http.advertisedUrl` is the address
MCP clients reach the endpoint at when that is not the port it binds —
a remapped published port, a tunnel, a devcontainer, a proxy — and is
what the Admin UI's "Connect an AI agent" page hands out instead of
building one from the browser's host (`KOZOU_MCP_HTTP_ADVERTISED_URL`
sets it from the environment). `server.mcp.http.enabled: false` turns the
MCP HTTP endpoint off entirely — `kozou dev` then starts no MCP
listener and serves only the Admin UI and whichever data backend you
configured, and `kozou mcp --http` refuses rather than contradicting
the config (stdio is unaffected).
It can also be set as `KOZOU_MCP_HTTP_ENABLED` in the environment,
which is how the scaffolded compose stack reaches it — that stack
mounts no config file. The value must read as `true` or `false` (case and
surrounding whitespace are ignored); anything else is refused at
startup rather than guessed at.
The Admin UI follows suit when `kozou dev` spawns it: its "Connect
an AI agent" page and both links to it are gone, so nothing hands
out connection instructions for an endpoint that is not listening.
The same channel carries how a live endpoint authenticates, so the
page describes the posture it is actually in — with
`server.mcp.http.auth` set it says the endpoint is an OAuth 2.1
protected resource instead of claiming there is no authentication,
and it hands out that block's `resource` URI as the address to
register instead of guessing one from the browser's host (which is
wrong behind the proxy that `resource` exists for). The client config
keeps the same shape either way: one URL, no secret.
(A UI you start yourself with `node build/index.js` never reads the
config; pass `KOZOU_UI_MCP_POSTURE=off` to it directly, or it keeps
advertising the default endpoint.) `${VAR}` and
`${VAR:-default}` are expanded from the process environment at load
time — expansion cannot set this one, since it yields a string and
the field is a boolean.

### Choosing a backend

By default the Admin UI runs against **Kozou's in-house REST backend**
(`@kozou/api`), served in-process by `kozou dev` — no extra container. To use
an external **PostgREST** instead, set `adapter.type: postgrest` (with its
`url`) or pass `kozou dev --adapter postgrest`, and run a PostgREST instance
(the scaffold's `docker-compose.yml` ships a commented service for it). For
which relational-REST features the in-house backend covers by default and
which to keep PostgREST for, see the scope table in the `@kozou/api` README.

> **Migrating from v0.2.x:** the default backend changed from PostgREST to the
> in-house `@kozou/api` in v1.0. Projects that relied on the PostgREST default
> keep working by setting `adapter.type: postgrest` in `kozou.config.yaml`
> (the value the old scaffold wrote) — nothing else changes.

### Authentication (in-house API backend)

> The in-house `@kozou/api` backend is bundled with the `kozou` CLI and is the
> default `kozou dev` data backend. Its wire format and OpenAPI are a stable
> contract as of v1.0. The settings below apply to that backend; the external
> PostgREST opt-out is unaffected.

By default the in-house `@kozou/api` backend (`kozou dev`)
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
    claims:                            # extra claims minted into the UI token (HS256)
      tenant_id: acme                  #   for RLS policies reading request.jwt.claims
    # token: ${KOZOU_ADAPTER_TOKEN}    # RS256 / external IdP: supply a token instead
```

Provide exactly one of `jwt.secret` (HS256), `jwt.publicKey` (RS256), or
`jwt.jwksUri` (a provider's remote JWKS endpoint — keys are selected by `kid`,
cached, and refreshed on rotation).

With no `auth:` block, the section is built instead from
`KOZOU_JWT_SECRET` / `KOZOU_JWT_PUBLIC_KEY` / `KOZOU_JWT_JWKS_URI` /
`KOZOU_JWT_ALGORITHMS` / `KOZOU_JWT_ISSUER` / `KOZOU_JWT_AUDIENCE` /
`KOZOU_JWT_ROLE_CLAIM` / `KOZOU_JWT_ALLOWED_ROLES` / `KOZOU_JWT_DEFAULT_ROLE` /
`KOZOU_JWT_ANON_ROLE` / `KOZOU_UI_ROLE` / `KOZOU_UI_CLAIMS` /
`KOZOU_ADAPTER_TOKEN` (algorithms and roles are comma-separated;
`KOZOU_UI_CLAIMS` takes a JSON object and fails loudly at startup when
malformed). A role outside `allowedRoles` gets `403`. A request with
no token gets `401` unless `anonRole` is set, in which case it runs under
that role and your RLS policies decide what it sees (a present but invalid
token is always `401`). The login role of `database.url` must be `GRANT`ed
membership in every allowed role, and in `anonRole` when set.

#### The bundled Admin UI

The Admin UI calls `@kozou/api` server-side, so when `auth` is on it must
send a token too. Under **HS256** the CLI mints one for the UI claiming
`auth.ui.role` (or, if unset, no role — the API then applies `defaultRole`);
set `auth.ui.role` to the role the console should run as. RLS policies
usually need more than the role: `auth.ui.claims` (or `KOZOU_UI_CLAIMS`,
a JSON object) merges extra claims — a tenant id, an operator flag — into
the minted token, where `request.jwt.claims` makes them visible to your
policies. The merge is flat: the role claim is always controlled by
`auth.ui.role` (a colliding key is dropped with a startup warning), and
`iat` / configured `iss` / `aud` win likewise. These are *service-token*
claims — everyone who can reach the UI port acts with them. Under
**RS256** or an external identity provider the CLI cannot mint, so supply
a ready-made token via `auth.ui.token` (or the `KOZOU_ADAPTER_TOKEN` env);
without it the UI is rejected with `401` and the CLI logs how to fix it
(`auth.ui.claims` only applies to tokens the CLI mints itself).
The minted role must satisfy `allowedRoles` or the UI gets `403`.

#### Privilege-aware introspection (opt-in)

By default the Admin UI reflects what the schema *declares*, not what the
serving role may *do* with it — so a column protected by a column-level
`GRANT` still renders editable (the write then fails at save), and a table
the role cannot read still appears in the nav (opening it errors). Set:

```yaml
introspection:
  respectPrivileges: true   # default false
  # role: app_user          # optional; defaults to auth.ui.role / auth.defaultRole
```

and the UI's introspection evaluates the serving role's privileges
(`has_table_privilege` / `has_column_privilege`, gated by schema `USAGE`) and
folds them in **per form mode**: on the edit form a column the role cannot
`UPDATE` renders **read-only**; on the create form a column it cannot `INSERT`
renders read-only (so a write-once column with `INSERT` but no `UPDATE` is
editable on create and locked on edit, and vice versa). A table **or view** the
role cannot `SELECT` is **hidden** from the nav and resource list (a startup
line names what was hidden). The role evaluated is the Admin UI's
(`auth.ui.role`, else `auth.defaultRole`); set `introspection.role` to override.
When the UI uses a **ready-made token** (`auth.ui.token` / `KOZOU_ADAPTER_TOKEN`,
the RS256 / external-IdP path) you must set `introspection.role` explicitly —
the CLI cannot read the token's role, so it will not guess. This shapes the
**Admin UI** only — `@kozou/api` and the MCP server stay schema-wide (the API
enforces per request through the database; the MCP server intentionally
describes the whole schema). Per-request, per-role surfaces for direct API
consumers are a future refinement.

## License

Apache 2.0. See [LICENSE](../../LICENSE) at the repository root.
