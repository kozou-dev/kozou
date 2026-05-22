# Comparison Demo

`kozou` の核心: PostgreSQL スキーマに `COMMENT ON` と `CREATE VIEW` を書くだけで、
AI agent が業務概念を理解した SQL を生成できる。

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

### 2. Without COMMENT 版 MCP server を起動

別ターミナルで:

```bash
bash scripts/demo/run-comparison.sh mcp-without
```

### 3. Claude Code (別 session) で MCP 接続 + prompt 投入

Claude Code の MCP 設定で `KOZOU_DATABASE_URL=postgres://postgres:demo@localhost:5500/postgres`
に接続。`scripts/demo/prompts/01-sales-by-artist.md` の prompt 本文を投入。

得られた AI 出力 (思考プロセス含む) を `docs/demo/before.md` に貼り付け。

### 4. With COMMENT 版 MCP server を起動 (Without を Ctrl+C で止めてから)

```bash
bash scripts/demo/run-comparison.sh mcp-with
```

### 5. Claude Code を再起動 + With COMMENT MCP に接続 + 同じ prompt

`KOZOU_DATABASE_URL=postgres://postgres:demo@localhost:5501/postgres` に接続。
同じ prompt を投入。

得られた AI 出力を `docs/demo/after.md` に貼り付け。

### 6. transcript.md を更新

`docs/demo/transcript.md` に prompt + 両出力サマリ + 観察される差分を記録。

### 7. cleanup

```bash
bash scripts/demo/run-comparison.sh stop
```

### 8. 再現性検証 (最低 3 回独立実行)

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
