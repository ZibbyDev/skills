/**
 * gbrain.js — knowledge-base (KB) skill, brokered through the control-plane.
 *
 * WHAT IT IS
 * ──────────
 * Gives an agent an ingest / query / delete surface over a per-tenant KNOWLEDGE
 * BASE (Postgres + pgvector). The brain is persisted as a Stores-v2 store whose
 * TYPE is the engine protocol — `postgres` — NOT `gbrain` (a product name never
 * belongs in a store `type`; `gbrain` is only THIS skill). Naming the type after
 * the protocol keeps the contract stable if the engine is ever swapped.
 *
 * ARCHITECTURE — brokered, NOT a direct sidecar dial (security)
 * ─────────────────────────────────────────────────────────────
 * The KB engine holds tenant data and is TOO heavy to bake into every run, so it
 * runs as an on-demand SIDECAR. But run containers are network-isolated by design
 * (they can reach ONLY the control-plane, never a datastore/sidecar). So this
 * skill does NOT dial the sidecar directly. It behaves EXACTLY like the
 * dataset-store skill: it hits the token-gated control-plane store API
 *
 *   POST {ZIBBY_ACCOUNT_API_URL}/datasets/stores/{storeId}/ingest {docs}
 *   POST {ZIBBY_ACCOUNT_API_URL}/datasets/stores/{storeId}/query  {query, topK}
 *   POST {ZIBBY_ACCOUNT_API_URL}/datasets/stores/{storeId}/delete {sourceIds}
 *
 * with the run's PROJECT_API_TOKEN (Bearer). The control-plane resolves +
 * authorizes the tenant from the token, then (postgres-store.js) launches/reuses
 * the sidecar on the ISOLATED infra network and proxies the call, deriving the
 * sidecar's `kbId` SERVER-SIDE from (account, project, storeId). The agent never
 * sees the sidecar URL or a kbId — the engine is never exposed to the run.
 *
 * STORES v2 — NAME-BASED RESOLUTION (the shared contract, same as dataset-store)
 * ─────────────────────────────────────────────────────────────────────────────
 * Stores are auto-provisioned at DEPLOY and resolved at runtime BY NAME via env:
 *   - The run carries one `ZIBBY_STORE__<name> = <storeId>` per bound store.
 *   - The agent reads the injected "AVAILABLE STORES" catalog (name + type +
 *     description), picks one, and passes the chosen logical `store` NAME.
 *   - That name→storeId env map is BOTH the allowlist AND the resolver.
 * A knowledge-base agent typically has ONE postgres store bound, so `store` may
 * be omitted and defaults to it.
 *
 * TIER / GATING
 * ─────────────
 * Tier ③ (heavy resident runtime → sidecar), but the sidecar is brokered by the
 * control-plane (above), not dialled by the run. Fully server-side, no user
 * connection → UNGATED. No-connection TOGGLEABLE via SKILL_META['gbrain'].
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_META } from '@zibby/skill-ids';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 1; // one retry on a transient network/5xx error

/**
 * Resolve the generic skill MCP server binary — identical rationale to
 * kvMemory.js / datasetStore.js resolveSkillBin().
 */
function resolveSkillBin() {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

/** The run's backend credential — same resolution order as datasetStore.js. */
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

/** Account API base URL — same resolution as datasetStore.js / backend-client.js. */
function getAccountApiUrl() {
  if (process.env.ZIBBY_ACCOUNT_API_URL) return process.env.ZIBBY_ACCOUNT_API_URL.replace(/\/$/, '');
  const env = process.env.ZIBBY_ENV || 'prod';
  if (env === 'local') return 'http://localhost:3001';
  return process.env.ZIBBY_PROD_ACCOUNT_API_URL || 'https://api-prod.zibby.app';
}

/**
 * The run's bound-store map from `ZIBBY_STORE__<name>=<storeId>` env (same as
 * datasetStore.js). `{ <name>: <storeId> }` is BOTH the allowlist AND resolver;
 * empty values are skipped so an unbound placeholder never becomes addressable.
 */
function storeMap() {
  const map = {};
  for (const [key, value] of Object.entries(process.env)) {
    const m = /^ZIBBY_STORE__(.+)$/.exec(key);
    if (!m) continue;
    const id = typeof value === 'string' ? value.trim() : '';
    if (!id) continue;
    map[m[1]] = id;
  }
  return map;
}

/**
 * Resolve a logical store NAME to its backend storeId against the bound map.
 * Returns `{ storeId, name }` or `{ error }` — never throws. The anti-
 * fragmentation guard: an agent can ONLY address a store bound at deploy.
 *   - name omitted + exactly one bound store → default to it
 *   - name omitted + multiple                → error, list the names
 *   - name omitted + zero bound stores       → error, nothing bound
 *   - name given but not bound               → error, list the available names
 */
function resolveStore(store) {
  const map = storeMap();
  const names = Object.keys(map);
  const requested = typeof store === 'string' ? store.trim() : '';
  if (!requested) {
    if (names.length === 1) return { storeId: map[names[0]], name: names[0] };
    if (names.length === 0) return { error: 'no knowledge-base store is bound to this agent' };
    return { error: `multiple stores are bound; pass \`store\` (one of: ${names.join(', ')})` };
  }
  if (!Object.prototype.hasOwnProperty.call(map, requested)) {
    return { error: `unknown store '${requested}'; available: ${names.join(', ')}` };
  }
  return { storeId: map[requested], name: requested };
}

/**
 * POST {base}/datasets/stores/{storeId}/{action} with the project Bearer token.
 * Tenancy is derived server-side from the token (the skill never sends
 * account/project/kbId). Bounded timeout, one retry on a transient failure.
 * Throws a clear Error on a hard failure; handleToolCall wraps it structurally.
 */
async function storeFetch(storeId, action, payload) {
  const session = getSessionToken();
  if (!session) {
    throw new Error('No backend credential (PROJECT_API_TOKEN). The knowledge base is only available inside a Zibby run.');
  }
  const url = `${getAccountApiUrl()}/datasets/stores/${encodeURIComponent(storeId)}/${action}`;
  const headers = { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' };
  const body = JSON.stringify(payload);

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'POST', headers, body, signal: ac.signal });
      const text = await res.text().catch(() => '');
      if (res.status >= 500 && attempt < MAX_RETRIES) { lastErr = new Error(`store ${res.status}`); continue; }
      if (!res.ok) throw new Error(`gbrain ${action} failed (${res.status}): ${text.slice(0, 300)}`);
      try { return JSON.parse(text); }
      catch { throw new Error(`store returned non-JSON: ${text.slice(0, 200)}`); }
    } catch (e) {
      lastErr = e;
      const transient = e?.name === 'AbortError' || e?.code === 'ECONNREFUSED' || /fetch failed|network/i.test(String(e?.message));
      if (!(transient && attempt < MAX_RETRIES)) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error(`gbrain ${action} request failed`);
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
    'Knowledge base (GBrain) — ingest source documents into, semantically query, and prune a per-tenant Postgres/pgvector brain (a `postgres`-type store, brokered by the control-plane)',

  promptFragment: `## Knowledge Base (GBrain — per-tenant document brain)
You have a per-tenant KNOWLEDGE BASE (a Postgres + pgvector "brain"), bound as a
\`postgres\`-type store in the "AVAILABLE STORES" block below. Ingested documents
are addressed by a STABLE \`sourceId\` so re-ingesting the same source UPSERTS
(updates in place) rather than duplicating, and a source can be removed. If
exactly one store is bound you may omit \`store\`; otherwise pass its NAME.
Tools:
- gbrain_ingest({ docs, store? }): upsert an array of { sourceId, markdown, deleted? }.
  Pass deleted:true to remove a source that no longer exists upstream.
- gbrain_query({ query, topK, store? }): semantic search; returns the topK most
  relevant document chunks with their sourceId and relevance score.
- gbrain_delete({ sourceIds, store? }): remove documents by their stable sourceId(s).`,

  /**
   * Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs) pointing at this
   * module's gbrainSkill export — same FIXED pattern as datasetStore. Forwards
   * the backend-auth env + every bound-store mapping the spawned process needs.
   */
  resolve() {
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env: {}, description: this.description };
    const env = {};
    for (const key of [
      'PROJECT_API_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_ENV',
      'ZIBBY_PROD_ACCOUNT_API_URL', 'ZIBBY_USER_TOKEN', 'WORKFLOW_TYPE',
    ]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    // Forward EVERY bound-store mapping (ZIBBY_STORE__<name>=<storeId>) so the
    // spawned MCP process can resolve store names → ids. A node without a bound
    // store has none → the tools report "no knowledge-base store bound".
    for (const key of Object.keys(process.env)) {
      if (/^ZIBBY_STORE__.+$/.test(key) && process.env[key]) env[key] = process.env[key];
    }
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/gbrain.js', 'gbrainSkill'],
      env,
      description: this.description,
      // Force tools into the system prompt rather than deferring behind the
      // SDK's ToolSearch (same as kvMemory / datasetStore).
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
          const target = resolveStore(args?.store);
          if (target.error) return JSON.stringify({ error: target.error });
          const data = await storeFetch(target.storeId, 'ingest', { docs });
          return JSON.stringify({ ...data, store: target.name, storeId: target.storeId });
        }

        case 'gbrain_query': {
          const query = typeof args?.query === 'string' ? args.query.trim() : '';
          if (!query) return JSON.stringify({ error: 'query is required' });
          const target = resolveStore(args?.store);
          if (target.error) return JSON.stringify({ error: target.error });
          const payload = { query };
          if (Number.isInteger(args?.topK) && args.topK > 0) payload.topK = Math.min(args.topK, 50);
          const data = await storeFetch(target.storeId, 'query', payload);
          return JSON.stringify({ ...data, store: target.name, storeId: target.storeId });
        }

        case 'gbrain_delete': {
          const sourceIds = Array.isArray(args?.sourceIds)
            ? args.sourceIds.filter((s) => typeof s === 'string' && s.trim())
            : null;
          if (!sourceIds || sourceIds.length === 0) {
            return JSON.stringify({ error: 'sourceIds is required (non-empty array of strings)' });
          }
          const target = resolveStore(args?.store);
          if (target.error) return JSON.stringify({ error: target.error });
          const data = await storeFetch(target.storeId, 'delete', { sourceIds });
          return JSON.stringify({ ...data, store: target.name, storeId: target.storeId });
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
          store: { type: 'string', description: 'The bound knowledge-base store NAME (from AVAILABLE STORES). Omit if exactly one store is bound.' },
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
          store: { type: 'string', description: 'The bound knowledge-base store NAME (from AVAILABLE STORES). Omit if exactly one store is bound.' },
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
          store: { type: 'string', description: 'The bound knowledge-base store NAME (from AVAILABLE STORES). Omit if exactly one store is bound.' },
        },
        required: ['sourceIds'],
      },
    },
  ],
};

export default gbrainSkill;
