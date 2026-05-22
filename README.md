# kozou

PostgreSQL compiler. One source, many faithful forms.

Kozou reads a PostgreSQL schema once and produces every form a modern team and its AI need from it — admin UI, MCP context, TypeScript types, GraphQL endpoints, and documentation. No duplicate definitions. No drift.

## Status

Pre-release (v0.0.x). Core architecture and public API are being designed. Source code and documentation will land in this package as development proceeds.

## Comparison Demo

`kozou` の核心: PostgreSQL スキーマに `COMMENT ON` と `CREATE VIEW` を書くだけで、
AI agent (Claude Code 経由) が業務概念を理解した SQL を生成できる。

- 実証手順: [docs/demo/README.md](docs/demo/README.md)
- 静的 transcript: [docs/demo/transcript.md](docs/demo/transcript.md)
- Before (COMMENT なし): [docs/demo/before.md](docs/demo/before.md)
- After (COMMENT あり): [docs/demo/after.md](docs/demo/after.md)

シナリオ: 「販売可能在庫を作家別に集計する API エンドポイント」
(Kozou v0.1 spec §11.1)。Setup script: `bash scripts/demo/run-comparison.sh setup`。

v0.1 では静的 transcript で実証。動画化は v0.1.1 以降。

## Security

Kozou は PostgreSQL の `COMMENT ON` / VIEW 定義 / 型情報を introspect し、
`@kozou/mcp` 経由で AI agent に **そのまま** context として渡す。
これにより重要な前提: **schema author (DB schema 編集権限保有者) は trusted** という
trust boundary を採用する。

Multi-tenant SaaS で tenant が DB COMMENT を編集できる設計は **v0.1 では非推奨**
(prompt injection リスク)。詳細・mitigation 計画は [docs/security.md](docs/security.md) 参照。

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

- **子象** (*kozō*) — the young elephant; the calf walking beside PostgreSQL's mascot Slonik
- **構造** (*kōzō*) — structure; the structural transformation a compiler performs
- **小僧** (*kozō*) — the apprentice; the quiet figure who serves something larger than itself

## License

Apache 2.0
