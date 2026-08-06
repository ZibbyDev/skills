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

## HTTP contract

```
POST /ingest   { kbId, docs: [{ sourceId, markdown, deleted? }] }
               → { ok:true, upserted:<n>, deleted:<n>, chunks:<n> }
POST /query    { kbId, query, topK }
               → { ok:true, results: [{ sourceId, chunk, score }] }
POST /delete   { kbId, sourceIds: [...] }
               → { ok:true, deleted:<n> }
POST /stat     { kbId }
               → { ok:true, exists, sizeBytes, docs }
POST /drop     { kbId, confirm:true }
               → { ok:true, dropped:<bool> }
POST /compact  { kbId, olderThanHours?, vacuum?:'full'|'light'|'none', halfvec? }
               → { ok:true, purgedCount, vacuumMode, vacuumed, halfvec,
                   beforeBytes, afterBytes, reclaimedBytes }
GET  /health   → { ok:true }
```

`upsert` is **by `sourceId`** within `kbId`. `deleted:true` (in `/ingest`) or
`/delete` soft-removes the source (it disappears from query results). On error:
HTTP `4xx`/`5xx` with `{ ok:false, error }`. Missing `kbId`/`docs`/`query`/
`sourceIds` → `400`.

### Removing data — three operations, told apart by what SURVIVES

None of them is called "purge": the word means "erase everything" to a user and
"reclaim freed space" to a DBA, so it can only ever describe one of these to half
the room.

| | Live documents | The store | Route |
|---|---|---|---|
| **Reclaim space** | kept | kept | `POST /compact` |
| **Empty the knowledge base** | erased | kept | `POST /drop` |
| **Delete the store** | erased | erased | control-plane `DELETE` (calls `/drop`) |

`/delete` is a **soft** delete — GBrain keeps a 72h recovery window, and a
soft-deleted page's chunks, vectors and HNSW entries stay on disk. GBrain ships
no `VACUUM` and PGLite runs no autovacuum daemon, so without `/compact` a
churning KB only ever grows. Measured on an 80-doc brain with 30 deletes:

```
soft delete                       79,688 KB → 80,728 KB   (+1 MB — it GROWS)
+ purge_deleted_pages (hard)      80,728 KB → 80,720 KB   (unchanged)
+ VACUUM FULL                     80,720 KB → 65,904 KB   (−14.8 MB)
```

`reclaimedBytes` is **signed**: `VACUUM FULL` is itself WAL-logged, so on a small
store the new WAL can outweigh what it frees (measured 42.7 MB → 59.4 MB). That
is reported honestly rather than clamped to zero.

### One-off vs incremental — the `vacuum` weight

| Mode | What it does | Cost |
|---|---|---|
| `full` (default) | `VACUUM FULL` — gives bytes back to the filesystem | rewrites every table, ACCESS EXCLUSIVE lock, needs room for a second copy, ~17 MB/s |
| `light` | `VACUUM (ANALYZE)` — returns dead tuples to the free-space map so the next write REUSES them | O(dead tuples), no exclusive lock, no rewrite |
| `none` | hard purge only | — |

A fixed vocabulary: an unrecognized value is a `400`, never coerced.

**`light` also runs automatically**, unattended, when a brain goes idle — the
moment its persistent `gbrain serve` is about to be reaped anyway, so nothing is
contending for the single-writer lock and the work is free to the user. That is
what actually fixes "the store only ever grows"; `full` is the operator-triggered
"give me the bytes back now" and is **never** scheduled. The automatic pass skips
any brain nothing has written to, and never resurrects a reaped one.

### halfvec (opt-in, ONE-WAY)

`{ halfvec: true }` narrows `content_chunks.embedding` from `vector(N)` (float32)
to `halfvec(N)` (float16) in place and rebuilds the HNSW index. pgvector casts the
stored values, so there is **no re-embedding and no API call** — measured 16.2%
off a whole 1536-dim store in ~3s. Compare cutting the *dimension* 1536→512,
which needs every document re-embedded and measured only 7.8%.

Idempotent (a second pass is a no-op) but **irreversible**: float16 precision
cannot be recovered by widening the column back. Never a default.

**Auth:** if `SIDECAR_AUTH_TOKEN` is set, POST routes require
`Authorization: Bearer <that token>` (else `401`).

## Environment

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `SIDECAR_AUTH_TOKEN` | *(unset)* | If set, Bearer token required on POST routes |
| `GBRAIN_DATA_ROOT` | `/data` | Root under which per-kbId brains live |
| `GBRAIN_OP_TIMEOUT_MS` | `120000` | Per-operation subprocess timeout |
| `GBRAIN_SERVE_IDLE_MS` | `300000` | How long a brain must be untouched before it is reclaimed + released |
| `GBRAIN_SERVE_STOP_TIMEOUT_MS` | `5000` | Grace period before a `gbrain serve` that won't stop is SIGKILLed |
| `AUTO_RECLAIM` | *(on)* | `0`/`false`/`off` ⇒ disable the automatic idle reclaim entirely (idle reaping continues) |
| `AUTO_RECLAIM_WINDOW_HOURS` | `72` | Recovery window the automatic pass hard-purges past — GBrain's own default |
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
