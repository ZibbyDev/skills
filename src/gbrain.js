/**
 * gbrain.js — tier-③ "connect to a sidecar over an env-injected URL" skill.
 * Gives an agent an ingest / query / delete surface over a per-tenant
 * KNOWLEDGE-BASE brain (Postgres/PGlite + pgvector) that runs as a SIDECAR,
 * reached at GBRAIN_MCP_URL.
 *
 * The brain is persisted as a Stores-v2 store whose TYPE is the real engine —
 * `postgres` (PGlite = embedded Postgres 17.5 + pgvector), NOT `gbrain`. A
 * product name never belongs in a store `type`; `gbrain` is only this SKILL.
 * Naming the type after the engine keeps the contract stable if the engine is
 * ever swapped (Supabase / self-managed Postgres / another pgvector KB). See
 * the knowledge-base template's ingest node for the store DEF.
 *
 * WHY THIS SHAPE
 * ─────────────────────────────────────────────────
 * The engine's MCP client (@zibby/core/mcp-client.js) speaks ONLY the stdio
 * transport — no built-in streamable-HTTP / SSE client. So the tier-③ "sidecar
 * via env URL" pattern is NOT "the engine dials an HTTP MCP server"; it is a
 * LOCAL stdio MCP proxy that itself dials the sidecar. `browser` does this
 * (stdio bin → remote browser over CDP / BROWSER_WS_ENDPOINT). GBrain mirrors
 * it: a hand-written skill (kvMemory.js shape — `tools[]` + `handleToolCall` +
 * a `resolve()` that spawns the GENERIC bin/mcp-skill.mjs stdio server pointing
 * back at THIS module), whose tool handlers proxy each call to the sidecar over
 * HTTP at GBRAIN_MCP_URL.
 *
 * SIDECAR HTTP CONTRACT (stable; engine-agnostic — implemented by sidecars/gbrain)
 * ─────────────────────────────────────────────────────────────────────────────
 *   POST  {GBRAIN_MCP_URL}/ingest  { kbId, docs:[{sourceId, markdown, deleted?}] }
 *         → { ok, upserted, deleted, chunks }
 *   POST  {GBRAIN_MCP_URL}/query   { kbId, query, topK }
 *         → { ok, results:[{ sourceId, chunk, score }] }
 *   POST  {GBRAIN_MCP_URL}/delete  { kbId, sourceIds:[...] }
 *         → { ok, deleted }
 *   GET   {GBRAIN_MCP_URL}/health  → { ok }
 *   Auth: optional `Authorization: Bearer <PROJECT_API_TOKEN>` (the sidecar
 *   normally runs on the run's private network and may not require it).
 *
 * Keeping this a small REST contract (not GBrain's own API) is deliberate: the
 * sidecar can be GBrain, a bare PGlite+pgvector server, or another engine — the
 * skill never changes. This IS the "pluggable engine" property of the KB.
 *
 * TIER / GATING
 * ─────────────
 * Tier ③ (heavy resident runtime → sidecar). Fully server-side, no user
 * connection → UNGATED (deliberately NOT in the backend REQUIRED/OPTIONAL
 * integration maps). No-connection TOGGLEABLE via SKILL_META['gbrain'] (see
 * @zibby/skill-ids). meta is set BY REFERENCE to that single source of truth.
 *
 * BUILD NOTE
 * ──────────
 * No build-script entry is needed: the shared build (packages/scripts/build.mjs)
 * GLOB-collects every non-test src/*.js — dropping this file in src/ suffices.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_META } from '@zibby/skill-ids';

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 1; // one retry on a transient network/5xx error

/**
 * Resolve the generic skill MCP server binary — identical rationale to
 * kvMemory.js resolveSkillBin(): derive from import.meta.url so it works in src/
 * (dev), dist/ (bundled), and node_modules/@zibby/skills/ (published).
 */
function resolveSkillBin() {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

/** The sidecar base URL, env-injected by the runtime (like BROWSER_WS_ENDPOINT). */
function gbrainBase() {
  const u = typeof process.env.GBRAIN_MCP_URL === 'string' ? process.env.GBRAIN_MCP_URL.trim() : '';
  return u ? u.replace(/\/+$/, '') : null;
}

/** The run's backend credential — same resolution order as kvMemory.js. */
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
 * The knowledge-base id this run writes to. The parent knowledge-base agent
 * forwards it; falls back to WORKFLOW_TYPE (per-agent brain) then 'default'.
 */
function kbId() {
  const explicit = typeof process.env.GBRAIN_KB_ID === 'string' ? process.env.GBRAIN_KB_ID.trim() : '';
  if (explicit) return explicit;
  const wt = typeof process.env.WORKFLOW_TYPE === 'string' ? process.env.WORKFLOW_TYPE.trim() : '';
  return wt || 'default';
}

/**
 * POST to a sidecar endpoint. Real client: bounded timeout (AbortController),
 * one retry on a transient failure (network error or 5xx), Bearer auth when a
 * token is present. Throws a clear Error on a hard failure; handleToolCall wraps
 * it into a structured tool result (never crashes the run).
 */
async function gbrainPost(path, payload) {
  const base = gbrainBase();
  if (!base) {
    throw new Error(
      'GBrain sidecar URL is not set (GBRAIN_MCP_URL). The knowledge-base sidecar '
      + '(sidecars/gbrain) must be running and its URL injected into the run env.',
    );
  }
  const url = `${base}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  const session = getSessionToken();
  if (session) headers.Authorization = `Bearer ${session}`;
  const body = JSON.stringify({ kbId: kbId(), ...payload });

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'POST', headers, body, signal: ac.signal });
      const text = await res.text().catch(() => '');
      if (res.status >= 500 && attempt < MAX_RETRIES) { lastErr = new Error(`sidecar ${res.status}`); continue; }
      if (!res.ok) throw new Error(`sidecar ${res.status}: ${text.slice(0, 300)}`);
      try { return JSON.parse(text); }
      catch { throw new Error(`sidecar returned non-JSON: ${text.slice(0, 200)}`); }
    } catch (e) {
      lastErr = e;
      const transient = e?.name === 'AbortError' || e?.code === 'ECONNREFUSED' || /fetch failed|network/i.test(String(e?.message));
      if (!(transient && attempt < MAX_RETRIES)) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('GBrain sidecar request failed');
}

export const gbrainSkill = {
  id: 'gbrain',
  serverName: 'gbrain',
  allowedTools: ['mcp__gbrain__*'],
  // Static toggle metadata by REFERENCE to the single source of truth
  // (@zibby/skill-ids SKILL_META) — the engine's toggle gate reads
  // skill.meta.toggleable off this.
  meta: SKILL_META.gbrain,
  description:
    'Knowledge base (GBrain) — ingest source documents into, semantically query, and prune a per-tenant Postgres/pgvector brain via a sidecar',

  promptFragment: `## Knowledge Base (GBrain — per-tenant document brain)
You have a per-tenant KNOWLEDGE BASE (a Postgres + pgvector "brain") reached over a
sidecar. Ingested documents are addressed by a STABLE \`sourceId\` so re-ingesting
the same source UPSERTS (updates in place) rather than duplicating, and a source
can be removed. Tools:
- gbrain_ingest({ docs }): upsert an array of { sourceId, markdown, deleted? }.
  Pass deleted:true to remove a source that no longer exists upstream.
- gbrain_query({ query, topK }): semantic search the brain; returns the topK most
  relevant document chunks with their sourceId and relevance score.
- gbrain_delete({ sourceIds }): remove documents by their stable sourceId(s).`,

  /**
   * Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs) pointing at this
   * module's gbrainSkill export — same FIXED pattern as kvMemory. Forwards the
   * sidecar URL + backend auth env the spawned process needs.
   */
  resolve() {
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env: {}, description: this.description };
    const env = {};
    for (const key of [
      'GBRAIN_MCP_URL', 'GBRAIN_KB_ID',
      'PROJECT_API_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_ENV',
      'ZIBBY_PROD_ACCOUNT_API_URL', 'ZIBBY_USER_TOKEN', 'WORKFLOW_TYPE',
    ]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/gbrain.js', 'gbrainSkill'],
      env,
      description: this.description,
      // Force tools into the system prompt rather than deferring behind the
      // SDK's ToolSearch (same as kvMemory / github).
      alwaysLoad: true,
    };
  },

  async handleToolCall(name, args) {
    try {
      switch (name) {
        case 'gbrain_ingest': {
          const docs = Array.isArray(args?.docs) ? args.docs : null;
          if (!docs) return JSON.stringify({ error: 'docs is required (array of { sourceId, markdown, deleted? })' });
          if (docs.length === 0) return JSON.stringify({ ok: true, upserted: 0, deleted: 0, chunks: 0, note: 'empty docs — nothing to ingest' });
          const bad = docs.find((d) => !d || typeof d.sourceId !== 'string' || !d.sourceId.trim());
          if (bad !== undefined) return JSON.stringify({ error: 'every doc requires a non-empty string sourceId' });
          // A non-deleted doc must carry markdown to upsert.
          const missingMd = docs.find((d) => d.deleted !== true && (typeof d.markdown !== 'string' || !d.markdown.length));
          if (missingMd !== undefined) return JSON.stringify({ error: `doc "${missingMd.sourceId}" has no markdown (required unless deleted:true)` });
          const data = await gbrainPost('/ingest', { docs });
          return JSON.stringify(data);
        }

        case 'gbrain_query': {
          const query = typeof args?.query === 'string' ? args.query.trim() : '';
          if (!query) return JSON.stringify({ error: 'query is required' });
          const topK = Number.isInteger(args?.topK) && args.topK > 0 ? Math.min(args.topK, 50) : 8;
          const data = await gbrainPost('/query', { query, topK });
          return JSON.stringify(data);
        }

        case 'gbrain_delete': {
          const sourceIds = Array.isArray(args?.sourceIds)
            ? args.sourceIds.filter((s) => typeof s === 'string' && s.trim())
            : null;
          if (!sourceIds || sourceIds.length === 0) {
            return JSON.stringify({ error: 'sourceIds is required (non-empty array of strings)' });
          }
          const data = await gbrainPost('/delete', { sourceIds });
          return JSON.stringify(data);
        }

        default:
          return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (e) {
      return JSON.stringify({ error: String(e?.message || e) });
    }
  },

  tools: [
    {
      name: 'gbrain_ingest',
      description: 'Upsert documents into the knowledge base. Each doc is { sourceId, markdown, deleted? }; sourceId is a STABLE id (e.g. "owner/repo#docs/x.md" or a Lark doc token) so re-ingesting the same source UPDATES in place instead of duplicating. Set deleted:true to remove a source.',
      input_schema: {
        type: 'object',
        properties: {
          docs: {
            type: 'array',
            description: 'Documents to upsert.',
            items: {
              type: 'object',
              properties: {
                sourceId: { type: 'string', description: 'Stable source id — the upsert/delete key.' },
                markdown: { type: 'string', description: 'The normalized markdown content of the document.' },
                deleted: { type: 'boolean', description: 'When true, remove this sourceId from the brain (markdown ignored).' },
              },
              required: ['sourceId'],
            },
          },
        },
        required: ['docs'],
      },
    },
    {
      name: 'gbrain_query',
      description: 'Semantic-search the knowledge base and return the most relevant document chunks (each with its sourceId and relevance score).',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language query.' },
          topK: { type: 'integer', description: 'How many chunks to return (default 8, max 50).' },
        },
        required: ['query'],
      },
    },
    {
      name: 'gbrain_delete',
      description: 'Remove documents from the knowledge base by their stable sourceId(s).',
      input_schema: {
        type: 'object',
        properties: {
          sourceIds: {
            type: 'array',
            description: 'Stable source ids to delete.',
            items: { type: 'string' },
          },
        },
        required: ['sourceIds'],
      },
    },
  ],
};

export default gbrainSkill;
