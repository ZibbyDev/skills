# PingCode MCP — sidecar packaging notes

This directory is the **packaged copy** of the PingCode MCP service that the
self-host sidecar mechanism builds/publishes (`publish-sidecar.sh pingcode
--arch <amd64|arm64>` → `dl.zibby.app/sidecars/pingcode/<version>.tar.gz`,
sha256-pinned in `selfhosted/sidecar/sidecar-versions.json`).

| | |
|---|---|
| Upstream repo | `pingcode-mcp` (first-party; not a third-party vendor) |
| Runtime | Node **22** (alpine) — uses the BUILTIN `node:sqlite`, no native module |
| Port / health | `8090` / `GET /health` |
| Durable state | `/app/data` (declared named volume): encrypted SQLite token store |
| Secrets | env only — `PINGCODE_CLIENT_ID/SECRET`, `TOKEN_STORE_KEY` (32-byte) |

## What it is

A remote **MCP server** (Streamable HTTP, `POST/GET /mcp`) exposing PingCode
REST tools, plus **self-service per-user OAuth**: a user authorizes, and the
callback page shows — once — the `claude mcp add … --header "Authorization:
Bearer mcp_…"` line. That bearer is the user's own handle; the service keeps
their PingCode access/refresh tokens (encrypted at rest) and rotates them.

**Identity is per USER, never a shared/service identity** — PingCode's own
project + role permissions apply natively to every call.

## Two audiences, ONE contract (OAuth-minted bearer + MCP)

1. **Outside Zibby** — local Claude Code / any remote agent: paste the
   `claude mcp add …` line from the callback page.
2. **A Zibby agent** — attach the SAME url + bearer through the platform's
   existing **custom MCP** feature (ask the Copilot: "add an MCP server
   `<url>/mcp` to this agent"). The token is stored encrypted, never returned
   by the API, and the run reaches the server through the control-plane broker.

There is **no platform-side identity injection and no Zibby-specific code** in
this service: to the platform it is just another authenticated remote MCP
server, which is exactly why hosting it is a pure declaration.

## Secret hygiene (this repo is PUBLIC, MIT)

Only `src/`, `test/`, `Dockerfile`, `.dockerignore`, `package.json`,
`package-lock.json`, `README.md`, `.env.example` and `scripts/revoke-token.sh`
are copied here — never `.env`, never `data/` (it holds live refresh tokens),
never the vendored API-doc HTML. The PingCode API base + client credentials are
REQUIRED env with no hardcoded default, so no customer host/IP/client-id ships
in source. Re-run that whitelist (and re-scan) on every re-sync from upstream.

## Re-sync rule — vendor from the CURRENT source HEAD, then DIFF

A stale snapshot in a public repo is not "slightly behind", it is a **shipped
vulnerability**: the first copy here predated the OAuth slot-hijack fix by 47
minutes, so the open-source copy still carried the confused-deputy the private
branch had already closed. Anyone deploying from it would have run the bug.

So every re-sync ends with a byte comparison, not a vibe:

```sh
for f in $(git -C <source> ls-files | grep -E '^(src|test)/|^(Dockerfile|package.json|package-lock.json|README.md|.env.example|.dockerignore)$|^scripts/revoke-token.sh$'); do
  cmp -s "<source>/$f" "sidecars/pingcode/$f" || echo "DIFF: $f"
done
```

No `DIFF:` lines ⇒ the public copy is exactly the reviewed source.
