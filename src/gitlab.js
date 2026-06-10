/**
 * GitLab integration — low-level API-wrapper skill.
 *
 * GitLab exposes a REST API (https://docs.gitlab.com/ee/api/) rooted at
 * `<host>/api/v4`. Auth is a token sent in the `PRIVATE-TOKEN` header
 * (personal / project / group access token) or, for OAuth, an
 * `Authorization: Bearer <token>` header.
 *
 * This is the GitLab analog of github.js (the GitHub skill). It mirrors that
 * skill's structure exactly: a small `glFetch` helper as the single auth
 * chokepoint, a skill object ({ id, description, envKeys, promptFragment,
 * resolve, handleToolCall, tools[] }), tools that return JSON strings, and
 * graceful error messages instead of throws.
 *
 * Auth / config (env). Like linear.js (and UNLIKE jira.js / github.js whose
 * OAuth tokens are minted by the Zibby backend and fetched via
 * resolveIntegrationToken), the GitLab backend integration stores a pasted
 * Personal Access Token + an instanceUrl (see backend/src/handlers/gitlab.js:
 * { instanceUrl, accessToken }). The workflow-executor injects those into the
 * run as environment variables, which this skill reads:
 *
 *   - GITLAB_TOKEN          personal/project access token (api scope) — sent
 *                           in the PRIVATE-TOKEN header. This is the value the
 *                           backend stored as `accessToken`.
 *   - GITLAB_OAUTH_TOKEN    OAuth bearer token (optional; takes precedence;
 *                           sent as `Authorization: Bearer <token>`)
 *   - GITLAB_INSTANCE_URL   the GitLab host the token belongs to, cloud OR
 *                           self-hosted — e.g. "https://gitlab.com" or
 *                           "https://gitlab.example.com". This is the backend's
 *                           `instanceUrl`. We append `/api/v4`. Defaults to
 *                           https://gitlab.com when unset, so cloud works with
 *                           just a token. SSRF on this URL is already validated
 *                           at the integration layer (validateInstanceUrl in
 *                           backend/src/handlers/gitlab.js); the skill just uses
 *                           the value it is handed.
 *   - GITLAB_API_URL        full `/api/v4` base override (rarely needed). If
 *                           set it wins over GITLAB_INSTANCE_URL.
 *
 * When a backend GitLab OAuth handler lands, swap glFetch's auth + base to
 * resolveIntegrationToken('gitlab') — the tool surface stays the same.
 *
 * `requiresIntegration: INTEGRATIONS.GITLAB` makes GitLab a REQUIRED
 * integration for any workflow node that declares this skill (the marketplace
 * deploy gate blocks until GitLab is connected) — same as the github skill is
 * required for github_* tools.
 *
 * The GitLab vocabulary differs from GitHub: a "merge request" (MR) is the
 * GitHub "pull request"; an MR is addressed by (projectId, iid) where
 * `projectId` is either the numeric id or the URL-encoded full path
 * ("group/subgroup/repo") and `iid` is the per-project MR number. Both the
 * numeric id and the "namespace/project" path form are accepted everywhere a
 * projectId is taken (encodeProject handles the path-encoding).
 */

import { INTEGRATIONS } from './integrations.js';

/**
 * Base API url. Resolution order:
 *   1. GITLAB_API_URL          — explicit /api/v4 base, used verbatim
 *   2. GITLAB_INSTANCE_URL     — the integration's host; we append /api/v4
 *   3. https://gitlab.com      — cloud default
 * Works for BOTH gitlab.com (cloud) and any self-hosted instanceUrl.
 */
function gitlabApiBase() {
  const explicit = process.env.GITLAB_API_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  // GITLAB_URL is the name the workflow-executor actually injects (from the
  // integration's instanceUrl); GITLAB_INSTANCE_URL kept as an alias.
  const host = (process.env.GITLAB_URL || process.env.GITLAB_INSTANCE_URL || 'https://gitlab.com').trim().replace(/\/+$/, '');
  // If the configured host already points at the API root, don't double it.
  if (/\/api\/v\d+$/.test(host)) return host;
  return `${host}/api/v4`;
}

/** Resolve the GitLab auth headers from env. */
function gitlabAuthHeaders() {
  if (process.env.GITLAB_OAUTH_TOKEN) {
    return { Authorization: `Bearer ${process.env.GITLAB_OAUTH_TOKEN}` };
  }
  const token = process.env.GITLAB_TOKEN;
  if (!token) {
    throw new Error('GitLab is not connected: set GITLAB_TOKEN (personal/project access token, api scope) or GITLAB_OAUTH_TOKEN.');
  }
  return { 'PRIVATE-TOKEN': token };
}

/**
 * Low-level GitLab REST helper. Throws on non-2xx, returns parsed JSON
 * (or raw text when opts.raw). Exported so a future gitlabAdapter (neutral
 * tracker layer) can reach endpoints the tools don't cover without
 * re-implementing auth — keep this the single auth chokepoint.
 *
 * @param {string} path  API path beginning with `/` (relative to /api/v4),
 *                       or a full https:// url.
 * @param {{ method?: string, body?: object, raw?: boolean }} [opts]
 */
export async function glFetch(path, opts = {}) {
  const url = /^https?:\/\//.test(path) ? path : `${gitlabApiBase()}${path}`;
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'Zibby-App',
    ...gitlabAuthHeaders(),
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
  };
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`GitLab API ${res.status}: ${err.slice(0, 300)}`);
  }
  if (opts.raw) return res.text();
  return res.json();
}

/** URL-encode a project id/path (numeric ids pass through; paths get encoded). */
function encodeProject(projectId) {
  const id = String(projectId);
  // Numeric id → leave as-is; full path "group/repo" → URL-encode (slashes too).
  return /^\d+$/.test(id) ? id : encodeURIComponent(id);
}

export const gitlabSkill = {
  id: 'gitlab',
  serverName: 'gitlab',
  // No MCP server — tools are served directly via handleToolCall, same as
  // the sentry / linear skills. allowedTools still namespaces them.
  allowedTools: ['mcp__gitlab__*'],
  requiresIntegration: INTEGRATIONS.GITLAB, // see githubSkill.requiresIntegration for semantics
  envKeys: ['GITLAB_TOKEN', 'GITLAB_OAUTH_TOKEN', 'GITLAB_INSTANCE_URL', 'GITLAB_API_URL'],
  description: 'GitLab — merge requests, diffs, MR reviews/discussions, issues',

  promptFragment: `## GitLab (connected)
You have access to the user's GitLab projects via the REST API (cloud gitlab.com OR self-hosted). A "merge request" (MR) is GitLab's pull request. An MR is addressed by a PROJECT (numeric id OR full path like "group/repo") and an \`iid\` (the per-project MR number shown in the URL). For projects, prefer the full path form ("group/subgroup/repo") — it's what users have. Available tools:

### Merge requests
- gitlab_get_mr: Get an MR's details (title, description, author, source/target branch, state, web url, diff_refs)
- gitlab_get_mr_changes: Get the MR's changed files with per-file diffs — THIS is the code to review
- gitlab_list_mrs: List a project's merge requests (filter by state: opened|closed|merged|all)
- gitlab_list_mr_notes: Get the discussion/notes thread on an MR
- gitlab_post_mr_note: Post a general (non-inline) comment on an MR
- gitlab_post_mr_discussion: Post an INLINE review comment anchored to a file + line in the MR diff. Needs diff_refs (pass them from gitlab_get_mr / gitlab_get_mr_changes, or omit and the tool fetches them). Provide newLine for added/changed lines (or oldLine for removed/context lines).

### Issues
- gitlab_get_issue: Get a single issue (by project + issue iid) — title, description, state, labels, assignee, web url
- gitlab_list_issues: List a project's issues (filter by state: opened|closed|all, labels, updatedAfter cursor)
- gitlab_add_issue_comment: Add a comment to an issue (also the way to record an MR link on a ticket)

### Notes
- A code-review flow is: gitlab_get_mr (context + diff_refs) → gitlab_get_mr_changes (the diff) → gitlab_post_mr_discussion per inline finding → gitlab_post_mr_note for the summary.
- If an inline position is rejected by GitLab (bad line anchor), fall back to gitlab_post_mr_note with the file/line in the text.`,

  resolve() {
    // No server process — direct handleToolCall. Mirror sentry/linear:
    // surface the configured env so the runtime can inject it.
    const env = {};
    for (const key of this.envKeys) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return { command: null, args: [], env, description: this.description };
  },

  async handleToolCall(name, args) {
    try {
      switch (name) {
        case 'gitlab_get_mr': {
          const { projectId, iid } = args || {};
          if (!projectId || !iid) return JSON.stringify({ error: 'projectId and iid are required' });
          const mr = await glFetch(`/projects/${encodeProject(projectId)}/merge_requests/${iid}`);
          return JSON.stringify({
            iid: mr.iid,
            projectId: mr.project_id,
            title: mr.title,
            description: (mr.description || '').slice(0, 5000),
            state: mr.state,
            author: mr.author?.username,
            sourceBranch: mr.source_branch,
            targetBranch: mr.target_branch,
            draft: mr.draft ?? mr.work_in_progress ?? false,
            mergeStatus: mr.merge_status,
            changesCount: mr.changes_count,
            labels: Array.isArray(mr.labels) ? mr.labels : [],
            webUrl: mr.web_url,
            createdAt: mr.created_at,
            updatedAt: mr.updated_at,
            mergedAt: mr.merged_at,
            // SHAs needed to anchor inline discussion comments on the diff.
            diffRefs: mr.diff_refs || null,
          });
        }

        case 'gitlab_get_mr_changes': {
          const { projectId, iid } = args || {};
          if (!projectId || !iid) return JSON.stringify({ error: 'projectId and iid are required' });
          // /changes returns the MR plus a `changes[]` array of per-file diffs.
          const data = await glFetch(`/projects/${encodeProject(projectId)}/merge_requests/${iid}/changes`);
          const changes = Array.isArray(data.changes) ? data.changes : [];
          return JSON.stringify({
            iid: data.iid,
            total: changes.length,
            // Pass these straight to gitlab_post_mr_discussion for inline anchoring.
            diffRefs: data.diff_refs || null,
            files: changes.map((c) => ({
              oldPath: c.old_path,
              newPath: c.new_path,
              newFile: !!c.new_file,
              deletedFile: !!c.deleted_file,
              renamedFile: !!c.renamed_file,
              diff: typeof c.diff === 'string' ? c.diff.slice(0, 3000) : '',
            })),
          });
        }

        case 'gitlab_list_mrs': {
          const { projectId, state, targetBranch, sourceBranch, authorUsername, labels, search, sort, orderBy, limit } = args || {};
          if (!projectId) return JSON.stringify({ error: 'projectId is required' });
          const params = new URLSearchParams();
          params.set('state', state || 'opened'); // opened | closed | merged | locked | all
          params.set('per_page', String(limit || 20));
          params.set('order_by', orderBy || 'updated_at'); // created_at | updated_at | title
          params.set('sort', sort || 'desc');
          if (targetBranch) params.set('target_branch', targetBranch);
          if (sourceBranch) params.set('source_branch', sourceBranch);
          if (authorUsername) params.set('author_username', authorUsername);
          if (labels) params.set('labels', Array.isArray(labels) ? labels.join(',') : labels);
          if (search) params.set('search', search);
          const data = await glFetch(`/projects/${encodeProject(projectId)}/merge_requests?${params.toString()}`);
          const mrs = (Array.isArray(data) ? data : []).map((m) => ({
            iid: m.iid,
            title: m.title,
            state: m.state,
            author: m.author?.username,
            sourceBranch: m.source_branch,
            targetBranch: m.target_branch,
            draft: m.draft ?? m.work_in_progress ?? false,
            labels: Array.isArray(m.labels) ? m.labels : [],
            webUrl: m.web_url,
            createdAt: m.created_at,
            updatedAt: m.updated_at,
          }));
          return JSON.stringify({ count: mrs.length, mergeRequests: mrs });
        }

        case 'gitlab_list_mr_notes': {
          const { projectId, iid, limit } = args || {};
          if (!projectId || !iid) return JSON.stringify({ error: 'projectId and iid are required' });
          const notes = await glFetch(
            `/projects/${encodeProject(projectId)}/merge_requests/${iid}/notes?per_page=${limit || 50}&sort=asc&order_by=created_at`,
          );
          return JSON.stringify({
            total: Array.isArray(notes) ? notes.length : 0,
            notes: (Array.isArray(notes) ? notes : []).map((n) => ({
              id: n.id,
              author: n.author?.username,
              body: (n.body || '').slice(0, 1000),
              system: !!n.system,
              createdAt: n.created_at,
            })),
          });
        }

        case 'gitlab_post_mr_note': {
          // General (non-inline) comment on an MR.
          const { projectId, iid, body } = args || {};
          if (!projectId || !iid || !body) return JSON.stringify({ error: 'projectId, iid, and body are required' });
          const note = await glFetch(`/projects/${encodeProject(projectId)}/merge_requests/${iid}/notes`, {
            method: 'POST',
            body: { body: String(body) },
          });
          return JSON.stringify({ ok: true, id: note.id, createdAt: note.created_at });
        }

        case 'gitlab_post_mr_discussion': {
          // Inline review comment anchored to a file/line in the MR diff.
          //
          // GitLab anchors inline discussions with a `position` object that
          // carries the MR's diff_refs (base/start/head SHAs) plus the file
          // path and line. Provide newLine for added/changed lines (RIGHT side
          // of the diff) and/or oldLine for removed/context lines (LEFT side).
          // diff_refs come from gitlab_get_mr / gitlab_get_mr_changes; if the
          // caller omits them we fetch the MR to resolve them.
          const { projectId, iid, path, oldPath, newLine, oldLine, body } = args || {};
          if (!projectId || !iid || !path || !body) {
            return JSON.stringify({ error: 'projectId, iid, path, and body are required' });
          }
          if (newLine == null && oldLine == null) {
            return JSON.stringify({ error: 'newLine (added/changed line) or oldLine (removed/context line) is required to anchor an inline comment' });
          }
          const proj = encodeProject(projectId);
          let diffRefs = args.diffRefs || null;
          if (!diffRefs) {
            const mr = await glFetch(`/projects/${proj}/merge_requests/${iid}`);
            diffRefs = mr.diff_refs || null;
          }
          if (!diffRefs || !diffRefs.head_sha) {
            return JSON.stringify({ error: 'could not resolve diff_refs for this MR — cannot anchor an inline comment. Use gitlab_post_mr_note instead.' });
          }
          const position = {
            base_sha: diffRefs.base_sha,
            start_sha: diffRefs.start_sha,
            head_sha: diffRefs.head_sha,
            position_type: 'text',
            new_path: path,
            old_path: oldPath || path,
          };
          if (newLine != null) position.new_line = Number(newLine);
          if (oldLine != null) position.old_line = Number(oldLine);
          try {
            const disc = await glFetch(`/projects/${proj}/merge_requests/${iid}/discussions`, {
              method: 'POST',
              body: { body: String(body), position },
            });
            return JSON.stringify({ ok: true, discussionId: disc.id });
          } catch (e) {
            // A bad line anchor is the common GitLab failure (the line must be
            // part of the diff). Surface a clear, actionable error.
            return JSON.stringify({
              ok: false,
              error: `inline anchor rejected (${e.message}). The line must be part of the MR diff. Fall back to gitlab_post_mr_note with the file/line in the text.`,
            });
          }
        }

        case 'gitlab_create_mr_review': {
          // Convenience: post a full review in one call — a summary NOTE plus
          // optional inline DISCUSSIONS. GitLab has no single "create review"
          // call like GitHub, so this just composes gitlab_post_mr_note +
          // gitlab_post_mr_discussion. Inline failures are non-fatal so one
          // mis-positioned comment doesn't drop the whole review.
          const { projectId, iid, body, comments } = args || {};
          if (!projectId || !iid) return JSON.stringify({ error: 'projectId and iid are required' });
          const proj = encodeProject(projectId);

          const inline = Array.isArray(comments)
            ? comments.filter((c) => c && c.path && c.body && (c.newLine != null || c.oldLine != null))
            : [];

          if (!body && inline.length === 0) {
            return JSON.stringify({ error: 'a review needs a body and/or inline comments' });
          }

          let diffRefs = args.diffRefs || null;
          if (inline.length > 0 && !diffRefs) {
            const mr = await glFetch(`/projects/${proj}/merge_requests/${iid}`);
            diffRefs = mr.diff_refs || null;
          }

          let notePosted = false;
          if (body) {
            await glFetch(`/projects/${proj}/merge_requests/${iid}/notes`, {
              method: 'POST',
              body: { body: String(body) },
            });
            notePosted = true;
          }

          let inlinePosted = 0;
          const inlineErrors = [];
          if (inline.length > 0 && diffRefs) {
            for (const c of inline) {
              const position = {
                base_sha: diffRefs.base_sha,
                start_sha: diffRefs.start_sha,
                head_sha: diffRefs.head_sha,
                position_type: 'text',
                new_path: c.path,
                old_path: c.oldPath || c.path,
              };
              if (c.newLine != null) position.new_line = Number(c.newLine);
              if (c.oldLine != null) position.old_line = Number(c.oldLine);
              try {
                await glFetch(`/projects/${proj}/merge_requests/${iid}/discussions`, {
                  method: 'POST',
                  body: { body: String(c.body), position },
                });
                inlinePosted += 1;
              } catch (e) {
                inlineErrors.push(`${c.path}:${c.newLine ?? c.oldLine} — ${e.message}`);
              }
            }
          } else if (inline.length > 0 && !diffRefs) {
            inlineErrors.push('no diff_refs available — inline comments skipped (pass diffRefs from gitlab_get_mr)');
          }

          return JSON.stringify({
            ok: true,
            notePosted,
            inlinePosted,
            inlineErrors: inlineErrors.length ? inlineErrors : undefined,
          });
        }

        // ---- Issues (ticket context for a tracker/review agent) ----
        case 'gitlab_list_issues': {
          const { projectId, state, labels, assigneeUsername, authorUsername, updatedAfter, search, sort, orderBy, limit } = args || {};
          if (!projectId) return JSON.stringify({ error: 'projectId is required' });
          const params = new URLSearchParams();
          params.set('state', state || 'opened'); // opened | closed | all
          params.set('per_page', String(limit || 30));
          params.set('order_by', orderBy || 'updated_at'); // created_at | updated_at
          params.set('sort', sort || 'desc');
          if (labels) params.set('labels', Array.isArray(labels) ? labels.join(',') : labels);
          if (assigneeUsername) params.set('assignee_username', assigneeUsername);
          if (authorUsername) params.set('author_username', authorUsername);
          if (updatedAfter) params.set('updated_after', updatedAfter); // ISO-8601 polling cursor
          if (search) params.set('search', search);
          const data = await glFetch(`/projects/${encodeProject(projectId)}/issues?${params.toString()}`);
          const issues = (Array.isArray(data) ? data : []).map((i) => ({
            iid: i.iid,
            title: i.title,
            state: i.state,
            labels: Array.isArray(i.labels) ? i.labels : [],
            author: i.author?.username,
            assignees: (i.assignees || []).map((a) => a.username),
            userNotesCount: i.user_notes_count,
            webUrl: i.web_url,
            createdAt: i.created_at,
            updatedAt: i.updated_at,
          }));
          return JSON.stringify({ count: issues.length, issues });
        }

        case 'gitlab_get_issue': {
          const { projectId, iid } = args || {};
          if (!projectId || !iid) return JSON.stringify({ error: 'projectId and iid are required' });
          const i = await glFetch(`/projects/${encodeProject(projectId)}/issues/${iid}`);
          return JSON.stringify({
            iid: i.iid,
            projectId: i.project_id,
            title: i.title,
            description: (i.description || '').slice(0, 5000),
            state: i.state,
            labels: Array.isArray(i.labels) ? i.labels : [],
            author: i.author?.username,
            assignees: (i.assignees || []).map((a) => a.username),
            milestone: i.milestone?.title || null,
            webUrl: i.web_url,
            createdAt: i.created_at,
            updatedAt: i.updated_at,
            closedAt: i.closed_at,
          });
        }

        case 'gitlab_add_issue_comment': {
          // addComment (also the path for recording an MR link on a ticket).
          const { projectId, iid, body } = args || {};
          if (!projectId || !iid || !body) return JSON.stringify({ error: 'projectId, iid, and body are required' });
          const note = await glFetch(`/projects/${encodeProject(projectId)}/issues/${iid}/notes`, {
            method: 'POST',
            body: { body: String(body) },
          });
          return JSON.stringify({ ok: true, id: note.id, createdAt: note.created_at });
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
      name: 'gitlab_get_mr',
      description: 'Get a GitLab merge request — title, description, branches, state, author, web url, and diff_refs (needed to anchor inline review comments).',
      input_schema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project numeric id OR full path (e.g. "group/repo")' },
          iid: { type: 'number', description: 'Merge request iid (the per-project MR number in the URL)' },
        },
        required: ['projectId', 'iid'],
      },
    },
    {
      name: 'gitlab_get_mr_changes',
      description: 'Get the changed files of a GitLab merge request with per-file diffs — the actual code changes to review. Also returns diff_refs for inline comments.',
      input_schema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project numeric id OR full path (e.g. "group/repo")' },
          iid: { type: 'number', description: 'Merge request iid' },
        },
        required: ['projectId', 'iid'],
      },
    },
    {
      name: 'gitlab_list_mrs',
      description: 'List a GitLab project\'s merge requests, filtered by state and other criteria. Returns newest-updated first.',
      input_schema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project numeric id OR full path (e.g. "group/repo")' },
          state: { type: 'string', enum: ['opened', 'closed', 'merged', 'locked', 'all'], description: 'Filter by state (default: opened)' },
          targetBranch: { type: 'string', description: 'Filter by target branch' },
          sourceBranch: { type: 'string', description: 'Filter by source branch' },
          authorUsername: { type: 'string', description: 'Filter by author username' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Only MRs carrying ALL of these labels' },
          search: { type: 'string', description: 'Search title and description' },
          orderBy: { type: 'string', enum: ['created_at', 'updated_at', 'title'], description: 'Sort field (default: updated_at)' },
          sort: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction (default: desc)' },
          limit: { type: 'number', description: 'Max MRs (default: 20)' },
        },
        required: ['projectId'],
      },
    },
    {
      name: 'gitlab_list_mr_notes',
      description: 'List the discussion notes on a GitLab merge request (chronological).',
      input_schema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project numeric id OR full path' },
          iid: { type: 'number', description: 'Merge request iid' },
          limit: { type: 'number', description: 'Max notes (default 50)' },
        },
        required: ['projectId', 'iid'],
      },
    },
    {
      name: 'gitlab_post_mr_note',
      description: 'Post a general (non-inline) comment on a GitLab merge request. Use for a review summary or a top-level remark.',
      input_schema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project numeric id OR full path' },
          iid: { type: 'number', description: 'Merge request iid' },
          body: { type: 'string', description: 'Comment body (markdown)' },
        },
        required: ['projectId', 'iid', 'body'],
      },
    },
    {
      name: 'gitlab_post_mr_discussion',
      description: 'Post an INLINE review comment anchored to a file + line in a GitLab merge request diff. Provide newLine (added/changed line) or oldLine (removed/context line). Pass diffRefs from gitlab_get_mr/gitlab_get_mr_changes, or omit to have the tool fetch them. If the line anchor is rejected, fall back to gitlab_post_mr_note.',
      input_schema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project numeric id OR full path' },
          iid: { type: 'number', description: 'Merge request iid' },
          path: { type: 'string', description: 'New file path as it appears in the diff' },
          oldPath: { type: 'string', description: 'Old file path (defaults to path)' },
          newLine: { type: 'number', description: 'Line number in the NEW version of the file (for added/changed lines)' },
          oldLine: { type: 'number', description: 'Line number in the OLD version (for removed/context lines)' },
          body: { type: 'string', description: 'The inline comment text (markdown)' },
          diffRefs: {
            type: 'object',
            description: 'The MR diff_refs ({ base_sha, start_sha, head_sha }) from gitlab_get_mr. Omit and the tool fetches them.',
          },
        },
        required: ['projectId', 'iid', 'path', 'body'],
      },
    },
    {
      name: 'gitlab_create_mr_review',
      description: 'Post a full review on a GitLab merge request in one call: a summary note plus optional inline comments anchored to file/line in the diff. Convenience wrapper over gitlab_post_mr_note + gitlab_post_mr_discussion.',
      input_schema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project numeric id OR full path' },
          iid: { type: 'number', description: 'Merge request iid' },
          body: { type: 'string', description: 'The review summary (markdown). Posted as a top-level MR note.' },
          diffRefs: {
            type: 'object',
            description: 'The MR diff_refs ({ base_sha, start_sha, head_sha }) from gitlab_get_mr — required to anchor inline comments. Omit and the tool fetches them.',
          },
          comments: {
            type: 'array',
            description: 'Optional inline comments, each anchored to a changed line in a file.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'New file path as it appears in the diff' },
                oldPath: { type: 'string', description: 'Old file path (defaults to path)' },
                newLine: { type: 'number', description: 'Line number in the NEW version of the file (for added/changed lines)' },
                oldLine: { type: 'number', description: 'Line number in the OLD version (for removed/context lines)' },
                body: { type: 'string', description: 'The inline comment text (markdown)' },
              },
              required: ['path', 'body'],
            },
          },
        },
        required: ['projectId', 'iid'],
      },
    },
    {
      name: 'gitlab_list_issues',
      description: 'List a GitLab project\'s issues, filtered by state, labels, and an updatedAfter polling cursor. Returns newest-updated first.',
      input_schema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project numeric id OR full path (e.g. "group/repo")' },
          state: { type: 'string', enum: ['opened', 'closed', 'all'], description: 'Filter by state (default: opened)' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Only issues carrying ALL of these labels' },
          assigneeUsername: { type: 'string', description: 'Filter by assignee username' },
          authorUsername: { type: 'string', description: 'Filter by author username' },
          updatedAfter: { type: 'string', description: 'ISO-8601 timestamp; only issues updated after this (polling cursor)' },
          search: { type: 'string', description: 'Search title and description' },
          orderBy: { type: 'string', enum: ['created_at', 'updated_at'], description: 'Sort field (default: updated_at)' },
          sort: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction (default: desc)' },
          limit: { type: 'number', description: 'Max issues (default: 30)' },
        },
        required: ['projectId'],
      },
    },
    {
      name: 'gitlab_get_issue',
      description: 'Get a single GitLab issue with full detail (title, description, state, labels, assignees, web url).',
      input_schema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project numeric id OR full path' },
          iid: { type: 'number', description: 'Issue iid (the per-project issue number in the URL)' },
        },
        required: ['projectId', 'iid'],
      },
    },
    {
      name: 'gitlab_add_issue_comment',
      description: 'Add a comment to a GitLab issue. Also the way to record an MR link on a ticket (post a markdown link).',
      input_schema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project numeric id OR full path' },
          iid: { type: 'number', description: 'Issue iid' },
          body: { type: 'string', description: 'Comment body (markdown)' },
        },
        required: ['projectId', 'iid', 'body'],
      },
    },
  ],
};
