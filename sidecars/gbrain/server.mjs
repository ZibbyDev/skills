/**
 * server.mjs — the KB sidecar HTTP server (Node built-in `http`, no framework).
 *
 * Implements the stable, engine-agnostic REST contract that the @zibby/skills
 * `gbrain` skill calls (see src/gbrain.js "SIDECAR HTTP CONTRACT"):
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
import { upsertDoc, deleteSources, query, getDb, stats } from './db.mjs';

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

  let upserted = 0;
  let chunks = 0;
  const toDelete = [];

  for (const d of docs) {
    if (!d || typeof d.sourceId !== 'string' || !d.sourceId.trim()) {
      return { status: 400, body: { ok: false, error: 'every doc requires a non-empty string sourceId' } };
    }
    const sourceId = d.sourceId.trim();
    if (d.deleted === true) {
      toDelete.push(sourceId);
      continue;
    }
    if (typeof d.markdown !== 'string' || !d.markdown.length) {
      return { status: 400, body: { ok: false, error: `doc "${sourceId}" has no markdown (required unless deleted:true)` } };
    }
    // eslint-disable-next-line no-await-in-loop
    const r = await upsertDoc(kbId, sourceId, d.markdown);
    upserted += 1;
    chunks += r.chunks;
  }

  let deleted = 0;
  if (toDelete.length > 0) {
    const r = await deleteSources(kbId, toDelete);
    deleted = r.deleted;
  }

  return { status: 200, body: { ok: true, upserted, deleted, chunks } };
}

async function handleQuery(body) {
  const kbId = typeof body?.kbId === 'string' ? body.kbId.trim() : '';
  const q = typeof body?.query === 'string' ? body.query.trim() : '';
  if (!kbId) return { status: 400, body: { ok: false, error: 'kbId is required' } };
  if (!q) return { status: 400, body: { ok: false, error: 'query is required' } };
  const topK = Number.isInteger(body?.topK) && body.topK > 0 ? body.topK : 8;
  const results = await query(kbId, q, topK);
  return { status: 200, body: { ok: true, results } };
}

async function handleDelete(body) {
  const kbId = typeof body?.kbId === 'string' ? body.kbId.trim() : '';
  const sourceIds = Array.isArray(body?.sourceIds) ? body.sourceIds : null;
  if (!kbId) return { status: 400, body: { ok: false, error: 'kbId is required' } };
  if (!sourceIds) return { status: 400, body: { ok: false, error: 'sourceIds is required (array)' } };
  const r = await deleteSources(kbId, sourceIds);
  return { status: 200, body: { ok: true, deleted: r.deleted } };
}

const POST_ROUTES = {
  '/ingest': handleIngest,
  '/query': handleQuery,
  '/delete': handleDelete,
};

const server = http.createServer(async (req, res) => {
  try {
    const url = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && (url === '/health' || url === '/')) {
      return sendJson(res, 200, { ok: true });
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
  // Open the DB up front so /health only returns ok once the brain is ready.
  await getDb();
  const s = await stats().catch(() => ({ chunks: 0 }));
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[gbrain-sidecar] listening on :${PORT} (chunks=${s.chunks}, auth=${AUTH_TOKEN ? 'on' : 'off'})`);
  });
}

// Only auto-start when run directly (not when imported, e.g. by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[gbrain-sidecar] fatal:', e);
    process.exit(1);
  });
}

export { server, handleIngest, handleQuery, handleDelete };
