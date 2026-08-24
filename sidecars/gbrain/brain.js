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
//
// ⚠️ THE WAIT IS BOUNDED. THE WORK IS NEVER CANCELLED. Those are two different
// promises and conflating them is how this turns from a hang into data loss.
//
// What was here before was an UNBOUNDED FIFO promise chain per brain: every
// caller did `prev.then(fn)` with no acquisition budget, no cancellation and no
// queue bound. One `fn` that never settles therefore wedged EVERY later caller
// for that brain for the life of the process — measured on a live box
// (2026-08-24): `/stat` answered in 583ms, another brain's `/query` in 13.7s,
// and one brain's `/query` never returned at all while the container sat at
// 0.11% CPU and served `/health` in 75ms. Nothing anywhere reported it.
//
// The fix is deliberately asymmetric:
//
//   WAITERS get a budget. A caller that has not been given its turn within
//   LOCK_ACQUIRE_TIMEOUT_MS abandons its place in the queue and rejects. It has
//   not touched the store and never will — `run()` below re-checks `abandoned`
//   at the instant it would call `fn`, so an abandoned turn is skipped, not
//   deferred. That is the whole single-writer argument: the only thing a
//   timeout can cancel here is work that has NOT STARTED.
//
//   THE HOLDER gets no deadline, only a watchdog. Its work is happening in
//   ANOTHER process — a `gbrain serve` child over stdio, a spawned CLI, or
//   PGLite's own worker holding brain.pglite open — and this process has no way
//   to prove that process has let go of the file. Releasing the chain on a
//   timer would hand the next caller a lock the previous one still physically
//   holds: two writers on a single-writer file. This codebase has already paid
//   for the weaker version of that mistake once (see stopServe: a
//   signalled-but-alive child made an `rm` fail SILENTLY and a "dropped" store
//   came back with the same inode). The only actor that can guarantee those fds
//   are gone is the process/container itself, so a genuinely wedged holder is
//   reported LOUDLY and left alone; the recovery is a sidecar restart, which is
//   safe and cheap (serves are lazily restarted anyway).
//
// KNOWN UNBOUNDED HOLDERS, named rather than hidden: every leaf op here has its
// own budget (`runGbrain` SIGKILLs at OP_TIMEOUT_MS, `rpc` rejects at the same)
// EXCEPT the direct PGLite open in `withStore` — `new PGlite()` + `waitReady`
// take no timeout and are exactly the call that contends for the single-writer
// file lock. It is left unbounded ON PURPOSE: racing `waitReady` and walking
// away would abandon a half-open store that may still take the lock afterwards,
// which is the two-writer hazard again, one layer down. An `ingest` batch is
// the other long holder — bounded per document, unbounded in the aggregate, and
// legitimately so.
const LOCK_ACQUIRE_TIMEOUT_MS = Number(process.env.LOCK_ACQUIRE_TIMEOUT_MS) || 120_000;
// A hold longer than this is anomalous (only a large ingest batch reaches it
// legitimately) and gets one warn naming the brain, the op and the queue.
const LOCK_HOLD_WARN_MS = Number(process.env.LOCK_HOLD_WARN_MS) || 300_000;

const _locks = new Map();       // brainDir → tail promise (never rejects)
const _lockState = new Map();   // brainDir → { holder, since, waiters:Set }

// Returned by an abandoned turn so the chain advances without ever calling fn.
const _ABANDONED = Symbol('brain-lock-abandoned');

function lockStateFor(brainDir) {
  let st = _lockState.get(brainDir);
  if (!st) { st = { holder: null, since: 0, waiters: new Set() }; _lockState.set(brainDir, st); }
  return st;
}

/**
 * What this brain's lock is doing right now. `now` is a parameter so a caller
 * (and a test) can ask "is this holder stuck?" without faking a clock — the
 * same trick sweepIdleBrains uses for idleness.
 *
 * This is the signal that did not exist: `/stat` is lock-free by design and so
 * answered a cheerful `exists:true, sizeBytes:…` for a brain whose every other
 * op was wedged. It now carries the lock alongside the size.
 */
function lockSnapshot(brainDir, now = Date.now()) {
  const st = _lockState.get(brainDir);
  const idle = { held: false, holder: null, heldMs: 0, queued: 0, longestWaitMs: 0, stuck: false };
  if (!st) return idle;
  const held = st.holder != null;
  let longestWaitMs = 0;
  for (const w of st.waiters) longestWaitMs = Math.max(longestWaitMs, now - w.since);
  return {
    held,
    holder: held ? st.holder.label : null,
    heldMs: held ? now - st.since : 0,
    queued: st.waiters.size,
    longestWaitMs,
    stuck: held && (now - st.since) > LOCK_HOLD_WARN_MS,
  };
}

/**
 * Every brain whose lock is currently held or contended. Used by GET /health to
 * count stuck brains — a liveness probe that reports `ok:true` while a brain is
 * dead is exactly how this took a day to find.
 *
 * Returns brainDirs (hashed, non-enumerable), never kbIds.
 */
export function lockReport(now = Date.now()) {
  const out = [];
  for (const brainDir of _lockState.keys()) {
    const s = lockSnapshot(brainDir, now);
    if (s.held || s.queued > 0) out.push({ brainDir, ...s });
  }
  return out;
}

/**
 * Run `fn` with this brain's lock held, waiting at most `acquireTimeoutMs` for
 * a turn.
 *
 * @param {string} brainDir
 * @param {() => Promise<any>} fn      runs ONLY if this call actually gets its turn
 * @param {{label?: string, acquireTimeoutMs?: number}} [opts]
 *        `label` names the op in the warn/status surfaces ('ingest', 'query'…).
 */
function withBrainLock(brainDir, fn, opts = {}) {
  const label = opts.label || 'op';
  const acquireTimeoutMs = Number.isFinite(opts.acquireTimeoutMs)
    ? opts.acquireTimeoutMs
    : LOCK_ACQUIRE_TIMEOUT_MS;

  const st = lockStateFor(brainDir);
  const waiter = { label, since: Date.now(), abandoned: false, acquired: false };
  st.waiters.add(waiter);

  const prev = _locks.get(brainDir) || Promise.resolve();

  // The chain link. It resolves an OUTCOME envelope instead of rejecting, so
  // the tail can never carry an unhandled rejection and a failing op can never
  // break the queue behind it (the old code relied on two separate .catch()es
  // for that).
  const next = prev.catch(() => {}).then(() => {
    st.waiters.delete(waiter);
    // ⛔ THE SINGLE-WRITER GUARANTEE. A waiter that gave up gets skipped HERE,
    // before fn is ever called — so a timed-out caller performs no store access
    // at all, and the turn it abandoned is handed straight to the next waiter.
    if (waiter.abandoned) return _ABANDONED;

    waiter.acquired = true;
    if (waiter.disarm) waiter.disarm();
    st.holder = waiter;
    st.since = Date.now();

    const holdTimer = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.warn(
        `[gbrain] brain lock HELD >${LOCK_HOLD_WARN_MS}ms by '${label}' on ${brainDir}`
        + ` — ${st.waiters.size} waiter(s) queued behind it.`
        + ' The operation is still running and is NOT being cancelled (PGLite is single-writer,'
        + ' so releasing it here would mean two writers on one file).'
        + ' If it never finishes, only a sidecar restart clears it.',
      );
    }, LOCK_HOLD_WARN_MS);
    holdTimer.unref?.();

    const release = () => {
      clearTimeout(holdTimer);
      if (st.holder === waiter) { st.holder = null; st.since = 0; }
      // Keep the map from growing one dead entry per brain ever touched.
      if (_lockState.get(brainDir) === st && !st.holder && st.waiters.size === 0) {
        _lockState.delete(brainDir);
      }
    };

    return Promise.resolve().then(fn).then(
      (value) => { release(); return { ok: true, value }; },
      (error) => { release(); return { ok: false, error }; },
    );
  });

  _locks.set(brainDir, next);

  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      // Already running? The wait is over — the budget bounds the QUEUE, never
      // the operation, so a legitimately long op is untouched.
      //
      // `waiter.acquired` is REDUNDANT with the clearTimeout in `disarm` below,
      // deliberately: the two cover each other, and a mutation test proves it
      // (removing either alone leaves the suite green; removing both makes the
      // budget start timing the WORK, which fails). Don't tidy it away.
      if (waiter.acquired || settled) return;
      settled = true;
      waiter.abandoned = true;
      st.waiters.delete(waiter);
      const busy = lockSnapshot(brainDir);
      const err = new Error(
        `gbrain: gave up after ${acquireTimeoutMs}ms WAITING FOR A TURN on brain ${brainDir}`
        + ` — this request never started and touched nothing.`
        + (busy.held
          ? ` The brain is busy with '${busy.holder}' (holding for ${busy.heldMs}ms).`
          : ' The brain lock was contended.')
        + ` This is a QUEUE timeout, not an operation timeout.`
        + ` Raise LOCK_ACQUIRE_TIMEOUT_MS (currently ${LOCK_ACQUIRE_TIMEOUT_MS}ms) to wait longer.`,
      );
      err.code = 'BRAIN_LOCK_ACQUIRE_TIMEOUT';
      err.brainDir = brainDir;
      // eslint-disable-next-line no-console
      console.warn(`[gbrain] ${err.message}`);
      reject(err);
    }, acquireTimeoutMs);
    timer.unref?.();
    // Disarm the moment the turn is granted — assigned synchronously, before
    // any microtask can run `next`'s body.
    waiter.disarm = () => clearTimeout(timer);

    next.then((r) => {
      if (settled) return;          // abandoned: already rejected above
      settled = true;
      clearTimeout(timer);
      if (r === _ABANDONED) return; // unreachable (settled would be true)
      if (r.ok) resolve(r.value); else reject(r.error);
    });
  });
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

// How long to let `gbrain serve` shut down cleanly before SIGKILL.
const SERVE_STOP_TIMEOUT_MS = Number(process.env.GBRAIN_SERVE_STOP_TIMEOUT_MS) || 5_000;

/**
 * Release this brain's persistent `gbrain serve` — and with it the single-writer
 * PGLite lock and every open fd it holds — so a one-off CLI pass, a direct
 * PGLite open, or an `rm` of the brain dir can proceed. The next serveCall
 * lazily starts a fresh one.
 *
 * AWAITS THE PROCESS'S ACTUAL EXIT. Signalling is not stopping: `kill()` only
 * queues the signal, so the old code returned while the child was still running
 * with the whole brain open — and on the container's overlayfs, removing a file
 * another process still holds open FAILS, silently, mid-walk. That is not
 * theoretical: `drop` looked like it worked (it logged "removed", `rm` threw
 * nothing) while the brain dir came back untouched — SAME INODE, SAME MTIME, so
 * the store had never been erased at all. Anything that deletes or reopens a
 * brain must await this, not fire it.
 *
 * Always resolves — a child that ignores SIGTERM is SIGKILLed, and a child that
 * somehow survives both still releases the caller rather than wedging it.
 */
function stopServe(brainDir) {
  const s = _serves.get(brainDir);
  if (!s) return Promise.resolve();
  _serves.delete(brainDir);
  if (s.proc.exitCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hard); clearTimeout(cap);
      resolve();
    };
    s.proc.once('exit', done);
    const hard = setTimeout(() => { try { s.proc.kill('SIGKILL'); } catch { /* gone */ } }, SERVE_STOP_TIMEOUT_MS);
    const cap = setTimeout(done, SERVE_STOP_TIMEOUT_MS + 1_000);
    try { s.proc.stdin.end(); } catch { /* ignore */ }
    try { s.proc.kill('SIGTERM'); } catch { /* ignore */ }
  });
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

// ── AUTOMATIC reclaim on idle ───────────────────────────────────────────────
// The bug this exists for is "the KB only ever GROWS" — a customer store reached
// 954 MB / 4793 documents and could only go up. Stopping the growth is therefore
// the fix; giving bytes back is a separate, heavier, operator-triggered thing.
// So the automatic pass is deliberately the CHEAP half, and only the cheap half:
//
//   AUTOMATIC  hard-purge past the recovery window + VACUUM (ANALYZE)
//   MANUAL     nothing — there is no heavier mode. Giving bytes back is `drop`
//              + re-ingest (see VACUUM_MODES for why VACUUM FULL was removed).
//
// Why the purge is automatic and not a policy change: gbrain's own schema says
// the 72h window is a RECOVERY window and that a purge phase hard-deletes past
// it. Upstream always assumed something would sweep; nothing ever did. Keeping a
// page whose recovery window expired is not a feature, it is the leak.
//
// Why VACUUM FULL is not here — and is no longer ANYWHERE: it takes an ACCESS
// EXCLUSIVE lock, rewrites every table, needs room for a second copy, and is
// itself WAL-logged. Measured NET BIGGER every time (42.7 → 59.4 MB on a smoke
// brain; a 954 MB customer store → 1.1 GB on one click) because the PGLite WAL
// pool only ratchets up. It was wrong on a timer AND wrong as a button.
//
// WHEN: when a brain goes IDLE — the moment its persistent serve is about to be
// reaped anyway. That is the one instant where nothing is contending for the
// single-writer PGLite lock, so the work is free to the user, and it needs no
// new timer, no new state and no per-request hook (hanging it off every ingest
// would both run far too often and fight the write path for the lock).
//
// WHAT IT WILL NOT DO: it never resurrects a reaped brain to clean it (it only
// ever looks at brains already open), never touches an untouched brain (the
// dirty counter below), and never runs the heavy mode.
const _dirty = new Map(); // brainDir → writes since the last reclaim

/** Record that this brain now owes a maintenance pass. */
function markDirty(brainDir, writes) {
  if (writes > 0) _dirty.set(brainDir, (_dirty.get(brainDir) || 0) + writes);
}

// Off-switch + window, read PER SWEEP (not at import) so the knobs are honestly
// testable and an operator changing them needs no code path of their own.
// Brand-neutral names — these are new knobs (CLAUDE.md).
function autoReclaimEnabled() {
  return !/^(0|false|off|no)$/i.test(String(process.env.AUTO_RECLAIM ?? '').trim());
}
function autoReclaimWindowHours() {
  const n = Number(process.env.AUTO_RECLAIM_WINDOW_HOURS);
  return Number.isFinite(n) && n >= 0 ? n : 72;   // gbrain's own recovery window
}

/**
 * One pass over the OPEN brains: reclaim + release the ones that have gone idle.
 *
 * `now` is a parameter rather than a `Date.now()` inside so a test can drive a
 * brain past the idle threshold without faking a clock or mutating internals —
 * which is what makes "the sweep did NOT fire here" a claim worth anything: the
 * same call, with the same arguments, is PROVEN to fire in the positive case.
 *
 * Returns one entry per brain it considered, so the caller (and the test) can
 * see what happened instead of inferring it from side effects.
 */
export async function sweepIdleBrains(now = Date.now()) {
  const out = [];
  const enabled = autoReclaimEnabled();
  const olderThanHours = autoReclaimWindowHours();
  for (const [brainDir, s] of Array.from(_serves)) {
    if (now - s.lastUsed <= SERVE_IDLE_MS) continue;
    // eslint-disable-next-line no-await-in-loop
    if (!enabled) { await stopServe(brainDir); out.push({ brainDir, action: 'reaped', reason: 'disabled' }); continue; }
    // eslint-disable-next-line no-await-in-loop
    if (!_dirty.get(brainDir)) { await stopServe(brainDir); out.push({ brainDir, action: 'reaped', reason: 'unchanged' }); continue; }
    // Queue behind any in-flight request rather than racing it — PGLite is
    // single-writer, so correctness is not optional here. The cost of that
    // choice is bounded: this only runs on a brain untouched for the whole idle
    // window, and only ever runs the LIGHT pass, so a request that lands in the
    // gap waits seconds, not the minutes a full rewrite would take.
    // Snapshot the idleness we judged on. The re-check below asks "did anything
    // touch this brain while we queued?" — which is a comparison of lastUsed
    // against ITSELF, not against a clock. Comparing `Date.now()` to `lastUsed`
    // here would be reading a different clock from the one the caller passed in,
    // and made every swept brain look freshly active.
    const lastUsedAtQueue = s.lastUsed;
    // eslint-disable-next-line no-await-in-loop
    const r = await withBrainLock(brainDir, async () => {
      // A request may have run while we were queued — it, not us, now owns this
      // brain's idleness. Stand down rather than reaching into a live store.
      if (s.lastUsed !== lastUsedAtQueue) return { action: 'skipped', reason: 'became-active' };
      if (!(await pathExists(brainDir))) { await stopServe(brainDir); return { action: 'skipped', reason: 'gone' }; }
      const res = await reclaim(brainDir, { olderThanHours, mode: 'light', label: 'auto-reclaim' });
      return { action: 'reclaimed', purgedCount: res.purgedCount, vacuumMode: res.vacuumMode, reclaimedBytes: res.reclaimedBytes };
    }, {
      label: 'auto-reclaim',
      // Maintenance has no user waiting on it: stand down FAST rather than
      // queue behind a long ingest (or a wedged holder). Before the acquire
      // budget existed this loop could park on one wedged brain forever, and
      // because `_sweeping` guards re-entry that stalled the sweep for EVERY
      // other brain too — one wedged tenant froze all housekeeping.
      acquireTimeoutMs: Math.min(LOCK_ACQUIRE_TIMEOUT_MS, 10_000),
    }).catch((e) => ({ action: 'failed', reason: String((e && e.message) || e).slice(0, 200) }));
    // `reclaim` already released the serve (the vacuum needs the lock it holds);
    // this settles the skip/fail paths, and is a resolved no-op otherwise.
    // eslint-disable-next-line no-await-in-loop
    await stopServe(brainDir);
    out.push({ brainDir, ...r });
  }
  return out;
}

let _sweeping = false;
setInterval(() => {
  // Never overlap: a light pass on a large brain can outlive the interval, and a
  // second sweep entering behind it would queue on the same per-brain lock and
  // pile up.
  if (_sweeping) return;
  _sweeping = true;
  sweepIdleBrains()
    .catch((e) => console.warn(`[gbrain] auto-reclaim sweep failed: ${(e && e.message) || e}`))
    .finally(() => { _sweeping = false; });
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
  // Born narrow: the vector column is halfvec from the brain's FIRST byte, so
  // it never holds a float32 row to convert later. Empty-table DDL, so this is
  // the one moment where narrowing costs nothing and risks nothing.
  const narrowed = embeddings ? await narrowNewBrainToHalfvec(brainDir) : null;
  // eslint-disable-next-line no-console
  console.log(`[gbrain] brain created: embeddings=${embeddings ? 'ON (vector+BM25 hybrid)' : 'OFF (keyword/BM25 only)'}`
    + `${narrowed && narrowed.converted ? ` storage=${narrowed.to} (half the vector+index bytes)` : ''}`
    + `${narrowed && !narrowed.converted && narrowed.reason ? ` storage=vector (${narrowed.reason})` : ''}`);
  _initialized.add(brainDir);
}

/**
 * Narrow a BRAND-NEW, still-EMPTY brain's vector column to halfvec — the
 * DEFAULT since 2026-08-07.
 *
 * WHY THIS IS SAFE HERE AND ONLY HERE: `compact({halfvec:true})` converts a
 * POPULATED store, which rewrites rows that already exist — one-way, and the
 * caller has to opt into it. This runs before the brain holds a single vector,
 * so there is nothing to rewrite and nothing to lose: every embedding the brain
 * will ever hold is written INTO a halfvec column, never rounded on arrival at
 * one. Existing brains are untouched and stay opt-in.
 *
 * WHAT IT COSTS TO RETRIEVAL: nothing, MEASURED (2026-08-07) rather than
 * inferred from pgvector's docs. 80 real documents / 579 indexed chunks,
 * embedded with text-embedding-3-small at 1536d, 120 queries generated from the
 * corpus itself (60 verbatim phrasings + 60 LLM paraphrases of them), the SAME
 * brain measured before and after conversion so documents, chunks, embeddings
 * and query vectors are byte-identical and element width is the only variable:
 *
 *   pass                             overlap@1/@5/@10  #1 unchanged  mean |Δscore|
 *   E2E hybrid (what a caller gets)    1.000 1.000 1.000    100%          0.0 *
 *   isolated vector lane (no BM25)     1.000 1.000 1.000    100%          0.0
 *   … same, paraphrased queries only   1.000 1.000 1.000    100%          0.0
 *
 *   (*) the E2E pass shows 14/1200 ranked pairs swapping by one place. That is
 *   gbrain's own run-to-run jitter, not this change: running the float32 pass
 *   TWICE against the untouched brain produced the identical 14/1200. The
 *   halfvec-attributable difference is zero on both paths.
 *
 * Not "negligible" — IDENTICAL, and not by luck. OpenAI's text-embedding-3-*
 * already returns float16-VALUED components (measured over the stored vectors:
 * every component either exactly representable in fp16 or an fp16 subnormal).
 * A float32 `vector` column was storing 16 bits of guaranteed zero per element;
 * halfvec drops exactly those bits, so the re-typing is BIT-EXACT for this
 * provider — which is why the score deltas are 0.0 and not merely small.
 *
 * THE ZERO IS NOT A BLIND HARNESS (the negative-result rule). Three controls:
 *   · the same metric fed MISMATCHED queries reported overlap@10 0.04 (lane) /
 *     0.20 (E2E) — it can see a difference when there is one;
 *   · 1200 RANDOM float32 unit vectors with full mantissa entropy, where fp16
 *     genuinely does discard information, reported the loss: overlap@5 0.999,
 *     6/2000 ranks moved by one place, mean |Δscore| 5.8e-6. Re-run with those
 *     same vectors pre-rounded to fp16 it reported 0.0 again;
 *   · both passes asserted mode='vector' (never the keyword fallback) and the
 *     column type was read back as vector(1536) before / halfvec(1536) after.
 * Even the full-entropy arm never moved a #1 result, so a provider that does
 * ship true float32 loses a rounding error, not a document.
 *
 * WHAT IT SAVES: 17.8% of the whole store on that corpus (pg_database_size
 * 34.4 MB → 28.3 MB, no vacuum). The vector + HNSW portion roughly halves;
 * scale the saving off THAT share, never off the store's total.
 *
 * WHAT IT COSTS TO CREATE: nothing measurable. A/B over 3 brains each, the
 * opt-out env as the only variable: 8623 ms with narrowing vs 8681 ms without
 * — inside the noise of `gbrain init` itself, and paid once per brain lifetime.
 *
 * PLANNER: gbrain's registry hard-codes the built-in `embedding` column as
 * type 'vector' (search/embedding-column.ts), so its SQL casts the query as
 * `$1::vector` against what is now a halfvec column. VERIFIED that this still
 * plans as `Index Scan using idx_chunks_embedding` (pgvector casts the
 * parameter to halfvec instead of widening the column, so the
 * halfvec_cosine_ops HNSW index stays usable) and that a brain born halfvec
 * ingests with a real key, fills every chunk's vector, and answers a
 * PARAPHRASED query as mode='vector' — i.e. the semantic lane really is live,
 * not a keyword fallback wearing its name.
 *
 * FAIL-SOFT: any error leaves the brain exactly as gbrain built it (float32,
 * i.e. the old behaviour) and never fails the creation — this is a storage
 * optimisation, not a correctness requirement. Set GBRAIN_NEW_BRAIN_HALFVEC=0
 * to keep new brains float32 (a box whose embedding provider returns true
 * float32 and who would rather spend the bytes).
 */
async function narrowNewBrainToHalfvec(brainDir) {
  if (process.env.GBRAIN_NEW_BRAIN_HALFVEC === '0') {
    return { converted: false, reason: 'GBRAIN_NEW_BRAIN_HALFVEC=0' };
  }
  try {
    // `gbrain init` is a one-shot subprocess and no serve has been started for
    // a brain that did not exist a moment ago — but PGLite is single-writer, so
    // ask anyway rather than depend on that ordering staying true.
    await stopServe(brainDir);
    return await withStore(brainDir, (db) => convertToHalfvec(db));
  } catch (e) {
    const reason = String((e && e.message) || e).slice(0, 200);
    // eslint-disable-next-line no-console
    console.warn(`[gbrain] could not narrow new brain to halfvec (keeping float32): ${reason}`);
    return { converted: false, reason };
  }
}

/**
 * DESTROY a whole brain — every page, its vectors and its slug map. The ONLY
 * way a brain's data goes away: nothing implicit ever deletes one (a store
 * delete in the control-plane calls this explicitly, and a mode rebuild is
 * drop-then-reingest from the caller's archive). Idempotent: dropping a brain
 * that was never created succeeds with dropped:false.
 *
 * This is ALSO how "empty this knowledge base but keep the store" is served —
 * the store row lives in the control-plane, not here, so erasing the brain and
 * letting the next ingest/query `ensureBrain` a fresh one IS an empty store.
 * There is deliberately no second `/empty` route: one engine op, named once,
 * with the store-level word applied at the layer that owns stores. It also
 * beats "delete every document one by one" outright — instant, no per-slug
 * round trip over thousands of pages, and it returns 100% of the bytes without
 * needing a vacuum at all (the directory is gone).
 */
export async function drop(kbId) {
  const brainDir = brainDirFor(kbId);
  return withBrainLock(brainDir, async () => {
    const existed = await pathExists(brainDir);
    // RELEASE THE PERSISTENT SERVE FIRST. `gbrain serve` holds the whole PGLite
    // brain OPEN, and unlinking a file an fd is still on does not take the data
    // away from the process that has it — so without this the "emptied" store
    // kept answering queries from the deleted database until the 5-minute idle
    // reap happened to kill it. Caught by smoke: after an empty, a query still
    // returned the erased documents (as raw slugs, the sourcemap being gone).
    // Stop it BEFORE the rm, and AWAIT it — see stopServe: a signalled-but-alive
    // child makes the rm fail silently on overlayfs and the store survives intact.
    await stopServe(brainDir);
    if (existed) await rm(brainDir, { recursive: true, force: true });
    _initialized.delete(brainDir);
    _dirty.delete(brainDir);
    // eslint-disable-next-line no-console
    console.log(`[gbrain] drop ${existed ? 'removed' : 'no-op (absent)'}: ${brainDir}`);
    return { dropped: existed };
  }, { label: 'drop' });
}

/**
 * STOP a deleted document from holding disk forever. Measured, not assumed
 * (2026-08-06, 80-doc brain, 30 docs deleted = 43%):
 *
 *   soft delete (what `delete` does)  79,688 KB → 80,728 KB   (+1 MB, GROWS)
 *   + purge_deleted_pages (hard)      80,728 KB → 80,720 KB   (unchanged)
 *
 * The hard purge is what makes the space REUSABLE; the vacuum then hands those
 * pages to the free-space map so the next ingest fills them instead of
 * extending the file. Neither shrinks the file, and that is now the honest
 * scope of this function — the third row of that table used to read
 * `+ VACUUM FULL … -14.8 MB` and it was a TRAP: true of the table, false of the
 * DIRECTORY, because it never counted the WAL the rewrite produced. See
 * VACUUM_MODES.
 *
 * gbrain's `delete_page` is a soft delete by
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
 *
 * ── THIS STOPS GROWTH. IT DOES NOT SHRINK A STORE. ───────────────────────────
 * `VACUUM (ANALYZE)` gives NOTHING back to the filesystem — it returns dead
 * tuples to the table's own free-space map, so the NEXT ingest reuses those
 * pages instead of extending the file. It costs O(dead tuples), takes no
 * exclusive lock and needs no second copy, and the ANALYZE refreshes the
 * planner statistics that a large churn invalidates.
 *
 *   vacuum: 'light' → hard purge + VACUUM ANALYZE — routine pass, stops the growth
 *   vacuum: 'none'  → hard purge only             — reclaim nothing, just erase
 *
 * There is deliberately NO mode here that shrinks a bloated store — see
 * VACUUM_MODES for the measurements that removed 'full'. To actually get bytes
 * back, `drop` the brain and re-ingest: that removes the directory outright, so
 * the WAL pool goes with it and the brain comes back halfvec.
 *
 * A FIXED vocabulary, validated by the caller (server.js) — an unrecognized
 * value is REJECTED, never coerced to a default, because coercion here silently
 * runs the wrong weight of operation on a customer's 1 GB store. 'full' is now
 * one of those rejected values, on purpose: a caller still asking for it (an
 * older control-plane, a saved script) gets a loud 400 rather than the quiet
 * +32 MB it used to get.
 *
 * The 'light' pass ALSO runs BY ITSELF, automatically, when a brain goes idle —
 * see `sweepIdleBrains`.
 */
export async function compact(kbId, { olderThanHours = 72, vacuum = 'light', halfvec = false } = {}) {
  // REJECT an unknown mode rather than coercing it, and reject it BEFORE the
  // hard purge — a typo must not cost the caller a destructive step it then
  // can't finish. server.js validates first, so this only fires for an
  // in-process caller (the smoke harness, a drainer); for those, silently
  // running the HEAVY rewrite on a 1 GB store is exactly the failure this guard
  // exists to prevent.
  const mode = String(vacuum);
  if (!Object.prototype.hasOwnProperty.call(VACUUM_MODES, mode)) {
    throw new Error(`unknown vacuum mode '${mode}' (expected one of: ${VACUUM_MODE_NAMES.join(', ')})`);
  }
  const brainDir = brainDirFor(kbId);
  if (!(await pathExists(brainDir))) return { exists: false, reclaimedBytes: 0 };
  return withBrainLock(
    brainDir,
    () => reclaim(brainDir, { olderThanHours, mode, halfvec, label: 'compact' }),
    { label: 'compact' },
  );
}

/**
 * The reclaim itself — purge, then vacuum. Factored out of `compact` because the
 * AUTOMATIC idle sweep runs the exact same steps and must not be a second
 * implementation of them (the pair would drift, and the drift would be silent).
 *
 * PRECONDITION: the caller holds this brain's lock and has verified the brain
 * exists. Both callers do; nothing else may call it.
 */
async function reclaim(brainDir, { olderThanHours, mode, halfvec = false, label }) {
  {
    const beforeBytes = await dirSizeBytes(brainDir);

    // 1. Hard-delete through gbrain itself. purge_deleted_pages is marked
    //    admin+localOnly, but BOTH of those filters live in serve-http.ts —
    //    the stdio `gbrain serve` this adapter drives applies neither.
    const purged = await serveCall(brainDir, 'purge_deleted_pages', {
      older_than_hours: olderThanHours,
    });
    const purgedCount = Number(purged && purged.count) || 0;

    // 2. VACUUM needs the single-writer PGLite lock, which the persistent serve
    //    holds. Drop it first — AWAITED, so the lock is genuinely released before
    //    we open the store ourselves — and the next serveCall starts a fresh one.
    await stopServe(brainDir);

    // The work below IS the debt this brain owed. Clearing the marker here (not
    // at the top) means a failure leaves it dirty and the next sweep retries.
    _dirty.delete(brainDir);

    let vacuumed = false;
    let vacuumError = null;
    let halfvecResult = null;
    if (mode !== 'none' || halfvec) {
      try {
        // ONE store session for both: the halfvec rewrite leaves dead tuples of
        // its own, so converting and then vacuuming in the same open is both
        // cheaper and the only order that actually returns the narrowed bytes.
        await withStore(brainDir, async (db) => {
          if (halfvec) halfvecResult = await convertToHalfvec(db);
          if (mode !== 'none') { await db.query(VACUUM_MODES[mode]); vacuumed = true; }
        });
      } catch (e) {
        // A failure here must not lose the purge: report it and keep the
        // (already durable) hard-delete rather than throwing the whole call.
        vacuumError = String((e && e.message) || e).slice(0, 300);
      }
    }

    const afterBytes = await dirSizeBytes(brainDir);
    // Signed on purpose, and measured over the whole DIRECTORY rather than the
    // table: a pass can still end up net-negative (any WAL it writes lands here
    // too), and clamping at 0 would render that as "reclaimed nothing" instead
    // of "cost you N bytes". That distinction is not academic — it is the
    // signal that was present in this very log line, and ignored, while a
    // VACUUM FULL button shipped that made a 954 MB store 1.1 GB.
    const reclaimedBytes = beforeBytes - afterBytes;
    // eslint-disable-next-line no-console
    // `(failed)` ONLY when a vacuum was actually attempted and did not run.
    // Keyed on `vacuumed` alone it printed "vacuum=none(failed)" for the mode
    // that runs no vacuum BY DEFINITION — a diagnostic reporting a failure that
    // never happened, on the one line an operator reads to decide if it did.
    console.log(`[gbrain] ${label} ${brainDir}: purged=${purgedCount} vacuum=${mode}${mode !== 'none' && !vacuumed ? '(failed)' : ''} `
      + `${halfvecResult && halfvecResult.converted ? 'halfvec=yes ' : ''}`
      + `${beforeBytes} → ${afterBytes} bytes (${reclaimedBytes >= 0 ? 'reclaimed' : 'GREW BY'} `
      + `${Math.abs(reclaimedBytes)})`);
    return {
      exists: true,
      purgedCount,
      // WHICH weight of vacuum ran — the caller renders a very different promise
      // for 'full' ("disk returned") than for 'light' ("growth stopped"), so it
      // must not have to infer it from the flag it happened to send.
      vacuumMode: mode,
      vacuumed,
      vacuumError,
      halfvec: halfvecResult,
      beforeBytes,
      afterBytes,
      reclaimedBytes,
    };
  }
}

/**
 * The FIXED vacuum vocabulary → the SQL each one runs. One map, so the accepted
 * values and the statements can never drift apart, and `Object.keys` is the
 * single list server.js validates against (rather than a second copy of the
 * spelling in a route handler).
 *
 * 'light' is `VACUUM (ANALYZE)`, not bare `VACUUM`: after the churn that makes a
 * store worth vacuuming, its planner statistics are stale too, and refreshing
 * them is the cheap part of a pass that is already walking the table.
 *
 * ── 'full' IS GONE. `VACUUM FULL` COSTS MORE THAN IT RETURNS HERE ────────────
 * It shipped (0.3.2) as a "reclaim disk space" operator action and was WRONG on
 * a real store. VACUUM FULL rewrites every table and the rewrite is WAL-logged;
 * under PGLite the WAL pool then only ever ratchets UP. Measured on a brain that
 * had nothing left to reclaim:
 *
 *   run #1   base 61,040 → 57,160 KB   WAL 32,768 → 49,152 KB   NET +12 MB
 *   run #2   base 57,160 → 57,080 KB   WAL      unchanged       net  ~0
 *   run #3   base 57,080 → 57,000 KB   WAL 49,152 → 81,920 KB   NET +32 MB
 *
 * A live 954 MB customer store went to 1.1 GB on one click. The WAL does not
 * come back: CHECKPOINT is a no-op (verified twice), and `ALTER SYSTEM` on
 * max_wal_size/min_wal_size returns ok while the values read back unchanged —
 * PGLite never reloads the config. So the growth is one-way and unbounded up to
 * max_wal_size (1 GB by default), which is exactly the leak this whole module
 * exists to stop.
 *
 * The two things that DO work, and are what callers get instead:
 *   - STOP THE GROWTH → 'light', automatically, on idle (`sweepIdleBrains`).
 *     No table rewrite, so no WAL ratchet.
 *   - GIVE THE BYTES BACK → `drop` the brain and re-ingest. It `rm -rf`s the
 *     directory, so base bloat AND the WAL pool go with it, and the brain is
 *     reborn halfvec (`narrowNewBrainToHalfvec`) — narrower than the one it
 *     replaced. Deterministic, and the only thing measured to actually shrink a
 *     bloated store.
 *
 * Do NOT re-add 'full' without a measurement that includes the WAL directory.
 * The bytes freed inside the table were real every single time; the reason this
 * was still a net loss was never visible in the table-level numbers alone.
 */
const VACUUM_MODES = {
  light: 'VACUUM (ANALYZE)',
  none: null,
};
export const VACUUM_MODE_NAMES = Object.keys(VACUUM_MODES);

/**
 * Open the brain's PGLite store DIRECTLY, run `fn(db)`, always close.
 *
 * The extension set MUST match what gbrain opens with (pglite-engine.ts:302):
 * anything touching content_chunks trips over its pgvector-typed `embedding`
 * column and fails with `could not access file "$libdir/vector"` without them.
 *
 * @electric-sql/pglite is resolved from gbrain's own node_modules rather than
 * declared here on purpose: there must be exactly ONE PGLite build touching a
 * given store. Sharing gbrain's copy makes that true by construction instead of
 * by a version pin that could silently drift out of step with the vendored
 * commit. A mismatch cannot pass silently either — an incompatible build fails
 * to open the store and surfaces as the caller's error field.
 *
 * The CALLER must have released the persistent `gbrain serve` first (PGLite is
 * single-writer) — see stopServe.
 */
async function withStore(brainDir, fn) {
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
    return await fn(db);
  } finally {
    try { await db.close(); } catch { /* already closed */ }
  }
}

/**
 * Narrow content_chunks.embedding from vector(N) (float32) to halfvec(N)
 * (float16) IN PLACE — pgvector casts the stored values, so there is NO
 * re-embedding and no API call. Halves the vector bytes AND the HNSW index
 * built on them; measured 16.2% off a whole 1536-dim store in ~3s.
 *
 * Why this and not a narrower vector: cutting the DIMENSION (1536→512) requires
 * re-embedding every document through the provider and measured only 7.8%,
 * because the vector is one part of a store, not all of it. Halving the
 * ELEMENT WIDTH gets more, instantly, with nothing to recompute.
 *
 * gbrain needs no change to read it: pgvector's distance operators are defined
 * on halfvec too, so the SQL gbrain generates keeps working (verified — queries
 * still return mode=vector, and new ingests still embed and land).
 *
 * ONE-WAY in principle: float16 has ~3 decimal digits of mantissa, so anything
 * it discards cannot be recovered by widening the column back. What it actually
 * discards, MEASURED (2026-08-07, full method + numbers in
 * `narrowNewBrainToHalfvec`): NOTHING for an OpenAI-embedded store — 120
 * queries over 80 real documents, top-1/5/10 overlap 1.000 and every score
 * delta exactly 0.0, on the hybrid path AND on the isolated vector lane,
 * because text-embedding-3-* already returns float16-valued components. The
 * earlier "precision loss is negligible" line here was borrowed from pgvector's
 * documentation and had never been checked against this store; it is now, and
 * the answer is stronger than negligible. A provider that does emit true
 * float32 was measured too (synthetic full-entropy vectors): overlap@5 0.999,
 * top-1 never moved.
 *
 * Still opt-in for a POPULATED brain, because it rewrites data the caller
 * already has and the caller — not this function — owns that decision. Brand-new
 * brains are born halfvec by default (`narrowNewBrainToHalfvec`), where there is
 * no stored data to rewrite at all.
 *
 * IDEMPOTENT: an already-halfvec column returns converted:false and touches
 * nothing, so this is safe to include in a repeatable maintenance action — and
 * it is now the NORMAL result for a brain created after 2026-08-07.
 */
async function convertToHalfvec(db) {
  const col = (await db.query(`
    SELECT format_type(a.atttypid, a.atttypmod) AS typ
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relname = 'content_chunks' AND a.attname = 'embedding'`)).rows[0];
  const typ = col && col.typ ? String(col.typ) : '';
  if (!typ) return { converted: false, reason: 'no embedding column' };
  if (/^halfvec/.test(typ)) return { converted: false, reason: 'already halfvec', from: typ };

  const dims = Number((typ.match(/\((\d+)\)/) || [])[1] || 0);
  if (!dims) return { converted: false, reason: `unrecognized column type '${typ}'` };

  // The HNSW index must go first and come back after: a vector_cosine_ops index
  // cannot sit on a halfvec column, and rebuilding it is also what shrinks the
  // index half (it is built FROM the narrowed values).
  const idx = (await db.query(`
    SELECT indexname FROM pg_indexes
     WHERE tablename = 'content_chunks'
       AND indexdef ILIKE '%hnsw%' AND indexdef ILIKE '%(embedding %'`)).rows;
  for (const r of idx) await db.query(`DROP INDEX IF EXISTS ${r.indexname}`);
  await db.query(`ALTER TABLE content_chunks ALTER COLUMN embedding TYPE halfvec(${dims})`);
  for (const r of idx) {
    await db.query(`CREATE INDEX ${r.indexname} ON content_chunks USING hnsw (embedding halfvec_cosine_ops)`);
  }
  return { converted: true, from: typ, to: `halfvec(${dims})`, indexesRebuilt: idx.length };
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
      await stopServe(brainDir);
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

    // Every upsert leaves the old row version behind and every delete leaves the
    // whole page behind, so this batch is exactly the debt the idle sweep pays.
    // Counting writes (rather than sweeping on time alone) is what keeps a
    // never-written brain from being reopened and vacuumed for nothing.
    markDirty(brainDir, upserted + deleted);

    // Report HOW this brain searches. A caller that just wrote 80 documents into
    // a keyword-only brain must be able to find that out from the write itself
    // — the old contract gave no way to tell vector from lexical, which is how a
    // whole corpus got indexed the wrong way without a single warning.
    return { upserted, deleted, chunks, ...(await embeddingState(brainDir)) };
  }, { label: 'ingest' });
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
  }, { label: 'query' });
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
    // A soft-deleted page keeps its chunks, vectors and index entries until
    // something hard-purges it — this is the write that most needs the sweep.
    markDirty(brainDir, deleted);
    return { deleted };
  }, { label: 'delete' });
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
 *
 * `lock` is here BECAUSE this route is lock-free. Being the one op that never
 * queues made it the one op that kept answering while every other op on the
 * same brain was wedged behind a stuck holder — a healthy-looking size for a
 * dead KB, which is exactly why that state went unnoticed for a day. Same
 * reasoning as `mode`/`stale` on /query: report what the caller cannot infer.
 * `{ held, holder, heldMs, queued, longestWaitMs, stuck }`; `stuck` means the
 * holder has been running longer than LOCK_HOLD_WARN_MS.
 */
export async function stat(kbId) {
  const brainDir = brainDirFor(kbId);
  const lock = lockSnapshot(brainDir);
  if (!(await pathExists(brainDir))) return { exists: false, sizeBytes: 0, docs: 0, lock };
  const m = await readMap(brainDir);
  return {
    exists: true,
    sizeBytes: await dirSizeBytes(brainDir),
    docs: m.ok ? Object.keys(m.map).length : null,
    lock,
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

export const _internal = {
  brainDirFor, slugForSourceId, embeddingsEnabled, parseGbrainJson,
  // The lock, exported so its contract is testable without a real gbrain
  // binary, a real store, or a five-minute wait: `withBrainLock` takes an
  // explicit per-call `acquireTimeoutMs`, and `lockSnapshot`/`lockReport` take
  // `now` by ARGUMENT — the same technique sweepIdleBrains uses for idleness.
  withBrainLock, lockSnapshot, lockReport,
  LOCK_ACQUIRE_TIMEOUT_MS, LOCK_HOLD_WARN_MS,
  // The idle threshold the sweep measures against — exported so a test can drive
  // a brain past it by ARGUMENT (sweepIdleBrains(now + SERVE_IDLE_MS + 1)) rather
  // than by mutating internal state or waiting five real minutes.
  SERVE_IDLE_MS,
};
