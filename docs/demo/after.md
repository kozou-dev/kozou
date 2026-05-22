# After — AI output with COMMENT + VIEW (placeholder)

このファイルは Step 4-B で実 AI 出力 (Claude Code + With COMMENT MCP) を
貼り付ける placeholder です。

実証手順は [README.md](README.md) を参照。

## 期待される成功パターン (dev_spec §11.2)

- `vw_inventory_for_sale` を起点に SELECT
- `GROUP BY artist_name` (VIEW に既存、再 JOIN 不要)
- `@ai:` tag (`aiNotes`) で `deleted_at` / `visibility` の正しい扱いを示唆

実出力はここに貼り付けられる予定 (Step 4-B)。

(demo-recheck.yml は本ファイルに `vw_inventory_for_sale` / `GROUP BY` / `artist_name`
キーワードを含むかを週次で grep 検証する予定、Step 4-B commit と同時に追加)
