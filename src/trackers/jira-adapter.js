/**
 * Jira tracker adapter — projects Jira onto the neutral TrackerAdapter contract.
 * ============================================================================
 *
 * Thin wrapper over jira.js. ~90% of the work is the toNeutral mapping; the
 * write methods mostly delegate to the JIRA skill's first-class tools
 * (jira_transition_issue already does the fuzzy status matching we want, so we
 * do NOT re-implement it). The single gap with no tool is attaching a PR remote
 * link, which we issue against the exported `jiraFetch` chokepoint directly,
 * with a comment fallback.
 *
 * State mapping: Jira's `statusCategory.key` is a 3-value enum — `new` /
 * `indeterminate` / `done` (see backend/.../jira-tickets-service.js:70). That
 * maps cleanly onto three of the five neutral buckets. Jira has no native
 * "blocked" category, so 'blocked' is only ever derived from a status NAME
 * match (best-effort), matching how the other adapters surface it.
 *
 * Auth/config is inherited from jira.js (resolveIntegrationToken('jira')); this
 * file adds no new env keys.
 */

import { jiraFetch, jiraSkill } from '../jira.js';

/** Jira statusCategory.key → neutral stateCategory bucket. */
const STATUS_CATEGORY_TO_BUCKET = {
  new: 'todo',
  indeterminate: 'in_progress',
  done: 'done',
};

/**
 * Status NAMES that mean "blocked". No provider has a native blocked group, so
 * this name heuristic is the only source of the 'blocked' bucket. Conservative:
 * fires only on an explicit blocked-ish word. Shared shape across adapters.
 */
const BLOCKED_NAME_RE = /\b(blocked|on[\s-]?hold|waiting|stuck)\b/i;

/**
 * Map a Jira status into the neutral 5-bucket category.
 * @param {{name?: string, statusCategory?: {key?: string}}} [status]
 * @returns {'todo'|'in_progress'|'done'|'blocked'|'unknown'}
 */
function toStateCategory(status) {
  if (!status) return 'unknown';
  if (status.name && BLOCKED_NAME_RE.test(status.name)) return 'blocked';
  const key = status.statusCategory?.key;
  return STATUS_CATEGORY_TO_BUCKET[key] || 'unknown';
}

// Reuse jira.js's ADF flattener through the skill, but jira.js doesn't export
// it. The full-issue REST payload returns description as ADF; we flatten with a
// tiny local walker (text nodes only — enough for body text; rich tools should
// read _raw). Comments come back already-flattened from the jira_get_comments
// tool, so this only covers the description.
function adfText(node) {
  if (!node) return '';
  if (Array.isArray(node)) return node.map(adfText).join('');
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak' || node.type === 'rule') return '\n';
  let inner = node.content ? adfText(node.content) : '';
  if (/^(paragraph|heading|listItem|blockquote|codeBlock|panel)$/.test(node.type)) inner += '\n';
  return inner;
}

/** Build a NeutralTicket from a full Jira issue REST payload. */
function toNeutral(issue, instanceUrl) {
  const fields = issue.fields || {};
  const status = fields.status || null;
  let url = null;
  if (issue.self && issue.key) {
    // issue.self is the API URL; derive the browse URL from its origin.
    try {
      const origin = new URL(issue.self).origin;
      url = `${origin}/browse/${issue.key}`;
    } catch {
      url = null;
    }
  }
  if (!url && instanceUrl && issue.key) url = `${String(instanceUrl).replace(/\/+$/, '')}/browse/${issue.key}`;
  return {
    id: String(issue.id ?? issue.key ?? ''),
    key: issue.key,
    title: fields.summary || '',
    body: typeof fields.description === 'string'
      ? fields.description
      : adfText(fields.description?.content).trim(),
    state: status?.name || null,
    stateCategory: toStateCategory(status),
    assignee: fields.assignee?.displayName || null,
    url,
    _raw: issue,
  };
}

/** Parse a JSON string returned by a jira.js tool; throw if it carries `error`. */
function unwrap(jsonStr) {
  const data = JSON.parse(jsonStr);
  if (data && data.error) throw new Error(data.error);
  return data;
}

export const jiraAdapter = {
  id: 'jira',

  // expose mapping internals for testing / reuse (not part of the 6-method contract)
  toStateCategory,
  toNeutral,

  // ---- READ ----

  /**
   * listCandidates — JQL search. `opts.query` is the JQL; if omitted we build a
   * bounded default. Returns newest-updated first.
   * @param {import('./types.js').ListCandidatesOptions} [opts]
   * @returns {Promise<import('./types.js').NeutralTicket[]>}
   */
  async listCandidates(opts = {}) {
    let jql = opts.query || '';
    if (!jql.trim()) {
      const clauses = [];
      if (opts.state) clauses.push(`status = "${opts.state}"`);
      if (opts.labels) {
        const labels = Array.isArray(opts.labels) ? opts.labels : [opts.labels];
        for (const l of labels) clauses.push(`labels = "${l}"`);
      }
      if (opts.updatedAfter) clauses.push(`updated >= "${opts.updatedAfter}"`);
      jql = clauses.length ? `${clauses.join(' AND ')} ORDER BY updated DESC` : 'ORDER BY updated DESC';
    }
    const max = Number(opts.limit) || 30;
    // jira_search trims fields; for stateCategory we need statusCategory, which
    // the tool does not return. Go to jiraFetch directly so the bucket is honest.
    const qs = `jql=${encodeURIComponent(jql)}&maxResults=${max}`
      + '&fields=summary,description,status,assignee,labels,project,updated,created';
    const data = await jiraFetch(`/rest/api/3/search/jql?${qs}`);
    return (data.issues || []).map((i) => toNeutral(i));
  },

  /**
   * getTicket — one issue by key. Uses jiraFetch (not jira_get_issue) so the
   * full status object incl. statusCategory is present for bucketing.
   */
  async getTicket(key) {
    if (!key) throw new Error('key is required');
    const issue = await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}`);
    if (!issue || !issue.key) return null;
    return toNeutral(issue);
  },

  /** getComments — newest first (jira_get_comments already flattens ADF). */
  async getComments(key) {
    if (!key) throw new Error('key is required');
    const data = unwrap(await jiraSkill.handleToolCall('jira_get_comments', { issueKey: key }));
    return (data.comments || []).map((c) => ({
      id: String(c.id),
      author: c.author || 'Unknown',
      body: c.body || '',
      createdAt: c.created || null,
      updatedAt: c.updated || null,
      _raw: c,
    }));
  },

  // ---- WRITE ----

  /** addComment — delegates to jira_add_comment (wraps text in ADF). */
  async addComment(key, body) {
    if (!key || !body) throw new Error('key and body are required');
    const data = unwrap(await jiraSkill.handleToolCall('jira_add_comment', { issueKey: key, body }));
    return { ok: !!data.ok, id: null };
  },

  /**
   * transition — reuse jira_transition_issue's fuzzy matching (exact → core →
   * dice). Returns ok + the resulting raw state name and its bucket.
   */
  async transition(key, targetStateName) {
    if (!key) throw new Error('key is required');
    const res = JSON.parse(await jiraSkill.handleToolCall('jira_transition_issue', {
      issueKey: key,
      toStatus: targetStateName,
    }));
    if (!res.ok) {
      return { ok: false, error: res.error || 'transition failed', _raw: res };
    }
    const stateAfter = res.statusAfter || null;
    return {
      ok: true,
      stateAfter,
      stateCategoryAfter: toStateCategory(stateAfter ? { name: stateAfter } : null),
      _raw: res,
    };
  },

  /**
   * linkPullRequest — try Jira's remote-link API; fall back to a comment.
   * Remote-link needs the granular `write:issue.remote-link:jira` scope; if it
   * 403s (or anything else), we still record the PR via a comment so the link
   * is never silently lost.
   */
  async linkPullRequest(key, prUrl, title) {
    if (!key || !prUrl) throw new Error('key and prUrl are required');
    try {
      await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`, {
        method: 'POST',
        body: {
          object: {
            url: prUrl,
            title: title || prUrl,
            icon: { url16x16: 'https://github.com/favicon.ico', title: 'GitHub' },
          },
        },
      });
      return { ok: true, via: 'remotelink' };
    } catch (e) {
      // Fallback: drop the link into a comment.
      const body = `${title ? `${title}: ` : 'Linked PR: '}${prUrl}`;
      const data = unwrap(await jiraSkill.handleToolCall('jira_add_comment', { issueKey: key, body }));
      return { ok: !!data.ok, via: 'comment', error: String(e?.message || e) };
    }
  },
};

export default jiraAdapter;
