import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve as resolvePath } from 'path';
import { resolveIntegrationToken } from '@zibby/core/backend-client.js';
import { INTEGRATIONS } from './integrations.js';

/**
 * Resolve the path to the bundled MCP server binary. Override via
 * MCP_SLACK_PATH for development. Returns null when the binary can't
 * be found — strategy treats that as "no MCP server" and falls back
 * to the in-process handleToolCall path (assistant agent only).
 *
 * Same resolution dance as resolveLarkBin / resolveSentryBin — see
 * comment in lark.js for the esbuild + dist/package.json subtlety.
 */
function resolveSlackBin() {
  if (process.env.MCP_SLACK_PATH) return process.env.MCP_SLACK_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-slack.mjs');
  return existsSync(candidate) ? candidate : null;
}

async function slackApi(method, params = {}) {
  const { token } = await resolveIntegrationToken('slack');
  const isGet = [
    'conversations.list',
    'users.list',
    'users.profile.get',
    'users.lookupByEmail',
    'usergroups.list',
    'usergroups.users.list',
    'conversations.history',
    'conversations.replies',
  ].includes(method);
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

export const slackSkill = {
  id: 'slack',
  serverName: 'slack',
  allowedTools: ['mcp__slack__*'],
  requiresIntegration: INTEGRATIONS.SLACK, // see sentrySkill.requiresIntegration for semantics
  envKeys: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
  description: 'Slack MCP Server',

  promptFragment: `## Slack (connected)
You have access to the user's Slack workspace. Use these tools:
- slack_list_channels, slack_post_message, slack_reply_to_thread
- slack_add_reaction, slack_get_channel_history, slack_get_thread_replies
- slack_get_users, slack_get_user_profile
- slack_lookup_user_by_email (precise email→user_id, prefer this over scanning slack_get_users)
- slack_list_usergroups, slack_get_usergroup_members (workspace-defined teams like @oncall, @platform)`,

  /**
   * MCP-style agents (Claude Code / Cursor / Codex / Gemini) call
   * this. Returns the spawn spec for our self-contained MCP binary
   * (bin/mcp-slack.mjs) — replaces the previous
   * `@modelcontextprotocol/server-slack@latest` so we can expose
   * the extra routing tools (lookupByEmail, usergroups, search).
   *
   * Returns null when the binary can't be found (e.g. running
   * outside a node_modules layout) — agent strategy falls back to
   * its built-in tools; the in-process path keeps working for the
   * `assistant` agent via handleToolCall.
   */
  resolve() {
    const bin = resolveSlackBin();
    if (!bin) return null;
    const env = {};
    // Pass through env the MCP server needs to call the backend's
    // resolveIntegrationToken endpoint. Explicit allow-list (mirrors
    // larkSkill / sentrySkill) — keeps secrets scoped.
    // See sentry.js for the full rationale: ZIBBY_ACCOUNT_API_URL + ZIBBY_ENV
    // let the MCP stdio child resolve integration tokens through the same
    // endpoint the in-process path uses. Without them a local/dev task falls
    // back to api-prod and every slack_* call 401s — so dispatch can't post.
    for (const k of ['PROJECT_API_TOKEN', 'ZIBBY_USER_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_ENV', 'ZIBBY_PROD_ACCOUNT_API_URL', 'PROGRESS_API_URL', 'EXECUTION_ID', 'PROJECT_ID', 'STAGE']) {
      if (process.env[k]) env[k] = process.env[k];
    }
    // Legacy env vars that may still get injected by older infra —
    // forward harmlessly so an old workflow runner doesn't suddenly
    // start failing post-switch.
    for (const k of this.envKeys) {
      if (process.env[k]) env[k] = process.env[k];
    }
    return {
      type: 'stdio',
      command: 'node',
      args: [bin],
      env,
      // Same `alwaysLoad: true` as larkSkill / sentrySkill. Forces
      // MCP tools into the initial prompt; without it they sit
      // behind ToolSearch where the LLM keyword search misses them.
      alwaysLoad: true,
    };
  },

  async handleToolCall(name, args) {
    try {
      switch (name) {
        case 'slack_list_channels': {
          const data = await slackApi('conversations.list', { types: 'public_channel', limit: 100 });
          return JSON.stringify({ channels: (data.channels || []).map(c => ({ id: c.id, name: c.name, topic: c.topic?.value })) });
        }
        case 'slack_post_message': {
          if (!args.channel || !args.text) return JSON.stringify({ error: 'channel and text are required' });
          // text is required as the notification/fallback string; blocks (Block
          // Kit) is optional and renders the rich card when present.
          const data = await slackApi('chat.postMessage', {
            channel: args.channel,
            text: args.text,
            ...(args.blocks ? { blocks: args.blocks } : {}),
          });
          return JSON.stringify({ ok: true, ts: data.ts, channel: data.channel });
        }
        case 'slack_reply_to_thread': {
          if (!args.channel || !args.thread_ts || !args.text) return JSON.stringify({ error: 'channel, thread_ts, and text are required' });
          const data = await slackApi('chat.postMessage', { channel: args.channel, thread_ts: args.thread_ts, text: args.text });
          return JSON.stringify({ ok: true, ts: data.ts });
        }
        case 'slack_add_reaction': {
          if (!args.channel || !args.timestamp || !args.reaction) return JSON.stringify({ error: 'channel, timestamp, and reaction are required' });
          await slackApi('reactions.add', { channel: args.channel, timestamp: args.timestamp, name: args.reaction });
          return JSON.stringify({ ok: true });
        }
        case 'slack_get_channel_history': {
          if (!args.channel) return JSON.stringify({ error: 'channel is required' });
          const data = await slackApi('conversations.history', { channel: args.channel, limit: args.limit || 20 });
          return JSON.stringify({ messages: (data.messages || []).map(m => ({ user: m.user, text: m.text, ts: m.ts })) });
        }
        case 'slack_get_thread_replies': {
          if (!args.channel || !args.thread_ts) return JSON.stringify({ error: 'channel and thread_ts are required' });
          const data = await slackApi('conversations.replies', { channel: args.channel, ts: args.thread_ts });
          return JSON.stringify({ messages: (data.messages || []).map(m => ({ user: m.user, text: m.text, ts: m.ts })) });
        }
        case 'slack_get_users': {
          const data = await slackApi('users.list', { limit: 100 });
          return JSON.stringify({ users: (data.members || []).filter(u => !u.is_bot && !u.deleted).map(u => ({ id: u.id, name: u.real_name || u.name })) });
        }
        case 'slack_get_user_profile': {
          if (!args.user_id) return JSON.stringify({ error: 'user_id is required' });
          const data = await slackApi('users.profile.get', { user: args.user_id });
          return JSON.stringify({ profile: data.profile });
        }
        case 'slack_lookup_user_by_email': {
          // Wraps users.lookupByEmail. Exact match — avoids the agent
          // having to scan `users.list` to find someone by email, which
          // is both slow (paginated) and noisy in the agent's context.
          // Returns { user: { id, name, email } } on hit, { ok:false } on
          // miss so the agent can branch on "not found" without an
          // exception. Slack returns `users_not_found` as a JSON error,
          // which our slackApi wrapper throws — catch that one case.
          if (!args.email) return JSON.stringify({ error: 'email is required' });
          try {
            const data = await slackApi('users.lookupByEmail', { email: args.email });
            return JSON.stringify({
              ok: true,
              user: {
                id: data.user?.id,
                name: data.user?.real_name || data.user?.name,
                email: data.user?.profile?.email || args.email,
              },
            });
          } catch (e) {
            if (/users_not_found/.test(e.message)) {
              return JSON.stringify({ ok: false, reason: 'users_not_found' });
            }
            throw e;
          }
        }
        case 'slack_list_usergroups': {
          // Workspace-defined groups (e.g. @oncall, @platform). Returns
          // handle ("oncall") + id ("S012ABC") + user_count so the agent
          // can pick by name without expanding members upfront.
          const data = await slackApi('usergroups.list', {});
          return JSON.stringify({
            usergroups: (data.usergroups || []).map((g) => ({
              id: g.id,
              handle: g.handle,
              name: g.name,
              description: g.description || '',
              user_count: Number(g.user_count || 0),
            })),
          });
        }
        case 'slack_get_usergroup_members': {
          // Expands a usergroup id (S012ABC) into its current user IDs.
          // Caller uses these as `channel` values for slack_post_message
          // to DM each member individually, OR mentions the group as
          // <!subteam^S012ABC|@handle> inside a channel message.
          if (!args.usergroup) return JSON.stringify({ error: 'usergroup id is required' });
          const data = await slackApi('usergroups.users.list', { usergroup: args.usergroup });
          return JSON.stringify({ users: data.users || [] });
        }
        case 'slack_search_users': {
          // Slack has no native "search by name" — `users.list` is the
          // closest thing. Paginated; we cap at ~5 pages (1000 users) to
          // keep latency bounded on big workspaces. Match is a simple
          // case-insensitive substring against real_name + display_name
          // + name, scored by which field hit (real_name > display_name
          // > name). Returns top `limit` matches (default 5) with id +
          // canonical name + email so the dispatch agent can pick one.
          if (!args.query || typeof args.query !== 'string') {
            return JSON.stringify({ error: 'query is required' });
          }
          const q = args.query.trim().toLowerCase();
          if (!q) return JSON.stringify({ ok: true, matches: [] });
          const limit = Math.max(1, Math.min(Number(args.limit) || 5, 25));
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
            if (realName === q || displayName === q) score += 200; // exact match wins
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
          return JSON.stringify({
            ok: true,
            matches: matches.slice(0, limit).map(({ _score, ...m }) => m),
            scanned: all.length,
          });
        }
        default:
          return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  },

  tools: [
    { name: 'slack_list_channels', description: 'List public channels in the workspace', input_schema: { type: 'object', properties: {} } },
    {
      name: 'slack_post_message', description: 'Post a message to a Slack channel or DM. Pass `blocks` (Block Kit) for a rich card; `text` is the required notification fallback.',
      input_schema: { type: 'object', properties: { channel: { type: 'string', description: 'Channel ID or name' }, text: { type: 'string', description: 'Notification/fallback text (required)' }, blocks: { type: 'array', description: 'Block Kit blocks for rich formatting (optional). Each block is a Slack Block Kit object (header/section/divider/context). section blocks may carry a button accessory with a url.' } }, required: ['channel', 'text'] },
    },
    {
      name: 'slack_reply_to_thread', description: 'Reply to a specific message thread',
      input_schema: { type: 'object', properties: { channel: { type: 'string', description: 'Channel ID' }, thread_ts: { type: 'string', description: 'Thread timestamp' }, text: { type: 'string', description: 'Reply text' } }, required: ['channel', 'thread_ts', 'text'] },
    },
    {
      name: 'slack_add_reaction', description: 'Add an emoji reaction to a message',
      input_schema: { type: 'object', properties: { channel: { type: 'string', description: 'Channel ID' }, timestamp: { type: 'string', description: 'Message timestamp' }, reaction: { type: 'string', description: 'Emoji name without colons' } }, required: ['channel', 'timestamp', 'reaction'] },
    },
    {
      name: 'slack_get_channel_history', description: 'Get recent messages from a channel',
      input_schema: { type: 'object', properties: { channel: { type: 'string', description: 'Channel ID' }, limit: { type: 'number', description: 'Number of messages' } }, required: ['channel'] },
    },
    {
      name: 'slack_get_thread_replies', description: 'Get all replies in a message thread',
      input_schema: { type: 'object', properties: { channel: { type: 'string', description: 'Channel ID' }, thread_ts: { type: 'string', description: 'Thread timestamp' } }, required: ['channel', 'thread_ts'] },
    },
    { name: 'slack_get_users', description: 'List workspace users with basic profiles', input_schema: { type: 'object', properties: {} } },
    {
      name: 'slack_get_user_profile', description: 'Get detailed profile for a specific user',
      input_schema: { type: 'object', properties: { user_id: { type: 'string', description: 'Slack user ID' } }, required: ['user_id'] },
    },
    {
      name: 'slack_lookup_user_by_email',
      description: 'Find a Slack user by email. Returns { ok:true, user:{id,name,email} } on hit, { ok:false } when no user has that email. Prefer this over slack_get_users for email-based routing — single API call, exact match.',
      input_schema: { type: 'object', properties: { email: { type: 'string', description: 'Email address to look up' } }, required: ['email'] },
    },
    {
      name: 'slack_list_usergroups',
      description: 'List workspace-defined user groups (e.g. @oncall, @platform). Each item has { id, handle, name, description, user_count }. Use the id with slack_get_usergroup_members to expand the membership.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'slack_get_usergroup_members',
      description: 'List user IDs that belong to a Slack usergroup. Pair with slack_post_message to DM each member, or use the group id directly in a channel message as <!subteam^ID> to @-mention.',
      input_schema: { type: 'object', properties: { usergroup: { type: 'string', description: 'Usergroup id, e.g. S012ABC' } }, required: ['usergroup'] },
    },
    {
      name: 'slack_search_users',
      description: 'Fuzzy-search workspace users by display name or real name. Use when the user said something like "send to Sam" without an email. Returns up to `limit` ranked matches { id, name, email }. Slack has no native name-search API — this scans paginated users.list + does substring scoring (real_name > display_name > name). For large workspaces consider higher limit + ask the user to confirm if multiple hit.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Substring to match against names (case-insensitive)' },
          limit: { type: 'number', description: 'Max matches to return (default 5, max 25)' },
        },
        required: ['query'],
      },
    },
  ],
};
