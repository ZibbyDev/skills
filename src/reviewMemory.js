/**
 * reviewMemory.js — per-PR (configurable-scope) review-memory skill for the
 * github-code-review agent.
 *
 * WHAT IT IS
 * ──────────
 * A hand-written multi-tool skill (same shape as github.js / gitlab.js):
 * `serverName`, `allowedTools`, `tools[]`, `handleToolCall`, and a `resolve()`
 * that spawns the GENERIC bin/mcp-skill.mjs. It lets the review agent persist
 * "what I pulled + found + reasoned" for a PR and recall it on a follow-up
 * (a fresh stateless Fargate run replying on the same PR).
 *
 * SCOPE IS A PARAM (the whole point) — NOT hardcoded "per-PR"
 * ───────────────────────────────────────────────────────────
 * Every tool takes a `scope` string that becomes the storage key verbatim.
 * The agent decides the granularity by passing a different string:
 *   per-PR   →  scope = 'review:owner/repo#42'
 *   per-repo →  scope = 'repo:owner/repo'
 *   per-org  →  scope = 'org:owner'
 *   custom   →  anything
 * Changing granularity is a different arg — ZERO code change here or in the
 * backend. `review_memory_recall_prefix` lists everything under a prefix
 * (e.g. 'review:owner/repo#') for future per-repo recall.
 *
 * AUTH — how the skill reaches the ZIBBY backend (not a 3rd-party API)
 * ────────────────────────────────────────────────────────────────────
 * Unlike github/sentry/etc (which call a 3rd-party API with a token from
 * resolveIntegrationToken), this skill calls ZIBBY'S OWN backend. It uses the
 * EXACT credential + endpoint the workflow-executor injects for every Fargate
 * run and that @zibby/core/backend-client.js already reads:
 *   - PROJECT_API_TOKEN  — the run's project token (Bearer). The backend
 *     request authorizer validates it → context { accountId, projectId,
 *     authType:'project' }; review-memory.js derives the tenant partition
 *     from THAT, never from anything the skill sends. (Same path the agent's
 *     SKILLS.* integration-token lookups already trust.)
 *   - ZIBBY_ACCOUNT_API_URL — account API base, default api-prod.zibby.app
 *     (workflow-executor only sets it explicitly for dev/local → ngrok).
 * We mirror backend-client.js's getSessionToken()/getAccountApiUrl() rather
 * than import a non-existent helper, so the auth model stays identical.
 *
 * Endpoint: POST {base}/memory/review  with body { op, ... }. One route,
 * body-dispatched op ('store' | 'recall' | 'recall-prefix') — the backend's
 * MainApiRoutes stack is near CFN's 500-resource cap (see review-memory.js).
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the generic skill MCP server binary — identical rationale to
 * github.js resolveSkillBin(): derive from import.meta.url so it works in
 * src/ (dev), dist/ (bundled), and node_modules/@zibby/skills/ (published).
 */
function resolveSkillBin() {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

/**
 * The run's backend credential. Mirrors @zibby/core/backend-client.js
 * getSessionToken(): prefer the Fargate-injected PROJECT_API_TOKEN, then the
 * dev ZIBBY_USER_TOKEN, then the local CLI session — so the same skill works
 * in a deployed run and in local dev.
 */
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

/**
 * Account API base URL. Mirrors backend-client.js getAccountApiUrl():
 * explicit ZIBBY_ACCOUNT_API_URL (dev/local → ngrok) wins; otherwise default
 * to the live prod host (the route is mounted on the main API Gateway).
 */
function getAccountApiUrl() {
  if (process.env.ZIBBY_ACCOUNT_API_URL) return process.env.ZIBBY_ACCOUNT_API_URL.replace(/\/$/, '');
  const env = process.env.ZIBBY_ENV || 'prod';
  if (env === 'local') return 'http://localhost:3001';
  return process.env.ZIBBY_PROD_ACCOUNT_API_URL || 'https://api-prod.zibby.app';
}

/**
 * POST {base}/memory/review with a body { op, ... }. Returns the parsed JSON.
 * Throws a descriptive error on a non-2xx so handleToolCall surfaces it.
 */
async function reviewMemoryFetch(op, payload) {
  const session = getSessionToken();
  if (!session) {
    throw new Error('No backend credential (PROJECT_API_TOKEN). Review memory is only available inside a Zibby run.');
  }
  const url = `${getAccountApiUrl()}/memory/review`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ op, ...payload }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Review memory ${op} failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

// ── SELF-HOST FILE BACKEND (opt-in, additive) ───────────────────────────────
// When running OUTSIDE Zibby cloud (self-hosted CI), there is no Zibby backend
// to POST /memory/review at — and no PROJECT_API_TOKEN. Instead we persist the
// SAME three ops to a LOCAL JSON FILE so a re-review of the same PR recalls the
// prior note across stateless CI runs.
//
// This is GATED on an EXPLICIT self-host signal — identical rationale to
// @zibby/core's resolveIntegrationToken() fast path: it is NEVER inferred from
// "a path env happens to be set", because the cloud Fargate task injects all
// sorts of env. The gate is `ZIBBY_SELF_HOST` truthy (the same flag the runner
// sets, and that the cloud task NEVER sets). With the flag absent,
// selfHostMemoryFile() returns null and every op takes the cloud HTTP branch —
// byte-for-byte unchanged.
//
// File shape (a scope→entry map, atomic write to avoid a torn file):
//   { "<scope>": { content, metadata?, headSha?, scope, createdAt, updatedAt }, ... }

/** ZIBBY_SELF_HOST truthy? Mirrors core/backend-client.js selfHostEnabled(). */
function selfHostEnabled() {
  const v = process.env.ZIBBY_SELF_HOST;
  return v != null && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

/**
 * The local JSON file path when self-host FILE mode is active, else null.
 *
 * Active iff ALL of:
 *   1. ZIBBY_SELF_HOST is truthy (explicit opt-in — same gate as core), AND
 *   2. the backend isn't disabled (ZIBBY_REVIEW_MEMORY_BACKEND !== 'none'), AND
 *   3. a path is resolvable — ZIBBY_REVIEW_MEMORY_PATH, else the default
 *      `.zibby/review-memory.json` under cwd.
 *
 * Returns an absolute path, or null → the cloud HTTP path stays unchanged.
 */
function selfHostMemoryFile() {
  if (!selfHostEnabled()) return null;
  const backend = (process.env.ZIBBY_REVIEW_MEMORY_BACKEND || '').trim().toLowerCase();
  if (backend === 'none') return null;
  const configured = process.env.ZIBBY_REVIEW_MEMORY_PATH;
  const rel = configured && configured.trim() ? configured.trim() : join('.zibby', 'review-memory.json');
  return resolvePath(process.cwd(), rel);
}

/** Read the scope→entry map from the file. Missing/corrupt file ⇒ {}. */
function readMemoryFile(file) {
  try {
    if (!existsSync(file)) return {};
    const raw = readFileSync(file, 'utf-8');
    if (!raw.trim()) return {};
    const data = JSON.parse(raw);
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  } catch {
    // A corrupt/unreadable file must NOT crash the review — treat as empty.
    return {};
  }
}

/** Atomic write (temp + rename) so a crash mid-write can't leave a torn file. */
function writeMemoryFile(file, data) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  renameSync(tmp, file);
}

/** Shape one entry exactly like the cloud `memory` object so prompts match. */
function toMemory(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    scope: entry.scope,
    content: entry.content,
    metadata: entry.metadata || null,
    headSha: entry.headSha || null,
    createdAt: entry.createdAt || null,
    updatedAt: entry.updatedAt || null,
  };
}

/**
 * Run an op against the local JSON file, returning the EXACT same result shape
 * the cloud backend (handlers/review-memory.js) returns for that op:
 *   store        → { stored: true, scope, headSha, updatedAt }
 *   recall       → { found, memory }      (memory null on miss)
 *   recall-prefix→ { count, truncated, memories }
 * Self-host runs one review at a time (single writer), so a plain
 * read-modify-write is safe; we write atomically to avoid a torn file. Errors
 * degrade to the soft "nothing found"/error shape — never throw.
 */
function reviewMemoryFile(file, op, payload) {
  if (op === 'store') {
    const store = readMemoryFile(file);
    const now = new Date().toISOString();
    const prev = store[payload.scope];
    const entry = {
      scope: payload.scope,
      content: payload.content,
      metadata: payload.metadata != null ? payload.metadata : undefined,
      headSha: payload.headSha != null ? payload.headSha : undefined,
      createdAt: (prev && prev.createdAt) || now,
      updatedAt: now,
    };
    store[payload.scope] = entry;
    writeMemoryFile(file, store);
    return { stored: true, scope: payload.scope, headSha: entry.headSha || null, updatedAt: now };
  }

  if (op === 'recall') {
    const store = readMemoryFile(file);
    const entry = store[payload.scope];
    if (!entry) return { found: false, memory: null };
    return { found: true, memory: toMemory(entry) };
  }

  if (op === 'recall-prefix') {
    const store = readMemoryFile(file);
    const memories = Object.values(store)
      .filter((e) => e && typeof e.scope === 'string' && e.scope.startsWith(payload.scopePrefix))
      .map(toMemory)
      // Match the cloud's RECALL_PREFIX_LIMIT (25) so behaviour is identical.
      .slice(0, 25);
    return { count: memories.length, truncated: false, memories };
  }

  return { error: `Unknown op: ${op}` };
}

/**
 * One dispatch helper the handlers call for ALL three ops. When the self-host
 * file backend is active it reads/writes the local JSON file; otherwise it
 * takes the EXACT cloud HTTP path (reviewMemoryFetch) — unchanged.
 */
async function reviewMemoryOp(op, payload) {
  const file = selfHostMemoryFile();
  if (file) return reviewMemoryFile(file, op, payload);
  return reviewMemoryFetch(op, payload);
}

export const reviewMemorySkill = {
  id: 'review-memory',
  serverName: 'review_memory',
  allowedTools: ['mcp__review_memory__*'],
  description: 'Review memory — persist & recall per-PR (configurable-scope) review notes across stateless runs',

  promptFragment: `## Review Memory (per-PR, configurable scope)
Persist what you pulled, found, and reasoned during a review so a FOLLOW-UP
run (a fresh stateless task replying on the same PR) can recall it. Storage is
keyed by a \`scope\` STRING you choose — nothing is hardcoded to per-PR:
- per-PR:   scope = "review:owner/repo#<prNumber>"   (the usual choice)
- per-repo: scope = "repo:owner/repo"
- per-org:  scope = "org:owner"
Same tools, different scope string — pick the granularity you need.

Tools:
- review_memory_recall: At the START of a review, recall any prior note for
  this PR's scope (e.g. "review:owner/repo#42"). If found, build on it instead
  of re-deriving everything.
- review_memory_recall_prefix: List notes whose scope starts with a prefix
  (e.g. "review:owner/repo#") — e.g. to see prior reviews across a repo.
- review_memory_store: At the END (or when you learn something durable), store
  a concise note under the PR's scope. Pass headSha so a later run knows which
  commit the note describes. Overwrites the prior note for that exact scope.`,

  resolve() {
    // Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs) pointing at this
    // module's reviewMemorySkill export — same FIXED pattern as github/gitlab/
    // linear (NEVER return { command: null }; that hands the SDK an
    // unspawnable server → zero tools). The module arg resolves relative to
    // bin/ at runtime → ../dist/reviewMemory.js in a published install.
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env: {}, description: this.description };
    // Forward the backend-auth env the spawned MCP process needs (the skill's
    // own fetch helper reads these). resolve() runs in the agent process where
    // they're set by the workflow-executor.
    const env = {};
    for (const key of [
      'PROJECT_API_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_ENV', 'ZIBBY_PROD_ACCOUNT_API_URL', 'ZIBBY_USER_TOKEN',
      // Self-host file backend: the spawned MCP process's selfHostMemoryFile()
      // reads these. Forwarded only when set (cloud never sets ZIBBY_SELF_HOST),
      // so the cloud spawn env is unchanged.
      'ZIBBY_SELF_HOST', 'ZIBBY_REVIEW_MEMORY_BACKEND', 'ZIBBY_REVIEW_MEMORY_PATH',
    ]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/reviewMemory.js', 'reviewMemorySkill'],
      env,
      description: this.description,
      // Force tools into the system prompt instead of deferring behind the
      // SDK's ToolSearch (same as github.js — MCP-served tools are otherwise
      // invisible to the model).
      alwaysLoad: true,
    };
  },

  async handleToolCall(name, args) {
    try {
      switch (name) {
        case 'review_memory_recall': {
          const scope = typeof args?.scope === 'string' ? args.scope.trim() : '';
          if (!scope) return JSON.stringify({ error: 'scope is required' });
          // `query` is accepted for forward-compat (a future semantic recall)
          // but v1 recall is an exact-scope lookup; we ignore it server-side.
          const data = await reviewMemoryOp('recall', { scope });
          return JSON.stringify(data);
        }

        case 'review_memory_recall_prefix': {
          const scopePrefix = typeof args?.scopePrefix === 'string' ? args.scopePrefix.trim() : '';
          if (!scopePrefix) return JSON.stringify({ error: 'scopePrefix is required' });
          const data = await reviewMemoryOp('recall-prefix', { scopePrefix });
          return JSON.stringify(data);
        }

        case 'review_memory_store': {
          const scope = typeof args?.scope === 'string' ? args.scope.trim() : '';
          if (!scope) return JSON.stringify({ error: 'scope is required' });
          if (typeof args?.content !== 'string' || args.content.length === 0) {
            return JSON.stringify({ error: 'content is required (non-empty string)' });
          }
          const payload = { scope, content: args.content };
          if (args.metadata != null) payload.metadata = args.metadata;
          if (args.headSha != null) payload.headSha = String(args.headSha);
          const data = await reviewMemoryOp('store', payload);
          return JSON.stringify(data);
        }

        default:
          return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  },

  tools: [
    {
      name: 'review_memory_recall',
      description: 'Recall the prior review note for a scope (exact match). Use at the start of a review to build on what an earlier run pulled/found/reasoned. scope is the storage key — e.g. "review:owner/repo#42" for per-PR.',
      input_schema: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: 'Storage key. Per-PR: "review:owner/repo#<prNumber>". Per-repo: "repo:owner/repo". Per-org: "org:owner". Or any custom string.' },
          query: { type: 'string', description: 'Optional free-text hint (reserved for future semantic recall; v1 ignores it — recall is exact-scope).' },
        },
        required: ['scope'],
      },
    },
    {
      name: 'review_memory_recall_prefix',
      description: 'List review notes whose scope STARTS WITH a prefix (e.g. "review:owner/repo#" to see all prior PR reviews in a repo). Capped at 25 most-relevant.',
      input_schema: {
        type: 'object',
        properties: {
          scopePrefix: { type: 'string', description: 'Scope prefix to match, e.g. "review:owner/repo#" or "repo:owner/".' },
        },
        required: ['scopePrefix'],
      },
    },
    {
      name: 'review_memory_store',
      description: 'Store (overwrite) the review note for a scope so a follow-up run can recall it. Write a concise summary of what you pulled, found, and reasoned. Pass headSha so a later run knows which commit the note describes.',
      input_schema: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: 'Storage key. Per-PR: "review:owner/repo#<prNumber>". Or per-repo/per-org/custom. Same key you recall by.' },
          content: { type: 'string', description: 'The note: what was pulled, what was found, the reasoning. Free-form markdown/text.' },
          metadata: { type: 'object', description: 'Optional structured metadata (e.g. {filesReviewed, verdict, severity}).' },
          headSha: { type: 'string', description: 'Optional PR head commit SHA this note describes — lets a later run detect new commits.' },
        },
        required: ['scope', 'content'],
      },
    },
  ],
};
