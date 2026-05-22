# Comparison Demo

`kozou` の核心: PostgreSQL スキーマに `COMMENT ON` と `CREATE VIEW` を書くだけで、
AI agent が業務概念を理解した SQL を生成できる。

> **Demo-only credentials**: 本書中の `postgres:demo@localhost:5500/postgres` 等は
> **demo 専用 password で、production では絶対に使わないこと**。`scripts/demo/run-comparison.sh`
> は `docker run --rm` で立ち上げ、即廃棄するため漏洩リスクは限定的。

このディレクトリは v0.1 DoD「サンプル業務スキーマで COMMENT あり/なしの AI 出力差を
示す」(Kozou v0.1 spec §1.2) を **静的 transcript** で実証する。動画化は v0.1.1 以降。

## ファイル

| File | 内容 |
|---|---|
| `README.md` | 本書 (再現手順) |
| `transcript.md` | 実証セッションの完全記録 (prompt + 両出力 + 観察される差分) |
| `before.md` | COMMENT なし版 DB に対する AI 出力 (典型的失敗パターン) |
| `after.md` | COMMENT + VIEW あり版 DB に対する AI 出力 (起点 VIEW を使う成功パターン) |

## 再現手順

### 前提

- Docker / Docker Desktop 起動済み
- Node.js 20+、pnpm 9+、本リポジトリのルートで `pnpm install` 済み
- Claude Code (本ホスト) インストール済み

### 1. 比較 DB を立てる

```bash
bash scripts/demo/run-comparison.sh setup
```

これで 2 つの PostgreSQL container (`kozou-demo-without` / `kozou-demo-with`) が
立ち上がり、それぞれに `scripts/demo/nimart-no-comment.sql` と
`examples/nimart/migrations/0001_init.sql` が流し込まれる。

### 2. `.mcp.json` を local 作成 + Claude Code から MCP 接続

リポジトリ root に `.mcp.json.example` (template) が含まれている。これを
local の `.mcp.json` に copy する (実体は `.gitignore` で git 管理外):

```bash
cd ~/projects/kozou
cp .mcp.json.example .mcp.json
```

`.mcp.json.example` には以下 2 つの MCP server が定義済み:

- `kozou-without`: COMMENT なし DB (`localhost:5500`)
- `kozou-with`: COMMENT 付き DB (`localhost:5501`)

> **Demo-only credentials**: `.mcp.json.example` 内の `postgres:demo@localhost`
> は **demo 専用 password** で、production では絶対に使わないこと。
> `scripts/demo/run-comparison.sh setup` で立てた docker container は `--rm` で
> 即廃棄される設計。

別 Claude Code session を kozou repo のルートディレクトリで起動すると、
`.mcp.json` を自動 detect し、両 MCP server が利用可能になる:

```bash
cd ~/projects/kozou
claude  # 別ターミナルで起動
```

Claude Code が `kozou-without` / `kozou-with` MCP server を自動 spawn する。
ターミナルで `bash scripts/demo/run-comparison.sh mcp-without` を手動起動する
必要は **無い** (subcommand は debug 用、Claude Code は子プロセスで spawn
する仕組みのため手動起動 server には接続不可)。

### 3. Phase 1: Without COMMENT 版で実証

別 Claude Code session で、`kozou-without` MCP tools を使って以下の prompt を投入
(`scripts/demo/prompts/01-sales-by-artist.md` 参照):

> 販売可能在庫を作家別に集計する API エンドポイントを書いてください。
> Node.js + Express + node-postgres で実装してください。レスポンスは
> `[{ artist_name, for_sale_count }]` の JSON 配列で、販売可能在庫数の
> 降順でソートしてください。

明示的に「kozou-without の MCP tools のみ使って」と指示すると区別が明確。
得られた AI 出力 (思考プロセス + コード) を `docs/demo/before.md` に貼り付け。

### 4. Phase 2: With COMMENT 版で同じ prompt

同じ Claude Code session で、今度は `kozou-with` MCP tools を使って同じ
prompt を投入 (「kozou-with の MCP tools のみ使って」と明示)。

得られた AI 出力を `docs/demo/after.md` に貼り付け。

### 5. transcript.md を更新

`docs/demo/transcript.md` に prompt + 両出力サマリ + 観察される差分を記録。

### 6. cleanup

```bash
bash scripts/demo/run-comparison.sh stop
```

### 7. 再現性検証 (最低 3 回独立実行)

Kozou v0.1 spec §18.6 「AI 出力 non-deterministic」への対応として、上記手順を最低 3 回
独立して実行し、Before/After の差分が安定的に観察できることを確認する。

## 期待される対比 (Kozou v0.1 spec §11.2)

### Before (COMMENT なし)
- `inventory_items.status = 'sale'` のような誤った値 (実際は `for_sale`)
- `deleted_at IS NULL` の付け忘れ
- 存在しないカラム名の捏造 (`artworks.artist_name` 等)
- `visibility = 'public'` 付け忘れ
- 必要な JOIN 不足 / 過剰

### After (COMMENT + VIEW あり)
- `vw_inventory_for_sale` を起点 (MCP `get_concept_context` の preferredQuerySource)
- `GROUP BY artist_name` (VIEW に既存、再 JOIN 不要)
- `@ai:` tag が aiNotes 経由で AI に渡る (`deleted_at`/`visibility` の正しい扱い)

## 関連 spec

- Kozou v0.1 spec §1.2: v0.1 DoD
- Kozou v0.1 spec §11: 比較デモ仕様
- Kozou v0.1 spec §18.6: 比較デモ「演出化」リスク
