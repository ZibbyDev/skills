/**
 * Plane tracker adapter — projects Plane onto the neutral TrackerAdapter
 * contract. Promoted from strategy/plane-app-draft/plane-adapter.draft.js.
 * ============================================================================
 *
 * Mirrors the proven shape of linear.js: ONE auth chokepoint (planeFetch, with
 * X-API-Key), the 6 neutral methods, and a NeutralTicket with `state` (raw
 * name), `stateCategory` (normalized bucket) and `_raw`.
 *
 * Plane specifics that drove the design (verified — see RESEARCH.md):
 *   - Auth: personal access token in header `X-API-Key: <token>`. Self-hosted ⇒
 *     base URL is the TENANT's host (https://<host>/api/v1), NOT api.plane.so.
 *     Both come from env (same posture as linear.js).
 *   - Scoping: every issue is workspace_slug → project_id → id. No global list,
 *     so the adapter is bound to a (workspace, project) via env or per-call ctx.
 *   - States carry a `group` ∈ {backlog, unstarted, started, completed,
 *     cancelled} — the normalization key. NO transition object: you PATCH the
 *     work-item `state` to a target state uuid (like Linear, unlike Jira).
 *   - List endpoints are cursor-paginated:
 *       { results, next_cursor, prev_cursor, count, total_results, ... }
 *     per_page default & max 100; cursor format "value:offset:is_prev".
 *   - Comments are HTML (comment_html), NOT markdown. We wrap plaintext.
 *
 * HONEST TODOs (inline) are Plane-version-specific details not fully confirmable
 * from the public docs without a live instance — kept from the research draft.
 */

// ── Config / auth resolution ──────────────────────────────────────────────
//
// Base URL: for self-hosted Plane this is the tenant's own host + /api/v1.
// PLANE_API_URL should be e.g. "https://plane.acme.com/api/v1" (or, for Plane
// Cloud, "https://api.plane.so/api/v1"). We DON'T hardcode api.plane.so.
const PLANE_API_URL = (process.env.PLANE_API_URL || 'https://api.plane.so/api/v1').replace(/\/+$/, '');

// Default (workspace, project) the adapter is bound to. Per-call ctx may
// override. Plane has no global issue scope, so one of (env | ctx) is required.
const PLANE_WORKSPACE_SLUG = process.env.PLANE_WORKSPACE_SLUG || '';
const PLANE_PROJECT_ID = process.env.PLANE_PROJECT_ID || '';

/** Resolve the X-API-Key value from env. Mirrors resolveLinearAuth(). */
function resolvePlaneApiKey() {
  const key = process.env.PLANE_API_KEY || process.env.PLANE_OAUTH_TOKEN;
  if (!key) {
    throw new Error('Plane is not connected: set PLANE_API_KEY (personal access token).');
  }
  return key;
}

function resolveScope(ctx = {}) {
  const workspaceSlug = ctx.workspaceSlug || PLANE_WORKSPACE_SLUG;
  const projectId = ctx.projectId || PLANE_PROJECT_ID;
  if (!workspaceSlug || !projectId) {
    throw new Error('Plane scope missing: provide workspaceSlug + projectId (env PLANE_WORKSPACE_SLUG / PLANE_PROJECT_ID or per-call ctx).');
  }
  return { workspaceSlug, projectId };
}

/**
 * Low-level Plane REST helper — the SINGLE auth chokepoint (cf. linearFetch).
 * Keep token + base-url resolution here; never re-implement at call sites.
 * Exported so a pipeline can issue raw calls the 6 methods don't cover.
 *
 * @param {string} path  path AFTER /api/v1, e.g.
 *   `/workspaces/acme/projects/<uuid>/work-items/`
 * @param {{method?:string, body?:any, query?:object, headers?:object}} [opts]
 * @returns {Promise<any>} parsed JSON (or {} for empty body)
 */
export async function planeFetch(path, opts = {}) {
  let url = `${PLANE_API_URL}${path}`;
  if (opts.query && Object.keys(opts.query).length) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }

  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      'X-API-Key': resolvePlaneApiKey(),
      'Accept': 'application/json',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Plane API ${res.status}: ${err.slice(0, 300)}`);
  }
  const raw = await res.text().catch(() => '');
  if (!raw || !raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return { raw }; }
}

// ── State-group → neutral stateCategory mapping ───────────────────────────
//
// Plane's `group` enum maps cleanly onto the neutral buckets. Plane has NO
// native "blocked" group — 'blocked' in the neutral model only ever comes from
// a state NAME match (a project with e.g. a "Blocked" state, which Plane stores
// under some other group). So we map by group first, then a name heuristic can
// upgrade to 'blocked'.
const GROUP_TO_CATEGORY = {
  backlog: 'todo',
  unstarted: 'todo',
  started: 'in_progress',
  completed: 'done',
  cancelled: 'done', // cancelled == terminal/closed for pipeline purposes
};

const BLOCKED_NAME_RE = /\b(blocked|on[\s-]?hold|waiting|stuck)\b/i;

/**
 * Normalize a Plane state into the neutral 5-bucket category.
 * @param {{name?:string, group?:string}} [state]
 * @returns {'todo'|'in_progress'|'done'|'blocked'|'unknown'}
 */
export function toStateCategory(state) {
  if (!state) return 'unknown';
  if (state.name && BLOCKED_NAME_RE.test(state.name)) return 'blocked';
  return GROUP_TO_CATEGORY[state.group] || 'unknown';
}

// ── State cache (name↔uuid↔group resolution per project) ──────────────────
//
// Work-items carry `state` as a UUID, and transition() takes a target state
// NAME. So we need the project's state list to (a) resolve a uuid → {name,group}
// for NeutralTicket, and (b) resolve a name → uuid for PATCH. States are
// per-project (like Linear's per-team states). Cache by project id.
const _stateCache = new Map(); // projectId -> { fetchedAt, states: [...] }
const STATE_TTL_MS = 5 * 60 * 1000;

async function getStates(ctx) {
  const { workspaceSlug, projectId } = resolveScope(ctx);
  const cached = _stateCache.get(projectId);
  if (cached && Date.now() - cached.fetchedAt < STATE_TTL_MS) return cached.states;
  const data = await planeFetch(
    `/workspaces/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}/states/`,
    { query: { per_page: 100 } },
  );
  // States list is cursor-paginated like everything else, but a project rarely
  // has >100 states, so one page is fine. TODO: follow next_cursor if ever >100.
  const states = (data.results || data || []).map((s) => ({
    id: s.id, name: s.name, group: s.group, color: s.color,
  }));
  _stateCache.set(projectId, { fetchedAt: Date.now(), states });
  return states;
}

// fuzzy name matching (kept aligned with the other adapters' philosophy).
function normalizeLabel(v) {
  return String(v || '').toLowerCase().replace(/\s+/g, '').replace(/[()\-_:："'`]/g, '');
}
function matchState(states, target) {
  const want = normalizeLabel(target);
  if (!want) return null;
  const exact = states.find((s) => normalizeLabel(s.name) === want);
  if (exact) return exact;
  // group-alias: let neutral category words resolve to a group.
  const aliasGroups = {
    todo: ['todo', 'backlog', 'open', 'unstarted'],
    inprogress: ['inprogress', 'started', 'doing', 'wip'],
    done: ['done', 'completed', 'closed', 'resolved', 'cancelled', 'canceled'],
    blocked: ['blocked', 'onhold', 'waiting'],
  };
  for (const [, words] of Object.entries(aliasGroups)) {
    if (!words.some((w) => normalizeLabel(w) === want)) continue;
    const groupGuess = want === 'done' ? 'completed'
      : want === 'inprogress' ? 'started'
        : 'unstarted';
    const byGroup = states.find((s) => s.group === groupGuess);
    if (byGroup) return byGroup;
  }
  return null;
}

// ── NeutralTicket builder ─────────────────────────────────────────────────
//
// TODO (verify field names against the target Plane version):
//   - description: description_html vs description_stripped vs description
//   - whether list endpoint returns `state` as a uuid (assumed) or expanded
//   - priority enum casing (urgent|high|medium|low|none assumed)
async function toNeutral(raw, ctx) {
  const states = await getStates(ctx).catch(() => []);
  const stateObj = states.find((s) => s.id === raw.state) || null;
  const { workspaceSlug, projectId } = resolveScope(ctx);
  // Human key: Plane shows <PROJECT_IDENTIFIER>-<sequence_id> (e.g. ENG-42).
  // The project identifier isn't on the work-item payload; TODO fetch it once
  // from GET /projects/{id}/ and cache, or accept ctx.projectIdentifier.
  const key = ctx.projectIdentifier && raw.sequence_id != null
    ? `${ctx.projectIdentifier}-${raw.sequence_id}`
    : (raw.sequence_id != null ? String(raw.sequence_id) : raw.id);

  const assignees = raw.assignees || [];
  return {
    id: raw.id,
    key,
    title: raw.name || '',
    // TODO confirm description field name on the target Plane version.
    body: raw.description_html || raw.description_stripped || raw.description || '',
    state: stateObj ? stateObj.name : null, // RAW state name
    stateCategory: toStateCategory(stateObj), // normalized bucket
    // Plane assignees are member uuids; collapse to first for the neutral
    // single-assignee field (full list stays in _raw). TODO: expand to names.
    assignee: assignees.length ? String(assignees[0]) : null,
    url: ctx.baseWebUrl
      ? `${ctx.baseWebUrl}/${workspaceSlug}/projects/${projectId}/issues/${raw.id}`
      : null, // TODO: derive the web (not API) base from PLANE_API_URL host
    _raw: raw,
  };
}

// ── The 6 neutral methods ─────────────────────────────────────────────────

export const planeAdapter = {
  id: 'plane',
  // declared like linear.js: no backend OAuth handler; auth is the env key.
  envKeys: ['PLANE_API_KEY', 'PLANE_OAUTH_TOKEN', 'PLANE_API_URL', 'PLANE_WORKSPACE_SLUG', 'PLANE_PROJECT_ID'],

  /** Expose the chokepoint + mapping so a pipeline/tests can reuse them. */
  planeFetch,
  toStateCategory,

  // ---- READ ----

  /**
   * listCandidates — poll work items for a (workspace, project).
   * @param {import('./types.js').ListCandidatesOptions & {ctx?: object}} [opts]
   * @returns {Promise<import('./types.js').NeutralTicket[]>}
   */
  async listCandidates(opts = {}) {
    const ctx = opts.ctx || {};
    const { workspaceSlug, projectId } = resolveScope(ctx);
    const query = {
      per_page: Math.min(Number(opts.limit) || 50, 100),
      cursor: opts.cursor,
    };
    // TODO: confirm Plane's server-side filter param names. The API supports
    // filtering; exact keys (state / priority / updated_at__gte) are
    // version-specific. Until confirmed, we pass them through and also filter
    // client-side below as a safety net.
    if (opts.state) query.state = opts.state;
    if (opts.updatedAfter) query.updated_at__gte = opts.updatedAfter; // TODO confirm

    const data = await planeFetch(
      `/workspaces/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}/work-items/`,
      { query },
    );
    let rows = data.results || [];
    // client-side updatedAfter safety net (in case the server param is wrong)
    if (opts.updatedAfter) {
      rows = rows.filter((r) => String(r.updated_at) > String(opts.updatedAfter));
    }
    return Promise.all(rows.map((r) => toNeutral(r, ctx)));
  },

  /**
   * getTicket — one work item by uuid (Plane addresses work items by uuid, NOT
   * by the PROJ-42 human key).
   * TODO: if `key` looks like "PROJ-42", resolve sequence_id → uuid via a
   * filtered list call. For now assume a uuid.
   */
  async getTicket(key, ctx = {}) {
    const { workspaceSlug, projectId } = resolveScope(ctx);
    const raw = await planeFetch(
      `/workspaces/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(key)}/`,
    );
    if (!raw || !raw.id) return null;
    return toNeutral(raw, ctx);
  },

  /** getComments — newest first. */
  async getComments(key, ctx = {}) {
    const { workspaceSlug, projectId } = resolveScope(ctx);
    const data = await planeFetch(
      `/workspaces/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(key)}/comments/`,
      { query: { per_page: 100 } },
    );
    const rows = data.results || [];
    return rows
      .map((c) => ({
        id: c.id,
        author: c.actor || c.actor_detail?.display_name || 'Unknown', // TODO confirm shape
        body: c.comment_html || c.comment_stripped || '',
        createdAt: c.created_at || null,
        updatedAt: c.updated_at || null,
        _raw: c,
      }))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  },

  // ---- WRITE ----

  /**
   * addComment — Plane comments are HTML, not markdown. We wrap plaintext in a
   * <p> so a markdown-y body at least renders as text.
   * TODO: confirm the API accepts comment_html on POST (vs comment_stripped),
   * and whether it sanitizes/strips.
   */
  async addComment(key, body, ctx = {}) {
    const { workspaceSlug, projectId } = resolveScope(ctx);
    const looksHtml = /<[a-z][\s\S]*>/i.test(String(body || ''));
    const commentHtml = looksHtml ? String(body) : `<p>${String(body || '')}</p>`;
    const data = await planeFetch(
      `/workspaces/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(key)}/comments/`,
      { method: 'POST', body: { comment_html: commentHtml } },
    );
    return { ok: !!data.id, id: data.id || null, _raw: data };
  },

  /**
   * transition — Plane has NO transition object (like Linear). Resolve the
   * target state NAME (or a neutral category word) to the project's matching
   * state uuid, then PATCH work-item { state: <uuid> }.
   */
  async transition(key, targetStateName, ctx = {}) {
    const { workspaceSlug, projectId } = resolveScope(ctx);
    const states = await getStates(ctx);
    const match = matchState(states, targetStateName);
    if (!match) {
      return {
        ok: false,
        error: `No Plane state matches "${targetStateName}" in this project`,
        availableStates: states.map((s) => ({ id: s.id, name: s.name, group: s.group })),
      };
    }
    const data = await planeFetch(
      `/workspaces/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(key)}/`,
      { method: 'PATCH', body: { state: match.id } },
    );
    return {
      ok: !!data.id,
      stateAfter: match.name,
      stateCategoryAfter: toStateCategory(match),
      _raw: data,
    };
  },

  /**
   * linkPullRequest — Plane has no first-class "attachment URL on issue" like
   * Linear's attachmentCreate. The portable path is a comment with the link.
   * (Plane does have a GitHub *integration* for repo-level linking, but that's
   * an installed integration, not a per-issue API write.)
   * TODO: if a target Plane exposes a link/attachment endpoint, prefer it.
   */
  async linkPullRequest(key, prUrl, title, ctx = {}) {
    const prefix = title ? `${title}: ` : 'Linked PR: ';
    const res = await this.addComment(key, `<p>${prefix}<a href="${prUrl}">${prUrl}</a></p>`, ctx);
    return { ok: !!res.ok, via: 'comment' };
  },
};

export default planeAdapter;
