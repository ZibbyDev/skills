# figma-mcp

A **stateless remote MCP server** exposing **Figma REST tools** over Streamable
HTTP. Each MCP request carries the caller's **Figma Personal Access Token** in a
header; the server proxies to the Figma REST API as that user. No OAuth, no
token store, no secrets. Built for **background / cloud agents** that can't do
interactive OAuth.

> Packaging + publishing notes for the Zibby self-host sidecar live in
> [`SIDECAR.md`](./SIDECAR.md). Deployed on a Zibby box, you don't run any of
> the commands below — you deploy the **Figma MCP Service** agent from the
> marketplace and open its Connect link.

## Why PAT (not the official Figma MCP, not OAuth)

The official Figma MCP (`mcp.figma.com`) requires interactive, browser-based
OAuth with a localhost redirect — impossible for a headless background agent,
and it rejects PATs. A PAT is a static credential: no browser, no redirect, no
human at call time. A PAT and an OAuth token grant the *same* access (both act
as the same user), so OAuth buys nothing here — only friction. So: the caller
brings a PAT, this server proxies it to the Figma REST API.

```
agent tool call → POST /mcp   (header: X-Figma-Token: <PAT>)
  → this server → Figma REST API (api.figma.com) as that user
  → design data → agent
```

The PAT is read per request. On session `initialize` it is validated once
against Figma (`GET /v1/me`) — an invalid/revoked PAT is bounced with 401 at the
door — then bound to the session, so a later request presenting a different
token is 403'd (anti-hijack). Nothing is persisted.

## Tools (12)

`figma_whoami`, `figma_get_file`, `figma_get_file_nodes`, **`figma_get_node_specs`**
(dev-handoff: size/position/colors-as-hex/fonts/spacing/radius/strokes/effects),
`figma_get_images`, `figma_get_image_fills`, `figma_get_file_versions`,
`figma_get_comments`, `figma_post_comment`, `figma_get_team_projects`,
`figma_get_project_files`, `figma_parse_url`. File args accept a raw key **or** a
Figma URL; node ids accept `1-23` (URL) or `1:23` (API).

## Connect (per user)

1. Create a PAT at **figma.com/settings → Security → Personal access tokens**
   (scope: `File content · Read`, plus `Comments · Write` to post comments).
2. Install it against this server:

```
claude mcp add --transport http figma <PUBLIC_BASE_URL>/mcp \
  --header "X-Figma-Token: <YOUR_FIGMA_PAT>"
```

The onboarding page at `/connect` prints this line with the real URL already
filled in. If you share a home directory with teammates, install under a
per-person name (`figma-<your-slug>`): `claude mcp add` keys its config by
(home)×(workspace)×name, so one shared name means one shared token.

## Endpoints

- `GET  /connect` — onboarding page (how to make a PAT + the install command); also served at `/`
- `POST /mcp`     — Streamable HTTP MCP endpoint (header `X-Figma-Token: <PAT>`, or `Authorization: Bearer <PAT>`)
- `GET  /health`

## Run locally

```bash
cp .env.example .env       # no secrets to fill in
docker compose up --build  # → http://localhost:31091
# no Docker (bare node doesn't read .env):
npm install && node --env-file=.env src/server.js
```

## Configuration (`.env`) — no secrets

| var              | meaning                                        |
| ---------------- | ---------------------------------------------- |
| `PUBLIC_BASE_URL`| public URL; builds the install command         |
| `HOST_PORT`      | host port to publish on (app listens on 8090)  |
| `BIND_ADDR`      | `0.0.0.0` to expose on the public interface    |
| `MCP_NAME`       | name the install command registers under       |
| `FIGMA_API_ROOT` | (advanced) Figma REST root                     |

As a Zibby sidecar none of these are set by hand: the control-plane derives
`PUBLIC_BASE_URL`/`PUBLIC_BASE_PATH` from the box's advertised origin and the
sidecar's resolved public mount.
