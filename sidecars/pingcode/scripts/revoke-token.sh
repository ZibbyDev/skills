#!/usr/bin/env bash
# Revoke (delete) a leaked MCP_TOKEN from the token store, safely.
#
# The store is an encrypted SQLite DB (data/users.db, see src/token-store.js).
# We still do stop → delete → start: SQLite handles cross-process writes, but
# stopping first also drops any live MCP session bound to the leaked token and
# any in-flight refresh, so revocation is immediate and unambiguous.
#
# The row is deleted via a throwaway container of the SAME image (node + the
# builtin node:sqlite are in it, ./data is mounted), so the host needs no
# sqlite3/jq/node — only docker compose. No TOKEN_STORE_KEY needed: we delete
# and list rows, never decrypt them.
#
# Usage:
#   ./scripts/revoke-token.sh mcp_09b5ce34...      # revoke one token
#   ./scripts/revoke-token.sh --list               # list token ids + grant time
#
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root (where docker-compose.yml lives)

SERVICE=pingcode-mcp

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <mcp_token> | --list" >&2
  exit 2
fi

# A node one-liner run inside the app image. ACTION + REVOKE_TOKEN come via env
# so the token never has to be shell-escaped into the JS source.
run_in_image() {
  local action="$1" token="${2:-}"
  docker compose run --rm --no-deps \
    -e "ACTION=$action" -e "REVOKE_TOKEN=$token" \
    --entrypoint node "$SERVICE" --eval '
      const { DatabaseSync } = require("node:sqlite");
      const path = require("node:path");
      const fs = require("node:fs");
      // Same TOKEN_STORE_PATH resolution as src/token-store.js: a legacy
      // .../users.json value maps to a sibling users.db.
      let p = process.env.TOKEN_STORE_PATH || "/data/users.db";
      if (p.endsWith(".json")) p = path.join(path.dirname(p), "users.db");
      if (!fs.existsSync(p)) { console.error(`store not found: ${p}`); process.exit(3); }
      const db = new DatabaseSync(p);
      if (process.env.ACTION === "list") {
        const rows = db.prepare(
          "SELECT mcp_token, granted_at, created_at, " +
          "(access_token_enc IS NULL OR refresh_token_enc IS NULL) AS dead " +
          "FROM users ORDER BY created_at").all();
        if (!rows.length) { console.log("(no tokens stored)"); process.exit(0); }
        for (const r of rows) {
          const g = r.granted_at || r.created_at;
          const when = g ? new Date(Number(g)).toISOString() : "unknown";
          console.log(`${r.mcp_token}  granted=${when}${r.dead ? "  [revoked/expired]" : ""}`);
        }
        console.log(`\ntotal: ${rows.length}`);
        process.exit(0);
      }
      const t = process.env.REVOKE_TOKEN;
      const hit = db.prepare("SELECT 1 FROM users WHERE mcp_token = ?").get(t);
      if (!hit) {
        const n = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
        console.error(`token not found in store: ${t}`);
        console.error(`(${n} token(s) present; run with --list to see them)`);
        process.exit(3);
      }
      db.prepare("DELETE FROM users WHERE mcp_token = ?").run(t);
      const n = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
      console.log(`revoked ${t}; ${n} token(s) remain`);
    '
}

if [[ "$1" == "--list" ]]; then
  run_in_image list
  exit 0
fi

TOKEN="$1"
if [[ "$TOKEN" != mcp_* ]]; then
  echo "refusing: '$TOKEN' doesn't look like an mcp_ token" >&2
  exit 2
fi

echo "==> stopping $SERVICE (brief downtime so live sessions/refreshes drop)…"
docker compose stop "$SERVICE"

echo "==> deleting token from the store…"
run_in_image revoke "$TOKEN"

echo "==> starting $SERVICE back up…"
docker compose up -d "$SERVICE"

echo "✅ done. The leaked token no longer works. The user can re-onboard via /oauth/start if needed."
