#!/usr/bin/env node
/**
 * Zibby Lark / Feishu MCP Server — standalone stdio MCP binary.
 *
 * Mirrors @zibby/mcp-browser + bin/mcp-sentry.mjs: self-contained
 * MCP server that exposes Lark messaging tools to any MCP client
 * (Claude Code, Cursor, Codex, Gemini). Skill's `resolve()` spawns
 * this binary; everything else runs inside the spawned process.
 *
 * Auth: reads PROJECT_API_TOKEN + PROGRESS_API_URL + EXECUTION_ID
 * + PROJECT_ID + STAGE from the inherited env. The backend's
 * resolveIntegrationToken('lark') endpoint returns appId + appSecret;
 * we exchange those for a tenant_access_token cached locally (~2h TTL).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolveIntegrationToken } from '@zibby/core/backend-client.js';

// Lark's tenant_access_token TTL is ~2h. Cache slightly under that —
// keeps the MCP server alive across multiple tool calls without
// re-fetching from Lark every time.
const TOKEN_TTL_MS = 100 * 60 * 1000;
let tokenCache = null;

async function getTenantAccessToken() {
  const { appId, appSecret, host } = await resolveIntegrationToken('lark');
  if (tokenCache && tokenCache.appId === appId && tokenCache.expiresAt > Date.now()) {
    return { token: tokenCache.token, host };
  }
  const res = await fetch(`${host}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`Lark tenant_access_token failed: ${data.msg || data.code}`);
  }
  tokenCache = { token: data.tenant_access_token, expiresAt: Date.now() + TOKEN_TTL_MS, appId };
  return { token: data.tenant_access_token, host };
}

async function larkApi(method, path, params = {}) {
  const { token, host } = await getTenantAccessToken();
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
  };
  if (method !== 'GET') init.body = JSON.stringify(params);
  const res = await fetch(`${host}${path}`, init);
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`Lark API ${path} error: ${data.msg || data.code}`);
  }
  return data.data || {};
}

function textContent(text) {
  return JSON.stringify({ text });
}

// receive_id_type required by Lark; inferred from the id prefix.
//   oc_* → chat_id, ou_* → open_id, on_* → union_id, cli_* → app_id,
//   email-looking → email, else chat_id (most common bot target).
function inferReceiveIdType(id) {
  if (!id || typeof id !== 'string') return 'chat_id';
  if (id.startsWith('oc_')) return 'chat_id';
  if (id.startsWith('ou_')) return 'open_id';
  if (id.startsWith('on_')) return 'union_id';
  if (id.startsWith('cli_')) return 'app_id';
  if (id.includes('@')) return 'email';
  return 'chat_id';
}

const server = new McpServer(
  { name: 'zibby-lark', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

// ── lark_send_message ──────────────────────────────────────────────
server.registerTool(
  'lark_send_message',
  {
    title: 'Send Lark Message',
    description: 'Send a text message to a Lark chat, user, or DM. receive_id can be a chat_id (oc_*), open_id (ou_*), union_id (on_*), or email.',
    inputSchema: z.object({
      receive_id: z.string().describe('Target id: chat_id (oc_*), open_id (ou_*), union_id (on_*), or email'),
      text: z.string().describe('Message text'),
    }),
  },
  async (args = {}) => {
    try {
      if (!args.receive_id || !args.text) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'receive_id and text are required' }) }], isError: true };
      }
      const receiveIdType = inferReceiveIdType(args.receive_id);
      const data = await larkApi(
        'POST',
        `/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
        { receive_id: args.receive_id, msg_type: 'text', content: textContent(args.text) },
      );
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, message_id: data.message_id }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

// ── lark_reply ─────────────────────────────────────────────────────
server.registerTool(
  'lark_reply',
  {
    title: 'Reply to Lark Message',
    description: 'Reply to an existing Lark message (creates a thread). Use the message_id from the inbound event.',
    inputSchema: z.object({
      message_id: z.string().describe('Lark message id (om_*) to reply to'),
      text: z.string().describe('Reply text'),
    }),
  },
  async (args = {}) => {
    try {
      if (!args.message_id || !args.text) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'message_id and text are required' }) }], isError: true };
      }
      const data = await larkApi(
        'POST',
        `/open-apis/im/v1/messages/${encodeURIComponent(args.message_id)}/reply`,
        { msg_type: 'text', content: textContent(args.text) },
      );
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, message_id: data.message_id }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

// ── lark_list_chats ────────────────────────────────────────────────
server.registerTool(
  'lark_list_chats',
  {
    title: 'List Lark Chats',
    description: 'List chats (groups + DMs) the bot is a member of.',
    inputSchema: z.object({
      page_size: z.number().optional().describe('Max results (default 50)'),
    }),
  },
  async (args = {}) => {
    try {
      const pageSize = args.page_size || 50;
      const data = await larkApi('GET', `/open-apis/im/v1/chats?page_size=${pageSize}`);
      const chats = (data.items || []).map((c) => ({
        chat_id: c.chat_id,
        name: c.name,
        description: c.description,
        owner_id: c.owner_id,
        chat_mode: c.chat_mode,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ chats }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

// ── lark_get_chat_history ──────────────────────────────────────────
server.registerTool(
  'lark_get_chat_history',
  {
    title: 'Get Lark Chat History',
    description: 'Fetch recent messages in a chat.',
    inputSchema: z.object({
      chat_id: z.string().describe('Chat id (oc_*)'),
      page_size: z.number().optional().describe('Max messages (default 20)'),
    }),
  },
  async (args = {}) => {
    try {
      if (!args.chat_id) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'chat_id is required' }) }], isError: true };
      }
      const pageSize = args.page_size || 20;
      const data = await larkApi(
        'GET',
        `/open-apis/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(args.chat_id)}&page_size=${pageSize}&sort_type=ByCreateTimeDesc`,
      );
      const messages = (data.items || []).map((m) => ({
        message_id: m.message_id,
        sender_id: m.sender?.id,
        sender_type: m.sender?.sender_type,
        msg_type: m.msg_type,
        content: m.body?.content,
        create_time: m.create_time,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ messages }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

// ── lark_lookup_user_by_email ──────────────────────────────────────
server.registerTool(
  'lark_lookup_user_by_email',
  {
    title: 'Find Lark User by Email',
    description: 'Resolve a Lark user from their email. Returns { ok:true, user:{open_id,email,name} } on hit, { ok:false } on miss. Use the open_id as `receive_id` in lark_send_message to DM.',
    inputSchema: z.object({
      email: z.string().describe('Email address to look up'),
    }),
  },
  async (args = {}) => {
    try {
      if (!args.email) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'email is required' }) }], isError: true };
      }
      const data = await larkApi(
        'POST',
        '/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id',
        { emails: [args.email] },
      );
      const hit = (data.user_list || []).find((u) => u.email === args.email && u.user_id);
      if (!hit) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'no_lark_user_for_email' }) }] };
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            user: { open_id: hit.user_id, email: hit.email, name: hit.name || undefined },
          }),
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

// ── lark_search_users ──────────────────────────────────────────────
server.registerTool(
  'lark_search_users',
  {
    title: 'Search Lark Users by Name',
    description: 'Fuzzy-search users by name across chats the bot is a member of. Lark has no public org-wide user search API for bots — this walks chat memberships and matches names client-side. Best for "send to Sam" style routing where you have a name but no email. Only users in chats with the bot are reachable.',
    inputSchema: z.object({
      query: z.string().describe('Substring to match against user names (case-insensitive)'),
      limit: z.number().optional().describe('Max matches to return (default 5, max 25)'),
    }),
  },
  async (args = {}) => {
    try {
      if (!args.query || typeof args.query !== 'string') {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'query is required' }) }], isError: true };
      }
      const q = args.query.trim().toLowerCase();
      if (!q) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, matches: [] }) }] };
      }
      const limit = Math.max(1, Math.min(Number(args.limit) || 5, 25));
      const MAX_USERS = 200;

      const chatRes = await larkApi('GET', '/open-apis/im/v1/chats?page_size=100');
      const chatIds = (chatRes.items || []).map((c) => c.chat_id);

      const seen = new Set();
      const candidates = [];
      for (const chatId of chatIds) {
        if (candidates.length >= MAX_USERS) break;
        try {
          const members = await larkApi(
            'GET',
            `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members?member_id_type=open_id&page_size=100`,
          );
          for (const m of members.items || []) {
            if (!m.member_id || seen.has(m.member_id)) continue;
            seen.add(m.member_id);
            candidates.push({ open_id: m.member_id, name: m.name || '' });
            if (candidates.length >= MAX_USERS) break;
          }
        } catch (e) {
          console.error(`[mcp-lark] member scan failed for ${chatId}: ${e.message}`);
        }
      }

      const matches = [];
      for (const c of candidates) {
        const name = (c.name || '').toLowerCase();
        if (!name) continue;
        let score = 0;
        if (name.includes(q))    score += 100 - Math.abs(name.length - q.length);
        if (name === q)          score += 200;
        if (score > 0) matches.push({ open_id: c.open_id, name: c.name, _score: score });
      }
      matches.sort((a, b) => b._score - a._score);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            matches: matches.slice(0, limit).map(({ _score, ...m }) => m),
            scanned: candidates.length,
          }),
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error('[mcp-lark] connected (6 tools: lark_send_message, lark_reply, lark_list_chats, lark_get_chat_history, lark_lookup_user_by_email, lark_search_users)');
