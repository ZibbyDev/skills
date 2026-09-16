/**
 * graphMemory.ts — memory-graph skill, brokered through the control-plane.
 *
 * WHAT IT IS
 * ──────────
 * Gives an agent a write / recall surface over a per-tenant MEMORY GRAPH — our
 * open-source `agent-graph` engine (Postgres + pgvector) run as an on-demand
 * sidecar. The graph is persisted as a Stores-v2 store whose TYPE is the
 * protocol name `graph-memory` (never a product name); `graph-memory` is also
 * THIS skill's id. gbrain.ts with the engine swapped: same brokering, same
 * store resolution, same auth.
 *
 * ARCHITECTURE — brokered, NOT a direct sidecar dial (security)
 * ─────────────────────────────────────────────────────────────
 * Run containers reach ONLY the control-plane, never a sidecar. So this skill
 * hits the token-gated control-plane store API
 *
 *   POST {ZIBBY_ACCOUNT_API_URL}/datasets/stores/{storeId}/<op>
 *   op ∈ put | link | recall_many | subgraph | trace   (the ops this skill exposes)
 *
 * with the run's PROJECT_API_TOKEN (Bearer). The control-plane resolves +
 * authorizes the tenant from the token, derives the sidecar's `graphId`
 * SERVER-SIDE from (account, project, storeId), resolves the OWNING agent's
 * embedding config + memory policy + writer identity (`origin`) from its own
 * row, and forwards to the engine. The agent never sees the sidecar URL, a
 * graphId, or an origin — and anything it sends under those names is STRIPPED
 * by the control-plane (backend/src/handlers/graph-memory-store.js).
 *
 * PROVENANCE — a model writes 'claimed', full stop
 * ────────────────────────────────────────────────
 * The engine distinguishes 'observed' (a runtime saw it) from 'claimed' (an
 * agent judged it). This skill runs INSIDE a model's run, so the control-plane
 * never marks its calls trusted and the engine refuses 'observed'. The tools
 * below therefore do not even offer a `provenance` argument; one that arrives
 * anyway is dropped here so the call is not refused for a field the model
 * could never legitimately set.
 *
 * STORES v2 — NAME-BASED RESOLUTION: identical to gbrain.ts / datasetStore.ts
 * (`ZIBBY_STORE__<name>=<storeId>` is both the allowlist and the resolver; a
 * single bound store may be addressed without naming it).
 *
 * TIER / GATING: tier ③ (heavy resident runtime → sidecar), brokered by the
 * control-plane, fully server-side, no user connection → UNGATED. Toggleable
 * via SKILL_META['graph-memory'].
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_META } from '@zibby/skill-ids';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 1; // one retry on a transient network/5xx error

// ONE constant per layer for the brand-neutral name (the product may be renamed).
const SKILL_ID = 'graph-memory';

/** Resolve the generic skill MCP server binary — same rationale as gbrain.ts. */
function resolveSkillBin() {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

/** The run's backend credential — same resolution order as datasetStore.ts. */
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

/** Account API base URL — same resolution as datasetStore.ts / backend-client.js. */
function getAccountApiUrl() {
  if (process.env.ZIBBY_ACCOUNT_API_URL) return process.env.ZIBBY_ACCOUNT_API_URL.replace(/\/$/, '');
  const env = process.env.ZIBBY_ENV || 'prod';
  if (env === 'local') return 'http://localhost:3001';
  return process.env.ZIBBY_PROD_ACCOUNT_API_URL || 'https://api-prod.zibby.app';
}

/** The run's bound-store map from `ZIBBY_STORE__<name>=<storeId>` env. */
function storeMap() {
  const map: Record<string, string> = {};
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
 * Returns `{ storeId, name }` or `{ error }` — never throws (gbrain.ts rules).
 */
type StoreTarget = { storeId: string; name: string } | { error: string };
const isStoreError = (t: StoreTarget): t is { error: string } => 'error' in t;

export function resolveStore(store: unknown): StoreTarget {
  const map = storeMap();
  const names = Object.keys(map);
  const requested = typeof store === 'string' ? store.trim() : '';
  if (!requested) {
    if (names.length === 1) return { storeId: map[names[0]], name: names[0] };
    if (names.length === 0) return { error: 'no memory-graph store is bound to this agent' };
    return { error: `multiple stores are bound; pass \`store\` (one of: ${names.join(', ')})` };
  }
  if (!Object.prototype.hasOwnProperty.call(map, requested)) {
    return { error: `unknown store '${requested}'; available: ${names.join(', ')}` };
  }
  return { storeId: map[requested], name: requested };
}

/**
 * POST {base}/datasets/stores/{storeId}/{op} with the project Bearer token.
 * Tenancy is derived server-side from the token (the skill never sends
 * account/project/graphId/origin). Bounded timeout, one retry on a transient
 * failure. Throws a clear Error on a hard failure; handleToolCall wraps it.
 */
async function storeFetch(storeId: string, op: string, payload: Record<string, unknown>) {
  const session = getSessionToken();
  if (!session) {
    throw new Error('No backend credential (PROJECT_API_TOKEN). The memory graph is only available inside a Zibby run.');
  }
  const url = `${getAccountApiUrl()}/datasets/stores/${encodeURIComponent(storeId)}/${op}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' };
  const body = JSON.stringify(payload);

  let lastErr: any;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'POST', headers, body, signal: ac.signal });
      const text = await res.text().catch(() => '');
      if (res.status >= 500 && attempt < MAX_RETRIES) { lastErr = new Error(`store ${res.status}`); continue; }
      if (!res.ok) throw new Error(`${SKILL_ID} ${op} failed (${res.status}): ${text.slice(0, 300)}`);
      try { return JSON.parse(text); }
      catch { throw new Error(`store returned non-JSON: ${text.slice(0, 200)}`); }
    } catch (e: any) {
      lastErr = e;
      const transient = e?.name === 'AbortError' || e?.code === 'ECONNREFUSED' || /fetch failed|network/i.test(String(e?.message));
      if (!(transient && attempt < MAX_RETRIES)) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error(`${SKILL_ID} ${op} request failed`);
}

/**
 * The engine's arguments from a tool call: everything but our own `store`
 * selector, and never `provenance` (see the header — a model writes 'claimed',
 * which is the engine's default; passing 'observed' would only be refused).
 * Platform-owned names (graphId/origin/trusted/…) are stripped again by the
 * control-plane, so this list does not have to know them.
 */
function engineArgs(args: any): Record<string, unknown> {
  const { store: _store, provenance: _provenance, ...rest } = (args && typeof args === 'object') ? args : {};
  return rest;
}

// A recall query, as the engine documents it (agent-graph RecallQuery). The
// same JSON Schema text the platform's MCP door advertises — parity by copy,
// asserted by the door's test against this module's tool list.
const RECALL_QUERY_SCHEMA = {
  type: 'object',
  description: 'One recall query (agent-graph RecallQuery): seeds and/or match as entry points; rels/kinds/direction/scope/provenance shape the walk; maxCost bounds it; validAt/asOf/recordedBetween are the time filters.',
  properties: {
    seeds: { type: 'array', items: { type: 'string' }, description: 'Entry points by node id.' },
    match: { type: 'object', description: 'Entry points by exact match: { kind?, label?, labelContains?, attrs?, limit? }.' },
    maxCost: { type: 'number', description: 'Budget: max accumulated edge cost from any seed (default 2).' },
    rels: { type: 'array', items: { type: 'string' }, description: 'Only traverse these relation names.' },
    kinds: { type: 'array', items: { type: 'string' }, description: 'Only RETURN nodes of these kinds.' },
    scope: { description: 'Only traverse edges with this scope (string or array); null-scope edges are global.' },
    provenance: { type: 'array', items: { type: 'string', enum: ['observed', 'claimed'] }, description: 'Only traverse edges with these provenances.' },
    direction: { type: 'string', enum: ['out', 'in', 'both'], description: "Edge direction relative to the frontier (default 'both')." },
    limit: { type: 'integer', description: 'Cap on returned hits (default 50).' },
    order: { type: 'string', enum: ['cost', 'recent', 'oldest'], description: "'cost' (default) = closest first." },
    includeSeeds: { type: 'boolean', description: 'Include the seed nodes themselves as hits.' },
    project: { type: 'string', enum: ['summary', 'full'], description: "How much of each hit to return: 'summary' (default) = id, kind, label, provenance, time and the path's relation names; 'full' = whole records including attrs." },
    validAt: { type: 'integer', description: 'WORLD-time filter (ms epoch): only edges valid at this instant.' },
    asOf: { type: 'integer', description: 'KNOWLEDGE-time filter (ms epoch): what the graph knew then.' },
    recordedBetween: { type: 'array', items: { type: ['integer', 'null'] }, description: 'KNOWLEDGE-time window [from, to] (ms epoch or null).' },
  },
};
const STORE_PARAM = { type: 'string', description: 'The bound memory-graph store NAME (from AVAILABLE STORES). Omit if exactly one store is bound.' };

// tool name → the store route's op. graph_recall is the BATCH form (one call,
// one engine load); the single-query `recall` op exists on the route too.
export const TOOL_OP: Readonly<Record<string, string>> = Object.freeze({
  graph_put: 'put',
  graph_link: 'link',
  graph_get: 'get',
  graph_recall: 'recall_many',
  graph_subgraph: 'subgraph',
  graph_trace: 'trace',
});

export const graphMemorySkill: any = {
  id: SKILL_ID,
  // Backend-calling: the MCP child talks to Zibby's own backend — the
  // session-env contract is guaranteed by backendSession.ts at registration.
  callsBackend: true,
  serverName: 'graph_memory',
  allowedTools: ['mcp__graph_memory__*'],
  // Static toggle metadata by REFERENCE to the single source of truth.
  meta: SKILL_META[SKILL_ID],
  description:
    'Memory graph — write entities and time-aware assertions into, and recall by traversal from, a per-tenant memory graph (a `graph-memory`-type store, brokered by the control-plane)',

  promptFragment: `## Memory Graph (per-tenant, shared by the fleet)
You have a MEMORY GRAPH bound as a \`graph-memory\`-type store in the "AVAILABLE
STORES" block below: entities are NODES (id \`kind:namespace/key\`, e.g.
\`file:github.com/org/repo/src/x.ts\`, \`ticket:vikunja/292\`, \`run:exec-7f3a\`) and
relations are EDGES — assertions with a cost, a scope, world time (validFrom/validTo)
and knowledge time. Nothing is deleted: a wrong assertion is superseded. Your writes
are recorded as provenance 'claimed' (you are an agent; 'observed' is for runtimes).
Mint ids deterministically from the real-world identity so one entity is one node.
If exactly one store is bound you may omit \`store\`; otherwise pass its NAME.
Tools:
- graph_put({ id, kind, label, attrs?, store? }): create/update a node (upsert by id, versions kept).
- graph_link({ src, dst, rel, cost?, scope?, validFrom?, validTo?, attrs?, store? }): assert src →rel→ dst.
- graph_get({ id | edgeId, store? }): one node or edge, latest version, no traversal — check before you put.
- graph_recall({ queries: [{ seeds?, match?, rels?, kinds?, maxCost?, direction?, validAt?, asOf? }], store? }):
  batched traversal; each hit carries its cost and the exact path of edges.
- graph_subgraph({ seeds?, match?, rels?, kinds?, maxCost?, store? }): the induced subgraph (nodes + all live edges) for visualisation/hand-off.
- graph_trace({ id, store? }): a node's full history — every version and every edge, superseded ones included.`,

  /**
   * Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs) pointing at this
   * module — same FIXED pattern as gbrain/datasetStore. Forwards the backend-auth
   * env + every bound-store mapping the spawned process needs.
   */
  resolve() {
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env: {}, description: this.description };
    const env: Record<string, string> = {};
    for (const key of [
      'PROJECT_API_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_ENV',
      'ZIBBY_PROD_ACCOUNT_API_URL', 'ZIBBY_USER_TOKEN', 'WORKFLOW_TYPE',
    ]) {
      if (process.env[key]) env[key] = process.env[key] as string;
    }
    for (const key of Object.keys(process.env)) {
      if (/^ZIBBY_STORE__.+$/.test(key) && process.env[key]) env[key] = process.env[key] as string;
    }
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/graphMemory.js', 'graphMemorySkill'],
      env,
      description: this.description,
    };
  },

  async handleToolCall(name: string, args: any) {
    try {
      const op = TOOL_OP[name];
      if (!op) return JSON.stringify({ error: `Unknown tool: ${name}` });
      // Per-tool argument gates: the ones a wrong call would otherwise pay a
      // round-trip to learn. Field-level validation is the ENGINE's (by name).
      switch (name) {
        case 'graph_put':
          for (const k of ['id', 'kind', 'label']) {
            if (typeof args?.[k] !== 'string' || !args[k].trim()) return JSON.stringify({ error: `${k} (a non-empty string) is required` });
          }
          break;
        case 'graph_link':
          for (const k of ['src', 'dst', 'rel']) {
            if (typeof args?.[k] !== 'string' || !args[k].trim()) return JSON.stringify({ error: `${k} (a non-empty string) is required` });
          }
          break;
        case 'graph_get': {
          const hasId = typeof args?.id === 'string' && !!args.id.trim();
          const hasEdge = typeof args?.edgeId === 'string' && !!args.edgeId.trim();
          if (hasId === hasEdge) return JSON.stringify({ error: 'exactly one of id (a node) or edgeId (an edge) is required' });
          break;
        }
        case 'graph_recall':
          if (!Array.isArray(args?.queries) || args.queries.length === 0) return JSON.stringify({ error: 'queries is required (non-empty array of recall queries)' });
          break;
        case 'graph_trace':
          if (typeof args?.id !== 'string' || !args.id.trim()) return JSON.stringify({ error: 'id (a non-empty string) is required' });
          break;
        default:
          break;
      }
      const target = resolveStore(args?.store);
      if (isStoreError(target)) return JSON.stringify({ error: target.error });
      const data = await storeFetch(target.storeId, op, engineArgs(args));
      return JSON.stringify({ ...data, store: target.name, storeId: target.storeId });
    } catch (e: any) {
      return JSON.stringify({ error: String(e?.message || e) });
    }
  },

  tools: [
    {
      name: 'graph_put',
      description: 'Create or update a node (an entity: a file, ticket, run, person, repo, conclusion) in the memory graph. Upsert by id (`kind:namespace/key`); an existing id appends a version, so history is kept. Call it before graph_link so both ends exist. Recorded as provenance \'claimed\'. Credential-shaped values are rejected — never put secrets here.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Canonical node id, e.g. `file:github.com/org/repo/src/x.ts`, `ticket:vikunja/292`, `run:exec-7f3a`. Mint it deterministically from the real-world identity.' },
          kind: { type: 'string', description: "Free-string kind: 'file', 'ticket', 'run', 'member', 'repo', 'epic', 'note', …" },
          label: { type: 'string', description: 'Human-readable name (a path, a ticket title, a run name).' },
          attrs: { type: 'object', description: 'Free-form JSON attributes. Never secrets.' },
          recordedAt: { type: 'integer', description: 'Knowledge time of this version (ms epoch). Defaults to now.' },
          store: STORE_PARAM,
        },
        required: ['id', 'kind', 'label'],
      },
    },
    {
      name: 'graph_link',
      description: 'Assert a relation between two nodes (src →rel→ dst). Every call appends a NEW edge with its own id. cost shapes later recall (cheap = close; a hub relation like in_repo might be 10); validFrom/validTo say when the fact held in the world (omitted validTo = still holds); scope is a branch/environment. Recorded as provenance \'claimed\'.',
      input_schema: {
        type: 'object',
        properties: {
          src: { type: 'string', description: 'Source node id (create it with graph_put first).' },
          dst: { type: 'string', description: 'Destination node id (create it with graph_put first).' },
          rel: { type: 'string', description: "Relation name, snake_case by convention: 'touched', 'worked_on', 'depends_on', 'in_repo', 'notes', 'returned'." },
          cost: { type: 'number', description: 'Traversal cost; lower = closer (default 1).' },
          directed: { type: 'boolean', description: 'Default true. An undirected edge is traversable both ways.' },
          scope: { type: ['string', 'null'], description: 'Branch / version / environment the assertion applies to. Omitted = global.' },
          attrs: { type: 'object', description: 'Free-form JSON attributes ({ reason }, { text }, { status }). Never secrets.' },
          validFrom: { type: ['integer', 'null'], description: 'World time the fact started to hold (ms epoch). Omitted = unbounded past; pass Date.now() for "starts now".' },
          validTo: { type: ['integer', 'null'], description: 'World time the fact stopped holding (ms epoch). Omitted = still holds (an OPEN fact).' },
          recordedAt: { type: 'integer', description: 'Knowledge time (ms epoch). Defaults to now; set only when back-filling.' },
          store: STORE_PARAM,
        },
        required: ['src', 'dst', 'rel'],
      },
    },
    {
      name: 'graph_get',
      description: 'Fetch one node (by `id`) or one edge (by `edgeId`) — latest version, no traversal. Returns null when unknown. The cheapest way to check existence or read current attrs before a graph_put.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Node id to fetch.' },
          edgeId: { type: 'string', description: 'Edge id to fetch instead of a node.' },
          store: STORE_PARAM,
        },
      },
    },
    {
      name: 'graph_recall',
      description: 'The main read, BATCHED: several recall queries in one call. Each starts from seeds (ids) and/or match (kind/label/attrs) and walks the graph cheapest-first within maxCost, returning every reachable node with its cost, the exact path of edges walked (origin, provenance, scope, validity) and which seed reached it. Shape the walk with rels (which hops), kinds (what to return), direction, scope, provenance; validAt = world time ("what was true then"), asOf = knowledge time ("what did the graph know then"). Results stay grouped per query; node records are in the shared `nodes` map.',
      input_schema: {
        type: 'object',
        properties: {
          queries: { type: 'array', items: RECALL_QUERY_SCHEMA, minItems: 1, description: 'The recall queries, answered in order.' },
          store: STORE_PARAM,
        },
        required: ['queries'],
      },
    },
    {
      name: 'graph_subgraph',
      description: 'Export the induced subgraph around a query: every node the same recall would reach, plus ALL live edges among those nodes (not just the cheapest paths). The input for visualisation and for hand-offs that need the full local structure. Same filters as a recall query; the seeds are always included.',
      input_schema: { ...RECALL_QUERY_SCHEMA, properties: { ...RECALL_QUERY_SCHEMA.properties, store: STORE_PARAM } },
    },
    {
      name: 'graph_trace',
      description: "A node's full history: every version (oldest first) and every edge ever attached to it, in or out, including superseded ones. Use it to audit how an entity was described over time.",
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Node id to trace.' },
          store: STORE_PARAM,
        },
        required: ['id'],
      },
    },
  ],
};

export default graphMemorySkill;
