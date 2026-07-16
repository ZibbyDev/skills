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
import { mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
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

function embeddingsEnabled() {
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

/** Create + init the kbId's GBrain brain once (idempotent). */
async function ensureBrain(brainDir) {
  if (_initialized.has(brainDir)) return;
  const configPath = join(brainDir, '.gbrain', 'config.json');
  if (await pathExists(configPath)) { _initialized.add(brainDir); return; }

  await mkdir(brainDir, { recursive: true });
  const args = ['init', '--pglite', '--non-interactive', '--json'];
  if (!embeddingsEnabled()) args.push('--no-embedding');
  const r = await runGbrain(brainDir, args);
  // init can print a large skillpack suggestion; success is the exit code +
  // the presence of the brain's config.json.
  if (r.code !== 0 && !(await pathExists(configPath))) {
    throw new Error(`gbrain init failed (code ${r.code}): ${(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
  _initialized.add(brainDir);
}

// ── slug↔sourceId map (per brain, our own metadata, outside .gbrain) ──────────
function mapPathFor(brainDir) {
  return join(brainDir, 'adapter', 'sourcemap.json');
}

async function loadMap(brainDir) {
  try {
    const raw = await readFile(mapPathFor(brainDir), 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch { return {}; }
}

async function saveMap(brainDir, map) {
  const p = mapPathFor(brainDir);
  await mkdir(join(brainDir, 'adapter'), { recursive: true });
  await writeFile(p, JSON.stringify(map), 'utf8');
}

// ── op: soft-delete a slug; returns true iff a page was actually removed ──────
async function deleteSlug(brainDir, slug) {
  const r = await runGbrain(brainDir, ['call', 'delete_page', JSON.stringify({ slug })]);
  const res = parseGbrainJson(r.stdout);
  // delete_page → { status: 'soft_deleted' | 'already_soft_deleted' } on success,
  // or throws page_not_found (non-zero exit, message on stderr).
  return !!res && (res.status === 'soft_deleted' || res.status === 'already_soft_deleted');
}

// ── op: upsert one markdown doc as a GBrain page ─────────────────────────────
async function upsertDoc(brainDir, slug, markdown) {
  // A previously soft-deleted slug must come back live on re-ingest. restore is
  // a cheap no-op / harmless error when the page is live or absent.
  await runGbrain(brainDir, ['call', 'restore_page', JSON.stringify({ slug })]);

  const tmp = join(tmpdir(), `gbrain-ingest-${randomBytes(8).toString('hex')}.md`);
  try {
    await writeFile(tmp, markdown, 'utf8');
    const r = await runGbrain(brainDir, ['capture', '--file', tmp, '--slug', slug, '--json']);
    const res = parseGbrainJson(r.stdout);
    if (r.code !== 0 || !res || !res.slug) {
      throw new Error(`gbrain capture failed for ${slug} (code ${r.code}): ${(r.stderr || r.stdout || '').slice(0, 300)}`);
    }
    return { chunks: Number(res.chunks) || 0 };
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
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
    return { upserted, deleted, chunks };
  });
}

/** POST /query → { results: [{ sourceId, chunk, score }] } */
export async function query(kbId, queryText, topK) {
  const brainDir = brainDirFor(kbId);
  return withBrainLock(brainDir, async () => {
    await ensureBrain(brainDir);
    const map = await loadMap(brainDir);
    const r = await runGbrain(brainDir, [
      'call', 'query', JSON.stringify({ query: queryText, limit: topK }),
    ]);
    const arr = parseGbrainJson(r.stdout);
    if (!Array.isArray(arr)) {
      // A genuine gbrain error (non-zero exit + no JSON array) must not be
      // silently swallowed as "no results".
      if (r.code !== 0) {
        throw new Error(`gbrain query failed (code ${r.code}): ${(r.stderr || '').slice(0, 300)}`);
      }
      return { results: [] };
    }
    const results = arr.map((hit) => ({
      sourceId: map[hit.slug] || hit.slug,
      chunk: hit.chunk_text || '',
      score: typeof hit.score === 'number' ? hit.score : 0,
    }));
    return { results };
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
