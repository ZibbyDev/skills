/**
 * brain.js — the thin adapter that maps Zibby's engine-agnostic KB REST
 * contract onto the REAL GBrain (github.com/garrytan/gbrain, MIT).
 *
 * This file does NOT reimplement a knowledge base. It drives the actual
 * `gbrain` CLI (vendored as a pinned dependency — see VENDOR.md) which runs
 * GBrain's real ingestion (chunk + embed + index), its real hybrid search
 * (vector + BM25 + RRF + graph signals), and its real soft-delete. Each call
 * shells out to a GBrain operation:
 *
 *   /ingest  → `gbrain capture --file <md> --slug <slug>`  (put_page: chunk+embed+index)
 *              deleted:true → `gbrain call delete_page`     (soft-delete)
 *   /query   → `gbrain call query {query, limit}`           (hybrid search)
 *   /delete  → `gbrain call delete_page {slug}`             (soft-delete)
 *
 * MULTI-TENANCY — one sidecar, many tenants, ZERO cross-tenant reach:
 *   Every kbId maps to its OWN GBrain "brain" (its own PGLite database) via a
 *   per-kbId GBRAIN_HOME dir. GBrain resolves `${GBRAIN_HOME}/.gbrain/brain.pglite`
 *   at call time, so two kbIds are two physically separate databases that
 *   cannot see each other. The kbId is hashed into the dir name so it is both
 *   path-safe and non-enumerable.
 *
 * sourceId ↔ slug:
 *   The contract addresses documents by an arbitrary `sourceId`. GBrain
 *   addresses pages by a `slug` with a restricted grammar. We map injectively
 *   with `doc/<sha256(sourceId)>` (always a valid slug) and persist the reverse
 *   slug→sourceId map per brain so query results can be reported by sourceId.
 */

import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  mkdir, writeFile, readFile, rm, rename, access, readdir, stat as fsStat,
} from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DATA_ROOT = process.env.GBRAIN_DATA_ROOT || '/data';
// Resolve the vendored gbrain bin; PATH also carries node_modules/.bin in the image.
const GBRAIN_BIN = process.env.GBRAIN_BIN || 'gbrain';
const OP_TIMEOUT_MS = Number(process.env.GBRAIN_OP_TIMEOUT_MS) || 120_000;

// Embedding providers GBrain reads straight from the process env. If any key is
// present we let GBrain wire up semantic embeddings at init; otherwise we init
// with --no-embedding so the brain still boots + serves keyword/BM25 hybrid
// search fully offline. Force either way with GBRAIN_EMBEDDING=1 / GBRAIN_NO_EMBEDDING=1.
const EMBED_KEYS = [
  'OPENAI_API_KEY', 'ZEROENTROPY_API_KEY', 'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY', 'VOYAGE_API_KEY', 'AZURE_OPENAI_API_KEY',
  'DASHSCOPE_API_KEY', 'ZHIPU_API_KEY', 'MINIMAX_API_KEY',
];

// Read an embedding setting the way the SPAWNED gbrain will see it: the
// per-request overrides withEmbedding() carries WIN over the container env.
//
// This is the whole ballgame. On this platform the embedding key is per-AGENT
// and arrives ON THE REQUEST — a shared multi-tenant sidecar must never hold one
// tenant's key as container env (north-star #9). So the container env has no key
// by design, and a decision that consults only `process.env` concludes "no
// embeddings" on EVERY request, forever. That is what happened: the key was
// threaded faithfully into every gbrain subprocess, and then ignored by the one
// decision that mattered — `ensureBrain` passed `--no-embedding`, which freezes
// at creation, so every brain became keyword-only for life while its config.json
// still advertised text-embedding-3-large. Symptom: exact-token queries hit with
// BM25 scores, semantically-equivalent queries returned nothing.
function embedSetting(k) {
  const o = _embedCtx.getStore();
  const v = (o && o[k] != null) ? o[k] : process.env[k];
  return v == null ? '' : String(v);
}

function embeddingsEnabled() {
  if (embedSetting('GBRAIN_NO_EMBEDDING') === '1') return false;
  if (embedSetting('GBRAIN_EMBEDDING') === '1') return true;
  return EMBED_KEYS.some((k) => embedSetting(k).trim().length > 0);
}

// What the OLD (pre-fix) code would have decided for a brain created before the
// marker existed — a pure function of container env, so it reconstructs exactly.
// Used to classify legacy brains instead of guessing.
function legacyEmbeddingsEnabled() {
  if (process.env.GBRAIN_NO_EMBEDDING === '1') return false;
  if (process.env.GBRAIN_EMBEDDING === '1') return true;
  return EMBED_KEYS.some((k) => (process.env[k] || '').trim().length > 0);
}

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** kbId → its own brain dir (path-safe, non-enumerable). GBRAIN_HOME points here. */
function brainDirFor(kbId) {
  return join(DATA_ROOT, `kb-${sha256(kbId).slice(0, 40)}`);
}

/** sourceId → a valid, injective GBrain page slug. */
function slugForSourceId(sourceId) {
  return `doc/${sha256(sourceId)}`;
}

// ── per-brain serialization ────────────────────────────────────────────────
// PGLite takes a single-writer file lock per data dir, so concurrent gbrain
// subprocesses on the SAME brain would collide. Serialize per brain; different
// brains (kbIds) still run fully in parallel.
const _locks = new Map();
function withBrainLock(brainDir, fn) {
  const prev = _locks.get(brainDir) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  _locks.set(brainDir, next.catch(() => {}));
  return next;
}

// ── gbrain subprocess ───────────────────────────────────────────────────────
// Per-REQUEST embedding overrides (model/key), threaded WITHOUT touching every
// function signature: the server wraps an ingest/query call in withEmbedding(),
// and every nested gbrain spawn (init + capture + query) reads the same store.
// AsyncLocalStorage keeps it concurrency-safe — two kbIds running in parallel
// each see their own overrides. GBrain reads GBRAIN_EMBEDDING_MODEL /
// GBRAIN_EMBEDDING_DIMENSIONS / OPENAI_API_KEY from its (per-spawn) env, so a
// per-agent model+key takes effect with NO gbrain fork. The model is baked into
// the brain at creation (pgvector dimension) → per-store, fixed for its lifetime.
const _embedCtx = new AsyncLocalStorage();
export function withEmbedding(embedEnv, fn) {
  if (!embedEnv || Object.keys(embedEnv).length === 0) return fn();
  return _embedCtx.run(embedEnv, fn);
}

function runGbrain(brainDir, args) {
  return new Promise((resolve) => {
    const child = spawn(GBRAIN_BIN, args, {
      env: {
        ...process.env,
        // Per-agent embedding overrides win over the box-global env (else inherit).
        ...(_embedCtx.getStore() || {}),
        GBRAIN_HOME: brainDir,
        // Keep the CLI from retrying a wedged connect for the whole timeout.
        GBRAIN_NO_RETRY_CONNECT: '1',
        // Never let the CLI phone home for update checks inside a run.
        GBRAIN_NO_UPDATE_CHECK: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, OP_TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(e && e.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// ── persistent `gbrain serve` per brain (PERF) ───────────────────────────────
// The per-op spawn above RELOADS the whole PGLite brain into memory every call,
// so bulk ingest cost scaled O(brain-size) per doc (quadratic). Instead keep ONE
// long-running `gbrain serve` (its MCP stdio server mode — gbrain's intended
// server usage) per brain, holding the brain OPEN, and send each op as an MCP
// tools/call. Idle-reaped like the container's own warm/reap model. The embedding
// env is baked at spawn — correct, since a brain's vector dimension (model) is
// fixed for its lifetime; a rotated key is picked up on the next reap+relaunch.
const _serves = new Map(); // brainDir → serve session
const SERVE_IDLE_MS = Number(process.env.GBRAIN_SERVE_IDLE_MS) || 300_000;

function startServe(brainDir) {
  const proc = spawn(GBRAIN_BIN, ['serve'], {
    env: {
      ...process.env,
      ...(_embedCtx.getStore() || {}),
      GBRAIN_HOME: brainDir,
      GBRAIN_NO_UPDATE_CHECK: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const s = { proc, pending: new Map(), buf: '', seq: 1, lastUsed: Date.now() };
  proc.stdout.on('data', (d) => {
    s.buf += d;
    let idx;
    // eslint-disable-next-line no-cond-assign
    while ((idx = s.buf.indexOf('\n')) >= 0) {
      const line = s.buf.slice(0, idx); s.buf = s.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && s.pending.has(msg.id)) {
        const { resolve, reject, timer } = s.pending.get(msg.id); s.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error((msg.error.message || 'gbrain error').slice(0, 300)));
        else resolve(msg.result);
      }
    }
  });
  proc.stderr.on('data', () => {}); // gbrain logs to stderr; ignore
  const fail = (e) => { for (const { reject, timer } of s.pending.values()) { clearTimeout(timer); reject(e); } s.pending.clear(); if (_serves.get(brainDir) === s) _serves.delete(brainDir); };
  proc.on('exit', () => fail(new Error('gbrain serve exited')));
  proc.on('error', (e) => fail(new Error(`gbrain serve error: ${e.message}`)));
  s.initialized = rpc(s, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gbrain-sidecar', version: '1' } })
    .then(() => { try { s.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`); } catch { /* ignore */ } });
  return s;
}

function rpc(s, method, params) {
  const id = s.seq++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { if (s.pending.has(id)) { s.pending.delete(id); reject(new Error(`gbrain ${method} timeout`)); } }, OP_TIMEOUT_MS);
    s.pending.set(id, { resolve, reject, timer });
    try { s.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }
    catch (e) { s.pending.delete(id); clearTimeout(timer); reject(e); }
  });
}

async function getServe(brainDir) {
  let s = _serves.get(brainDir);
  if (!s || s.proc.exitCode != null || s.proc.killed) { s = startServe(brainDir); _serves.set(brainDir, s); }
  await s.initialized;
  s.lastUsed = Date.now();
  return s;
}

// Release this brain's persistent `gbrain serve` (and with it the single-writer
// PGLite lock) so a one-off CLI pass can open the same database. The next
// serveCall lazily starts a fresh one.
function stopServe(brainDir) {
  const s = _serves.get(brainDir);
  if (!s) return;
  _serves.delete(brainDir);
  try { s.proc.stdin.end(); } catch { /* ignore */ }
  try { s.proc.kill('SIGTERM'); } catch { /* ignore */ }
}

// Call a gbrain MCP tool on the brain's persistent serve process. Returns the
// tool's JSON payload (MCP wraps it as content[0].text). Throws on tool error.
async function serveCall(brainDir, tool, args) {
  const s = await getServe(brainDir);
  s.lastUsed = Date.now();
  const res = await rpc(s, 'tools/call', { name: tool, arguments: args || {} });
  const text = res && res.content && res.content[0] && res.content[0].text;
  if (res && res.isError) throw new Error((typeof text === 'string' ? text : 'gbrain tool error').slice(0, 300));
  if (typeof text !== 'string') return text;
  try { return JSON.parse(text); } catch { return text; }
}

setInterval(() => {
  const now = Date.now();
  for (const [dir, s] of _serves) {
    if (now - s.lastUsed > SERVE_IDLE_MS) {
      try { s.proc.stdin.end(); } catch { /* ignore */ }
      try { s.proc.kill('SIGTERM'); } catch { /* ignore */ }
      _serves.delete(dir);
    }
  }
}, 60_000).unref?.();

/**
 * Extract the JSON value a `gbrain call`/`capture --json` command printed to
 * stdout. GBrain logs to stderr, so stdout is the JSON — but we still locate
 * the first well-formed JSON value defensively.
 */
function parseGbrainJson(stdout) {
  const trimmed = (stdout || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const start = trimmed.search(/[[{]/);
  if (start >= 0) {
    try { return JSON.parse(trimmed.slice(start)); } catch { /* ignore */ }
  }
  return null;
}

// ── brain lifecycle ──────────────────────────────────────────────────────────
const _initialized = new Set();

async function pathExists(p) {
  try { await access(p); return true; } catch { return false; }
}

// The brain's OWN record of how it was initialized. gbrain's config.json is NOT
// usable for this: it writes `embedding_model: openai:text-embedding-3-large`
// even when created with --no-embedding, so it reports a capability the brain
// does not have. This marker is written by us, from the decision we actually
// made, so "is this brain vector-capable?" has a truthful answer.
function markerPathFor(brainDir) {
  return join(brainDir, 'adapter', 'embedding.json');
}

async function readMarker(brainDir) {
  try {
    const m = JSON.parse(await readFile(markerPathFor(brainDir), 'utf8'));
    return (m && typeof m === 'object' && typeof m.embeddings === 'boolean') ? m : null;
  } catch { return null; }
}

async function writeMarker(brainDir, embeddings) {
  try {
    await mkdir(join(brainDir, 'adapter'), { recursive: true });
    await writeFile(markerPathFor(brainDir), JSON.stringify({
      embeddings, model: embedSetting('GBRAIN_EMBEDDING_MODEL') || null, at: new Date().toISOString(),
    }), 'utf8');
  } catch { /* the marker is diagnostics — never fail an ingest over it */ }
}

/**
 * How this brain SEARCHES, as opposed to how it is configured:
 *   { mode: 'vector'|'lexical', stale: boolean }
 * `stale` = the brain was frozen in a mode that disagrees with what this request
 * can do (almost always: created keyword-only before a key was available, and a
 * key is present now). It is REPORTED, never acted on — the brain is destroyed
 * and rebuilt only by an explicit /drop, because a KB may hold pages saved
 * straight from an editor that exist nowhere else. Silent rebuild = data loss.
 */
async function embeddingState(brainDir) {
  const want = embeddingsEnabled();
  const marker = await readMarker(brainDir);
  // No marker → the brain predates it, so reconstruct the old code's decision.
  const have = marker ? marker.embeddings : legacyEmbeddingsEnabled();
  return { mode: have ? 'vector' : 'lexical', stale: want !== have };
}

/** Create + init the kbId's GBrain brain once (idempotent). */
async function ensureBrain(brainDir) {
  if (_initialized.has(brainDir)) return;
  const configPath = join(brainDir, '.gbrain', 'config.json');
  if (await pathExists(configPath)) { _initialized.add(brainDir); return; }

  await mkdir(brainDir, { recursive: true });
  const embeddings = embeddingsEnabled();
  const args = ['init', '--pglite', '--non-interactive', '--json'];
  if (!embeddings) {
    args.push('--no-embedding');
  } else {
    // NAME THE MODEL AT INIT. Setting GBRAIN_EMBEDDING_MODEL in the environment
    // does NOT configure the brain — gbrain takes the model from its init flag
    // and otherwise writes its own default, which is how a brain asked for
    // text-embedding-3-small ended up recorded as text-embedding-3-large while
    // carrying our 1536 dimensions (3-large is natively 3072): a vector space
    // that matches nothing. The flag wants a PROVIDER-QUALIFIED id.
    const m = embedSetting('GBRAIN_EMBEDDING_MODEL').trim();
    if (m) args.push('--embedding-model', m.includes(':') ? m : `openai:${m}`);
    const dims = embedSetting('GBRAIN_EMBEDDING_DIMENSIONS').trim();
    if (dims) args.push('--embedding-dimensions', dims);
  }
  const r = await runGbrain(brainDir, args);
  // init can print a large skillpack suggestion; success is the exit code +
  // the presence of the brain's config.json.
  if (r.code !== 0 && !(await pathExists(configPath))) {
    throw new Error(`gbrain init failed (code ${r.code}): ${(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
  await writeMarker(brainDir, embeddings);
  // eslint-disable-next-line no-console
  console.log(`[gbrain] brain created: embeddings=${embeddings ? 'ON (vector+BM25 hybrid)' : 'OFF (keyword/BM25 only)'}`);
  _initialized.add(brainDir);
}

/**
 * DESTROY a whole brain — every page, its vectors and its slug map. The ONLY
 * way a brain's data goes away: nothing implicit ever deletes one (a store
 * delete in the control-plane calls this explicitly, and a mode rebuild is
 * drop-then-reingest from the caller's archive). Idempotent: dropping a brain
 * that was never created succeeds with dropped:false.
 */
export async function drop(kbId) {
  const brainDir = brainDirFor(kbId);
  return withBrainLock(brainDir, async () => {
    const existed = await pathExists(brainDir);
    if (existed) await rm(brainDir, { recursive: true, force: true });
    _initialized.delete(brainDir);
    // eslint-disable-next-line no-console
    console.log(`[gbrain] drop ${existed ? 'removed' : 'no-op (absent)'}: ${brainDir}`);
    return { dropped: existed };
  });
}

/**
 * RECLAIM disk a deleted document still occupies. Measured, not assumed
 * (2026-08-06, 80-doc brain, 30 docs deleted = 43%):
 *
 *   soft delete (what `delete` does)  79,688 KB → 80,728 KB   (+1 MB, GROWS)
 *   + purge_deleted_pages (hard)      80,728 KB → 80,720 KB   (unchanged)
 *   + VACUUM FULL                     80,720 KB → 65,904 KB   (-14.8 MB)
 *
 * BOTH halves are required and NEITHER is enough alone — that pair is the whole
 * reason a KB only ever grows. gbrain's `delete_page` is a soft delete by
 * design (72h recovery window); its own `purge_deleted_pages` then hard-deletes
 * past that window, cascading content_chunks/page_links/chunk_relations. But
 * gbrain has NO VACUUM anywhere in its source and no raw-SQL op, so a hard
 * delete only returns rows to the free-space map — the file never shrinks.
 * PGLite runs no autovacuum daemon either, so nothing ever does it implicitly.
 *
 * Hence: purge through gbrain (it owns the cascade), then VACUUM through the
 * PGLite store directly, which is the half gbrain does not offer.
 *
 * `olderThanHours` is gbrain's own recovery window and defaults to its 72 —
 * pass 0 only when the caller has accepted that in-window deletes become
 * unrecoverable.
 */
export async function compact(kbId, { olderThanHours = 72, vacuum = true } = {}) {
  const brainDir = brainDirFor(kbId);
  if (!(await pathExists(brainDir))) return { exists: false, reclaimedBytes: 0 };
  return withBrainLock(brainDir, async () => {
    const beforeBytes = await dirSizeBytes(brainDir);

    // 1. Hard-delete through gbrain itself. purge_deleted_pages is marked
    //    admin+localOnly, but BOTH of those filters live in serve-http.ts —
    //    the stdio `gbrain serve` this adapter drives applies neither.
    const purged = await serveCall(brainDir, 'purge_deleted_pages', {
      older_than_hours: olderThanHours,
    });
    const purgedCount = Number(purged && purged.count) || 0;

    // 2. VACUUM needs the single-writer PGLite lock, which the persistent serve
    //    holds. Drop it first; the next serveCall lazily starts a fresh one.
    stopServe(brainDir);

    let vacuumed = false;
    let vacuumError = null;
    if (vacuum) {
      try {
        await vacuumFull(brainDir);
        vacuumed = true;
      } catch (e) {
        // A failed VACUUM must not lose the purge: report it and keep the
        // (already durable) hard-delete rather than throwing the whole call.
        vacuumError = String((e && e.message) || e).slice(0, 300);
      }
    }

    const afterBytes = await dirSizeBytes(brainDir);
    // Signed on purpose: VACUUM FULL rewrites every table, and that rewrite is
    // itself WAL-logged. On a SMALL brain the new WAL segments outweigh what
    // the rewrite frees and the directory ends up BIGGER (measured: a 42.7 MB
    // smoke brain went to 59.4 MB). Clamping this at 0 would report that as
    // "reclaimed nothing" instead of "cost you 17 MB" — the caller must be able
    // to see it, so compaction stays worth doing only where it actually pays
    // (large, churned stores — the 80-doc brain above reclaimed 14.8 MB).
    const reclaimedBytes = beforeBytes - afterBytes;
    // eslint-disable-next-line no-console
    console.log(`[gbrain] compact ${brainDir}: purged=${purgedCount} vacuumed=${vacuumed} `
      + `${beforeBytes} → ${afterBytes} bytes (${reclaimedBytes >= 0 ? 'reclaimed' : 'GREW BY'} `
      + `${Math.abs(reclaimedBytes)})`);
    return {
      exists: true,
      purgedCount,
      vacuumed,
      vacuumError,
      beforeBytes,
      afterBytes,
      reclaimedBytes,
    };
  });
}

/**
 * VACUUM FULL the brain's PGLite store, opened directly.
 *
 * The extension set MUST match what gbrain opens with (pglite-engine.ts:302):
 * VACUUM FULL rewrites every table including content_chunks, whose `embedding`
 * is a pgvector type — without the vector extension loaded the rewrite fails
 * with `could not access file "$libdir/vector"`.
 *
 * @electric-sql/pglite is resolved from gbrain's own node_modules rather than
 * declared here on purpose: there must be exactly ONE PGLite build touching a
 * given store. Sharing gbrain's copy makes that true by construction instead of
 * by a version pin that could silently drift out of step with the vendored
 * commit. A mismatch cannot pass silently either — an incompatible build fails
 * to open the store and surfaces as vacuumError.
 */
async function vacuumFull(brainDir) {
  const [{ PGlite }, { vector }, { pg_trgm }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('@electric-sql/pglite/vector'),
    import('@electric-sql/pglite/contrib/pg_trgm'),
  ]);
  const db = new PGlite(join(brainDir, '.gbrain', 'brain.pglite'), {
    extensions: { vector, pg_trgm },
  });
  try {
    await db.waitReady;
    await db.query('VACUUM FULL');
  } finally {
    try { await db.close(); } catch { /* already closed */ }
  }
}

// ── slug↔sourceId map (per brain, our own metadata, outside .gbrain) ──────────
function mapPathFor(brainDir) {
  return join(brainDir, 'adapter', 'sourcemap.json');
}

/**
 * Read the map, DISTINGUISHING "no map yet" from "unreadable map".
 *   { ok:true,  map }  — parsed (an absent file is an empty map: a brand-new brain)
 *   { ok:false, map:{} } — present but unparseable/unreadable
 * The difference matters for anything that REPORTS on the map (stat's document
 * count): "0 documents" and "I can't tell" are different answers, and printing
 * the first when the second is true is a lie about the user's data.
 */
async function readMap(brainDir) {
  let raw;
  try {
    raw = await readFile(mapPathFor(brainDir), 'utf8');
  } catch (e) {
    // ENOENT = never saved = genuinely empty. Any other read error is unknown.
    return e && e.code === 'ENOENT' ? { ok: true, map: {} } : { ok: false, map: {} };
  }
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? { ok: true, map: obj } : { ok: false, map: {} };
  } catch { return { ok: false, map: {} }; }
}

/** The map, or {} if it can't be read — for the OPERATIONS, which recover by
 *  rewriting it. Reporting paths use readMap() and say "unknown" instead. */
async function loadMap(brainDir) {
  return (await readMap(brainDir)).map;
}

/**
 * ATOMIC replace: write a temp file in the same dir, then rename over the target
 * (rename is atomic within a filesystem). A plain writeFile truncates first, so
 * any concurrent reader — a lock-free stat probe, or the next ingest if the
 * process dies mid-write — can observe a HALF-WRITTEN map and parse it as empty.
 * That silently turns a populated KB into "0 documents". The temp name carries a
 * random suffix so two writers can never collide on it.
 */
async function saveMap(brainDir, map) {
  const p = mapPathFor(brainDir);
  await mkdir(join(brainDir, 'adapter'), { recursive: true });
  const tmp = `${p}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(map), 'utf8');
  try {
    await rename(tmp, p);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

// ── op: soft-delete a slug; returns true iff a page was actually removed ──────
async function deleteSlug(brainDir, slug) {
  // delete_page → { status: 'soft_deleted' | 'already_soft_deleted' } on success,
  // or an error for an absent slug (page_not_found) → treat as "nothing removed".
  const res = await serveCall(brainDir, 'delete_page', { slug }).catch((e) => {
    if (/not_found|not found/i.test(e.message || '')) return { status: 'not_found' };
    throw e;
  });
  return !!res && (res.status === 'soft_deleted' || res.status === 'already_soft_deleted');
}

// ── op: upsert one markdown doc as a GBrain page ─────────────────────────────
async function upsertDoc(brainDir, slug, markdown) {
  // A previously soft-deleted slug must come back live on re-ingest. restore is
  // a cheap in-process call on the persistent serve (no brain reload); ignore the
  // harmless "page live / absent" error.
  try { await serveCall(brainDir, 'restore_page', { slug }); } catch { /* live/absent — fine */ }
  const res = await serveCall(brainDir, 'put_page', { slug, content: markdown, source_kind: 'capture-cli' });
  const outSlug = res && (res.slug || (res.page && res.page.slug));
  if (!res || !outSlug) throw new Error(`gbrain put_page failed for ${slug}: ${JSON.stringify(res).slice(0, 200)}`);
  return { chunks: Number((res.chunks != null ? res.chunks : (res.page && res.page.chunks))) || 0 };
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — one function per REST route. Each returns the exact response
// body shape the contract (and backend/src/handlers/postgres-store.js) expects.
// ═══════════════════════════════════════════════════════════════════════════

/** POST /ingest → { upserted, deleted, chunks } */
export async function ingest(kbId, docs) {
  const brainDir = brainDirFor(kbId);
  return withBrainLock(brainDir, async () => {
    await ensureBrain(brainDir);
    const map = await loadMap(brainDir);
    let upserted = 0;
    let deleted = 0;
    let chunks = 0;

    for (const d of docs) {
      const slug = slugForSourceId(d.sourceId);
      if (d.deleted === true) {
        if (await deleteSlug(brainDir, slug)) deleted += 1;
        delete map[slug];
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await upsertDoc(brainDir, slug, d.markdown);
      upserted += 1;
      chunks += r.chunks;
      map[slug] = d.sourceId;
    }
    await saveMap(brainDir, map);

    // EMBED. `put_page` writes the page and its keyword index — it does NOT
    // generate vectors; in GBrain that is a separate `gbrain embed` pass. Skip
    // it and a brain with embeddings ON and a live key still holds ZERO vectors,
    // so every search silently degrades to keyword-only: the exact words in the
    // document hit, a paraphrase of them returns nothing. That is precisely how
    // an 80-document corpus ended up unsearchable by meaning while looking fine.
    // Once per BATCH (not per doc) and over --stale, so it costs one pass over
    // what this batch actually changed. `serve` holds the single-writer PGLite
    // lock, so it has to stand down for the CLI — the next query restarts it.
    if (upserted > 0 && embeddingsEnabled()) {
      stopServe(brainDir);
      const r = await runGbrain(brainDir, ['embed', '--stale']);
      if (r.code !== 0) {
        // Non-fatal: the documents ARE stored and keyword-searchable. Say so
        // loudly rather than failing the ingest — but never pretend it worked.
        // eslint-disable-next-line no-console
        console.warn(`[gbrain] embed pass FAILED (code ${r.code}) — documents are stored but NOT vector-searchable: ${(r.stderr || r.stdout || '').slice(0, 300)}`);
      } else {
        // eslint-disable-next-line no-console
        console.log(`[gbrain] embed --stale done for ${upserted} upserted doc(s)`);
      }
    }

    // Report HOW this brain searches. A caller that just wrote 80 documents into
    // a keyword-only brain must be able to find that out from the write itself
    // — the old contract gave no way to tell vector from lexical, which is how a
    // whole corpus got indexed the wrong way without a single warning.
    return { upserted, deleted, chunks, ...(await embeddingState(brainDir)) };
  });
}

/** POST /query → { results: [{ sourceId, chunk, score }] } */
export async function query(kbId, queryText, topK) {
  const brainDir = brainDirFor(kbId);
  return withBrainLock(brainDir, async () => {
    await ensureBrain(brainDir);
    const map = await loadMap(brainDir);
    // FLOOR THE FETCH DEPTH. GBrain's `limit` is not "top-N of one ranking" —
    // it also sets each retrieval lane's candidate depth before RRF fusion, so
    // a small limit LOSES documents outright: the same doc that ranks #1 at
    // limit 5 is ABSENT at limit 3 (reproduced verbatim — the BM25 lane's
    // candidates crowd the pool and the vector lane's never make it in). Fetch
    // at a depth where fusion behaves, then slice to what the caller asked for:
    // same contract, recall restored.
    const fetchK = Math.max(Number(topK) || 8, 8);
    const out = await serveCall(brainDir, 'query', { query: queryText, limit: fetchK });
    const arr = Array.isArray(out) ? out
      : (out && Array.isArray(out.results) ? out.results
        : (out && Array.isArray(out.hits) ? out.hits : []));
    const results = arr.slice(0, Number(topK) || fetchK).map((hit) => ({
      sourceId: map[hit.slug] || hit.slug,
      chunk: hit.chunk_text || hit.chunk || hit.text || '',
      score: typeof hit.score === 'number' ? hit.score : 0,
    }));
    return { results, ...(await embeddingState(brainDir)) };
  });
}

/** POST /delete → { deleted } */
export async function del(kbId, sourceIds) {
  const brainDir = brainDirFor(kbId);
  return withBrainLock(brainDir, async () => {
    await ensureBrain(brainDir);
    const map = await loadMap(brainDir);
    let deleted = 0;
    for (const sourceId of sourceIds) {
      const slug = slugForSourceId(sourceId);
      // eslint-disable-next-line no-await-in-loop
      if (await deleteSlug(brainDir, slug)) deleted += 1;
      delete map[slug];
    }
    await saveMap(brainDir, map);
    return { deleted };
  });
}

/**
 * POST /stat → { exists, sizeBytes, docs }
 *
 * What a brain COSTS and how much is in it — the read the control-plane needs to
 * show a sidecar-backed store's Size the way an object-store-backed one shows
 * the sum of its prefix. Object-store types sum their S3 prefix; a sidecar type
 * has no prefix to sum, so the engine has to answer for itself.
 *
 * DELIBERATELY lock-free (no withBrainLock): a size probe must never queue
 * behind a long ingest, and must never make one wait. The consequence is that a
 * stat taken mid-ingest reports a mid-write size — correct for a "how big is
 * this" number, and the alternative (a page load blocked behind a 5-minute
 * corpus ingest) is far worse. Nothing is created: an absent brain is
 * { exists:false, sizeBytes:0, docs:0 }, never an init.
 *
 * `docs` = LIVE documents (the slug↔sourceId map, which ingest/delete prune),
 * not chunks and not soft-deleted pages. It is **null** when the map exists but
 * can't be read: mid-write bytes must surface as "unknown", never as a confident
 * 0 that tells the user their populated KB is empty.
 */
export async function stat(kbId) {
  const brainDir = brainDirFor(kbId);
  if (!(await pathExists(brainDir))) return { exists: false, sizeBytes: 0, docs: 0 };
  const m = await readMap(brainDir);
  return {
    exists: true,
    sizeBytes: await dirSizeBytes(brainDir),
    docs: m.ok ? Object.keys(m.map).length : null,
  };
}

/**
 * Recursive byte size of `dir`. REGULAR FILES ONLY: a symlink is skipped
 * entirely (isFile() is false for one, and we never follow it), so a link
 * pointing out of the brain dir can't make one brain report another's bytes —
 * the few link-sized bytes it costs us are not worth that risk. Best-effort per
 * entry: a file that disappears mid-walk (a gbrain temp) contributes 0 instead
 * of failing the probe.
 */
async function dirSizeBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch { return 0; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      // eslint-disable-next-line no-await-in-loop
      total += await dirSizeBytes(p);
    } else if (e.isFile()) {
      try {
        // eslint-disable-next-line no-await-in-loop
        total += (await fsStat(p)).size;
      } catch { /* vanished mid-walk — count 0 */ }
    }
  }
  return total;
}

/** GET /health — verify the real gbrain binary is runnable. */
let _healthOk = null;
export async function health() {
  if (_healthOk === true) return true;
  const r = await runGbrain(DATA_ROOT, ['--version']);
  _healthOk = r.code === 0;
  if (!_healthOk) {
    throw new Error(`gbrain binary not runnable (code ${r.code}): ${(r.stderr || '').slice(0, 200)}`);
  }
  return true;
}

export const _internal = { brainDirFor, slugForSourceId, embeddingsEnabled, parseGbrainJson };
