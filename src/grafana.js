/**
 * Grafana integration — low-level API-wrapper skill.
 *
 * Grafana exposes a REST API (https://grafana.com/docs/grafana/latest/developers/http_api/)
 * rooted at `<host>/api`. Auth is a service-account token (or API key) sent as
 * `Authorization: Bearer <token>`. This works identically for Grafana Cloud
 * (https://<stack>.grafana.net) and any self-hosted instance.
 *
 * This is the Grafana analog of gitlab.js (a recent REST-API skill). It mirrors
 * that skill's structure exactly: a small `gfFetch` helper as the single auth
 * chokepoint, a skill object ({ id, serverName, allowedTools, envKeys,
 * description, promptFragment, resolve, handleToolCall, tools[] }), tools that
 * return JSON strings, graceful error messages instead of throws, and trimmed
 * result arrays so a large Grafana doesn't blow the context.
 *
 * Auth / config (env). Grafana has no Zibby backend OAuth handler (unlike
 * jira/github/sentry whose tokens are minted by the backend and fetched via
 * resolveIntegrationToken) — it's configured purely from a pasted token + base
 * URL injected into the run as environment variables, the same env-only shape
 * gitlab.js uses:
 *
 *   - GRAFANA_TOKEN     service-account token / API key (Viewer scope is enough
 *                       for read-only tools; Editor for alert-rule listing on
 *                       some instances). Sent as `Authorization: Bearer <token>`.
 *   - GRAFANA_URL       the Grafana base URL, cloud OR self-hosted — e.g.
 *                       "https://acme.grafana.net" or "https://grafana.acme.io".
 *                       We append `/api`. `GRAFANA_INSTANCE_URL` is kept as an
 *                       alias (mirrors gitlab.js's GITLAB_URL / GITLAB_INSTANCE_URL).
 *   - GRAFANA_API_URL   full `/api` base override (rarely needed). If set it
 *                       wins over GRAFANA_URL.
 *
 * Unlike gitlab.js there is NO `requiresIntegration` declaration: Grafana isn't
 * a member of the closed INTEGRATIONS set (no backend OAuth handler + no
 * frontend Integrations card mirror), and it's reached entirely through process
 * env. Declaring an integration would force users to "connect" something that
 * isn't wired up. Same rationale as the memory/core-tools/browser skills.
 *
 * Pairs with the marketplace's Grafana app and the sentry-triage agent: during
 * an incident, sentry surfaces the error, and these tools let the agent pull
 * the relevant dashboards, run a Prometheus query for the offending metric, and
 * read the currently-firing Grafana alerts for corroborating signal.
 *
 * `grafana_query` uses the modern unified query endpoint `POST /api/ds/query`
 * with a Prometheus query model (datasource resolved by uid). It returns the
 * data frames Grafana hands back, lightly summarized.
 */

import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve as resolvePath } from 'path';

/**
 * Resolve the path to the generic skill MCP server binary. Derived from
 * `import.meta.url` (NOT a package self-reference) so it works in src/
 * during dev, dist/ after bundling, and node_modules/@zibby/skills/ in a
 * published install — bin/ is always a sibling of this module's dir. Mirrors
 * github.js / gitlab.js resolveSkillBin().
 */
function resolveSkillBin() {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

/**
 * Base API url. Resolution order:
 *   1. GRAFANA_API_URL    — explicit /api base, used verbatim
 *   2. GRAFANA_URL        — the instance host; we append /api
 *   3. GRAFANA_INSTANCE_URL — alias for GRAFANA_URL
 * Works for BOTH Grafana Cloud and any self-hosted host. Throws (clear,
 * actionable) when nothing is configured rather than building a bad URL.
 */
function grafanaApiBase() {
  const explicit = process.env.GRAFANA_API_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  const host = (process.env.GRAFANA_URL || process.env.GRAFANA_INSTANCE_URL || '').trim().replace(/\/+$/, '');
  if (!host) {
    throw new Error('Grafana is not configured: set GRAFANA_URL (e.g. https://acme.grafana.net or https://grafana.example.com).');
  }
  // If the configured host already points at the API root, don't double it.
  if (/\/api$/.test(host)) return host;
  return `${host}/api`;
}

/** Resolve the Grafana auth headers from env. */
function grafanaAuthHeaders() {
  const token = process.env.GRAFANA_TOKEN;
  if (!token) {
    throw new Error('Grafana is not connected: set GRAFANA_TOKEN (a Grafana service-account token or API key, sent as a Bearer token).');
  }
  return { Authorization: `Bearer ${token}` };
}

/**
 * Low-level Grafana REST helper. Throws on non-2xx, returns parsed JSON
 * (or raw text when opts.raw). The single auth chokepoint — exported so a
 * future deterministic workflow node can reach endpoints the tools don't
 * cover without re-implementing auth.
 *
 * @param {string} path  API path beginning with `/` (relative to /api),
 *                       or a full https:// url.
 * @param {{ method?: string, body?: object, raw?: boolean }} [opts]
 */
export async function gfFetch(path, opts = {}) {
  const url = /^https?:\/\//.test(path) ? path : `${grafanaApiBase()}${path}`;
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'Zibby-App',
    ...grafanaAuthHeaders(),
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
  };
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Grafana API ${res.status}: ${err.slice(0, 300)}`);
  }
  if (opts.raw) return res.text();
  return res.json();
}

// Cap any list a tool returns so a huge Grafana can't blow the context.
const MAX_ITEMS = 50;

/** Trim an array to MAX_ITEMS and report whether it was truncated. */
function cap(arr, max = MAX_ITEMS) {
  const list = Array.isArray(arr) ? arr : [];
  return { items: list.slice(0, max), total: list.length, truncated: list.length > max };
}

export const grafanaSkill = {
  id: 'grafana',
  serverName: 'grafana',
  // No MCP server — tools are served directly via handleToolCall, same as
  // the gitlab / sentry-assistant skills. allowedTools still namespaces them.
  allowedTools: ['mcp__grafana__*'],
  // NB: no requiresIntegration — Grafana is configured from env (GRAFANA_URL /
  // GRAFANA_TOKEN), not a backend OAuth integration. See file header.
  envKeys: ['GRAFANA_URL', 'GRAFANA_TOKEN', 'GRAFANA_INSTANCE_URL', 'GRAFANA_API_URL'],
  description: 'Grafana — dashboards, datasources, Prometheus queries, alert rules, firing alerts',

  promptFragment: `## Grafana (connected)
You have access to the user's Grafana via the REST API (Grafana Cloud OR self-hosted). Use it to investigate dashboards, run datasource queries, and read alerts — pairs with Sentry for incident investigation. Available tools:

### Dashboards
- grafana_search_dashboards: Search dashboards by free-text query and/or tag. Returns [{uid,title,url,folderTitle,tags}].
- grafana_get_dashboard: Fetch one dashboard by uid. Returns its meta + a SUMMARY of its panels ({id,title,type}) — not the full dashboard JSON.

### Datasources & queries
- grafana_list_datasources: List configured datasources → [{uid,name,type}]. Use to find the uid to query against.
- grafana_query: Run an instant (or short-range) query against a datasource by uid. Prometheus-style: pass { datasourceUid, expr, start?, end?, step? }. start/end are unix seconds or ISO; omit for an instant query at now. Returns the result series.

### Alerts
- grafana_list_alert_rules: List Grafana-managed alert rules (their definitions/state) → summarized.
- grafana_list_firing_alerts: List currently firing/active alerts (the Alertmanager view) with labels + state — what's broken RIGHT NOW.

### Notes
- Incident flow: grafana_list_firing_alerts (what's firing) → grafana_search_dashboards / grafana_get_dashboard (the relevant board) → grafana_list_datasources + grafana_query (pull the offending metric).`,

  resolve() {
    // Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs), pointing it at
    // this module's grafanaSkill export. That binary registers every entry in
    // `tools[]` as an MCP tool and dispatches each call through handleToolCall
    // — so the model gets real mcp__grafana__* tools.
    //
    // Returning `{ command: null }` here (the previous behaviour) handed the
    // claude SDK an unspawnnable server → the model had ZERO grafana tools.
    // Mirrors the fixed github.js / gitlab.js resolve(). The module arg is
    // resolved RELATIVE TO bin/ at runtime, so `../dist/grafana.js` →
    // node_modules/@zibby/skills/dist/grafana.js in a published install.
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env: {}, description: this.description };
    const env = {};
    for (const key of this.envKeys) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/grafana.js', 'grafanaSkill'],
      env,
      description: this.description,
      // Force tools into the system prompt instead of deferring behind the
      // SDK's ToolSearch (see sentry.js resolve()).
      alwaysLoad: true,
    };
  },

  async handleToolCall(name, args) {
    try {
      switch (name) {
        case 'grafana_search_dashboards': {
          const { query, tag, limit } = args || {};
          const params = new URLSearchParams();
          params.set('type', 'dash-db');
          if (query) params.set('query', String(query));
          // Grafana accepts repeated `tag` params for an AND filter.
          if (tag) {
            for (const t of Array.isArray(tag) ? tag : [tag]) params.append('tag', String(t));
          }
          params.set('limit', String(Math.min(Number(limit) || MAX_ITEMS, 100)));
          const data = await gfFetch(`/search?${params.toString()}`);
          const { items, total, truncated } = cap(data);
          return JSON.stringify({
            count: items.length,
            total,
            truncated,
            dashboards: items.map((d) => ({
              uid: d.uid,
              title: d.title,
              url: d.url,
              folderTitle: d.folderTitle || null,
              tags: Array.isArray(d.tags) ? d.tags : [],
            })),
          });
        }

        case 'grafana_get_dashboard': {
          const { uid } = args || {};
          if (!uid) return JSON.stringify({ error: 'uid is required' });
          const data = await gfFetch(`/dashboards/uid/${encodeURIComponent(uid)}`);
          const dash = data.dashboard || {};
          const meta = data.meta || {};
          const panels = Array.isArray(dash.panels) ? dash.panels : [];
          const { items, total, truncated } = cap(panels);
          return JSON.stringify({
            uid: dash.uid,
            title: dash.title,
            url: meta.url || null,
            folderTitle: meta.folderTitle || null,
            tags: Array.isArray(dash.tags) ? dash.tags : [],
            version: dash.version,
            updated: meta.updated || null,
            panelCount: total,
            panelsTruncated: truncated,
            // Summary only — never dump the full (huge) dashboard JSON.
            panels: items.map((p) => ({ id: p.id, title: p.title || null, type: p.type })),
          });
        }

        case 'grafana_list_datasources': {
          const data = await gfFetch('/datasources');
          const { items, total, truncated } = cap(data);
          return JSON.stringify({
            count: items.length,
            total,
            truncated,
            datasources: items.map((d) => ({ uid: d.uid, name: d.name, type: d.type })),
          });
        }

        case 'grafana_query': {
          // Instant (or short-range) query via the modern unified endpoint
          // POST /api/ds/query with a Prometheus query model. The datasource
          // is resolved by uid. start/end are unix-seconds or ISO; omitted =>
          // an instant query over the last 5 minutes ending now.
          const { datasourceUid, expr, start, end, step } = args || {};
          if (!datasourceUid || !expr) {
            return JSON.stringify({ error: 'datasourceUid and expr are required' });
          }
          const toMs = (v, fallback) => {
            if (v == null) return fallback;
            if (typeof v === 'number') return v < 1e12 ? v * 1000 : v; // seconds → ms
            const n = Number(v);
            if (!Number.isNaN(n)) return n < 1e12 ? n * 1000 : n;
            const parsed = Date.parse(v); // ISO string
            return Number.isNaN(parsed) ? fallback : parsed;
          };
          const now = Date.now();
          const to = toMs(end, now);
          const from = toMs(start, to - 5 * 60 * 1000);
          const isInstant = start == null && end == null;
          const body = {
            queries: [{
              refId: 'A',
              expr: String(expr),
              datasource: { uid: String(datasourceUid) },
              // instant => single point at `to`; range => time series.
              instant: isInstant,
              range: !isInstant,
              ...(step ? { intervalMs: Number(step) * 1000, maxDataPoints: 1000 } : {}),
            }],
            from: String(from),
            to: String(to),
          };
          const data = await gfFetch('/ds/query', { method: 'POST', body });
          // /ds/query returns { results: { A: { frames: [...] } } }. Summarize
          // the frames into series ({ labels, values }) without dumping the
          // full frame schema.
          const frames = data?.results?.A?.frames || [];
          const series = frames.slice(0, MAX_ITEMS).map((f) => {
            const fields = f?.schema?.fields || [];
            const valueField = fields.find((x) => x?.type === 'number') || fields[fields.length - 1] || {};
            const fieldData = Array.isArray(f?.data?.values) ? f.data.values : [];
            return {
              labels: valueField.labels || {},
              name: valueField.name || null,
              // values are column-oriented; expose the count + a small sample.
              pointCount: fieldData[0] ? fieldData[0].length : 0,
              sample: fieldData.map((col) => (Array.isArray(col) ? col.slice(-3) : col)),
            };
          });
          return JSON.stringify({
            datasourceUid,
            expr,
            instant: isInstant,
            seriesCount: frames.length,
            seriesTruncated: frames.length > MAX_ITEMS,
            series,
          });
        }

        case 'grafana_list_alert_rules': {
          // Grafana-managed alert rules (their definitions). Needs the
          // provisioning API (Editor-ish token on some instances).
          const data = await gfFetch('/v1/provisioning/alert-rules');
          const { items, total, truncated } = cap(data);
          return JSON.stringify({
            count: items.length,
            total,
            truncated,
            rules: items.map((r) => ({
              uid: r.uid,
              title: r.title,
              folderUID: r.folderUID || null,
              ruleGroup: r.ruleGroup || null,
              condition: r.condition || null,
              noDataState: r.noDataState || null,
              execErrState: r.execErrState || null,
              for: r.for || null,
              labels: r.labels || {},
            })),
          });
        }

        case 'grafana_list_firing_alerts': {
          // Currently active/firing alerts — the Alertmanager view of the
          // Grafana-managed ruler. `active=true` filters to firing.
          const data = await gfFetch('/alertmanager/grafana/api/v2/alerts?active=true&silenced=false&inhibited=false');
          const { items, total, truncated } = cap(data);
          return JSON.stringify({
            count: items.length,
            total,
            truncated,
            alerts: items.map((a) => ({
              state: a.status?.state || null,
              labels: a.labels || {},
              annotations: a.annotations || {},
              startsAt: a.startsAt || null,
              updatedAt: a.updatedAt || null,
              generatorURL: a.generatorURL || null,
            })),
          });
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
      name: 'grafana_search_dashboards',
      description: 'Search Grafana dashboards by free-text query and/or tag. Returns [{uid,title,url,folderTitle,tags}]. Capped at 50.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free-text search over dashboard titles' },
          tag: {
            anyOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description: 'Filter by tag (string or array of tags — multiple tags are ANDed)',
          },
          limit: { type: 'number', description: 'Max dashboards (default 50, hard cap 100)' },
        },
      },
    },
    {
      name: 'grafana_get_dashboard',
      description: 'Get one Grafana dashboard by uid. Returns its meta plus a SUMMARY of panels ({id,title,type}) — not the full dashboard JSON.',
      input_schema: {
        type: 'object',
        properties: {
          uid: { type: 'string', description: 'Dashboard uid (from grafana_search_dashboards)' },
        },
        required: ['uid'],
      },
    },
    {
      name: 'grafana_list_datasources',
      description: 'List configured Grafana datasources → [{uid,name,type}]. Use to find the uid to run grafana_query against.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'grafana_query',
      description: 'Run an instant (or short-range) Prometheus-style query against a Grafana datasource by uid, via the unified /api/ds/query endpoint. Omit start/end for an instant query at now.',
      input_schema: {
        type: 'object',
        properties: {
          datasourceUid: { type: 'string', description: 'Datasource uid (from grafana_list_datasources)' },
          expr: { type: 'string', description: 'The query expression (e.g. a PromQL expression)' },
          start: { type: 'string', description: 'Range start — unix seconds or ISO-8601. Omit for an instant query.' },
          end: { type: 'string', description: 'Range end — unix seconds or ISO-8601. Defaults to now.' },
          step: { type: 'number', description: 'Range step in seconds (only used for range queries)' },
        },
        required: ['datasourceUid', 'expr'],
      },
    },
    {
      name: 'grafana_list_alert_rules',
      description: 'List Grafana-managed alert rules (their definitions/condition/labels) via the provisioning API. Summarized + capped at 50.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'grafana_list_firing_alerts',
      description: 'List currently firing/active Grafana-managed alerts (the Alertmanager view) with labels, annotations, and state — what is broken right now. Capped at 50.',
      input_schema: { type: 'object', properties: {} },
    },
  ],
};
