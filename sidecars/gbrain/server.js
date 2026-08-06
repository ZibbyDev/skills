/**
 * server.js — the KB sidecar HTTP server (Node built-in `http`, run by Bun).
 *
 * Exposes the STABLE, engine-agnostic REST contract the Zibby control-plane
 * (backend/src/handlers/postgres-store.js) calls. The contract is unchanged;
 * only the engine behind it changed — it is now the REAL GBrain
 * (github.com/garrytan/gbrain), driven by ./brain.js.
 *
 *   POST /ingest  { kbId, docs:[{ sourceId, markdown, deleted? }] }
 *                 → { ok, upserted, deleted, chunks }
 *   POST /query   { kbId, query, topK }  → { ok, results:[{ sourceId, chunk, score }] }
 *   POST /delete  { kbId, sourceIds:[...] } → { ok, deleted }
 *   POST /stat    { kbId } → { ok, exists, sizeBytes, docs }
 *   POST /compact { kbId, olderThanHours?, vacuum? }
 *                 → { ok, purgedCount, vacuumed, beforeBytes, afterBytes, reclaimedBytes }
 *   GET  /health  → { ok }
 *
 * Auth: if SIDECAR_AUTH_TOKEN is set, POST routes require
 * `Authorization: Bearer <token>` (else 401). Unset ⇒ no auth (private network).
 */

import http from 'node:http';
import { ingest, query, del, drop, stat, compact, health, withEmbedding } from './brain.js';

// Per-agent embedding overrides carried on the request (set by the control-plane
// from the deploying agent's snapshotted config). Maps to the env GBrain reads.
// The dimension is baked into the store at creation, so we pin it per known model.
//
// ⚠️ EMBED_DIMS is a FALLBACK, not the source of truth — it is a SECOND place
// that has to agree with GBrain's own per-model default, and it does NOT: GBrain
// records `text-embedding-3-large` at 1536 (schema.sql `embedding_dimensions`),
// this table says 3072. So the SAME model produced two different vector spaces
// depending on whether GBRAIN_EMBEDDING_MODEL happened to be set — 2× the vector
// + HNSW bytes for a brain whose only sin was carrying the env var. An explicit
// declaration therefore WINS over this table; the table only covers a caller
// that names a model and says nothing about width.
const EMBED_DIMS = { 'text-embedding-3-small': 1536, 'text-embedding-3-large': 3072 };
function embedEnvFrom(body) {
  const env = {};
  const model = typeof body?.embeddingModel === 'string' ? body.embeddingModel.trim() : '';
  const key = typeof body?.embeddingKey === 'string' ? body.embeddingKey.trim() : '';
  // Declared width (Matryoshka truncation). text-embedding-3-* accept any width
  // up to the model's native size, and the width is what the pgvector column is
  // sized to — so this is the ONE knob that decides a KB's vector footprint.
  //
  // How much that is worth, MEASURED (2026-08-06, same 80 docs / 611 chunks
  // ingested twice, dimension the only variable): 1536 → 79,692 KB on disk,
  // 512 → 73,452 KB. That is 7.8%, NOT the "~3× smaller store" this comment
  // used to claim — cutting the width cuts only the vector TOAST + HNSW index
  // (10.6 MB of a 28.6 MB database, and of a 77.8 MB directory once PGLite's
  // ~28 MB base and 32 MB of WAL are counted). Scale the saving off the VECTOR
  // share of a store, never off the store's total size. Reclaiming deleted
  // documents (see brain.js `compact`) is the bigger lever on a churning KB.
  //
  // Accepted as a number or a numeric string; anything else is ignored rather
  // than passed on as a malformed `--embedding-dimensions` that would fail init.
  const rawDims = body?.embeddingDimensions;
  const dims = Number.isFinite(Number(rawDims)) && Number(rawDims) > 0
    ? String(Math.floor(Number(rawDims)))
    : '';
  if (model) {
    // PROVIDER-QUALIFY the id. GBrain resolves a model as `<provider>:<model>`;
    // handed a bare `text-embedding-3-small` it reports provider "unknown" and
    // every embed pass fails — so the brain ends up vector-capable but empty of
    // vectors, which searches exactly like a keyword-only brain. The picker
    // stores bare ids, so normalize here rather than making every caller do it.
    const qualified = model.includes(':') ? model : `openai:${model}`;
    env.GBRAIN_EMBEDDING_MODEL = qualified;
    const bare = qualified.slice(qualified.indexOf(':') + 1);
    if (EMBED_DIMS[bare]) env.GBRAIN_EMBEDDING_DIMENSIONS = String(EMBED_DIMS[bare]);
  }
  // Explicit width wins over the per-model fallback, and stands on its own: a
  // caller may declare a width WITHOUT naming a model (keeping GBrain's default
  // model) — that is the whole point of exposing it as an independent knob.
  if (dims) env.GBRAIN_EMBEDDING_DIMENSIONS = dims;
  if (key) {
    env.OPENAI_API_KEY = key;   // GBrain reads the embedding key from OPENAI_API_KEY
    env.GBRAIN_EMBEDDING = '1'; // a key was supplied → force embeddings on
  }
  return env;
}

const PORT = Number(process.env.PORT) || 8080;
const AUTH_TOKEN = (process.env.SIDECAR_AUTH_TOKEN || '').trim();
const MAX_BODY = 25 * 1024 * 1024; // 25MB cap on a request body

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** True when the request is authorized (or auth is disabled). */
function authorized(req) {
  if (!AUTH_TOKEN) return true;
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return !!m && m[1].trim() === AUTH_TOKEN;
}

// ── Route handlers ──────────────────────────────────────────────────────────

async function handleIngest(body) {
  const kbId = typeof body?.kbId === 'string' ? body.kbId.trim() : '';
  const docs = Array.isArray(body?.docs) ? body.docs : null;
  if (!kbId) return { status: 400, body: { ok: false, error: 'kbId is required' } };
  if (!docs) return { status: 400, body: { ok: false, error: 'docs is required (array)' } };

  for (const d of docs) {
    if (!d || typeof d.sourceId !== 'string' || !d.sourceId.trim()) {
      return { status: 400, body: { ok: false, error: 'every doc requires a non-empty string sourceId' } };
    }
    if (d.deleted !== true && (typeof d.markdown !== 'string' || !d.markdown.length)) {
      return { status: 400, body: { ok: false, error: `doc "${d.sourceId}" has no markdown (required unless deleted:true)` } };
    }
  }

  const norm = docs.map((d) => ({ sourceId: d.sourceId.trim(), markdown: d.markdown, deleted: d.deleted === true }));
  const r = await withEmbedding(embedEnvFrom(body), () => ingest(kbId, norm));
  return { status: 200, body: { ok: true, ...r } };
}

async function handleQuery(body) {
  const kbId = typeof body?.kbId === 'string' ? body.kbId.trim() : '';
  const q = typeof body?.query === 'string' ? body.query.trim() : '';
  if (!kbId) return { status: 400, body: { ok: false, error: 'kbId is required' } };
  if (!q) return { status: 400, body: { ok: false, error: 'query is required' } };
  const topK = Number.isInteger(body?.topK) && body.topK > 0 ? Math.min(body.topK, 50) : 8;
  const r = await withEmbedding(embedEnvFrom(body), () => query(kbId, q, topK));
  // `mode` says how this brain actually searches ('vector' = hybrid vector+BM25,
  // 'lexical' = keyword only) and `stale` says it was frozen in a mode that
  // disagrees with the credentials on THIS request. Without them a keyword-only
  // brain answered semantic queries with an empty list and looked simply empty.
  return { status: 200, body: { ok: true, results: r.results, mode: r.mode, stale: r.stale } };
}

/**
 * DROP — destroy an entire brain (pages, vectors, slug map). Explicit and
 * irreversible: it exists so deleting a Store can really delete its data, and so
 * a brain frozen in the wrong search mode can be rebuilt from the caller's
 * archive. NOTHING calls it implicitly.
 */
async function handleDrop(body) {
  const kbId = typeof body?.kbId === 'string' ? body.kbId.trim() : '';
  if (!kbId) return { status: 400, body: { ok: false, error: 'kbId is required' } };
  if (body?.confirm !== true) return { status: 400, body: { ok: false, error: 'dropping a brain deletes all of its data — pass confirm:true' } };
  const r = await drop(kbId);
  return { status: 200, body: { ok: true, dropped: r.dropped } };
}

async function handleDelete(body) {
  const kbId = typeof body?.kbId === 'string' ? body.kbId.trim() : '';
  const sourceIds = Array.isArray(body?.sourceIds)
    ? body.sourceIds.filter((s) => typeof s === 'string' && s.trim())
    : null;
  if (!kbId) return { status: 400, body: { ok: false, error: 'kbId is required' } };
  if (!sourceIds) return { status: 400, body: { ok: false, error: 'sourceIds is required (array)' } };
  const r = await del(kbId, sourceIds.map((s) => s.trim()));
  return { status: 200, body: { ok: true, deleted: r.deleted } };
}

/**
 * STAT — how big this brain is and how many live documents it holds. Read-only
 * and side-effect free: an absent brain answers exists:false rather than being
 * created, so a size probe from a console page can never mint a brain.
 */
async function handleStat(body) {
  const kbId = typeof body?.kbId === 'string' ? body.kbId.trim() : '';
  if (!kbId) return { status: 400, body: { ok: false, error: 'kbId is required' } };
  const r = await stat(kbId);
  return { status: 200, body: { ok: true, ...r } };
}

/**
 * COMPACT — return the disk a deleted document still occupies.
 *
 * `/delete` is a SOFT delete (gbrain's 72h recovery window), and a soft-deleted
 * page's chunks, vectors and HNSW entries all stay on disk — so a KB that
 * churns only ever grows. This runs the two steps that actually reclaim:
 * gbrain's own hard purge, then VACUUM FULL. See brain.js `compact` for the
 * measurements showing neither step alone frees a single byte.
 *
 * Safe by default: `olderThanHours` defaults to gbrain's own 72h window, so a
 * plain call can never destroy a delete the user could still undo. Passing 0
 * waives that window and is the caller's explicit choice.
 */
async function handleCompact(body) {
  const kbId = typeof body?.kbId === 'string' ? body.kbId.trim() : '';
  if (!kbId) return { status: 400, body: { ok: false, error: 'kbId is required' } };

  let olderThanHours = 72;
  if (body?.olderThanHours != null) {
    const n = Number(body.olderThanHours);
    if (!Number.isFinite(n) || n < 0) {
      return { status: 400, body: { ok: false, error: 'olderThanHours must be a number >= 0' } };
    }
    olderThanHours = n;
  }
  const vacuum = body?.vacuum !== false;

  const r = await compact(kbId, { olderThanHours, vacuum });
  return { status: 200, body: { ok: true, ...r } };
}

const POST_ROUTES = {
  '/ingest': handleIngest,
  '/query': handleQuery,
  '/delete': handleDelete,
  '/drop': handleDrop,
  '/stat': handleStat,
  '/compact': handleCompact,
};

const server = http.createServer(async (req, res) => {
  try {
    const url = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && (url === '/health' || url === '/')) {
      try {
        await health();
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 503, { ok: false, error: String(e?.message || e) });
      }
    }

    const handler = POST_ROUTES[url];
    if (req.method === 'POST' && handler) {
      if (!authorized(req)) {
        return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        return sendJson(res, e.statusCode || 400, { ok: false, error: e.message });
      }
      const out = await handler(body);
      return sendJson(res, out.status, out.body);
    }

    return sendJson(res, 404, { ok: false, error: `not found: ${req.method} ${url}` });
  } catch (e) {
    // Never leak a stack; return a clean 500.
    return sendJson(res, 500, { ok: false, error: String(e?.message || e) });
  }
});

async function main() {
  // Confirm the real gbrain binary is runnable up front so a broken image fails
  // loudly at boot rather than on the first request.
  await health();
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[gbrain-sidecar] listening on :${PORT} (engine=real-gbrain, auth=${AUTH_TOKEN ? 'on' : 'off'})`);
  });
}

// Only auto-start when run directly (not when imported, e.g. by a test).
if (import.meta.main) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[gbrain-sidecar] fatal:', e);
    process.exit(1);
  });
}

export { server, handleIngest, handleQuery, handleDelete, handleDrop, handleStat, handleCompact };
