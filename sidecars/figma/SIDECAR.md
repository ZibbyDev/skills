# Figma MCP — sidecar packaging notes

This directory is the **packaged copy** of the Figma MCP service that the
self-host sidecar mechanism builds/publishes (`publish-sidecar.sh figma
--arch <amd64|arm64>` → `dl.zibby.app/sidecars/figma/<version>.tar.gz`,
sha256-pinned in `selfhosted/sidecar/sidecar-versions.json`).

| | |
|---|---|
| Upstream repo | `figma-mcp` (first-party; not a third-party vendor) |
| Runtime | Node **20** (alpine) — pure JS, no native module |
| Port / health | `8090` / `GET /health` |
| Durable state | **NONE** — stateless. No volume, nothing written to disk. |
| Box-global secret | **NONE** |
| Per-tenant config | **NONE** — see "Why there are no requestConfigKeys" below |
| Public paths | `/connect` (onboarding page), `/mcp` (the MCP endpoint) |
| Multi-tenancy | ONE shared container serves everyone; a session is bound at `initialize` to the PAT that opened it and a later request with a different token is 403'd |

## What it is

A remote **MCP server** (Streamable HTTP, `POST/GET/DELETE /mcp`) exposing 12
Figma REST tools — read a file, pull **dev-handoff specs** from a node tree
(hex colors, fonts, sizes, auto-layout spacing, radius, strokes, effects),
export images, read/post comments, list team projects.

**It is a pure PROXY.** Each request carries the caller's own Figma **Personal
Access Token** (`X-Figma-Token`, or `Authorization: Bearer`); the server
forwards it to `api.figma.com` for that one call. There is no OAuth flow, no
token store, no server-side identity, and no secret in the container.

**Identity is per USER, never a shared/service identity** — what a caller can
read is exactly what their own Figma account can see, enforced by Figma itself.

## Why a PAT and not OAuth (the design decision, not an omission)

A PAT and an OAuth token grant the **same access** — both act as that user — so
OAuth would buy no additional capability here, only a Figma app registration, a
client secret, a callback, a token store and refresh logic. And a PAT is a
*static* credential: no browser, no redirect, no human at call time, which is
what a headless/background agent needs. (Figma's own hosted MCP requires
interactive browser OAuth and rejects PATs outright, so it cannot serve a
background agent at all.)

That is also why this sidecar is far simpler than `pingcode`: no `/data`
volume, no `TOKEN_STORE_KEY`, no `dataPurpose: 'credentials'`, nothing to
delete on uninstall.

## Why there are no `requestConfigKeys`

Tempting, and wrong. `requestConfigKeys` injects the DECLARING AGENT's
configuration on each request — and the public-path proxy injects it too. So a
`FIGMA_TOKEN` config key would mean an **anonymous** caller hitting the public
`/mcp` with no token of their own would silently fall back to the agent
owner's Figma account. The credential and the caller must stay the same person:
no token in the request, no access (401).

An agent on this box that wants Figma tools attaches this same URL + a PAT
through the platform's existing **custom MCP server** feature — it then runs
under whoever's PAT was attached, which is the property we want.

## Two audiences, ONE contract (bring your own PAT + MCP)

1. **Outside Zibby** — local Claude Code / Cursor / Codex / any remote agent:
   copy the install line from the onboarding page at `<public-url>/connect`.
2. **A Zibby agent** — attach the same url + header through the platform's
   **custom MCP** feature (ask the Copilot: "add an MCP server `<url>/mcp` to
   this agent"). The header is stored encrypted, never returned by the API, and
   the run reaches the server through the control-plane broker.

There is **no platform-side identity injection and no Zibby-specific code** in
this service: to the platform it is just another authenticated remote MCP
server, which is exactly why hosting it is a pure declaration.

## Secret hygiene

Only `src/`, `Dockerfile`, `.dockerignore`, `package.json`, `package-lock.json`,
`README.md` and `.env.example` are copied here — never `.env`. Nothing in this
service has a hardcoded host, client id or key to leak, because it has none:
the only credential in the system is the caller's PAT, which lives in the
request and nowhere else.

## Re-sync rule — vendor from the CURRENT source HEAD, then DIFF

A stale snapshot of a vendored service is not "slightly behind", it is a
**shipped vulnerability** — the pingcode copy once predated its own OAuth
slot-hijack fix by 47 minutes and anyone deploying it would have run the bug.

`src/figma.js` and `src/tools.js` — the REST client and every tool — are
**byte-identical to upstream** and MUST stay that way. `src/server.js`
deliberately diverges in exactly one dimension: the human-facing onboarding
page (upstream serves one shared team box where a per-person install name is
mandatory; here each person installs on their own machine) and the `/connect`
route that makes that page declarable as a public path. Its MCP transport, PAT
handling and session anti-hijack logic are the same code.

So every re-sync ends with a byte comparison, not a vibe:

```sh
for f in src/figma.js src/tools.js Dockerfile package.json package-lock.json .dockerignore; do
  cmp -s "<source>/$f" "sidecars/figma/$f" || echo "DIFF: $f"
done
# server.js: re-read the divergence note in its header docblock and port any
# upstream change to the MCP/PAT paths by hand.
```

No `DIFF:` lines ⇒ the tool surface is exactly the reviewed source.

## Publishing

```sh
bash selfhosted/dist/publish-sidecar.sh figma <version> --arch amd64
bash selfhosted/dist/publish-sidecar.sh figma <version> --arch arm64
```

Both arches publish from ANY machine (the script builds the requested ISA and
asserts the image's `.Architecture` before uploading) — this is NOT the
two-EC2 rule that applies to a full self-host release cut. Then commit the
regenerated `selfhosted/sidecar/sidecar-versions.json`, and bump
`marketplace.sidecarSpecs`/the registry pin if the version moved.
