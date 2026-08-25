/**
 * reviewMemoryIo — the NODE-SIDE (deterministic JS) transport for the
 * code-review → comment_reply structured memory record.
 *
 * WHY THIS EXISTS
 * ───────────────
 * `reviewRecord.js` is PURE (build/serialize/parse/summarize — no I/O). Until now
 * the only thing that STORED/RECALLED the per-PR/MR memory was the LLM, via the
 * kv-memory MCP skill (`kv_store`/`kv_recall`). "Path A" of the approved design
 * lifts that I/O into the JS node so storage is DETERMINISTIC, not LLM-authored.
 * This module is that transport: a thin, BEST-EFFORT client that serializes a
 * record and POSTs it, and recalls + parses one back — reusing the SAME backend
 * route, ops, auth and namespacing the kv-memory skill (kvMemory.js) already uses,
 * so the two channels share one scope and one backend entry.
 *
 * It lives in @zibby/skills (next to kvMemory.js, whose transport it mirrors), NOT
 * in the generic @zibby/core kernel — this is review-domain code, and both review
 * templates already depend on @zibby/skills. The auth + namespace helpers below
 * are inlined (self-contained), byte-identical to kvMemory.js — keeping them the
 * same is what makes the node-side scope agree with the kv-memory skill's scope
 * for the same key (so a node-side store and a later LLM kv_recall land on the
 * SAME backend SK). If kvMemory.js's behaviour changes, change these to match.
 *
 * TRANSPORT CONTRACT (identical to kvMemory.js):
 *   POST `${getAccountApiUrl()}/credits/review-memory`
 *   Authorization: Bearer ${PROJECT_API_TOKEN}
 *   body: { op:'store', scope, content }   |   { op:'recall', scope }
 *   recall returns { content, metadata, ... } (content = stored STRING or null).
 *   scope is namespaced `${WORKFLOW_TYPE-or-'agent'}:${key}`.
 *
 * BEST-EFFORT, ALWAYS. Every function swallows all errors and NEVER throws — a
 * memory store/recall failure must never block or change a posted review/reply.
 * store → { ok:false } on any failure; recall → { kind:'empty' } on any failure.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { serializeReviewRecord, parseReviewMemory } from './reviewRecord.js';
import { fetchWithDeadline } from './lib/http-deadline.js';

// ── auth + base URL — inlined, byte-identical to kvMemory.js (self-contained) ──
function getSessionToken() {
  if (process.env.PROJECT_API_TOKEN) return process.env.PROJECT_API_TOKEN;
  if (process.env.ZIBBY_USER_TOKEN) return process.env.ZIBBY_USER_TOKEN;
  try {
    const p = join(homedir(), '.zibby', 'config.json');
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8')).sessionToken || null;
  } catch {
    return null;
  }
}

function getAccountApiUrl() {
  if (process.env.ZIBBY_ACCOUNT_API_URL) return process.env.ZIBBY_ACCOUNT_API_URL.replace(/\/$/, '');
  const env = process.env.ZIBBY_ENV || 'prod';
  if (env === 'local') return 'http://localhost:3001';
  return process.env.ZIBBY_PROD_ACCOUNT_API_URL || 'https://api-prod.zibby.app';
}

function agentNamespace() {
  const wt = typeof process.env.WORKFLOW_TYPE === 'string' ? process.env.WORKFLOW_TYPE.trim() : '';
  return wt || 'agent';
}

/** Effective backend scope for a plain per-PR/MR key. IDENTICAL to kvMemory scopeFor. */
export function scopeForReviewMemory(key) {
  return `${agentNamespace()}:${key}`;
}

/** POST the review-memory route with a { op, ... } body. Returns parsed JSON or throws. */
async function reviewMemoryFetch(op, payload) {
  const session = getSessionToken();
  if (!session) return { __noToken: true };
  const url = `${getAccountApiUrl()}/credits/review-memory`;
  const res = await fetchWithDeadline(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ op, ...payload }),
  }, { kind: 'api', what: `review-memory ${op}` });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`review-memory ${op} failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Store a review record under a plain per-PR/MR key. Serializes via
 * serializeReviewRecord (deterministic, byte-capped 200KB) and POSTs
 * { op:'store', scope, content }.
 *
 * BEST-EFFORT: never throws. { ok:true } on success; { ok:false, reason:'no-token' }
 * with no backend credential (local dev / self-host); { ok:false, reason } otherwise.
 * The caller must treat a false result as a no-op — memory NEVER blocks a run.
 */
export async function storeReviewRecord(key, record) {
  try {
    const content = serializeReviewRecord(record);
    if (!content) return { ok: false, reason: 'empty-record' };
    const data = await reviewMemoryFetch('store', { scope: scopeForReviewMemory(key), content });
    if (data && data.__noToken) return { ok: false, reason: 'no-token' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.message || 'store-error' };
  }
}

/**
 * Recall the review record stored under a plain per-PR/MR key. POSTs
 * { op:'recall', scope } and hands the returned `content` to the tolerant
 * parseReviewMemory (which never throws over any input).
 *
 * BEST-EFFORT: never throws. Returns parseReviewMemory's result
 * ({ kind:'empty' | 'record' | 'legacy', ... }); { kind:'empty' } on missing
 * token or ANY failure, so the caller degrades to "no prior memory".
 */
export async function recallReviewRecord(key) {
  try {
    const data = await reviewMemoryFetch('recall', { scope: scopeForReviewMemory(key) });
    if (!data || data.__noToken) return { kind: 'empty' };
    // The route returns { found, memory:{ content, metadata, headSha, ... } } —
    // content is the stored STRING (nested under `memory`). Nothing stored →
    // { found:false } (no memory). parseReviewMemory tolerates string|object|null.
    const mem = data.found && data.memory ? data.memory : null;
    if (!mem) return { kind: 'empty' };
    const raw = mem.content != null ? mem.content : (mem.metadata != null ? mem.metadata : null);
    return parseReviewMemory(raw);
  } catch {
    return { kind: 'empty' };
  }
}
