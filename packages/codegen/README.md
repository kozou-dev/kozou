# @kozou/codegen

> **Experimental.** API and output may change without notice
> while the package is stabilising.

Kozou's TypeScript codegen. Given a `SchemaContext` (from `@kozou/introspect`
+ `@kozou/core`), it emits one `export interface` per table and view —
the JSON row shape a client receives from `@kozou/api` — driven entirely by
your PostgreSQL DDL + `COMMENT` metadata.

This is the compiler-native half of Kozou's type story. It is a pure,
offline function — no database connection or running API is required to
generate the row types.

## Scope

Row / entity shapes only. The full API client surface (paths, query
parameters, request/response envelopes, pagination, embeds) is better served
by running an OpenAPI generator such as
[`openapi-typescript`](https://github.com/openapi-ts/openapi-typescript)
against `@kozou/api`'s `GET /openapi.json`, so this package does **not**
reimplement that.

## Type mapping

Interfaces describe the JSON shape returned by `@kozou/api` (node-postgres
defaults, after JSON serialization):

- `numeric` / `bigint` → `string` (precision is preserved as text)
- date / time / timestamp → `string` (ISO 8601)
- `json` / `jsonb` → `unknown`
- array columns → `T[]`
- `CHECK (... IN (...))` / enum types → an inline string-literal union
- anything unrecognised → `unknown`
- nullable columns → `| null`

## Library use

```ts
import { emitRowTypes } from '@kozou/codegen';

// `schema` is a SchemaContext from @kozou/introspect + @kozou/core.
const ts = emitRowTypes(schema);            // pass { header: false } to drop the banner
```

## CLI

The `kozou` CLI drives `emitRowTypes` through `kozou codegen`. This package
is an **optional companion** — it is not bundled with the `kozou` CLI — so
install it alongside `kozou` (or run from a source / workspace checkout):

```bash
npm install kozou @kozou/codegen

DATABASE_URL=postgres://kozou:kozou@localhost:5432/kozou \
  kozou codegen --output src/db-types.ts
```

`--output -` (the default) writes to stdout; `--config <path>` points at a
`kozou.config.yaml`. Without `@kozou/codegen` installed, `kozou codegen`
exits with a message telling you to install it.

## License

Apache 2.0
