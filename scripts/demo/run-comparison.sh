#!/usr/bin/env bash
# kozou v0.1 比較デモ setup (dev_spec §11)
#
# 2 つの PostgreSQL container を立てて、それぞれに nimart 全 DDL (COMMENT 付き)
# と nimart-no-comment.sql (COMMENT 削除版) を流す。各 DB に対応する @kozou/mcp
# server を起動 (stdio mode、フォアグラウンドで)。
#
# AI への prompt 投入は Claude Code で手動 (dev_spec §11.4 「実証してから映像化」)。
# 結果を docs/demo/{before,after}.md に貼り付け、docs/demo/transcript.md を
# 更新する。
#
# 使い方:
#   $ bash scripts/demo/run-comparison.sh setup    # PG 2 個と DDL を準備
#   $ bash scripts/demo/run-comparison.sh stop     # cleanup
#   $ bash scripts/demo/run-comparison.sh mcp-without  # Without COMMENT MCP server を立ち上げ
#   $ bash scripts/demo/run-comparison.sh mcp-with     # With COMMENT MCP server を立ち上げ

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WITHOUT_PORT=5500
WITH_PORT=5501
WITHOUT_NAME=kozou-demo-without
WITH_NAME=kozou-demo-with
WITHOUT_URL="postgres://postgres:demo@localhost:${WITHOUT_PORT}/postgres"
WITH_URL="postgres://postgres:demo@localhost:${WITH_PORT}/postgres"

setup() {
  echo "=== Starting 2 PostgreSQL containers ==="
  docker run --rm -d --name "${WITHOUT_NAME}" -p "${WITHOUT_PORT}:5432" \
    -e POSTGRES_PASSWORD=demo postgres:16
  docker run --rm -d --name "${WITH_NAME}" -p "${WITH_PORT}:5432" \
    -e POSTGRES_PASSWORD=demo postgres:16

  echo "=== Waiting for PG to be ready ==="
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if docker exec "${WITHOUT_NAME}" pg_isready -U postgres >/dev/null 2>&1 \
      && docker exec "${WITH_NAME}" pg_isready -U postgres >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done

  echo "=== Loading DDL ==="
  docker exec -i "${WITHOUT_NAME}" psql -U postgres < "${REPO_ROOT}/scripts/demo/nimart-no-comment.sql"
  docker exec -i "${WITH_NAME}" psql -U postgres < "${REPO_ROOT}/examples/nimart/migrations/0001_init.sql"

  cat <<EOM

=== Setup complete ===

Without COMMENT: KOZOU_DATABASE_URL=${WITHOUT_URL}
With COMMENT:    KOZOU_DATABASE_URL=${WITH_URL}

Prompt:
  $(sed -n '1,5p' "${REPO_ROOT}/scripts/demo/prompts/01-sales-by-artist.md")

Next steps (in another terminal):
  $ bash scripts/demo/run-comparison.sh mcp-without
    -> Claude Code で MCP 接続して prompt 投入、docs/demo/before.md に貼り付け
  $ bash scripts/demo/run-comparison.sh mcp-with
    -> Claude Code で MCP 接続して prompt 投入、docs/demo/after.md に貼り付け

Cleanup:
  $ bash scripts/demo/run-comparison.sh stop
EOM
}

stop() {
  echo "=== Stopping demo containers ==="
  docker stop "${WITHOUT_NAME}" 2>/dev/null || true
  docker stop "${WITH_NAME}" 2>/dev/null || true
}

mcp_without() {
  exec env KOZOU_DATABASE_URL="${WITHOUT_URL}" \
    pnpm --dir "${REPO_ROOT}" --filter @kozou/mcp exec tsx src/cli.ts
}

mcp_with() {
  exec env KOZOU_DATABASE_URL="${WITH_URL}" \
    pnpm --dir "${REPO_ROOT}" --filter @kozou/mcp exec tsx src/cli.ts
}

case "${1:-setup}" in
  setup) setup ;;
  stop) stop ;;
  mcp-without) mcp_without ;;
  mcp-with) mcp_with ;;
  *) echo "Usage: $0 [setup|stop|mcp-without|mcp-with]" >&2; exit 1 ;;
esac
