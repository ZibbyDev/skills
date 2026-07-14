# GBrain KB sidecar

A small **knowledge-base sidecar**: embedded Postgres ([PGlite](https://pglite.dev)
= Postgres compiled to WASM) + **pgvector**, exposed over a tiny REST contract.
It ingests markdown documents, chunks + embeds them, and answers semantic
queries — scoped per knowledge base (`kbId`) for multi-tenant isolation.

The `@zibby/skills` **`gbrain`** skill (`src/gbrain.js`) is the only caller. It
speaks this REST contract and nothing else, so **the engine behind the contract
is pluggable** — this PGlite+pgvector implementation can be swapped for GBrain
proper, a self-managed Postgres+pgvector, Supabase, or any other vector engine
without touching the skill. The contract is the API; the engine is an
implementation detail.

## HTTP contract

```
POST /ingest   { kbId, docs: [{ sourceId, markdown, deleted? }] }
               → { ok:true, upserted:<n>, deleted:<n>, chunks:<n> }
```
Upsert **by `sourceId`** within `kbId`: existing chunks for that `(kbId, sourceId)`
are deleted, then the new markdown is chunked, embedded and inserted. A doc with
`deleted:true` removes that `(kbId, sourceId)` (its `markdown` is ignored) and is
counted in `deleted`.

```
POST /query    { kbId, query, topK }
               → { ok:true, results: [{ sourceId, chunk, score }] }
```
Embeds the query and vector-searches **within that `kbId` only**, returning the
`topK` most similar chunks, highest similarity first. `score` is cosine
similarity in `[0,1]` (`1 - cosine_distance`, clamped).

```
POST /delete   { kbId, sourceIds: [...] }
               → { ok:true, deleted:<n> }
```
Removes the given sources within `kbId`. `deleted` = how many of them actually
had chunks removed.

```
GET  /health   → { ok:true }
```

All routes return JSON. On error: HTTP `4xx`/`5xx` with `{ ok:false, error:"..." }`.
Missing `kbId`/`docs`/`query`/`sourceIds` → `400`.

**Auth:** if `SIDECAR_AUTH_TOKEN` is set, the POST routes require
`Authorization: Bearer <that token>` (else `401`). If unset, there is no auth —
the sidecar is expected to run on the run's private network.

## Environment

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `SIDECAR_AUTH_TOKEN` | *(unset)* | If set, Bearer token required on POST routes |
| `PGLITE_DATA_DIR` | `/data/brain` | Persistent data dir (brain survives restart) |
| `EMBEDDINGS_API_URL` | `https://api.openai.com/v1/embeddings` | OpenAI-compatible embeddings endpoint |
| `EMBEDDINGS_API_KEY` | *(unset)* | API key for the embeddings endpoint |
| `EMBEDDINGS_MODEL` | `text-embedding-3-small` | Embedding model (dim 1536) |
| `EMBEDDINGS_FAKE` | *(unset)* | `1` ⇒ use the deterministic offline fake embedder (dim 64) |
| `EMBED_DIM_REAL` | `1536` | Dimension of the real embedding model |

**Embeddings.** With an API key set, the sidecar calls an OpenAI-compatible
`/embeddings` endpoint (batched). With `EMBEDDINGS_FAKE=1` **or no API key**, it
uses a deterministic, dependency-free hashing embedder (dim 64) so it boots and
works fully offline — lexically-overlapping text lands in the same hash buckets,
so nearest-neighbour ranking is still meaningful. The active embedder fixes
`EMBED_DIM`, and the `vector(EMBED_DIM)` schema is derived from it, so schema and
embedder never drift. (Switching embedder dimension means a fresh data dir.)

## Run

```bash
npm install          # installs @electric-sql/pglite (into ./node_modules, gitignored)
npm start            # boots the server on :8080

# offline smoke test — proves ingest/query/upsert/delete/isolation end-to-end:
EMBEDDINGS_FAKE=1 npm run smoke
```

Quick manual check:

```bash
EMBEDDINGS_FAKE=1 PORT=8899 node server.mjs &
curl -s localhost:8899/health
curl -s localhost:8899/ingest -H 'Content-Type: application/json' \
  -d '{"kbId":"demo","docs":[{"sourceId":"a","markdown":"# Bread\nBaking sourdough."}]}'
curl -s localhost:8899/query  -H 'Content-Type: application/json' \
  -d '{"kbId":"demo","query":"how to bake bread","topK":3}'
```

## Persistence

Data lives in `PGLITE_DATA_DIR` (default `/data/brain`; the Docker image mounts
`/data` as a volume). The brain therefore survives restarts. Shipping the data
dir off-box (the Stores-v2 S3/MinIO snapshot round-trip) is handled by the
platform, not this sidecar — the sidecar only reads/writes its local data dir.

## Files

- `server.mjs` — Node `http` server; routes, auth, JSON handling.
- `db.mjs` — PGlite init (data dir + `vector` extension + schema) and the
  `upsertDoc` / `deleteSources` / `query` ops (all `kb_id`-scoped).
- `embeddings.mjs` — OpenAI-compatible client + the deterministic fake;
  exports `embed()` and `EMBED_DIM`.
- `chunk.mjs` — `chunkMarkdown(md) -> string[]` (heading/paragraph-aware,
  ~500–1000 char chunks with overlap).
- `smoke.mjs` — end-to-end offline proof (run via `npm run smoke`).
- `Dockerfile` — `node:20-slim`, `/data` volume, `CMD node server.mjs`.
