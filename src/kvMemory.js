/**
 * kvMemory.js — general-purpose, per-agent persistent key-value skill.
 *
 * WHAT IT IS
 * ──────────
 * A hand-written multi-tool skill (same shape as reviewMemory.js / github.js):
 * `serverName`, `allowedTools`, `tools[]`, `handleToolCall`, and a `resolve()`
 * that spawns the GENERIC bin/mcp-skill.mjs. It gives ANY agent (github-ai-scout
 * for dedup, future agents, etc.) a durable key→value store across stateless
 * Fargate runs.
 *
 * RELATIONSHIP TO review-memory (REUSE, NOT FORK)
 * ───────────────────────────────────────────────
 * This skill hits the EXACT SAME backend route, ops, auth, and DDB table as
 * reviewMemory.js — POST {base}/credits/review-memory with a body { op, ... }
 * where op ∈ 'store' | 'recall' | 'recall-prefix' (served by the CreditsApi
 * nested stack; basePath '/credits' stripped → handler sees '/review-memory').
 * There is NO backend change and NO new table. review-memory.js is left 100%
 * untouched.
 *
 * THE ONE BEHAVIORAL ADDITION — AUTOMATIC PER-AGENT NAMESPACING
 * ─────────────────────────────────────────────────────────────
 * review-memory makes the caller pass a `scope` STRING verbatim, and per-agent
 * isolation today is a CONVENTION (each caller manually prefixes its scope).
 * This skill removes that footgun: the agent-facing tools take a PLAIN `key`
 * (or `keyPrefix`), and the skill itself derives the backend scope:
 *
 *     effective backend scope = `${WORKFLOW_TYPE}:${key}`
 *
 * `WORKFLOW_TYPE` is injected into every Fargate run by the workflow-executor
 * (backend/src/services/workflow-executor.js). If it's absent (local dev, a
 * runtime that doesn't set it) we fall back to the literal `'agent'` so the
 * skill NEVER crashes. Two different workflow types therefore land on disjoint
 * SKs for the same key (e.g. 'github-ai-scout:seen#42' vs
 * 'github-code-review:seen#42'), and both live in a distinct SK space from
 * review-memory's 'review:...' scopes — zero collision in the same per-project
 * partition (PK = `<accountId>#<projectId>`, derived by the backend from the
 * Bearer token, never from anything the skill sends).
 *
 * AUTH — identical to reviewMemory.js
 * ────────────────────────────────────
 * Calls ZIBBY'S OWN backend with PROJECT_API_TOKEN (Bearer) against
 * ZIBBY_ACCOUNT_API_URL (default api-prod.zibby.app). Mirrors
 * @zibby/core/backend-client.js getSessionToken()/getAccountApiUrl() rather
 * than importing a non-existent helper, so the auth model stays identical.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the generic skill MCP server binary — identical rationale to
 * reviewMemory.js resolveSkillBin(): derive from import.meta.url so it works in
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
 * dev ZIBBY_USER_TOKEN, then the local CLI session.
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
 * to the live prod host.
 */
function getAccountApiUrl() {
  if (process.env.ZIBBY_ACCOUNT_API_URL) return process.env.ZIBBY_ACCOUNT_API_URL.replace(/\/$/, '');
  const env = process.env.ZIBBY_ENV || 'prod';
  if (env === 'local') return 'http://localhost:3001';
  return process.env.ZIBBY_PROD_ACCOUNT_API_URL || 'https://api-prod.zibby.app';
}

/**
 * The per-agent namespace prefix. WORKFLOW_TYPE is injected into every Fargate
 * run; fall back to the literal 'agent' so the skill never crashes outside a
 * run. Trimmed; an empty/whitespace-only value also falls back.
 */
function agentNamespace() {
  const wt = typeof process.env.WORKFLOW_TYPE === 'string' ? process.env.WORKFLOW_TYPE.trim() : '';
  return wt || 'agent';
}

/** Build the effective backend scope from a plain caller key. */
function scopeFor(key) {
  return `${agentNamespace()}:${key}`;
}

/**
 * POST {base}/credits/review-memory with a body { op, ... }. Returns parsed JSON.
 * SAME route + ops + table as reviewMemory.js (intentional reuse — no backend
 * change). Throws a descriptive error on a non-2xx so handleToolCall surfaces it.
 */
async function kvMemoryFetch(op, payload) {
  const session = getSessionToken();
  if (!session) {
    throw new Error('No backend credential (PROJECT_API_TOKEN). KV memory is only available inside a Zibby run.');
  }
  const url = `${getAccountApiUrl()}/credits/review-memory`;
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
    throw new Error(`KV memory ${op} failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

export const kvMemorySkill = {
  id: 'kv-memory',
  serverName: 'kv_memory',
  allowedTools: ['mcp__kv_memory__*'],
  description: 'KV memory — a private, per-agent persistent key→value store across stateless runs (auto-namespaced)',

  promptFragment: `## KV Memory (private, per-agent, persistent key-value store)
You have a PRIVATE per-agent key-value memory that survives across your
stateless runs. It is automatically namespaced to YOU (this agent type) — other
agents cannot see or collide with your entries, and you don't need to prefix
anything. Just use plain keys.

Tools:
- kv_recall: Recall the value stored under a plain \`key\` (exact match).
  Use at the START of a run to pick up what a prior run of yours recorded.
- kv_recall_prefix: List entries whose plain \`keyPrefix\` matches
  (e.g. "seen#" to list everything you've marked seen). Capped at 25.
- kv_store: Store (overwrite) a concise value under a plain \`key\`.
  Use to record durable facts — e.g. dedup markers, prior decisions, summaries.

Your namespace is added for you automatically; pass plain keys like
"seen#owner/repo#42" or "lastRun".`,

  resolve() {
    // Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs) pointing at this
    // module's kvMemorySkill export — same FIXED pattern as reviewMemory/
    // github/gitlab (NEVER return { command: null }). The module arg resolves
    // relative to bin/ at runtime → ../dist/kvMemory.js in a published install.
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env: {}, description: this.description };
    // Forward the backend-auth env + WORKFLOW_TYPE the spawned MCP process needs
    // (the skill's fetch + namespace helpers read these). resolve() runs in the
    // agent process where the workflow-executor has set them.
    const env = {};
    for (const key of [
      'PROJECT_API_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_ENV', 'ZIBBY_PROD_ACCOUNT_API_URL', 'ZIBBY_USER_TOKEN',
      // The namespace source. Forwarded only when set; absent → 'agent' fallback.
      'WORKFLOW_TYPE',
    ]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/kvMemory.js', 'kvMemorySkill'],
      env,
      description: this.description,
      // Force tools into the system prompt instead of deferring behind the
      // SDK's ToolSearch (same as github.js / reviewMemory.js).
      alwaysLoad: true,
    };
  },

  async handleToolCall(name, args) {
    try {
      switch (name) {
        case 'kv_recall': {
          const key = typeof args?.key === 'string' ? args.key.trim() : '';
          if (!key) return JSON.stringify({ error: 'key is required' });
          const data = await kvMemoryFetch('recall', { scope: scopeFor(key) });
          return JSON.stringify(data);
        }

        case 'kv_recall_prefix': {
          const keyPrefix = typeof args?.keyPrefix === 'string' ? args.keyPrefix.trim() : '';
          if (!keyPrefix) return JSON.stringify({ error: 'keyPrefix is required' });
          const data = await kvMemoryFetch('recall-prefix', { scopePrefix: scopeFor(keyPrefix) });
          return JSON.stringify(data);
        }

        case 'kv_store': {
          const key = typeof args?.key === 'string' ? args.key.trim() : '';
          if (!key) return JSON.stringify({ error: 'key is required' });
          if (typeof args?.content !== 'string' || args.content.length === 0) {
            return JSON.stringify({ error: 'content is required (non-empty string)' });
          }
          const payload = { scope: scopeFor(key), content: args.content };
          if (args.metadata != null) payload.metadata = args.metadata;
          const data = await kvMemoryFetch('store', payload);
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
      name: 'kv_recall',
      description: 'Recall the value you stored under a plain key (exact match). Your per-agent namespace is added automatically — pass a plain key like "seen#owner/repo#42".',
      input_schema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Plain storage key (no namespace prefix needed) — e.g. "seen#owner/repo#42" or "lastRun".' },
        },
        required: ['key'],
      },
    },
    {
      name: 'kv_recall_prefix',
      description: 'List your entries whose plain key STARTS WITH a prefix (e.g. "seen#"). Your per-agent namespace is added automatically. Capped at 25.',
      input_schema: {
        type: 'object',
        properties: {
          keyPrefix: { type: 'string', description: 'Plain key prefix to match (no namespace prefix needed) — e.g. "seen#".' },
        },
        required: ['keyPrefix'],
      },
    },
    {
      name: 'kv_store',
      description: 'Store (overwrite) a value under a plain key so a later run of yours can recall it. Your per-agent namespace is added automatically.',
      input_schema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Plain storage key (no namespace prefix needed). Same key you recall by.' },
          content: { type: 'string', description: 'The value to persist. Free-form markdown/text.' },
          metadata: { type: 'object', description: 'Optional structured metadata.' },
        },
        required: ['key', 'content'],
      },
    },
  ],
};
