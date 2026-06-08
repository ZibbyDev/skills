/**
 * Linear tracker adapter — projects Linear onto the neutral TrackerAdapter
 * contract.
 * ============================================================================
 *
 * Thin wrapper over linear.js. The skill already exposes everything we need as
 * tools (list_issues / get_issue / get_comments / add_comment / update_state /
 * link_attachment) and does the fuzzy state resolution internally, so the
 * adapter is almost entirely the toNeutral mapping + plumbing.
 *
 * State mapping: Linear workflow states carry a `type` ∈
 *   triage | backlog | unstarted | started | completed | canceled
 * which maps onto the neutral buckets. Linear has no native "blocked" type, so
 * 'blocked' is only ever derived from a state NAME match (best-effort).
 *
 * transition == update_state: Linear has no transition object; you set
 * issue.stateId to any state in the same team. The skill resolves a target
 * NAME → the team's matching state id (exact → type-alias → fuzzy).
 *
 * linkPullRequest == link_attachment: Linear has native attachments, the
 * first-class way to hang a PR on an issue. Fall back to a comment if it fails.
 *
 * Auth/config is inherited from linear.js (LINEAR_API_KEY / LINEAR_OAUTH_TOKEN).
 */

import { linearSkill } from '../linear.js';

/** Linear WorkflowState `type` → neutral stateCategory bucket. */
const STATE_TYPE_TO_BUCKET = {
  triage: 'todo',
  backlog: 'todo',
  unstarted: 'todo',
  started: 'in_progress',
  completed: 'done',
  canceled: 'done',
};

const BLOCKED_NAME_RE = /\b(blocked|on[\s-]?hold|waiting|stuck)\b/i;

/**
 * Map a Linear state into the neutral 5-bucket category.
 * @param {{name?: string, type?: string}} [state]
 * @returns {'todo'|'in_progress'|'done'|'blocked'|'unknown'}
 */
function toStateCategory(state) {
  if (!state) return 'unknown';
  if (state.name && BLOCKED_NAME_RE.test(state.name)) return 'blocked';
  return STATE_TYPE_TO_BUCKET[state.type] || 'unknown';
}

/** Parse a JSON string returned by a linear.js tool; throw on `error`. */
function unwrap(jsonStr) {
  const data = JSON.parse(jsonStr);
  if (data && data.error) throw new Error(data.error);
  return data;
}

/**
 * Build a NeutralTicket from the linear.js tool projection. The list and get
 * tools both expose `state` (name) + `stateType` (the WorkflowState type); we
 * bucket off the type, keep the raw name as `state`.
 */
function toNeutral(issue) {
  const state = issue.state || null;
  const stateType = issue.stateType || null;
  return {
    id: String(issue.id || issue.identifier || ''),
    key: issue.identifier || String(issue.id || ''),
    title: issue.title || '',
    body: issue.description || '',
    state,
    stateCategory: toStateCategory(state ? { name: state, type: stateType } : null),
    assignee: issue.assignee || null,
    url: issue.url || null,
    _raw: issue,
  };
}

export const linearAdapter = {
  id: 'linear',

  toStateCategory,
  toNeutral,

  // ---- READ ----

  /**
   * listCandidates — poll issues filtered by team/state/label/assignee/cursor.
   * Linear ignores free-text `query`; pass structured filters via opts/ctx.
   * @param {import('./types.js').ListCandidatesOptions & {ctx?: object}} [opts]
   * @returns {Promise<import('./types.js').NeutralTicket[]>}
   */
  async listCandidates(opts = {}) {
    const ctx = opts.ctx || {};
    const args = {
      teamId: ctx.teamId,
      teamKey: ctx.teamKey,
      stateName: opts.state,
      label: Array.isArray(opts.labels) ? opts.labels[0] : opts.labels,
      assigneeId: ctx.assigneeId,
      updatedAfter: opts.updatedAfter,
      limit: opts.limit,
    };
    const data = unwrap(await linearSkill.handleToolCall('linear_list_issues', args));
    return (data.issues || []).map(toNeutral);
  },

  /** getTicket — one issue by identifier (ENG-123) or uuid. */
  async getTicket(key) {
    if (!key) throw new Error('key is required');
    const data = JSON.parse(await linearSkill.handleToolCall('linear_get_issue', { identifier: key }));
    if (data.error) return null;
    return toNeutral(data);
  },

  /** getComments — newest first. */
  async getComments(key) {
    if (!key) throw new Error('key is required');
    const data = unwrap(await linearSkill.handleToolCall('linear_get_comments', { identifier: key }));
    return (data.comments || []).map((c) => ({
      id: String(c.id),
      author: c.author || 'Unknown',
      body: c.body || '',
      createdAt: c.createdAt || null,
      updatedAt: c.updatedAt || null,
      _raw: c,
    }));
  },

  // ---- WRITE ----

  /** addComment — markdown body. */
  async addComment(key, body) {
    if (!key || !body) throw new Error('key and body are required');
    const data = unwrap(await linearSkill.handleToolCall('linear_add_comment', { identifier: key, body }));
    return { ok: !!data.ok, id: data.commentId || null };
  },

  /**
   * transition — set the issue's workflow state by target NAME. The skill
   * resolves the name to the team's matching state id (exact → type-alias →
   * fuzzy). No transition object in Linear.
   */
  async transition(key, targetStateName) {
    if (!key) throw new Error('key is required');
    const res = JSON.parse(await linearSkill.handleToolCall('linear_update_state', {
      identifier: key,
      toStatus: targetStateName,
    }));
    if (!res.ok) {
      return { ok: false, error: res.error || 'state update failed', _raw: res };
    }
    const stateAfter = res.stateAfter || null;
    return {
      ok: true,
      stateAfter,
      stateCategoryAfter: toStateCategory(
        stateAfter ? { name: stateAfter, type: res.stateTypeAfter } : null,
      ),
      _raw: res,
    };
  },

  /**
   * linkPullRequest — native Linear attachment; fall back to a comment.
   */
  async linkPullRequest(key, prUrl, title) {
    if (!key || !prUrl) throw new Error('key and prUrl are required');
    try {
      const res = unwrap(await linearSkill.handleToolCall('linear_link_attachment', {
        identifier: key,
        url: prUrl,
        title: title || prUrl,
      }));
      if (res.ok) return { ok: true, via: 'attachment' };
      throw new Error('attachmentCreate returned ok:false');
    } catch (e) {
      const body = `${title ? `${title}: ` : 'Linked PR: '}${prUrl}`;
      const data = unwrap(await linearSkill.handleToolCall('linear_add_comment', { identifier: key, body }));
      return { ok: !!data.ok, via: 'comment', error: String(e?.message || e) };
    }
  },
};

export default linearAdapter;
