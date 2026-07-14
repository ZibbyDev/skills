/**
 * gbrain.js — tier-③ "connect to a sidecar over an env-injected URL" skill
 * (SCAFFOLD / STUB). Gives an agent an ingest / query / delete surface over a
 * per-tenant KNOWLEDGE-BASE brain (PGlite + pgvector) that runs as a SIDECAR,
 * reached at GBRAIN_MCP_URL.
 *
 * The brain is persisted as a Stores-v2 store whose TYPE is the real engine —
 * `postgres` (PGlite = embedded Postgres 17.5 + pgvector), NOT `gbrain`. A
 * product name never belongs in a store `type`; `gbrain` is only this SKILL.
 * Naming the type after the engine keeps the contract stable if the engine is
 * ever swapped (Supabase / self-managed Postgres / another pgvector KB). See
 * the knowledge-base template's ingest node for the store DEF.
 *
 * WHY THIS SHAPE (and the honest dogfood finding)
 * ───────────────────────────────────────────────
 * The engine's MCP client (@zibby/core/mcp-client.js) speaks ONLY the stdio
 * transport — it has no built-in streamable-HTTP / SSE MCP client. So the
 * codebase's actual tier-③ "sidecar via env URL" pattern is NOT "the engine
 * dials an HTTP MCP server"; it is a LOCAL stdio MCP proxy that itself dials the
 * sidecar. `browser` does exactly this: it resolves to a local stdio MCP binary
 * that connects to a remote browser over CDP (BROWSER_WS_ENDPOINT). GBrain
 * mirrors that: a hand-written skill (kvMemory.js shape — `tools[]` +
 * `handleToolCall` + a `resolve()` that spawns the GENERIC bin/mcp-skill.mjs
 * stdio server pointing back at THIS module), whose tool handlers proxy each
 * call to the sidecar over HTTP at GBRAIN_MCP_URL.
 *
 * Reading env in resolve() to reach a sidecar (like browser reads
 * BROWSER_WS_ENDPOINT) is fully expressible on the public API. The one thing
 * that is NOT expressible today: pointing the engine DIRECTLY at a
 * streamable-HTTP MCP endpoint — that would need an engine transport change
 * (mcp-client.js is stdio-only). The stdio-proxy pattern here sidesteps that,
 * so this scaffold needs ZERO private-platform change.
 *
 * STUB STATUS
 * ───────────
 * The three tools are wired end-to-end shape-wise but their bodies are STUBS:
 * when GBRAIN_MCP_URL is set they POST to the sidecar; when it is unset (the
 * scaffold default) they return a clear, structured "sidecar not wired
 * (scaffold)" result rather than throwing — so a run that declares SKILLS.GBRAIN
 * degrades gracefully instead of crashing.
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
 * GLOB-collects every non-test src/*.js automatically — dropping this file in
 * src/ is sufficient. (The old CLAUDE.md "add a build.mjs entry" step predates
 * the glob-based builder.)
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_META } from '@zibby/skill-ids';

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

/** The sidecar MCP base URL, env-injected by the runtime (like BROWSER_WS_ENDPOINT). */
function gbrainUrl() {
  const u = typeof process.env.GBRAIN_MCP_URL === 'string' ? process.env.GBRAIN_MCP_URL.trim() : '';
  return u ? u.replace(/\/$/, '') : null;
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
 * STUB proxy to the sidecar. When GBRAIN_MCP_URL is unset (scaffold default),
 * returns a structured not-wired result instead of throwing. When set, POSTs
 * {op, ...} to the sidecar and returns its JSON. Never throws into the run.
 */
async function gbrainCall(op, payload) {
  const base = gbrainUrl();
  if (!base) {
    return {
      ok: false,
      wired: false,
      op,
      kbId: kbId(),
      message: 'GBrain sidecar not wired (scaffold). Set GBRAIN_MCP_URL to a running '
        + 'PGlite/pgvector knowledge-base sidecar to enable ingest/query/delete.',
      echo: payload,
    };
  }
  try {
    const headers = { 'Content-Type': 'application/json' };
    const session = getSessionToken();
    if (session) headers.Authorization = `Bearer ${session}`;
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ op, kbId: kbId(), ...payload }),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      return { ok: false, wired: true, op, status: res.status, message: text.slice(0, 300) };
    }
    try { return { ok: true, wired: true, op, ...JSON.parse(text) }; }
    catch { return { ok: true, wired: true, op, raw: text.slice(0, 1000) }; }
  } catch (e) {
    return { ok: false, wired: true, op, message: String(e?.message || e) };
  }
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
    'Knowledge base (GBrain) — ingest source documents into, query, and prune a per-tenant PGlite/pgvector brain via a sidecar (scaffold/stub)',

  promptFragment: `## Knowledge Base (GBrain — per-tenant document brain)
You have a per-tenant KNOWLEDGE BASE (a PGlite + pgvector "brain") reached over a
sidecar. Ingested documents are addressed by a STABLE \`sourceId\` so re-ingesting
the same source UPSERTS (updates in place) rather than duplicating, and a source
can be removed. Tools:
- gbrain_ingest({ docs }): upsert an array of { sourceId, markdown, deleted? }.
  Pass deleted:true to remove a source that no longer exists upstream.
- gbrain_query({ query, topK }): semantic search the brain; returns the topK most
  relevant document chunks with their sourceId.
- gbrain_delete({ sourceIds }): remove documents by their stable sourceId(s).
NOTE (scaffold): if the sidecar is not wired (GBRAIN_MCP_URL unset) these tools
return a clear "not wired" result — they do not fail the run.`,

  /**
   * Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs) pointing at this
   * module's gbrainSkill export — same FIXED pattern as kvMemory. The module
   * arg resolves relative to bin/ at runtime → ../dist/gbrain.js in a published
   * install. Forwards the sidecar URL + backend auth env the spawned process
   * needs (read GBRAIN_MCP_URL here, like browser reads BROWSER_WS_ENDPOINT).
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
          // Light shape validation — every doc needs a stable sourceId.
          const bad = docs.find((d) => !d || typeof d.sourceId !== 'string' || !d.sourceId.trim());
          if (bad !== undefined) return JSON.stringify({ error: 'every doc requires a non-empty string sourceId' });
          const data = await gbrainCall('ingest', { docs });
          return JSON.stringify(data);
        }

        case 'gbrain_query': {
          const query = typeof args?.query === 'string' ? args.query.trim() : '';
          if (!query) return JSON.stringify({ error: 'query is required' });
          const topK = Number.isInteger(args?.topK) ? args.topK : 8;
          const data = await gbrainCall('query', { query, topK });
          return JSON.stringify(data);
        }

        case 'gbrain_delete': {
          const sourceIds = Array.isArray(args?.sourceIds)
            ? args.sourceIds.filter((s) => typeof s === 'string' && s.trim())
            : null;
          if (!sourceIds || sourceIds.length === 0) {
            return JSON.stringify({ error: 'sourceIds is required (non-empty array of strings)' });
          }
          const data = await gbrainCall('delete', { sourceIds });
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
      description: 'Semantic-search the knowledge base and return the most relevant document chunks (each with its sourceId).',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language query.' },
          topK: { type: 'integer', description: 'How many chunks to return (default 8).' },
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
