#!/usr/bin/env node
/**
 * Zibby Sentry MCP Server — standalone stdio MCP binary.
 *
 * Mirrors the @zibby/mcp-browser pattern: this is a self-contained
 * MCP server that exposes Sentry tools (list_projects, list_issues,
 * get_issue) to any MCP client (Claude Code, Cursor, etc.). Skill's
 * `resolve()` just spawns this binary; everything else runs inside
 * the spawned process.
 *
 * Why standalone vs the function-bridge approach: the bridge required
 * the parent's in-memory handler registry to be visible to the child,
 * but each Node process has its own module instance map. Even when
 * the bridge re-imported the skill module, the `registerHandlers`
 * side-effect didn't always land in the same registry the bridge
 * subsequently read from (cross-package vs relative ESM URL resolution
 * subtleties). A self-contained binary side-steps the whole issue.
 *
 * Auth: reads PROJECT_API_TOKEN + PROGRESS_API_URL + EXECUTION_ID
 * + PROJECT_ID + STAGE from the inherited env (set by workflow-executor.js
 * on every Fargate task). resolveIntegrationToken('sentry') hits the
 * project's backend → returns the Sentry OAuth access token + org slug.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolveIntegrationToken } from '@zibby/core/backend-client.js';

async function sentryFetch(path, opts = {}) {
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

const server = new McpServer(
  { name: 'zibby-sentry', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

// ── sentry_list_projects ────────────────────────────────────────────
server.registerTool(
  'sentry_list_projects',
  {
    title: 'List Sentry Projects',
    description: 'List Sentry projects in the connected organization.',
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const data = await sentryFetch('/projects/?per_page=50');
      const text = JSON.stringify({
        projects: data.map((p) => ({ slug: p.slug, name: p.name, platform: p.platform })),
      });
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

// ── sentry_list_issues ──────────────────────────────────────────────
server.registerTool(
  'sentry_list_issues',
  {
    title: 'List Sentry Issues',
    description: 'List Sentry issues (errors). Supports Sentry search syntax in the query field (e.g. "is:unresolved level:error age:-1h").',
    inputSchema: z.object({
      project: z.string().optional().describe('Project slug (optional)'),
      query: z.string().optional().describe('Sentry search query (default: is:unresolved)'),
      sort: z.string().optional().describe('Sort order: date, new, priority, freq, user (default: date)'),
      limit: z.number().optional().describe('Max issues to return (default 25)'),
    }),
  },
  async (args = {}) => {
    try {
      const project = args.project || '';
      const query = args.query || 'is:unresolved';
      const sort = args.sort || 'date';
      let path = `/issues/?query=${encodeURIComponent(query)}&sort=${sort}&per_page=${args.limit || 25}`;
      if (project) path += `&project=${encodeURIComponent(project)}`;
      const data = await sentryFetch(path);
      const text = JSON.stringify({
        issues: data.map((i) => ({
          id: i.id, title: i.title, culprit: i.culprit,
          count: i.count, firstSeen: i.firstSeen, lastSeen: i.lastSeen,
          level: i.level, status: i.status,
        })),
      });
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

// ── sentry_get_issue ────────────────────────────────────────────────
server.registerTool(
  'sentry_get_issue',
  {
    title: 'Get Sentry Issue Details',
    description: 'Get details of a specific Sentry issue (culprit, metadata, userCount, etc).',
    inputSchema: z.object({
      issueId: z.string().describe('Sentry issue ID'),
    }),
  },
  async (args = {}) => {
    try {
      const { issueId } = args;
      if (!issueId) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'issueId is required' }) }], isError: true };
      }
      // Issue details hit /issues/<id>/ (NOT under /organizations/), so
      // we resolve just the token and build the URL directly.
      const { token } = await resolveIntegrationToken('sentry');
      const res = await fetch(`https://sentry.io/api/0/issues/${issueId}/`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        throw new Error(`Sentry API ${res.status}`);
      }
      const data = await res.json();
      const text = JSON.stringify({
        id: data.id, title: data.title, culprit: data.culprit,
        metadata: data.metadata, count: data.count, userCount: data.userCount,
        firstSeen: data.firstSeen, lastSeen: data.lastSeen,
        level: data.level, status: data.status,
        project: { slug: data.project?.slug, name: data.project?.name },
      });
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

// Tiny diagnostic line on stderr so operators can confirm the MCP
// server actually started. stdout is reserved for MCP JSON-RPC; only
// stderr is safe for human-readable logs.
console.error('[mcp-sentry] connected (3 tools: sentry_list_projects, sentry_list_issues, sentry_get_issue)');
