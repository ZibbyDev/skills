import { resolveIntegrationToken } from '@zibby/core/backend-client.js';
import { INTEGRATIONS } from './integrations.js';

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

  resolve() {
    const env = {};
    for (const key of this.envKeys) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return { command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack@latest'], env };
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
          const data = await slackApi('chat.postMessage', { channel: args.channel, text: args.text });
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
      name: 'slack_post_message', description: 'Post a message to a Slack channel or DM',
      input_schema: { type: 'object', properties: { channel: { type: 'string', description: 'Channel ID or name' }, text: { type: 'string', description: 'Message text' } }, required: ['channel', 'text'] },
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
  ],
};
