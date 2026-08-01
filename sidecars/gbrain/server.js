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
 *   GET  /health  → { ok }
 *
 * Auth: if SIDECAR_AUTH_TOKEN is set, POST routes require
 * `Authorization: Bearer <token>` (else 401). Unset ⇒ no auth (private network).
 */

import http from 'node:http';
import { ingest, query, del, drop, health, withEmbedding } from './brain.js';

// Per-agent embedding overrides carried on the request (set by the control-plane
// from the deploying agent's snapshotted config). Maps to the env GBrain reads.
// The dimension is baked into the store at creation, so we pin it per known model.
const EMBED_DIMS = { 'text-embedding-3-small': 1536, 'text-embedding-3-large': 3072 };
function embedEnvFrom(body) {
  const env = {};
  const model = typeof body?.embeddingModel === 'string' ? body.embeddingModel.trim() : '';
  const key = typeof body?.embeddingKey === 'string' ? body.embeddingKey.trim() : '';
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

const POST_ROUTES = {
  '/ingest': handleIngest,
  '/query': handleQuery,
  '/delete': handleDelete,
  '/drop': handleDrop,
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

export { server, handleIngest, handleQuery, handleDelete, handleDrop };
