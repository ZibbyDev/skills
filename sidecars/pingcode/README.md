# pingcode-mcp

Remote MCP server exposing PingCode (Ship & friends) tools over Streamable
HTTP, with **self-service per-user OAuth**: an admin deploys the server once
against their own PingCode instance; users onboard themselves by clicking a
link and pasting one block back to their agent.

Each user ends up calling PingCode as **themselves** — PingCode's own project
and role permissions are enforced natively. No shared identity.

Per-user PingCode access/refresh tokens are stored in an **encrypted SQLite
store** (`data/users.db`, AES-256-GCM via the Node builtin `node:sqlite` +
`node:crypto`) — never in plaintext on disk.

## Two kinds of consumers, one endpoint

The server speaks plain Streamable-HTTP MCP with a static
`Authorization: Bearer mcp_…` header, so anything that can attach a remote
MCP server with a header can use it:

1. **External users (Claude Code / Codex / Claude Desktop / Cursor …)** —
   after the one-time browser OAuth, the success page shows a copy-paste
   block per agent. The Claude Code one boils down to:

   ```
   claude mcp add --transport http pingcode-<slug> <PUBLIC_BASE_URL>/mcp \
     --header "Authorization: Bearer mcp_…"
   ```

2. **A hosted agent platform (e.g. a Zibby agent)** — attach the SAME URL +
   token via the platform's custom-MCP feature (paste
   `<PUBLIC_BASE_URL>/mcp` and the `Authorization: Bearer mcp_…` header into
   its add-MCP flow). The agent then calls PingCode as the human who did the
   OAuth — there is no platform-side identity injection, and nothing about
   the server is platform-specific.

Both audiences share the renew flow: when the ~90-day refresh token dies,
tool calls return a renew link that re-authorizes **without changing the
MCP token**, so neither config ever changes.

## Configuration (env)

All of these go in `.env` (see `.env.example`). **Required, no defaults** —
the server fails loud at boot when any is missing:

| Var | Meaning |
|---|---|
| `PINGCODE_CLIENT_ID` / `PINGCODE_CLIENT_SECRET` | OAuth app created in YOUR PingCode admin console |
| `PINGCODE_REST_ROOT` | REST API root of your instance, e.g. `https://pingcode.example.com/open` |
| `PINGCODE_AUTH_ROOT` | Authorize-page root, e.g. `https://pingcode.example.com` |
| `TOKEN_STORE_KEY` | 32-byte key (hex or base64) encrypting stored PingCode tokens. Generate: `openssl rand -hex 32`. Losing/changing it orphans the store. |
| `PINGCODE_SCOPE` | OAuth scope requested on authorize. **Effectively required** — see [Renew safety](#renew-safety-identity--nonce): with no scope PingCode grants the user token no API permissions, `GET /v1/myself` 403s, and **every renew is refused**. The server warns at boot when it is empty. |

Optional:

| Var | Meaning |
|---|---|
| `PUBLIC_BASE_URL` | Public URL of this server (used for the OAuth redirect URI + the install command shown to users). May include a path when reverse-proxied under a prefix. |
| `PUBLIC_BASE_PATH` | In-page link prefix when a reverse proxy mounts the app under a stripped prefix (e.g. `/sidecars/pingcode`). Normally derived from `PUBLIC_BASE_URL`'s path — set only to override. |
| `TOKEN_STORE_PATH` | Store location, default `/data/users.db`. A legacy `…/users.json` value is accepted: it maps to a sibling `users.db` and the JSON is imported once, verified, checkpointed, then **deleted** (plaintext must not survive on the volume). |
| `OAUTH_CALLBACK_PATH_NONCE` | `1` = also carry the per-attempt nonce in the redirect-URI **path** (`/oauth/callback/<nonce>`), on top of the always-on cookie. Requires a PingCode app that accepts the extra path segment — see [Renew safety](#renew-safety-identity--nonce). Default off. |
| `PINGCODE_TOOL_GROUPS` | Comma-separated doc-group filter to trim the generated tool list |
| `PORT` / `HOST_PORT` / `BIND_ADDR` | Container port (default 8090) / published host port / bind interface |

## What the admin does (once)

1. `cp .env.example .env` — fill every required var above
   (`openssl rand -hex 32` for `TOKEN_STORE_KEY`)
2. `docker compose up -d --build`
3. In the PingCode app admin console, register the **redirect URI**
   `<PUBLIC_BASE_URL>/oauth/callback` (the server prints the exact URL on
   startup)

That's it. **No token issuance, no user list, no manual provisioning.**

## What each user does (once, takes ~30s)

1. Open `<PUBLIC_BASE_URL>/oauth/start` in a browser (log into PingCode
   FIRST — see gotchas), consent.
2. The success page shows a per-agent install block containing a fresh
   personal `mcp_…` token. Copy the one for your agent, paste it to the
   agent, done. (A Zibby-style hosted agent instead takes the URL + header
   through its custom-MCP add flow.)

## Token lifetimes

```
MCP token              (in the client config)         — permanent until revoked
PingCode access_token  (encrypted in users.db)        — auto-refreshed
PingCode refresh_token (encrypted in users.db)        — ~90 days
```

- **Hourly:** transparent. Server detects upcoming expiry, refreshes via
  PingCode's `refresh_token` grant, stores the new pair.
- **~90 days:** tool calls return a renew link
  (`/oauth/start?renew=mcp_…`). The user re-consents; the callback updates
  the same slot. **The MCP token does not change** — no reconfig.

## Renew safety: identity + nonce

A renew writes fresh PingCode tokens into an **existing** slot, so it is the
one flow where a third party could land *their* tokens in *your* slot and have
your agent quietly operate their PingCode account. Two independent guards, both
**fail closed**:

**1. Every callback must present the one-time nonce from its own
`/oauth/start`.** Each authorization attempt gets an opaque single-use nonce
with a 10-minute TTL. It travels back in a short-lived `HttpOnly; SameSite=Lax`
cookie (and in `state`, and optionally in the redirect-URI path). If the
callback presents no nonce, an unknown/expired/already-used nonce, or two
sources that disagree, it is **refused** — the pending authorization is left
untouched so the legitimate user can still complete theirs. There is no
"use the most recent pending authorization" fallback (that was the hole:
PingCode does not echo `state`, so the old code correlated a callback with
whichever `/oauth/start` was newest, which anyone could race).

**2. Every renew must prove the consenting PingCode identity.** Each slot
records the PingCode `user_id` that created it (via `GET /v1/myself`). A renew
is refused when the consenting user differs — **and equally when the identity
cannot be resolved at all**, including for legacy slots that carry no recorded
id. Nothing is written on refusal.

> ⚠️ **This is why `PINGCODE_SCOPE` matters.** With an empty scope PingCode
> grants the user token no API permissions, `GET /v1/myself` returns 403, no
> identity can be established, and **every renew is refused** with an error page
> naming this variable. A *fresh* authorization still succeeds (there is no slot
> to hijack yet) but the success page warns that the slot is unbindable and
> cannot be renewed later. Give the OAuth app access to `/v1/myself`, set
> `PINGCODE_SCOPE`, and have the user authorize once more.

> **Redirect-URI implication of `OAUTH_CALLBACK_PATH_NONCE=1`.** With it on, the
> `redirect_uri` becomes `<PUBLIC_BASE_URL>/oauth/callback/<nonce>` — a
> *different* URI per attempt — and PingCode validates `redirect_uri` against
> the app's registered list. Only turn it on if your PingCode app can register a
> wildcard/prefix covering `/oauth/callback/*`; otherwise authorize fails with
> `'redirect_uri'与应用设置不匹配`. It is **off by default** so the single
> already-registered `<PUBLIC_BASE_URL>/oauth/callback` keeps working; the
> cookie nonce alone already binds the callback.

## Revoking a user

```bash
./scripts/revoke-token.sh --list          # see stored tokens
./scripts/revoke-token.sh mcp_xxx         # delete one (stop → delete → start)
```

That MCP token now returns 401. The user can re-onboard via `/oauth/start`.

## Tools

Six curated tools (`auth_status`, `list_products`, `list_ticket_types`,
`list_tickets`, `create_ticket`, `update_ticket`) plus the full generated
fleet from `src/pingcode-api.json` (one MCP tool per documented PingCode
REST endpoint; regenerate with `scripts/parse-api.mjs`). Trim with
`PINGCODE_TOOL_GROUPS` if the list overwhelms your agent.

## Layout

```
pingcode-mcp/
├── docker-compose.yml
├── Dockerfile             node:22-alpine, npm ci against the committed lockfile
├── package.json / package-lock.json
├── .env.example
├── data/                  ← bind-mounted volume; holds users.db (encrypted)
├── scripts/
│   ├── parse-api.mjs      docs HTML → pingcode-api.json generator
│   └── revoke-token.sh    delete a token slot safely
├── test/                  node:test suite (`npm test`)
│   ├── oauth-callback.test.js  nonce binding + renew identity fail-closed
│   ├── token-store.test.js     crypto round-trip, tamper, migration
│   └── helpers.js              PingCodeOAuth double + app harness
└── src/
    ├── server.js          entrypoint: env → deps → listen
    ├── app.js             Express app (injectable): /oauth/start, /oauth/callback, /mcp
    ├── pingcode.js        OAuth + REST client + auto-refresh + identity lookup
    ├── token-store.js     encrypted SQLite token store (node:sqlite + AES-256-GCM)
    ├── tools.js           tool registry (curated + generated)
    └── pingcode-api.json  generated endpoint spec (committed source of truth)
```

## Tests

```bash
npm ci && npm test      # node:test, no live PingCode needed
```

`src/app.js` takes its `PingCodeOAuth` as a parameter, so the whole OAuth
start/callback flow is exercised against a test double on an ephemeral port —
including every refusal path (missing/wrong/conflicting/replayed nonce, an
unresolvable identity, a mismatched identity) and the assertion that a refusal
writes **nothing**.

## Smoke test (admin)

```bash
# 1) Health
curl http://localhost:8090/health

# 2) Visit the landing page → 授权 PingCode → complete OAuth
#    → confirm the success page shows the install blocks

# 3) Copy the printed mcp_ token, then exercise the MCP endpoint:
TOKEN=mcp_xxx
curl -s -X POST http://localhost:8090/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'

# 4) Then tools/list + tools/call with the returned Mcp-Session-Id header.
```

## Gotchas (learned the hard way)

- **Log into PingCode FIRST**, then open `/oauth/start`. PingCode's signin
  round-trip drops query params, giving "缺少必要参数 'client_id'" otherwise.
- PingCode does **not** echo `state` on the OAuth callback (it sends `code` +
  `domain`). The callback therefore carries its one-time nonce in a cookie
  (optionally also in the redirect-URI path) and verifies the PingCode identity
  for renews — see [Renew safety](#renew-safety-identity--nonce). Complete the
  whole flow **in one browser**, within 10 minutes.
- The token endpoint is `GET <REST_ROOT>/v1/auth/token?grant_type=…`.
- `redirect_uri` IS validated against the app's registered list — register
  every deployment's callback (prod + ngrok dev) in the PingCode app.
