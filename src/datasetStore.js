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
 * dataset and later runs SQL-style queries/aggregations over them — e.g. to
 * accumulate metrics across runs and produce a report.
 *
 * BACKEND (already built — NO change here)
 * ─────────────────────────────────────────
 * Two routes on the SAME base URL kv-memory uses (getAccountApiUrl(), prod
 * https://api-prod.zibby.app), authed with the SAME Bearer project token
 * (getSessionToken()):
 *   - POST {base}/datasets/{dataset}/append  body { record, agent }
 *       → { ok, id, dataset, ts }
 *   - POST {base}/datasets/{dataset}/query   body { select?, where?, groupBy?,
 *       orderBy?, limit?, since?, until?, agent? }
 *       → { ok, dataset, rowCount, columns, rows }
 * The `dataset` lives in the URL path. Tenancy (account + project) is enforced
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
 * POST {base}/datasets/{dataset}/{action} with `payload`. Returns parsed JSON.
 * `dataset` is path-encoded; tenancy is derived server-side from the Bearer
 * token (the skill never sends account/project). Throws a descriptive error on
 * a non-2xx so handleToolCall surfaces it.
 */
async function datasetFetch(dataset, action, payload) {
  const session = getSessionToken();
  if (!session) {
    throw new Error('No backend credential (PROJECT_API_TOKEN). Dataset store is only available inside a Zibby run.');
  }
  const url = `${getAccountApiUrl()}/datasets/${encodeURIComponent(dataset)}/${action}`;
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
    throw new Error(`Dataset ${action} failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * The store allowlist for this run, parsed from ZIBBY_STORES (comma-joined ids
 * injected by the workflow-executor for a node that declares `stores:[...]`).
 * Returns null when unset/empty (no gating — backward-compatible). Helper kept
 * pure so handleToolCall can fast-fail BEFORE any network call.
 */
function storeAllowlist() {
  const raw = typeof process.env.ZIBBY_STORES === 'string' ? process.env.ZIBBY_STORES.trim() : '';
  if (!raw) return null;
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  return ids.length ? ids : null;
}

/**
 * POST {base}/datasets/stores/{storeId}/{action} with `payload`. The store-id
 * addressing variant of datasetFetch — resolves to the live store backend
 * (GET/POST /datasets/stores/{storeId}/...). Same auth + error shape.
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
You have a durable store for STRUCTURED records that survives across your
stateless runs. Unlike key-value memory (for picking up where you left off),
this is for accumulating DATA you want to QUERY and AGGREGATE later — e.g.
per-run metrics, processed items, findings — and turn into a report.

If your node has provisioned stores, an "AVAILABLE STORES" list appears below —
pick one BY DESCRIPTION and pass its \`storeId\` to the tools. Otherwise records
are grouped by a named \`dataset\` (your choice, e.g. "scout-metrics").
Each appended record is an arbitrary JSON object and is auto-tagged with YOUR
agent type, so you can later filter to just your own writes.

Tools:
- dataset_append: Append ONE structured JSON \`record\` to a \`dataset\`. Use to
  durably persist a row of data each run (e.g. {repo, stars, ts}).
- dataset_query: Run a SQL-style query over a \`dataset\` — select/aggregate
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
      // The node's store allowlist (comma-joined ids). Forwarded only when set,
      // so a node without `stores` gets no ZIBBY_STORES → no gating (no-op).
      'ZIBBY_STORES',
    ]) {
      if (process.env[key]) env[key] = process.env[key];
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
      // Resolve the target: a `store`/`storeId` arg (new, store-id addressed)
      // takes precedence over the legacy `dataset` name path. Returns one of:
      //   { storeId }          — hit /datasets/stores/{storeId}/...
      //   { dataset }          — legacy /datasets/{dataset}/...
      //   { error }            — fast-fail (allowlist reject / missing target)
      // ALLOWLIST GATE: when ZIBBY_STORES is set, a storeId outside it is
      // rejected BEFORE any backend call. Guarded: ZIBBY_STORES unset → no
      // gating, so existing dataset-name callers are unaffected.
      const resolveTarget = () => {
        let storeId = typeof args?.storeId === 'string' ? args.storeId.trim()
                    : typeof args?.store === 'string' ? args.store.trim()
                    : '';
        const allow = storeAllowlist();
        // Single-store convenience: if exactly one store is allowlisted and the
        // caller omitted a storeId, default to it.
        if (!storeId && allow && allow.length === 1) storeId = allow[0];
        if (storeId) {
          if (allow && !allow.includes(storeId)) {
            return { error: `storeId '${storeId}' is not in this node's store allowlist (${allow.join(', ')})` };
          }
          return { storeId };
        }
        const dataset = typeof args?.dataset === 'string' ? args.dataset.trim() : '';
        if (dataset) return { dataset };
        return { error: 'a storeId (or legacy dataset name) is required' };
      };

      switch (name) {
        case 'dataset_append': {
          if (args?.record == null || typeof args.record !== 'object' || Array.isArray(args.record)) {
            return JSON.stringify({ error: 'record is required (a JSON object)' });
          }
          const target = resolveTarget();
          if (target.error) return JSON.stringify({ error: target.error });
          const agent = typeof args?.agent === 'string' && args.agent.trim() ? args.agent.trim() : agentNamespace();
          if (target.storeId) {
            const data = await storeFetch(target.storeId, 'append', { record: args.record, agent });
            return JSON.stringify({ ...data, storeId: target.storeId });
          }
          const data = await datasetFetch(target.dataset, 'append', { record: args.record, agent });
          return JSON.stringify(data);
        }

        case 'dataset_query': {
          const target = resolveTarget();
          if (target.error) return JSON.stringify({ error: target.error });
          // Pass the DSL straight through; the backend validates it. Only
          // forward keys that were actually provided.
          const payload = {};
          for (const key of ['select', 'where', 'groupBy', 'orderBy', 'limit', 'since', 'until', 'agent']) {
            if (args?.[key] != null) payload[key] = args[key];
          }
          if (target.storeId) {
            const data = await storeFetch(target.storeId, 'query', payload);
            return JSON.stringify({ ...data, storeId: target.storeId });
          }
          const data = await datasetFetch(target.dataset, 'query', payload);
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
      name: 'dataset_append',
      description: 'Append ONE structured JSON record to a named dataset, durably. Records persist across your stateless runs and are auto-tagged with your agent type so you can filter to your own writes later. Use to accumulate data you will query/aggregate (e.g. per-run metrics, processed items).',
      input_schema: {
        type: 'object',
        properties: {
          storeId: { type: 'string', description: 'A provisioned store id (from AVAILABLE STORES — pick by description). Preferred. If your node has exactly one store, you may omit this and it defaults to that store.' },
          dataset: { type: 'string', description: 'Legacy: an ad-hoc dataset name (your choice, e.g. "scout-metrics"). Use `storeId` when a store is provisioned; only use `dataset` when no store is available.' },
          record: { type: 'object', description: 'An arbitrary JSON object — one row of data. Its keys become queryable fields (e.g. {"repo":"owner/x","stars":1200}).' },
          agent: { type: 'string', description: 'Optional writing-agent tag. Defaults to your own agent type — leave unset to auto-tag.' },
        },
        required: ['record'],
      },
    },
    {
      name: 'dataset_query',
      description: 'Run a SQL-style query over a dataset to build reports: select/aggregate (count|sum|avg|min|max), filter, group, order, limit, and bound by month. Returns { columns, rows }. Use this to compute summaries/aggregations from records you appended earlier.',
      input_schema: {
        type: 'object',
        properties: {
          storeId: { type: 'string', description: 'A provisioned store id (from AVAILABLE STORES — pick by description). Preferred. If your node has exactly one store, you may omit this and it defaults to that store.' },
          dataset: { type: 'string', description: 'Legacy: the ad-hoc dataset name you appended under. Use `storeId` when a store is provisioned.' },
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
