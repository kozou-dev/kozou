# Prompt: 販売可能在庫を作家別に集計する API エンドポイント

Kozou v0.1 spec §11.1 シナリオ。MCP 接続済みの状態 (または未接続の対照群) で以下の
プロンプトを Claude Code に投げる:

---

販売可能在庫を作家別に集計する API エンドポイントを書いてください。
Node.js + Express + node-postgres で実装してください。
レスポンスは `[{ artist_name, for_sale_count }]` の JSON 配列で、
販売可能在庫数の降順でソートしてください。

---

## 期待される対比 (Kozou v0.1 spec §11.2)

### Before (COMMENT なし、素の DDL のみ — `scripts/demo/nimart-no-comment.sql`)

予想される AI 出力の典型的失敗:
- `inventory_items.status = 'sale'` のような誤った値を使用 (実際は `for_sale`)
- `deleted_at IS NULL` の付け忘れ
- `artworks.artist_name` のような存在しないカラム名の捏造
  (実際は `artworks.title` + `artists.display_name` の JOIN が必要)
- `visibility = 'public'` 付け忘れ
- 必要な JOIN 不足 / 過剰

### After (COMMENT + VIEW あり — `examples/nimart/migrations/0001_init.sql`)

期待される AI 出力の典型的成功:
- `vw_inventory_for_sale` を起点に SELECT
  (`get_concept_context('vw_inventory_for_sale')` の preferredQuerySource ヒント)
- `GROUP BY artist_name` (VIEW に既に存在するため再 JOIN 不要)
- `deleted_at` / `visibility` の処理を MCP の `aiNotes` 経由で正しく扱う
  (`@ai: 販売可能在庫の抽出には vw_inventory_for_sale を優先利用すること`)

## 実証手順 (Kozou v0.1 spec §11.3)

1. `bash scripts/demo/run-comparison.sh` で 2 つの PostgreSQL container を起動
2. Claude Code を開いて Without COMMENT 用の MCP server に接続
   (`KOZOU_DATABASE_URL=postgres://postgres:demo@localhost:5500/postgres`)
3. 上記プロンプトを投げる → 出力を `docs/demo/before.md` にコピー
4. Claude Code を再起動して With COMMENT 用の MCP server に接続
   (`KOZOU_DATABASE_URL=postgres://postgres:demo@localhost:5501/postgres`)
5. 同じプロンプトを投げる → 出力を `docs/demo/after.md` にコピー
6. `docs/demo/transcript.md` に prompt + 観察される差分の説明を追記
7. cleanup: `docker stop kozou-demo-without kozou-demo-with`

最低 3 回独立実行で「演出」でないことを確認 (Kozou v0.1 spec §18.6)。
