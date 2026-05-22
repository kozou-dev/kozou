# Before — AI output without COMMENT (placeholder)

このファイルは Step 4-B で実 AI 出力 (Claude Code + Without COMMENT MCP) を
貼り付ける placeholder です。

実証手順は [README.md](README.md) を参照。

## 期待される失敗パターン (Kozou v0.1 spec §11.2)

- `inventory_items.status = 'sale'` のような誤った値
- `deleted_at IS NULL` の付け忘れ
- `artworks.artist_name` のような存在しないカラム名の捏造
- `visibility = 'public'` 付け忘れ
- 必要な JOIN 不足 / 過剰

実出力はここに貼り付けられる予定。
