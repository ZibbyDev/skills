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
// Single source of truth for Sentry calls: the @zibby/skills package
// exports typed client functions. Both this MCP server and the
// assistant-strategy in-process path delegate to them, so adding a new
// Sentry endpoint = one edit in src/sentry.js, not three. Deterministic
// workflow nodes import the same functions for cost-optimized fetches
// that skip the LLM entirely.
import { sentryListProjects, sentryListIssues, sentryGetIssue, sentryUpdateIssue, sentryAddComment } from '../dist/sentry.js';

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
      const data = await sentryListProjects();
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
      const data = await sentryListIssues({
        query: args.query,
        sort: args.sort,
        project: args.project,
        limit: args.limit,
      });
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
      const data = await sentryGetIssue(args.issueId);
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

// ── sentry_update_issue ─────────────────────────────────────────────
server.registerTool(
  'sentry_update_issue',
  {
    title: 'Update Sentry Issue',
    description: "Update a Sentry issue's status (resolved | resolvedInNextRelease | unresolved | ignored | muted), assignment, or bookmark. Requires the connected Sentry integration to have the event:write scope.",
    inputSchema: z.object({
      issueId: z.string().describe('Sentry issue ID'),
      status: z.string().optional().describe('resolved | resolvedInNextRelease | unresolved | ignored | muted'),
      statusDetails: z.object({}).passthrough().optional().describe('Optional status details, e.g. { "inRelease": "latest" }'),
      assignedTo: z.string().optional().describe('Assignee actor id, e.g. "user:123" or "team:456"'),
      isBookmarked: z.boolean().optional().describe('Bookmark/unbookmark the issue'),
      hasSeen: z.boolean().optional().describe('Mark the issue seen/unseen'),
    }),
  },
  async (args = {}) => {
    try {
      const data = await sentryUpdateIssue(args.issueId, {
        status: args.status,
        statusDetails: args.statusDetails,
        assignedTo: args.assignedTo,
        isBookmarked: args.isBookmarked,
        hasSeen: args.hasSeen,
      });
      const text = JSON.stringify({
        ok: true, id: data.id ?? args.issueId, status: data.status,
        assignedTo: data.assignedTo, isBookmarked: data.isBookmarked,
      });
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

// ── sentry_add_comment ──────────────────────────────────────────────
server.registerTool(
  'sentry_add_comment',
  {
    title: 'Comment on a Sentry Issue',
    description: 'Post a comment/note on a Sentry issue. Requires the connected Sentry integration to have the event:write scope.',
    inputSchema: z.object({
      issueId: z.string().describe('Sentry issue ID'),
      text: z.string().describe('Comment body (markdown)'),
    }),
  },
  async (args = {}) => {
    try {
      const data = await sentryAddComment(args.issueId, args.text);
      const text = JSON.stringify({ ok: true, id: data.id, issueId: args.issueId });
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
console.error('[mcp-sentry] connected (5 tools: sentry_list_projects, sentry_list_issues, sentry_get_issue, sentry_update_issue, sentry_add_comment)');
