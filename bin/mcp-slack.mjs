#!/usr/bin/env node
/**
 * Zibby Slack MCP Server — standalone stdio MCP binary.
 *
 * Mirrors bin/mcp-lark.mjs + bin/mcp-sentry.mjs: self-contained MCP
 * server that exposes Slack tools to any MCP client (Claude Code,
 * Cursor, Codex, Gemini). Skill's `resolve()` spawns this binary;
 * everything else runs inside the spawned process.
 *
 * Why we ship our own instead of using
 * `@modelcontextprotocol/server-slack`:
 *   1. We need workspace-defined usergroups (@oncall, @platform) for
 *      routing — stock server-slack doesn't expose them.
 *   2. We need users.lookupByEmail + a name-based fuzzy search for
 *      "send to Sam" style dispatch rules — stock server-slack only
 *      has users.list which the agent has to scan client-side every
 *      single call.
 *   3. Single source of truth: in-process callers and MCP agents
 *      share the same tool surface (src/slack.js mirrors this file's
 *      tool set 1:1).
 *
 * Auth: reads PROJECT_API_TOKEN + PROGRESS_API_URL + EXECUTION_ID +
 * PROJECT_ID + STAGE from the inherited env. The backend's
 * resolveIntegrationToken('slack') endpoint returns the workspace
 * bot token (xoxb-…); we cache it process-locally for the lifetime
 * of the MCP server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolveIntegrationToken } from '@zibby/core/backend-client.js';

// Cache the bot token for the life of the MCP server process. Slack
// bot tokens don't expire, but each call to resolveIntegrationToken
// is a backend round-trip — cache once so 10 tool calls per
// dispatch run = 1 token fetch.
let cachedToken = null;
async function getSlackToken() {
  if (cachedToken) return cachedToken;
  const { token } = await resolveIntegrationToken('slack');
  cachedToken = token;
  return token;
}

// Slack API endpoints that expect GET (query string) vs POST (JSON
// body). conversations.* and users.* are split across both — keep
// this list aligned with src/slack.js to avoid divergence.
const GET_METHODS = new Set([
  'conversations.list',
  'conversations.history',
  'conversations.replies',
  'users.list',
  'users.profile.get',
  'users.lookupByEmail',
  'usergroups.list',
  'usergroups.users.list',
]);

async function slackApi(method, params = {}) {
  const token = await getSlackToken();
  const isGet = GET_METHODS.has(method);
  let url = `https://slack.com/api/${method}`;
  const headers = { Authorization: `Bearer ${token}` };
  let body;
  if (isGet) {
    const qs = new URLSearchParams(params).toString();
    if (qs) url += `?${qs}`;
  } else {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    body = JSON.stringify(params);
  }
  const res = await fetch(url, { method: isGet ? 'GET' : 'POST', headers, body });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
  return data;
}

// Helper — every handler wraps its JSON result in this shape so MCP
// emits a single text content block. Errors flip isError so the
// caller (agent) can short-circuit on them cleanly.
function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}
function err(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

const server = new McpServer(
  { name: 'zibby-slack', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

// ── slack_list_channels ───────────────────────────────────────────
server.registerTool(
  'slack_list_channels',
  {
    title: 'List Slack Channels',
    description: 'List public channels in the workspace.',
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const data = await slackApi('conversations.list', { types: 'public_channel', limit: 100 });
      return ok({
        channels: (data.channels || []).map((c) => ({
          id: c.id,
          name: c.name,
          topic: c.topic?.value,
        })),
      });
    } catch (e) { return err(e.message); }
  },
);

// ── slack_post_message ────────────────────────────────────────────
server.registerTool(
  'slack_post_message',
  {
    title: 'Post Slack Message',
    description: 'Post a message to a Slack channel OR direct-message a user. `channel` accepts a channel id (C…), a channel name with `#` prefix, OR a user id (U…) for DMs. Pass `blocks` (Block Kit) for a rich card; `text` is the required notification fallback.',
    inputSchema: z.object({
      channel: z.string().describe('Channel id, channel name (#…), or user id (U…) for DMs'),
      text: z.string().describe('Notification/fallback text (required even when blocks are sent)'),
      blocks: z.array(z.any()).optional().describe('Block Kit blocks for a rich card (optional). header / section / divider / context; a section may carry a button accessory with a url.'),
    }),
  },
  async (args = {}) => {
    try {
      if (!args.channel || !args.text) return err('channel and text are required');
      const data = await slackApi('chat.postMessage', {
        channel: args.channel,
        text: args.text,
        ...(args.blocks ? { blocks: args.blocks } : {}),
      });
      return ok({ ok: true, ts: data.ts, channel: data.channel });
    } catch (e) { return err(e.message); }
  },
);

// ── slack_reply_to_thread ─────────────────────────────────────────
server.registerTool(
  'slack_reply_to_thread',
  {
    title: 'Reply in Slack Thread',
    description: 'Reply to a specific message thread.',
    inputSchema: z.object({
      channel: z.string().describe('Channel id'),
      thread_ts: z.string().describe('Thread timestamp'),
      text: z.string().describe('Reply text'),
    }),
  },
  async (args = {}) => {
    try {
      if (!args.channel || !args.thread_ts || !args.text) return err('channel, thread_ts, and text are required');
      const data = await slackApi('chat.postMessage', { channel: args.channel, thread_ts: args.thread_ts, text: args.text });
      return ok({ ok: true, ts: data.ts });
    } catch (e) { return err(e.message); }
  },
);

// ── slack_add_reaction ────────────────────────────────────────────
server.registerTool(
  'slack_add_reaction',
  {
    title: 'Add Slack Reaction',
    description: 'Add an emoji reaction to a message.',
    inputSchema: z.object({
      channel: z.string().describe('Channel id'),
      timestamp: z.string().describe('Message timestamp'),
      reaction: z.string().describe('Emoji name without colons'),
    }),
  },
  async (args = {}) => {
    try {
      if (!args.channel || !args.timestamp || !args.reaction) return err('channel, timestamp, and reaction are required');
      await slackApi('reactions.add', { channel: args.channel, timestamp: args.timestamp, name: args.reaction });
      return ok({ ok: true });
    } catch (e) { return err(e.message); }
  },
);

// ── slack_get_channel_history ─────────────────────────────────────
server.registerTool(
  'slack_get_channel_history',
  {
    title: 'Get Slack Channel History',
    description: 'Get recent messages from a channel.',
    inputSchema: z.object({
      channel: z.string().describe('Channel id'),
      limit: z.number().optional().describe('Number of messages (default 20)'),
    }),
  },
  async (args = {}) => {
    try {
      if (!args.channel) return err('channel is required');
      const data = await slackApi('conversations.history', { channel: args.channel, limit: args.limit || 20 });
      return ok({
        messages: (data.messages || []).map((m) => ({ user: m.user, text: m.text, ts: m.ts })),
      });
    } catch (e) { return err(e.message); }
  },
);

// ── slack_get_thread_replies ──────────────────────────────────────
server.registerTool(
  'slack_get_thread_replies',
  {
    title: 'Get Slack Thread Replies',
    description: 'Get all replies in a message thread.',
    inputSchema: z.object({
      channel: z.string().describe('Channel id'),
      thread_ts: z.string().describe('Thread timestamp'),
    }),
  },
  async (args = {}) => {
    try {
      if (!args.channel || !args.thread_ts) return err('channel and thread_ts are required');
      const data = await slackApi('conversations.replies', { channel: args.channel, ts: args.thread_ts });
      return ok({
        messages: (data.messages || []).map((m) => ({ user: m.user, text: m.text, ts: m.ts })),
      });
    } catch (e) { return err(e.message); }
  },
);

// ── slack_get_users ───────────────────────────────────────────────
server.registerTool(
  'slack_get_users',
  {
    title: 'List Slack Users',
    description: 'List workspace users with basic profiles. Use slack_search_users for fuzzy name matching or slack_lookup_user_by_email for exact email match — those are usually what you actually want.',
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const data = await slackApi('users.list', { limit: 100 });
      return ok({
        users: (data.members || [])
          .filter((u) => !u.is_bot && !u.deleted)
          .map((u) => ({ id: u.id, name: u.real_name || u.name })),
      });
    } catch (e) { return err(e.message); }
  },
);

// ── slack_get_user_profile ────────────────────────────────────────
server.registerTool(
  'slack_get_user_profile',
  {
    title: 'Get Slack User Profile',
    description: 'Get detailed profile for a specific user.',
    inputSchema: z.object({
      user_id: z.string().describe('Slack user id'),
    }),
  },
  async (args = {}) => {
    try {
      if (!args.user_id) return err('user_id is required');
      const data = await slackApi('users.profile.get', { user: args.user_id });
      return ok({ profile: data.profile });
    } catch (e) { return err(e.message); }
  },
);

// ── slack_lookup_user_by_email ────────────────────────────────────
server.registerTool(
  'slack_lookup_user_by_email',
  {
    title: 'Find Slack User by Email',
    description: 'Resolve a Slack user from their email address. Returns { ok:true, user:{id,name,email} } on hit, { ok:false } on miss (no exception — branch on `ok`). Prefer this over scanning slack_get_users / slack_search_users when you already have an exact email.',
    inputSchema: z.object({
      email: z.string().describe('Email address to look up'),
    }),
  },
  async (args = {}) => {
    try {
      if (!args.email) return err('email is required');
      try {
        const data = await slackApi('users.lookupByEmail', { email: args.email });
        return ok({
          ok: true,
          user: {
            id: data.user?.id,
            name: data.user?.real_name || data.user?.name,
            email: data.user?.profile?.email || args.email,
          },
        });
      } catch (e) {
        if (/users_not_found/.test(e.message)) {
          return ok({ ok: false, reason: 'users_not_found' });
        }
        throw e;
      }
    } catch (e) { return err(e.message); }
  },
);

// ── slack_list_usergroups ─────────────────────────────────────────
server.registerTool(
  'slack_list_usergroups',
  {
    title: 'List Slack Usergroups',
    description: 'List workspace-defined user groups (e.g. @oncall, @platform). Each item has { id, handle, name, description, user_count }. Use the id with slack_get_usergroup_members to expand the membership, OR mention as <!subteam^ID> in a channel message.',
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const data = await slackApi('usergroups.list', {});
      return ok({
        usergroups: (data.usergroups || []).map((g) => ({
          id: g.id,
          handle: g.handle,
          name: g.name,
          description: g.description || '',
          user_count: Number(g.user_count || 0),
        })),
      });
    } catch (e) { return err(e.message); }
  },
);

// ── slack_get_usergroup_members ───────────────────────────────────
server.registerTool(
  'slack_get_usergroup_members',
  {
    title: 'List Slack Usergroup Members',
    description: 'List user ids that belong to a Slack usergroup. Pair with slack_post_message to DM each member, or use the group id directly in a channel message as <!subteam^ID> to @-mention.',
    inputSchema: z.object({
      usergroup: z.string().describe('Usergroup id, e.g. S012ABC'),
    }),
  },
  async (args = {}) => {
    try {
      if (!args.usergroup) return err('usergroup id is required');
      const data = await slackApi('usergroups.users.list', { usergroup: args.usergroup });
      return ok({ users: data.users || [] });
    } catch (e) { return err(e.message); }
  },
);

// ── slack_search_users ────────────────────────────────────────────
server.registerTool(
  'slack_search_users',
  {
    title: 'Search Slack Users by Name',
    description: 'Fuzzy-search workspace users by display name or real name. Use when the user said something like "send to Sam" without an email. Returns up to `limit` ranked matches { id, name, email }. Slack has no native name-search API — this scans paginated users.list + does substring scoring (real_name > display_name > name). For ambiguous results consider asking the user to confirm.',
    inputSchema: z.object({
      query: z.string().describe('Substring to match against names (case-insensitive)'),
      limit: z.number().optional().describe('Max matches to return (default 5, max 25)'),
    }),
  },
  async (args = {}) => {
    try {
      if (!args.query || typeof args.query !== 'string') return err('query is required');
      const q = args.query.trim().toLowerCase();
      if (!q) return ok({ ok: true, matches: [] });
      const limit = Math.max(1, Math.min(Number(args.limit) || 5, 25));

      // Paginate up to 5 pages × 200 users = 1000 cap. Workspaces with
      // 10k+ users will miss the long tail — recommend lookupByEmail
      // there, but keep this useful for the common 50-500 user case.
      const all = [];
      let cursor;
      const MAX_PAGES = 5;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const params = { limit: 200 };
        if (cursor) params.cursor = cursor;
        const data = await slackApi('users.list', params);
        for (const u of data.members || []) {
          if (u.deleted || u.is_bot) continue;
          all.push(u);
        }
        cursor = data.response_metadata?.next_cursor;
        if (!cursor) break;
      }
      const matches = [];
      for (const u of all) {
        const realName    = (u.real_name || '').toLowerCase();
        const displayName = (u.profile?.display_name || '').toLowerCase();
        const name        = (u.name || '').toLowerCase();
        let score = 0;
        if (realName.includes(q))    score += 100 - Math.abs(realName.length - q.length);
        if (displayName.includes(q)) score += 60  - Math.abs(displayName.length - q.length);
        if (name.includes(q))        score += 30  - Math.abs(name.length - q.length);
        if (realName === q || displayName === q) score += 200;
        if (score > 0) {
          matches.push({
            id: u.id,
            name: u.real_name || u.profile?.display_name || u.name,
            email: u.profile?.email || undefined,
            _score: score,
          });
        }
      }
      matches.sort((a, b) => b._score - a._score);
      return ok({
        ok: true,
        matches: matches.slice(0, limit).map(({ _score, ...m }) => m),
        scanned: all.length,
      });
    } catch (e) { return err(e.message); }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error('[mcp-slack] connected (12 tools)');
