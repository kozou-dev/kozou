# Comparison Demo Transcript (placeholder)

このファイルは Step 4-B (ユーザー実証セッション) で更新する placeholder です。
現状の Step 4-A2 では `@kozou/mcp` + `scripts/demo/` の setup までを cover。
実 AI 投入と transcript 記録は別 Claude Code session で行う。

## Prompt

`scripts/demo/prompts/01-sales-by-artist.md` 参照。

## 実証日時

(未実施)

## 観察された差分サマリ

(未実施 — Step 4-B で記録)

## 詳細出力

- Before (COMMENT なし): [before.md](before.md)
- After (COMMENT あり): [after.md](after.md)

## Step 4-B 完了条件

- `before.md` / `after.md` に実 AI 出力が貼り付けられている
- 本ファイルに prompt + 観察される差分の説明が記録されている
- 最低 3 回独立実行で「演出」でないことを確認 (Kozou v0.1 spec §18.6)
- `.github/workflows/demo-recheck.yml` 週次 CI が追加される (Step 4-B commit と同時)
