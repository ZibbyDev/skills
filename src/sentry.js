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
export async function sentryFetch(path, opts = {}) {
  const { token, organizationSlug } = await resolveIntegrationToken('sentry');
  const url = `https://sentry.io/api/0/organizations/${organizationSlug}${path}`;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
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
  const { token } = await resolveIntegrationToken('sentry');
  const res = await fetch(`https://sentry.io/api/0/issues/${issueId}/`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Sentry API ${res.status}: ${err.slice(0, 300)}`);
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
- sentry_get_issue: Get detailed info about a specific issue (requires issueId)`,

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
    for (const k of ['PROJECT_API_TOKEN', 'ZIBBY_USER_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_ENV', 'ZIBBY_PROD_ACCOUNT_API_URL', 'PROGRESS_API_URL', 'EXECUTION_ID', 'PROJECT_ID', 'STAGE']) {
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
  ],
};

// `tools` is what assistant-strategy actually reads. Alias so the
// in-process path keeps working without renaming throughout the codebase.
sentrySkill.tools = sentrySkill.toolsForAssistant;
