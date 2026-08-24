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
POST /compact  { kbId, olderThanHours?, vacuum?:'light'|'none', halfvec? }
               → { ok:true, purgedCount, vacuumMode, vacuumed, halfvec,
                   beforeBytes, afterBytes, reclaimedBytes }
GET  /health   → { ok:true }
```

`upsert` is **by `sourceId`** within `kbId`. `deleted:true` (in `/ingest`) or
`/delete` soft-removes the source (it disappears from query results). On error:
HTTP `4xx`/`5xx` with `{ ok:false, error }`. Missing `kbId`/`docs`/`query`/
`sourceIds` → `400`.

### Removing data — two operations, told apart by what SURVIVES

Neither is called "purge": the word means "erase everything" to a user and
"reclaim freed space" to a DBA, so it can only ever describe one of them to half
the room.

| | Live documents | The store | Route |
|---|---|---|---|
| **Empty the knowledge base** | erased | kept | `POST /drop` |
| **Delete the store** | erased | erased | control-plane `DELETE` (calls `/drop`) |

`/delete` is a **soft** delete — GBrain keeps a 72h recovery window, and a
soft-deleted page's chunks, vectors and HNSW entries stay on disk. GBrain ships
no `VACUUM` and PGLite runs no autovacuum daemon, so without `/compact` a
churning KB only ever grows. Measured on an 80-doc brain with 30 deletes:

```
soft delete                       79,688 KB → 80,728 KB   (+1 MB — it GROWS)
+ purge_deleted_pages (hard)      80,728 KB → 80,720 KB   (unchanged)
```

`/compact` runs that hard purge plus a `VACUUM (ANALYZE)`, which hands the freed
pages to the free-space map so the next write reuses them. **It stops the growth;
it does not shrink the file** — and `reclaimedBytes` is **signed** so a pass that
costs more than it frees says so instead of reporting a comfortable zero.

### 🚫 There is no `VACUUM FULL`, and there must not be one again

`vacuum:'full'` shipped in 0.3.2 as the operator's "give me the bytes back"
action. It was **removed in 0.3.3** because it is a net LOSS under PGLite.
`VACUUM FULL` rewrites every table, the rewrite is WAL-logged, and PGLite's WAL
pool only ever ratchets UP. Measured on a brain with nothing left to reclaim:

```
run #1   base 61,040 → 57,160 KB   WAL 32,768 → 49,152 KB   NET +12 MB
run #2   base 57,160 → 57,080 KB   WAL      unchanged       net  ~0
run #3   base 57,080 → 57,000 KB   WAL 49,152 → 81,920 KB   NET +32 MB
```

A live 954 MB customer store became **1.1 GB on one click**. The WAL does not
come back: `CHECKPOINT` is a no-op (verified twice) and `ALTER SYSTEM` on
`max_wal_size`/`min_wal_size` returns ok while the values read back unchanged —
PGLite never reloads the config. Growth is one-way, up to `max_wal_size` (1 GB),
which is the exact leak this module exists to stop.

The table-level numbers looked like a win *every single time*. The loss was only
ever visible by measuring the whole store **directory**. That is why 0.3.2's
README could quote `+ VACUUM FULL … −14.8 MB` in good faith and still be wrong.
**Do not re-add the mode without a directory-level before/after.** Asking for it
now is a `400`, deliberately, so an older caller fails loudly instead of quietly
costing an operator another 32 MB — `smoke.mjs` asserts both halves of that.

### The `vacuum` weight

| Mode | What it does | Cost |
|---|---|---|
| `light` (default) | `VACUUM (ANALYZE)` — returns dead tuples to the free-space map so the next write REUSES them | O(dead tuples), no exclusive lock, no rewrite |
| `none` | hard purge only | — |

A fixed vocabulary: an unrecognized value is a `400`, never coerced.

**`light` also runs automatically**, unattended, when a brain goes idle — the
moment its persistent `gbrain serve` is about to be reaped anyway, so nothing is
contending for the single-writer lock and the work is free to the user. That is
what actually fixes "the store only ever grows". The automatic pass skips any
brain nothing has written to, and never resurrects a reaped one.

### Actually shrinking a bloated store

**Empty it and re-ingest.** `/drop` removes the brain directory outright, so the
table bloat and the WAL pool go with it, and the brain is recreated with
**halfvec** vectors — narrower than the one it replaced. It is the only thing
measured to make a bloated KB smaller. There is no in-place alternative.

### halfvec — DEFAULT for new brains, opt-in for existing ones

`content_chunks.embedding` is `halfvec(N)` (float16) rather than `vector(N)`
(float32). Half the vector bytes and half the HNSW index built on them —
measured **17.8%** off a whole 1536-dim store (34.4 MB → 28.3 MB
`pg_database_size`, 80 documents / 579 chunks). Compare cutting the *dimension*
1536→512, which needs every document re-embedded and measured only 7.8%.

**A brain created with embeddings enabled is born halfvec** (since 2026-08-07).
The column is narrowed at creation, while the table is empty, so no vector is
ever stored wide and nothing is ever rewritten. Set `GBRAIN_NEW_BRAIN_HALFVEC=0`
to keep new brains float32. A failure to narrow is non-fatal — the brain is
created float32 and a warning is logged.

**An EXISTING brain stays float32 until asked**, because converting one rewrites
data it already holds: `POST /compact { halfvec: true }` does it in place and
rebuilds the HNSW index. pgvector casts the stored values, so there is **no
re-embedding and no API call** (~3s on a 1536-dim store). Idempotent — a second
pass reports `already halfvec` and touches nothing.

Irreversible in principle: float16 precision cannot be recovered by widening the
column back. What it actually costs, **measured 2026-08-07** (the earlier
"negligible" claim here was borrowed from pgvector's docs and had never been
checked): **nothing.** 120 queries over 80 real documents — 60 verbatim, 60
paraphrased — against the same brain before and after conversion: top-1/5/10
overlap `1.000`, #1 unchanged `100%`, every score delta exactly `0.0`, on the
hybrid path and on the isolated vector lane. OpenAI's `text-embedding-3-*`
already returns float16-valued components, so for that provider the conversion
is bit-exact. Controls confirm the measurement can see a difference: mismatched
queries scored 0.04 overlap@10, and 1200 synthetic full-entropy float32 vectors
did show the expected tiny loss (overlap@5 0.999, mean |Δscore| 5.8e-6, #1 never
moved). Full method and numbers: `narrowNewBrainToHalfvec` in `brain.js`.

**Auth:** if `SIDECAR_AUTH_TOKEN` is set, POST routes require
`Authorization: Bearer <that token>` (else `401`).

## The per-brain lock

PGLite is single-writer per data dir, so every op on one brain is serialized;
different brains run fully in parallel (one shared process, isolated tenants).

**The wait is bounded, the work is never cancelled.** A caller that is not given
its turn within `LOCK_ACQUIRE_TIMEOUT_MS` abandons its place in the queue and
fails with a `BRAIN_LOCK_ACQUIRE_TIMEOUT` error that says it *never started* —
distinct wording from the per-operation timeouts, so a log reader can tell "I
never got a turn" from "my turn ran long". An abandoned turn is **skipped**, not
deferred: its `fn` is never invoked, which is what keeps a queue timeout from
becoming a second writer on the file.

The **holder** gets no deadline, only a watchdog, because its work is running in
another process (a `gbrain serve` child, a spawned CLI, PGLite's own worker) and
this process cannot prove that process has released the file. Releasing the
chain on a timer would hand the next caller a lock the previous one still
physically holds. A holder past `LOCK_HOLD_WARN_MS` is therefore reported, not
killed: one warn line, `stuck:true` in `POST /stat`'s `lock` field, and a count
in `GET /health`'s `stuckBrains`. Clearing a genuinely wedged holder means
restarting the sidecar — the only actor that can guarantee the fds are gone.

`POST /stat` is the read that carries this, because it is the one route that does
NOT take the lock — which used to make it the one route that kept answering
cheerfully while every other op on the brain was wedged.

## Environment

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `SIDECAR_AUTH_TOKEN` | *(unset)* | If set, Bearer token required on POST routes |
| `GBRAIN_DATA_ROOT` | `/data` | Root under which per-kbId brains live |
| `GBRAIN_OP_TIMEOUT_MS` | `120000` | Per-operation subprocess timeout |
| `GBRAIN_SERVE_IDLE_MS` | `300000` | How long a brain must be untouched before it is reclaimed + released |
| `GBRAIN_SERVE_STOP_TIMEOUT_MS` | `5000` | Grace period before a `gbrain serve` that won't stop is SIGKILLed |
| `LOCK_ACQUIRE_TIMEOUT_MS` | `120000` | How long a request will WAIT for a turn on a brain's single-writer lock before giving up. Bounds the QUEUE only — an operation that has already started is never cut short |
| `LOCK_HOLD_WARN_MS` | `300000` | A lock held longer than this logs one warn naming the brain, the op and the queue depth, and counts toward `GET /health`'s `stuckBrains` |
| `AUTO_RECLAIM` | *(on)* | `0`/`false`/`off` ⇒ disable the automatic idle reclaim entirely (idle reaping continues) |
| `GBRAIN_NEW_BRAIN_HALFVEC` | *(on)* | `0` ⇒ new vector-capable brains keep the wide `vector(N)` column instead of being born `halfvec(N)` |
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
