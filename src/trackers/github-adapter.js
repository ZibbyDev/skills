/**
 * GitHub Issues tracker adapter — projects GitHub onto the neutral
 * TrackerAdapter contract.
 * ============================================================================
 *
 * Thin wrapper over github.js. GitHub Issues are the awkward provider for a
 * tracker abstraction, because GitHub has NO workflow/transition model: an
 * issue is just open|closed. Everything richer (todo vs in-progress, blocked)
 * is a labelling CONVENTION, not a native state. This adapter makes that
 * convention explicit and keeps it documented in one place.
 *
 * SCOPING: GitHub issues live in a repo, so every method needs {owner, repo}.
 * That comes from `ctx` (per-call) or env GITHUB_OWNER / GITHUB_REPO. There is
 * no global "list all my issues" call here on purpose — it would not map.
 *
 * STATE MODEL (the real seam — read this):
 *   - closed                    → 'done'
 *   - open + a blocked label     → 'blocked'   (label matches BLOCKED_NAME_RE)
 *   - open + an in-progress label→ 'in_progress' (label matches IN_PROGRESS_RE,
 *                                  e.g. "in progress", "in-progress", "wip",
 *                                  "doing", "started")
 *   - open + (none of the above) → 'todo'
 *   The labels are a CONVENTION: GitHub has no concept of them being "states".
 *   A repo that doesn't use them simply shows every open issue as 'todo'.
 *
 * transition (NO native equivalent) maps the target name onto this convention:
 *   - a done/closed-ish name  → close the issue (state_reason 'completed')
 *   - a todo/open-ish name    → reopen + clear progress/blocked labels
 *   - 'in progress'-ish name  → ensure open + ADD the in-progress label
 *   - 'blocked'-ish name      → ensure open + ADD the blocked label
 *   - anything else           → ok:false (unrepresentable on GitHub) — this is a
 *                               genuine contract seam, surfaced honestly.
 *
 * linkPullRequest: a comment carrying the PR URL (GitHub's native issue↔PR link
 * requires a closing keyword IN the PR body / a cross-ref event, not an issue
 * API write, so the portable, always-works path is a comment).
 *
 * Auth/config is inherited from github.js (resolveIntegrationToken('github')).
 */

import { githubSkill } from '../github.js';

const BLOCKED_NAME_RE = /\b(blocked|on[\s-]?hold|waiting|stuck)\b/i;
const IN_PROGRESS_RE = /\b(in[\s-]?progress|wip|doing|started|in[\s-]?review|review)\b/i;
const DONE_NAME_RE = /\b(done|closed|complete|completed|resolved|fixed|merged|shipped)\b/i;
const TODO_NAME_RE = /\b(todo|to[\s-]?do|open|backlog|reopen|new)\b/i;

/** Conventional label names this adapter writes for the two open sub-states. */
const IN_PROGRESS_LABEL = 'in progress';
const BLOCKED_LABEL = 'blocked';

/**
 * Map a GitHub issue's open|closed state + its labels onto a neutral bucket.
 * @param {string} state           'open' | 'closed'
 * @param {string[]} [labels]      label names on the issue
 * @returns {'todo'|'in_progress'|'done'|'blocked'|'unknown'}
 */
function toStateCategory(state, labels = []) {
  if (state === 'closed') return 'done';
  if (state !== 'open') return 'unknown';
  const names = (labels || []).map(String);
  if (names.some((l) => BLOCKED_NAME_RE.test(l))) return 'blocked';
  if (names.some((l) => IN_PROGRESS_RE.test(l))) return 'in_progress';
  return 'todo';
}

/** Resolve {owner, repo} from ctx or env; throw if neither has them. */
function resolveRepo(ctx = {}) {
  const owner = ctx.owner || process.env.GITHUB_OWNER;
  const repo = ctx.repo || process.env.GITHUB_REPO;
  if (!owner || !repo) {
    throw new Error('GitHub scope missing: provide {owner, repo} via ctx or env GITHUB_OWNER / GITHUB_REPO.');
  }
  return { owner, repo };
}

/** Parse a JSON string returned by a github.js tool; throw on `error`. */
function unwrap(jsonStr) {
  const data = JSON.parse(jsonStr);
  if (data && data.error) throw new Error(data.error);
  return data;
}

/** Build a NeutralTicket from the github.js issue tool projection. */
function toNeutral(issue, ctx = {}) {
  const labels = issue.labels || [];
  const number = issue.number;
  const key = ctx.owner && ctx.repo ? `${ctx.owner}/${ctx.repo}#${number}` : `#${number}`;
  return {
    id: String(number),
    key,
    title: issue.title || '',
    body: issue.body || '',
    state: issue.state || null, // raw provider state: 'open' | 'closed'
    stateCategory: toStateCategory(issue.state, labels),
    assignee: issue.assignee || (issue.assignees && issue.assignees[0]) || null,
    url: issue.url || null,
    _raw: issue,
  };
}

export const githubAdapter = {
  id: 'github',

  toStateCategory,
  toNeutral,
  IN_PROGRESS_LABEL,
  BLOCKED_LABEL,

  // ---- READ ----

  /**
   * listCandidates — list a repo's issues by state/labels/since cursor.
   * Needs {owner, repo} via opts.ctx or env. `opts.query` is ignored (GitHub
   * issue search is a separate endpoint; the contract's listCandidates is the
   * repo-scoped poll).
   * @param {import('./types.js').ListCandidatesOptions & {ctx?: object}} [opts]
   * @returns {Promise<import('./types.js').NeutralTicket[]>}
   */
  async listCandidates(opts = {}) {
    const ctx = opts.ctx || {};
    const { owner, repo } = resolveRepo(ctx);
    const data = unwrap(await githubSkill.handleToolCall('github_list_issues', {
      owner,
      repo,
      state: opts.state || 'open',
      labels: opts.labels,
      since: opts.updatedAfter,
      limit: opts.limit,
    }));
    return (data.issues || []).map((i) => toNeutral(i, { owner, repo }));
  },

  /** getTicket — one issue by number (key may be `owner/repo#N` or just `N`). */
  async getTicket(key, ctx = {}) {
    const { owner, repo } = resolveRepo(ctx);
    const number = parseIssueNumber(key);
    if (number == null) throw new Error(`Cannot parse GitHub issue number from "${key}"`);
    const data = JSON.parse(await githubSkill.handleToolCall('github_get_issue', { owner, repo, number }));
    if (data.error) return null;
    return toNeutral(data, { owner, repo });
  },

  /** getComments — chronological; we reverse to newest-first for contract parity. */
  async getComments(key, ctx = {}) {
    const { owner, repo } = resolveRepo(ctx);
    const number = parseIssueNumber(key);
    if (number == null) throw new Error(`Cannot parse GitHub issue number from "${key}"`);
    const data = unwrap(await githubSkill.handleToolCall('github_get_issue_comments', { owner, repo, number }));
    return (data.comments || [])
      .map((c) => ({
        id: String(c.id),
        author: c.user || 'Unknown',
        body: c.body || '',
        createdAt: c.createdAt || null,
        updatedAt: c.updatedAt || null,
        _raw: c,
      }))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  },

  // ---- WRITE ----

  /** addComment — markdown body. */
  async addComment(key, body, ctx = {}) {
    const { owner, repo } = resolveRepo(ctx);
    const number = parseIssueNumber(key);
    if (number == null) throw new Error(`Cannot parse GitHub issue number from "${key}"`);
    if (!body) throw new Error('body is required');
    const data = unwrap(await githubSkill.handleToolCall('github_add_issue_comment', { owner, repo, number, body }));
    return { ok: !!data.ok, id: data.id ? String(data.id) : null };
  },

  /**
   * transition — map a neutral target NAME onto GitHub's open/close + labels
   * convention (see the file header). Returns ok:false for names GitHub can't
   * represent — that's a real seam, not a swallowed error.
   */
  async transition(key, targetStateName, ctx = {}) {
    const { owner, repo } = resolveRepo(ctx);
    const number = parseIssueNumber(key);
    if (number == null) throw new Error(`Cannot parse GitHub issue number from "${key}"`);
    const want = String(targetStateName || '');

    // Order matters: 'done'/'blocked'/'in progress' words are checked before the
    // broad todo/open match (which also matches "reopen").
    if (DONE_NAME_RE.test(want)) {
      const res = unwrap(await githubSkill.handleToolCall('github_close_issue', {
        owner, repo, number, stateReason: 'completed',
      }));
      return { ok: !!res.ok, stateAfter: res.state || 'closed', stateCategoryAfter: 'done', _raw: res };
    }
    if (BLOCKED_NAME_RE.test(want)) {
      await ensureOpen(owner, repo, number);
      const res = unwrap(await githubSkill.handleToolCall('github_label_issue', {
        owner, repo, number, labels: [BLOCKED_LABEL], mode: 'add',
      }));
      return { ok: !!res.ok, stateAfter: 'open', stateCategoryAfter: 'blocked', via: 'label', _raw: res };
    }
    if (IN_PROGRESS_RE.test(want)) {
      await ensureOpen(owner, repo, number);
      const res = unwrap(await githubSkill.handleToolCall('github_label_issue', {
        owner, repo, number, labels: [IN_PROGRESS_LABEL], mode: 'add',
      }));
      return { ok: !!res.ok, stateAfter: 'open', stateCategoryAfter: 'in_progress', via: 'label', _raw: res };
    }
    if (TODO_NAME_RE.test(want)) {
      const res = unwrap(await githubSkill.handleToolCall('github_reopen_issue', { owner, repo, number }));
      return { ok: !!res.ok, stateAfter: res.state || 'open', stateCategoryAfter: 'todo', _raw: res };
    }
    // Genuinely unrepresentable on GitHub.
    return {
      ok: false,
      error: `GitHub issues have no "${targetStateName}" state. Representable targets: open/todo, in progress, blocked, done/closed.`,
    };
  },

  /**
   * linkPullRequest — post a comment with the PR link. GitHub's native issue↔PR
   * association is driven by closing keywords in the PR body, not an issue API
   * write, so a comment is the portable, always-works path.
   */
  async linkPullRequest(key, prUrl, title, ctx = {}) {
    const { owner, repo } = resolveRepo(ctx);
    const number = parseIssueNumber(key);
    if (number == null) throw new Error(`Cannot parse GitHub issue number from "${key}"`);
    if (!prUrl) throw new Error('prUrl is required');
    const body = `${title ? `${title}: ` : 'Linked PR: '}${prUrl}`;
    const data = unwrap(await githubSkill.handleToolCall('github_add_issue_comment', { owner, repo, number, body }));
    return { ok: !!data.ok, via: 'comment' };
  },
};

/** Reopen the issue if needed (idempotent — github_reopen_issue is a PATCH). */
async function ensureOpen(owner, repo, number) {
  await githubSkill.handleToolCall('github_reopen_issue', { owner, repo, number });
}

/** Extract the numeric issue id from `owner/repo#123`, `#123`, or `123`. */
function parseIssueNumber(key) {
  if (key == null) return null;
  if (typeof key === 'number') return key;
  const m = /(\d+)\s*$/.exec(String(key));
  return m ? Number(m[1]) : null;
}

export default githubAdapter;
