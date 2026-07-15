# GBrain KB sidecar

A **knowledge-base sidecar** that runs the **real** [GBrain](https://github.com/garrytan/gbrain)
(MIT) behind a small, stable REST contract. It ingests markdown documents,
chunks + embeds + indexes them with GBrain, and answers hybrid (vector + BM25 +
RRF + graph-signal) queries — each `kbId` scoped to its **own GBrain brain** for
multi-tenant isolation.

> **This used to be a hand-rolled PGlite+pgvector engine.** It was replaced with
> real GBrain. The REST contract below is byte-for-byte unchanged, so nothing
> upstream (the control-plane's `backend/src/handlers/postgres-store.js`) changed
> — only the engine behind the contract did. See `VENDOR.md`.

## Architecture

GBrain is TypeScript-on-Bun. The sidecar image is based on `oven/bun` and
vendors GBrain as a **commit-pinned** dependency (`package.json` →
`github:garrytan/gbrain#<sha>`; see `VENDOR.md` + `GBRAIN_LICENSE`). A thin
adapter (`brain.js`) translates each REST call into a real GBrain CLI operation:

| REST route | GBrain operation | GBrain command |
|---|---|---|
| `POST /ingest` (upsert) | `put_page` (chunk + embed + index) | `gbrain capture --file <md> --slug <slug>` |
| `POST /ingest` (`deleted:true`) | `delete_page` (soft-delete) | `gbrain call delete_page {slug}` |
| `POST /query` | hybrid search | `gbrain call query {query,limit}` |
| `POST /delete` | `delete_page` (soft-delete) | `gbrain call delete_page {slug}` |

The adapter also issues `restore_page` before an upsert so a previously deleted
`sourceId` comes back live when re-ingested.

### Multi-tenant isolation

Each `kbId` maps to its own GBrain brain — a separate PGLite database at
`${GBRAIN_DATA_ROOT}/kb-<sha256(kbId)>/​.gbrain/brain.pglite`, selected via a
per-call `GBRAIN_HOME`. Two kbIds are two physically separate databases that
cannot see each other's pages, so one sidecar safely holds many tenants' KBs.
The control-plane derives `kbId` server-side from `(accountId, projectId,
storeId)`; the client never supplies it.

### sourceId ↔ slug

The contract addresses docs by an arbitrary `sourceId`; GBrain addresses pages
by a restricted-grammar `slug`. The adapter maps injectively with
`doc/<sha256(sourceId)>` and persists the reverse `slug → sourceId` map per brain
(`<brainDir>/adapter/sourcemap.json`) so query results are reported by
`sourceId`.

## HTTP contract (unchanged)

```
POST /ingest   { kbId, docs: [{ sourceId, markdown, deleted? }] }
               → { ok:true, upserted:<n>, deleted:<n>, chunks:<n> }
POST /query    { kbId, query, topK }
               → { ok:true, results: [{ sourceId, chunk, score }] }
POST /delete   { kbId, sourceIds: [...] }
               → { ok:true, deleted:<n> }
GET  /health   → { ok:true }
```

`upsert` is **by `sourceId`** within `kbId`. `deleted:true` (in `/ingest`) or
`/delete` soft-removes the source (it disappears from query results). On error:
HTTP `4xx`/`5xx` with `{ ok:false, error }`. Missing `kbId`/`docs`/`query`/
`sourceIds` → `400`.

**Auth:** if `SIDECAR_AUTH_TOKEN` is set, POST routes require
`Authorization: Bearer <that token>` (else `401`).

## Environment

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `SIDECAR_AUTH_TOKEN` | *(unset)* | If set, Bearer token required on POST routes |
| `GBRAIN_DATA_ROOT` | `/data` | Root under which per-kbId brains live |
| `GBRAIN_OP_TIMEOUT_MS` | `120000` | Per-operation subprocess timeout |
| `GBRAIN_NO_EMBEDDING` | *(unset)* | `1` ⇒ init brains keyword-only (fully offline) |
| `GBRAIN_EMBEDDING` | *(unset)* | `1` ⇒ force embeddings on (must supply a key) |
| `OPENAI_API_KEY` (or `ZEROENTROPY_API_KEY`, `VOYAGE_API_KEY`, …) | *(unset)* | Embeddings provider key GBrain reads directly |

**Embeddings.** If any known embeddings key is present in the environment, brains
are initialized with GBrain's semantic embeddings enabled (vector + keyword
hybrid). If **no** key is present (or `GBRAIN_NO_EMBEDDING=1`), brains init with
`--no-embedding` and GBrain still ingests, indexes, and answers via its
**keyword/BM25** hybrid arm — so the sidecar boots and works fully offline, just
without vector/semantic ranking. GBrain reads provider keys straight from the
process env; set them on the container.

## Run

```bash
bun install          # fetches the pinned gbrain (+ deps) into ./node_modules
bun server.js        # boots the server on :8080

# offline smoke test — proves ingest/query/upsert/delete/isolation end-to-end
# against real GBrain brains (keyword mode, no API key needed):
GBRAIN_NO_EMBEDDING=1 bun smoke.mjs
```

Quick manual check (from inside the built image):

```bash
curl -s localhost:8080/health
curl -s localhost:8080/ingest -H 'Content-Type: application/json' \
  -d '{"kbId":"a:b:store1","docs":[{"sourceId":"x","markdown":"# Bread\nBaking sourdough."}]}'
curl -s localhost:8080/query  -H 'Content-Type: application/json' \
  -d '{"kbId":"a:b:store1","query":"how to bake bread","topK":3}'
```

## Files

- `server.js` — Node `http` server (run by Bun); routes, auth, JSON handling.
- `brain.js` — the thin adapter: drives the real `gbrain` CLI per kbId brain.
- `smoke.mjs` — end-to-end proof against real GBrain (run via `bun smoke.mjs`).
- `Dockerfile` — `oven/bun`, `bun install` (pinned gbrain), `/data` volume.
- `VENDOR.md` / `GBRAIN_LICENSE` — pinned-commit record + MIT attribution.

## Notes / tradeoffs

- Each op spawns a short-lived `gbrain` process (correct + isolated, but a cold
  Bun+PGLite start per call). A future optimization is a persistent per-brain
  GBrain process or importing GBrain's library operations in-process; the REST
  contract would not change.
- Deletes are GBrain **soft**-deletes (recoverable for 72h, then purged by
  GBrain's own maintenance). They vanish from query results immediately, which is
  what the contract requires.
