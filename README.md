# kozou

PostgreSQL compiler. One source, many faithful forms.

Kozou reads a PostgreSQL schema once and produces every form a modern team and its AI need from it — admin UI, MCP context, TypeScript types, GraphQL endpoints, and documentation. No duplicate definitions. No drift.

## Status

Pre-release (v0.0.x). Core architecture and public API are being designed. Source code and documentation will land in this package as development proceeds.

## Roadmap

- v0.1: schema reader (DDL + comments + constraints)
- v0.2: TypeScript type emitter
- v0.3: MCP context emitter
- v0.4: admin UI scaffolder
- v0.5: GraphQL endpoint emitter
- v0.6: documentation emitter

## Name

**Kozou** carries three meanings in three syllables:

- **子象** (*kozō*) — the young elephant; the calf walking beside PostgreSQL's mascot Slonik
- **構造** (*kōzō*) — structure; the structural transformation a compiler performs
- **小僧** (*kozō*) — the apprentice; the quiet figure who serves something larger than itself

## License

Apache 2.0
