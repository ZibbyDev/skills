/**
 * Sentry skill — list projects, list issues, get issue details.
 *
 * Architecture: mirrors `browserSkill`. Resolves to a self-contained
 * MCP stdio server binary at `@zibby/skills/bin/mcp-sentry.mjs`. Any
 * agent strategy that supports MCP servers (Claude Code, Cursor,
 * Codex, Gemini) can spawn it and immediately get the 3 Sentry tools.
 *
 * Auth flows through PROJECT_API_TOKEN + PROGRESS_API_URL (inherited
 * env vars on Fargate). The MCP binary calls resolveIntegrationToken
 * against the backend to fetch the user's Sentry OAuth token.
 *
 * Backward compat: keeps `handleToolCall` for the `assistant` agent
 * (OpenAI Assistant API) which doesn't use MCP. Both runtimes call
 * the same Sentry endpoints with the same shape — assistant via
 * in-process JS, MCP-style agents via the spawned binary.
 */

import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve as resolvePath } from 'path';
import { resolveIntegrationToken } from '@zibby/core/backend-client.js';
import { INTEGRATIONS } from './integrations.js';

/**
 * Resolve the path to the bundled MCP server binary. Caller may
 * override via MCP_SENTRY_PATH for development.
 *
 * IMPORTANT: this used to call `require.resolve('@zibby/skills/bin/...')`
 * — a package self-reference. esbuild's dist bundler emits a
 * `dist/package.json` alongside the bundled output, which Node treats
 * as the package root for self-references. So `@zibby/skills/bin/...`
 * resolved to `dist/bin/...` (doesn't exist) instead of `bin/...` (where
 * the bins live). The MCP server silently never spawned. Verified
 * locally before this fix: `resolve()` returned null → strategy didn't
 * add the server to mcpServers → SDK init reported zero MCP servers →
 * model had no tools.
 *
 * Sidestep by deriving the path from `import.meta.url` directly: the
 * bin/ dir is always a sibling of whichever directory this module
 * ends up in (src/ during dev, dist/ after bundling, and the same in
 * a published install: node_modules/@zibby/skills/{dist,bin}/).
 */
function resolveSentryBin() {
  if (process.env.MCP_SENTRY_PATH) return process.env.MCP_SENTRY_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-sentry.mjs');
  return existsSync(candidate) ? candidate : null;
}

/**
 * Low-level Sentry REST helper, scoped to the user's connected org.
 * All endpoints under `/api/0/organizations/<slug>/…` route through
 * this — auth header + base URL + non-2xx → throw are handled once.
 *
 * Exported so deterministic workflow nodes can talk to Sentry without
 * going through the LLM tool layer. `sentryListIssues / Projects /
 * GetIssue` below are thin wrappers — prefer those over raw `sentryFetch`.
 */
/**
 * Base URL of the Sentry instance. Resolution order:
 *   1. `explicit` — the baseUrl the token resolver returns for a CLOUD account
 *      that connected a self-hosted Sentry (integration metadata.baseUrl).
 *   2. `SENTRY_URL` env — a SELF-HOSTED Zibby operator points at their instance
 *      via .env (mirrors the gitlab skill's `GITLAB_URL`).
 *   3. `https://sentry.io` — SaaS default (both cloud + self-host unchanged).
 * Trailing slash trimmed so path concatenation stays clean.
 */
function sentryBaseUrl(explicit) {
  return (explicit || process.env.SENTRY_URL || 'https://sentry.io').trim().replace(/\/+$/, '');
}

/**
 * Organization slug for org-scoped endpoints. Cloud provides it via the
 * connected integration (`organizationSlug` from resolveIntegrationToken).
 * Self-hosted has no integration record, so fall back to `SENTRY_ORG`
 * (the self-hosted installer's default org is literally `sentry`).
 */
function sentryOrg(organizationSlug) {
  const org = organizationSlug || process.env.SENTRY_ORG;
  if (!org) {
    throw new Error(
      'Sentry organization not resolved — reconnect Sentry, or set SENTRY_ORG '
      + '(self-hosted; the default org slug is "sentry").',
    );
  }
  return org;
}

export async function sentryFetch(path, opts = {}) {
  const { token, organizationSlug, baseUrl } = await resolveIntegrationToken('sentry');
  const url = `${sentryBaseUrl(baseUrl)}/api/0/organizations/${sentryOrg(organizationSlug)}${path}`;
  // Forward a JSON body for write calls. We accept either an already-serialized
  // string or a plain object (serialized here) — so callers can pass `{ body: {…} }`
  // for PUT/POST without remembering to JSON.stringify. GET stays body-less.
  const init = {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (opts.body != null) {
    init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Sentry API ${res.status}: ${err.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * List Sentry projects in the connected organization. Returns raw
 * Sentry-shape objects ({ slug, name, platform, id, … }).
 *
 * Single source of truth for the `sentry_list_projects` tool (MCP +
 * assistant), and for deterministic workflow nodes.
 */
export async function sentryListProjects() {
  return sentryFetch('/projects/?per_page=50');
}

/**
 * List Sentry issues. Returns the raw Sentry array. Wrappers above
 * (MCP / assistant tool handlers) format the shape for LLM consumers;
 * deterministic callers get the raw issue objects so their own
 * outputSchema can validate / reshape.
 *
 * @param {{ query?: string, sort?: string, project?: string, limit?: number }} opts
 */
export async function sentryListIssues({ query = 'is:unresolved', sort = 'date', project, limit = 25 } = {}) {
  let path = `/issues/?query=${encodeURIComponent(query)}&sort=${sort}&per_page=${limit}`;
  if (project) path += `&project=${encodeURIComponent(project)}`;
  return sentryFetch(path);
}

/**
 * Fetch one Sentry issue's details. Uses the global `/issues/<id>/`
 * endpoint (NOT under /organizations/<slug>/) — Sentry routes issue
 * details by ID without an org scope. Auth still uses the connected
 * integration's token.
 */
export async function sentryGetIssue(issueId) {
  if (!issueId) throw new Error('sentryGetIssue: issueId is required');
  const { token, baseUrl } = await resolveIntegrationToken('sentry');
  const res = await fetch(`${sentryBaseUrl(baseUrl)}/api/0/issues/${issueId}/`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Sentry API ${res.status}: ${err.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * WRITE-back to a Sentry issue. Mutates issue STATE (resolve / ignore / mute /
 * reopen), assignment, bookmark, or seen-flag via the global
 * `PUT /issues/<id>/` endpoint (NOT org-scoped — issues route by id, same as
 * sentryGetIssue). Only the fields you pass are sent.
 *
 * Common uses:
 *   sentryUpdateIssue(id, { status: 'resolvedInNextRelease' })  // leaves the
 *     is:unresolved queue, regresses only if it recurs in a LATER release
 *   sentryUpdateIssue(id, { status: 'resolved', statusDetails: { inRelease: 'latest' } })
 *   sentryUpdateIssue(id, { status: 'ignored' })
 *   sentryUpdateIssue(id, { assignedTo: 'user:123' })
 *
 * @param {string} issueId
 * @param {{ status?: 'resolved'|'resolvedInNextRelease'|'unresolved'|'ignored'|'muted',
 *           statusDetails?: object, assignedTo?: string, isBookmarked?: boolean,
 *           hasSeen?: boolean }} update
 *
 * Requires the connected Sentry integration's token to carry the `event:write`
 * scope. A 403 → a CLEAR error telling the operator the Sentry connection likely
 * lacks write scope and must be reconnected with it.
 */
export async function sentryUpdateIssue(issueId, update = {}) {
  if (!issueId) throw new Error('sentryUpdateIssue: issueId is required');
  // Only forward the fields the caller actually set — Sentry treats a present
  // key as "change this", so an undefined must never leak into the body.
  const body = {};
  for (const k of ['status', 'statusDetails', 'assignedTo', 'isBookmarked', 'hasSeen']) {
    if (update[k] !== undefined) body[k] = update[k];
  }
  if (Object.keys(body).length === 0) {
    throw new Error('sentryUpdateIssue: nothing to update (pass status / statusDetails / assignedTo / isBookmarked / hasSeen)');
  }
  const { token, baseUrl } = await resolveIntegrationToken('sentry');
  const res = await fetch(`${sentryBaseUrl(baseUrl)}/api/0/issues/${issueId}/`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    if (res.status === 403) {
      throw new Error(
        `Sentry API 403 updating issue ${issueId}: ${err.slice(0, 200)}. The connected Sentry `
        + 'integration likely lacks the `event:write` scope — reconnect Sentry with write access '
        + 'to let Zibby resolve/comment on issues.',
      );
    }
    throw new Error(`Sentry API ${res.status} updating issue ${issueId}: ${err.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Post a comment ("note") on a Sentry issue via
 * `POST /issues/<id>/comments/`. Same global-issue endpoint + token as
 * sentryGetIssue / sentryUpdateIssue, and the same `event:write`-scope 403 →
 * clear-error contract.
 *
 * @param {string} issueId
 * @param {string} text  the comment body (Sentry markdown)
 */
export async function sentryAddComment(issueId, text) {
  if (!issueId) throw new Error('sentryAddComment: issueId is required');
  if (!text || !String(text).trim()) throw new Error('sentryAddComment: text is required');
  const { token, baseUrl } = await resolveIntegrationToken('sentry');
  const res = await fetch(`${sentryBaseUrl(baseUrl)}/api/0/issues/${issueId}/comments/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: String(text) }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    if (res.status === 403) {
      throw new Error(
        `Sentry API 403 commenting on issue ${issueId}: ${err.slice(0, 200)}. The connected Sentry `
        + 'integration likely lacks the `event:write` scope — reconnect Sentry with write access.',
      );
    }
    throw new Error(`Sentry API ${res.status} commenting on issue ${issueId}: ${err.slice(0, 300)}`);
  }
  return res.json();
}

export const sentrySkill = {
  id: 'sentry',
  serverName: 'sentry',                  // MCP server name; tools appear as mcp__sentry__<tool>
  allowedTools: ['mcp__sentry__*'],      // glob for the Agent SDK's tool allowlist
  // External OAuth/credentialed service this skill calls. The backend
  // workflow-bundler reads this when a node lists this skill and adds
  // the provider to workflow.requiredIntegrations. Status endpoint then
  // tells the user "Sentry must be connected before this workflow runs".
  // Accept a single string OR string[] for skills that span >1 provider.
  requiresIntegration: INTEGRATIONS.SENTRY,
  description: 'Sentry error tracking — projects, issues, events',
  envKeys: [],
  tools: [],                             // Empty: tools come from the spawned MCP server, not declared here

  promptFragment: `## Sentry (connected)
You have access to the user's Sentry. Use these tools:
- sentry_list_projects: List projects in the organization
- sentry_list_issues: List errors/issues (supports Sentry search query, project filter, sort)
- sentry_get_issue: Get detailed info about a specific issue (requires issueId)
- sentry_update_issue: Change an issue's status (resolved / resolvedInNextRelease / ignored / unresolved / muted), assignment, or bookmark (requires issueId; needs write scope)
- sentry_add_comment: Post a comment/note on an issue (requires issueId + text; needs write scope)`,

  resolve() {
    const bin = resolveSentryBin();
    if (!bin) return null;
    // Pass through the env vars the MCP server needs to call the
    // backend's resolveIntegrationToken endpoint. Same approach as
    // browserSkill — explicit allow-list to keep secrets scoped.
    const env = {};
    // ZIBBY_ACCOUNT_API_URL + ZIBBY_ENV are what resolveIntegrationToken()
    // (backend-client.js getAccountApiUrl) reads to pick the token-resolution
    // endpoint. The in-process path inherits the full process.env and reads
    // them fine; the MCP stdio child only gets this allow-list, so WITHOUT
    // them the child falls back to api-prod.zibby.app and a local/dev task
    // 401s ("project not found") on every sentry_* call — returning 0 issues
    // that the LLM faithfully transcribes as []. ZIBBY_USER_TOKEN is the
    // session-token fallback when PROJECT_API_TOKEN isn't set.
    // SELF-HOSTED Sentry: the MCP child only gets THIS allow-list, so the base
    // URL / org / token vars must be forwarded explicitly or a self-hosted
    // instance falls back to sentry.io + the cloud token endpoint (→ "session
    // expired" / wrong host). ZIBBY_SELF_HOST flips resolveIntegrationToken to
    // the env-token fast path; SENTRY_AUTH_TOKEN is that token (see SELF_HOST_ENV
    // in @zibby/core). Absent on cloud → the child behaves exactly as before.
    for (const k of ['PROJECT_API_TOKEN', 'ZIBBY_USER_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_ENV', 'ZIBBY_PROD_ACCOUNT_API_URL', 'PROGRESS_API_URL', 'EXECUTION_ID', 'PROJECT_ID', 'STAGE', 'ZIBBY_SELF_HOST', 'SENTRY_URL', 'SENTRY_ORG', 'SENTRY_AUTH_TOKEN']) {
      if (process.env[k]) env[k] = process.env[k];
    }
    return {
      type: 'stdio',
      command: 'node',
      args: [bin],
      env,
      // Force tools into the system prompt instead of deferring them
      // behind ToolSearch (Claude Agent SDK default). Without this,
      // the LLM's `ToolSearch({"query":"sentry"})` returns nothing for
      // MCP-served tools even when the server is connected — we
      // verified this against Fargate logs. As a side effect this
      // blocks startup until the server completes its initial MCP
      // handshake (capped at the SDK's 5s connect timeout), so any
      // bridge spawn failure surfaces immediately instead of silently
      // leaving the LLM tool-less.
      alwaysLoad: true,
    };
  },

  // ── In-process path (assistant agent only) ─────────────────────────
  // The `assistant` strategy doesn't spawn MCP servers — it dispatches
  // tool calls in-process via this method. Delegates to the exported
  // sentry* helpers above; the LLM-shaped JSON envelope (and the
  // narrowed field set per tool) lives only here so deterministic
  // callers can use the raw helpers without inheriting it.
  async handleToolCall(name, args = {}) {
    try {
      switch (name) {
        case 'sentry_list_projects': {
          const data = await sentryListProjects();
          return JSON.stringify({
            projects: data.map((p) => ({ slug: p.slug, name: p.name, platform: p.platform })),
          });
        }
        case 'sentry_list_issues': {
          const data = await sentryListIssues({
            query: args.query,
            sort: args.sort,
            project: args.project,
            limit: args.limit,
          });
          return JSON.stringify({
            issues: data.map((i) => ({
              id: i.id, title: i.title, culprit: i.culprit,
              count: i.count, firstSeen: i.firstSeen, lastSeen: i.lastSeen,
              level: i.level, status: i.status,
            })),
          });
        }
        case 'sentry_get_issue': {
          const data = await sentryGetIssue(args.issueId);
          return JSON.stringify({
            id: data.id, title: data.title, culprit: data.culprit,
            metadata: data.metadata, count: data.count, userCount: data.userCount,
            firstSeen: data.firstSeen, lastSeen: data.lastSeen,
            level: data.level, status: data.status,
            project: { slug: data.project?.slug, name: data.project?.name },
          });
        }
        case 'sentry_update_issue': {
          const data = await sentryUpdateIssue(args.issueId, {
            status: args.status,
            statusDetails: args.statusDetails,
            assignedTo: args.assignedTo,
            isBookmarked: args.isBookmarked,
            hasSeen: args.hasSeen,
          });
          return JSON.stringify({
            ok: true, id: data.id ?? args.issueId, status: data.status,
            assignedTo: data.assignedTo, isBookmarked: data.isBookmarked,
          });
        }
        case 'sentry_add_comment': {
          const data = await sentryAddComment(args.issueId, args.text);
          return JSON.stringify({ ok: true, id: data.id, issueId: args.issueId });
        }
        default:
          return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  },

  // Mirror the MCP server's tool schemas so the `assistant` agent
  // strategy advertises them to OpenAI. Kept in sync with bin/mcp-sentry.mjs.
  toolsForAssistant: [
    { name: 'sentry_list_projects', description: 'List Sentry projects', input_schema: { type: 'object', properties: {} } },
    {
      name: 'sentry_list_issues',
      description: 'List Sentry issues (errors)',
      input_schema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project slug (optional)' },
          query: { type: 'string', description: 'Sentry search query (default: is:unresolved)' },
          sort: { type: 'string', description: 'Sort order: date, new, priority, freq, user (default: date)' },
          limit: { type: 'number', description: 'Max issues to return (default 25)' },
        },
      },
    },
    {
      name: 'sentry_get_issue',
      description: 'Get details of a specific Sentry issue',
      input_schema: {
        type: 'object',
        properties: { issueId: { type: 'string', description: 'Sentry issue ID' } },
        required: ['issueId'],
      },
    },
    {
      name: 'sentry_update_issue',
      description: "Update a Sentry issue's status, assignment, or bookmark (needs event:write scope)",
      input_schema: {
        type: 'object',
        properties: {
          issueId: { type: 'string', description: 'Sentry issue ID' },
          status: { type: 'string', description: 'resolved | resolvedInNextRelease | unresolved | ignored | muted' },
          statusDetails: { type: 'object', description: 'Optional status details, e.g. { "inRelease": "latest" }' },
          assignedTo: { type: 'string', description: 'Assignee actor id, e.g. "user:123" or "team:456" (optional)' },
          isBookmarked: { type: 'boolean', description: 'Bookmark/unbookmark the issue (optional)' },
          hasSeen: { type: 'boolean', description: 'Mark the issue seen/unseen (optional)' },
        },
        required: ['issueId'],
      },
    },
    {
      name: 'sentry_add_comment',
      description: 'Post a comment/note on a Sentry issue (needs event:write scope)',
      input_schema: {
        type: 'object',
        properties: {
          issueId: { type: 'string', description: 'Sentry issue ID' },
          text: { type: 'string', description: 'Comment body (markdown)' },
        },
        required: ['issueId', 'text'],
      },
    },
  ],
};

// `tools` is what assistant-strategy actually reads. Alias so the
// in-process path keeps working without renaming throughout the codebase.
sentrySkill.tools = sentrySkill.toolsForAssistant;
