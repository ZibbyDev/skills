/**
 * datasetStore.js — durable, queryable structured-artifact store skill.
 *
 * WHAT IT IS
 * ──────────
 * A hand-written multi-tool skill (same shape as kvMemory.js / reviewMemory.js /
 * github.js): `serverName`, `allowedTools`, `tools[]`, `handleToolCall`, and a
 * `resolve()` that spawns the GENERIC bin/mcp-skill.mjs. Unlike kv-memory (a
 * key→value MEMORY for picking up where a prior run left off), this is a durable
 * STRUCTURED-RECORD store: an agent appends arbitrary JSON records to a named
 * store and later runs SQL-style queries/aggregations over them — e.g. to
 * accumulate metrics across runs and produce a report.
 *
 * STORES v2 — NAME-BASED RESOLUTION (the shared contract)
 * ────────────────────────────────────────────────────────
 * Stores are auto-provisioned at DEPLOY and resolved at runtime BY NAME via env:
 *   - The run carries one `ZIBBY_STORE__<name> = <storeId>` per bound store.
 *   - The agent reads the injected "AVAILABLE STORES" prompt catalog (name +
 *     description), picks one, and passes the chosen logical `name` to the tool.
 *   - This name→storeId env map is BOTH the allowlist AND the resolver: the
 *     agent can only ever write to a declared/bound name (anti-fragmentation).
 *
 * BACKEND (already built — NO change here)
 * ─────────────────────────────────────────
 * Two routes on the SAME base URL kv-memory uses (getAccountApiUrl(), prod
 * https://api-prod.zibby.app), authed with the SAME Bearer project token
 * (getSessionToken()):
 *   - POST {base}/datasets/stores/{storeId}/append  body { record, agent }
 *       → { ok, id, ts }
 *   - POST {base}/datasets/stores/{storeId}/query   body { select?, where?,
 *       groupBy?, orderBy?, limit?, since?, until?, agent? }
 *       → { ok, rowCount, columns, rows }
 * The `storeId` lives in the URL path. Tenancy (account + project) is enforced
 * SERVER-SIDE from the Bearer token — the skill NEVER sends account/project.
 *
 * AUTOMATIC PER-AGENT TAGGING
 * ────────────────────────────
 * Appends default `agent` to the writing agent's namespace (WORKFLOW_TYPE,
 * falling back to the literal 'agent'), so records are auto-tagged with who
 * wrote them and `query`'s optional `agent` filter can scope to one writer.
 *
 * AUTH — identical to kvMemory.js / reviewMemory.js
 * ──────────────────────────────────────────────────
 * Calls ZIBBY'S OWN backend with PROJECT_API_TOKEN (Bearer) against
 * ZIBBY_ACCOUNT_API_URL (default api-prod.zibby.app). Mirrors
 * @zibby/core/backend-client.js getSessionToken()/getAccountApiUrl() rather than
 * importing a non-existent helper, so the auth model stays identical.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the generic skill MCP server binary — identical rationale to
 * kvMemory.js resolveSkillBin(): derive from import.meta.url so it works in
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
 * The per-agent namespace. WORKFLOW_TYPE is injected into every Fargate run;
 * fall back to the literal 'agent' so the skill never crashes outside a run.
 * Trimmed; an empty/whitespace-only value also falls back.
 */
function agentNamespace() {
  const wt = typeof process.env.WORKFLOW_TYPE === 'string' ? process.env.WORKFLOW_TYPE.trim() : '';
  return wt || 'agent';
}

/**
 * The run's bound-store map, derived from the `ZIBBY_STORE__<name>=<storeId>`
 * env injected at deploy/dispatch (one var per store the node declared). The
 * returned `{ <name>: <storeId> }` is BOTH the allowlist AND the resolver:
 *   - keys are the logical store NAMES the agent sees in "AVAILABLE STORES";
 *   - values are the opaque storeIds the backend addresses.
 * Empty values are skipped (an unbound placeholder must not become writable).
 * Pure, so handleToolCall can fast-fail BEFORE any network call.
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
 * Returns `{ storeId, name }` on success or `{ error }` (a clear, agent-facing
 * message) — never throws. This is the anti-fragmentation guard: an agent can
 * ONLY ever address a store that was declared at deploy and bound into env.
 *   - name omitted + exactly one bound store → default to it
 *   - name omitted + multiple                → error, list the names to choose
 *   - name omitted + zero bound stores       → error, nothing to write to
 *   - name given but not bound               → error, list the available names
 */
function resolveStore(store) {
  const map = storeMap();
  const names = Object.keys(map);
  const requested = typeof store === 'string' ? store.trim() : '';
  if (!requested) {
    if (names.length === 1) return { storeId: map[names[0]], name: names[0] };
    if (names.length === 0) return { error: 'no stores bound to this agent' };
    return { error: `multiple stores are bound; pass \`store\` (one of: ${names.join(', ')})` };
  }
  if (!Object.prototype.hasOwnProperty.call(map, requested)) {
    return { error: `unknown store '${requested}'; available: ${names.join(', ')}` };
  }
  return { storeId: map[requested], name: requested };
}

/**
 * POST {base}/datasets/stores/{storeId}/{action} with `payload`. Addresses the
 * live store backend by the storeId resolved from a bound store name
 * (resolveStore). Tenancy is derived server-side from the Bearer token (the
 * skill never sends account/project). Throws a descriptive error on a non-2xx
 * so handleToolCall surfaces it.
 */
async function storeFetch(storeId, action, payload) {
  const session = getSessionToken();
  if (!session) {
    throw new Error('No backend credential (PROJECT_API_TOKEN). Dataset store is only available inside a Zibby run.');
  }
  const url = `${getAccountApiUrl()}/datasets/stores/${encodeURIComponent(storeId)}/${action}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Store ${action} failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

export const datasetStoreSkill = {
  id: 'dataset-store',
  serverName: 'dataset_store',
  allowedTools: ['mcp__dataset_store__*'],
  description: 'Dataset store — a durable, queryable store for structured JSON records; append rows now, run SQL-style aggregations/reports later',

  promptFragment: `## Dataset Store (durable, queryable structured-record store)
You have one or more durable stores for STRUCTURED records that survive across
your stateless runs. Unlike key-value memory (for picking up where you left
off), this is for accumulating DATA you want to QUERY and AGGREGATE later — e.g.
per-run metrics, processed items, findings — and turn into a report.

Your bound stores are listed in the "AVAILABLE STORES" block below (each with a
name + description). Pick one BY DESCRIPTION and pass its \`store\` NAME (e.g.
"scorecards") to the tools — NOT an id. If exactly one store is bound you may
omit \`store\` and it defaults to that one. You can ONLY write to a bound store
name; any other name is rejected. Each appended record is an arbitrary JSON
object, auto-tagged with YOUR agent type so you can later filter to your writes.

Tools:
- dataset_append: Append ONE structured JSON \`record\` to a store (by \`store\`
  name). Use to durably persist a row of data each run (e.g. {repo, stars, ts}).
- dataset_query: Run a SQL-style query over a store — select/aggregate
  (count|sum|avg|min|max), filter (where), group (groupBy), order, limit, and
  bound by month (since/until). Use to compute reports from what you've stored.`,

  resolve() {
    // Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs) pointing at this
    // module's datasetStoreSkill export — same FIXED pattern as kvMemory/
    // reviewMemory/github (NEVER return { command: null }). The module arg
    // resolves relative to bin/ at runtime → ../dist/datasetStore.js in a
    // published install.
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
    // Forward EVERY bound-store mapping (ZIBBY_STORE__<name>=<storeId>) so the
    // spawned MCP process can resolve store names → ids. A node without `stores`
    // has none → the map is empty → the tools report "no stores bound".
    for (const key of Object.keys(process.env)) {
      if (/^ZIBBY_STORE__.+$/.test(key) && process.env[key]) env[key] = process.env[key];
    }
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/datasetStore.js', 'datasetStoreSkill'],
      env,
      description: this.description,
      // Opt-in capability: a node requests it via skills:[...]. Unlike
      // kv-memory (alwaysLoad), this is NOT auto-loaded — only nodes that
      // declare it get its tools.
      alwaysLoad: false,
    };
  },

  async handleToolCall(name, args) {
    try {
      switch (name) {
        case 'dataset_append': {
          if (args?.record == null || typeof args.record !== 'object' || Array.isArray(args.record)) {
            return JSON.stringify({ error: 'record is required (a JSON object)' });
          }
          // Resolve the logical store NAME → storeId via the bound env map. The
          // map is the allowlist: an unbound name is rejected BEFORE any call.
          const target = resolveStore(args?.store);
          if (target.error) return JSON.stringify({ error: target.error });
          const agent = typeof args?.agent === 'string' && args.agent.trim() ? args.agent.trim() : agentNamespace();
          const payload = { record: args.record, agent };
          // `description` is informational (the store already exists from
          // deploy) — accepted + passed through when present, never required.
          if (typeof args?.description === 'string' && args.description.trim()) {
            payload.description = args.description.trim();
          }
          const data = await storeFetch(target.storeId, 'append', payload);
          return JSON.stringify({ ...data, store: target.name, storeId: target.storeId });
        }

        case 'dataset_query': {
          const target = resolveStore(args?.store);
          if (target.error) return JSON.stringify({ error: target.error });
          // Pass the DSL straight through; the backend validates it. Only
          // forward keys that were actually provided.
          const payload = {};
          for (const key of ['select', 'where', 'groupBy', 'orderBy', 'limit', 'since', 'until', 'agent']) {
            if (args?.[key] != null) payload[key] = args[key];
          }
          const data = await storeFetch(target.storeId, 'query', payload);
          return JSON.stringify({ ...data, store: target.name, storeId: target.storeId });
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
      name: 'dataset_append',
      description: 'Append ONE structured JSON record to a bound store, durably. Records persist across your stateless runs and are auto-tagged with your agent type so you can filter to your own writes later. Use to accumulate data you will query/aggregate (e.g. per-run metrics, processed items). Append ONE record per call.',
      input_schema: {
        type: 'object',
        properties: {
          store: { type: 'string', description: 'The logical store NAME to write to (e.g. "scorecards"), taken from the AVAILABLE STORES list — pick by description. NOT an id. If exactly one store is bound you may omit this and it defaults to that store; you can ONLY write to a bound store name.' },
          record: { type: 'object', description: 'An arbitrary JSON object — one row of data. Its keys become queryable fields (e.g. {"repo":"owner/x","stars":1200}). One record per call.' },
          description: { type: 'string', description: 'Optional, informational note about this write. The store already exists from deploy, so this is not required and does not create anything.' },
          agent: { type: 'string', description: 'Optional writing-agent tag. Defaults to your own agent type — leave unset to auto-tag.' },
        },
        required: ['record'],
      },
    },
    {
      name: 'dataset_query',
      description: 'Run a SQL-style query over a bound store to build reports: select/aggregate (count|sum|avg|min|max), filter, group, order, limit, and bound by month. Returns { columns, rows }. Use this to compute summaries/aggregations from records you appended earlier.',
      input_schema: {
        type: 'object',
        properties: {
          store: { type: 'string', description: 'The logical store NAME to query (e.g. "scorecards"), taken from the AVAILABLE STORES list — pick by description. NOT an id. If exactly one store is bound you may omit this and it defaults to that store.' },
          select: {
            type: 'array',
            description: 'Columns to return. Each item is { field?, agg?, as? }. agg ∈ count|sum|avg|min|max; omit field for count(*). Omit `select` entirely to return raw rows.',
          },
          where: {
            type: 'array',
            description: 'Filters, ANDed. Each item is { field, op, value }; op ∈ eq|ne|gt|gte|lt|lte|like. `field` is a JSON key of the stored record.',
          },
          groupBy: {
            type: 'array',
            description: 'Field names to group by (array of strings) for aggregation.',
          },
          orderBy: {
            type: 'array',
            description: 'Sort spec. Each item is { field|as, dir }; dir ∈ asc|desc.',
          },
          limit: { type: 'number', description: 'Maximum number of rows to return.' },
          since: { type: 'string', description: "Inclusive lower bound month, 'yyyy-MM' (e.g. '2026-01')." },
          until: { type: 'string', description: "Inclusive upper bound month, 'yyyy-MM' (e.g. '2026-06')." },
          agent: { type: 'string', description: 'Filter to records written by one agent namespace. Omit to query across all writers.' },
        },
        required: [],
      },
    },
  ],
};
