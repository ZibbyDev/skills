import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve as resolvePath } from 'path';
import { resolveIntegrationToken } from '@zibby/core/backend-client.js';
import { INTEGRATIONS } from './integrations.js';

/**
 * Resolve the path to the bundled MCP server binary. Override via
 * MCP_LARK_PATH for development. Returns null when the binary can't
 * be found — strategy treats that as "no MCP server" and falls back
 * to the in-process handleToolCall path (assistant agent only).
 *
 * Path derived from `import.meta.url` (not `require.resolve(self-ref)`)
 * — see the long comment in sentry.js's `resolveSentryBin` for why.
 * tl;dr: esbuild emits a `dist/package.json` that makes self-references
 * resolve to `dist/bin/...` (wrong) instead of `bin/...` (correct).
 */
function resolveLarkBin() {
  if (process.env.MCP_LARK_PATH) return process.env.MCP_LARK_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-lark.mjs');
  return existsSync(candidate) ? candidate : null;
}

// Lark's tenant_access_token TTL is ~2h. Cache slightly under that.
const TOKEN_TTL_MS = 100 * 60 * 1000;
let tokenCache = null; // { token, expiresAt, appId }

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
  tokenCache = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + TOKEN_TTL_MS,
    appId,
  };
  return { token: data.tenant_access_token, host };
}

async function larkApi(method, path, params = {}) {
  const { token, host } = await getTenantAccessToken();
  const url = `${host}${path}`;
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
  };
  if (method !== 'GET') init.body = JSON.stringify(params);
  const res = await fetch(url, init);
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`Lark API ${path} error: ${data.msg || data.code}`);
  }
  return data.data || {};
}

// Lark text messages use a JSON-encoded `content` field whose shape depends
// on msg_type. For plain text the shape is `{ text: "..." }`.
function textContent(text) {
  return JSON.stringify({ text });
}

// receive_id_type is required by Lark and depends on the id format:
//   - "oc_*"     → chat_id (group/DM chat)
//   - "ou_*"     → open_id (user)
//   - "on_*"     → union_id
// We infer from the prefix so callers can pass whichever id they have.
function inferReceiveIdType(id) {
  if (!id || typeof id !== 'string') return 'chat_id';
  if (id.startsWith('oc_')) return 'chat_id';
  if (id.startsWith('ou_')) return 'open_id';
  if (id.startsWith('on_')) return 'union_id';
  if (id.startsWith('cli_')) return 'app_id';
  // Email-looking → email; otherwise default to chat_id since that's the
  // most common bot target.
  if (id.includes('@')) return 'email';
  return 'chat_id';
}

export const larkSkill = {
  id: 'lark',
  serverName: 'lark',                    // MCP server name; tools appear as mcp__lark__<tool>
  allowedTools: ['mcp__lark__*'],        // glob for the Agent SDK's tool allowlist
  requiresIntegration: INTEGRATIONS.LARK, // see sentrySkill.requiresIntegration for semantics
  description: 'Lark / Feishu messaging — send messages and reply in threads.',
  envKeys: [],

  promptFragment: `## Lark (connected)
You can send messages and replies on Lark. Use:
- lark_send_message: post a message to a chat, user, or DM
- lark_reply: reply to an existing message (threaded)
- lark_list_chats: list chats the bot is a member of
- lark_get_chat_history: fetch recent messages in a chat
When responding to an incoming event, prefer lark_reply with the source message_id so the response threads cleanly.`,

  /**
   * MCP-style agents (Claude Code / Cursor / Codex / Gemini) call
   * this. Returns the spawn spec for our self-contained MCP binary.
   * Pattern mirrors @zibby/mcp-browser + bin/mcp-sentry.mjs.
   *
   * Returns null when the binary can't be found (e.g. running
   * outside a node_modules layout) — agent strategy falls back to
   * its built-in tools, the in-process path keeps working for the
   * `assistant` agent.
   */
  resolve() {
    const bin = resolveLarkBin();
    if (!bin) return null;
    const env = {};
    // Pass through env vars the MCP server needs to call the
    // backend's resolveIntegrationToken endpoint. Explicit allow-list
    // (same approach as browserSkill / sentrySkill) — keeps secrets
    // scoped, no leakage of unrelated process env into the bridge.
    for (const k of ['PROJECT_API_TOKEN', 'PROGRESS_API_URL', 'EXECUTION_ID', 'PROJECT_ID', 'STAGE']) {
      if (process.env[k]) env[k] = process.env[k];
    }
    return {
      type: 'stdio',
      command: 'node',
      args: [bin],
      env,
      // Same `alwaysLoad: true` as sentrySkill — see comment there.
      // Forces MCP tools into the initial prompt; otherwise they sit
      // behind ToolSearch where the LLM keyword search misses them.
      alwaysLoad: true,
    };
  },

  tools: [
    {
      name: 'lark_send_message',
      description: 'Send a text message to a Lark chat, user, or DM. receive_id can be a chat_id (oc_*), open_id (ou_*), union_id (on_*), or email.',
      input_schema: {
        type: 'object',
        properties: {
          receive_id: { type: 'string', description: 'Target id: chat_id (oc_*), open_id (ou_*), union_id (on_*), or email' },
          text: { type: 'string', description: 'Message text' },
        },
        required: ['receive_id', 'text'],
      },
    },
    {
      name: 'lark_reply',
      description: 'Reply to an existing Lark message (creates a thread). Use the message_id from the inbound event.',
      input_schema: {
        type: 'object',
        properties: {
          message_id: { type: 'string', description: 'Lark message id (om_*) to reply to' },
          text: { type: 'string', description: 'Reply text' },
        },
        required: ['message_id', 'text'],
      },
    },
    {
      name: 'lark_list_chats',
      description: 'List chats (groups + DMs) the bot is a member of.',
      input_schema: {
        type: 'object',
        properties: {
          page_size: { type: 'number', description: 'Max results (default 50)' },
        },
      },
    },
    {
      name: 'lark_get_chat_history',
      description: 'Fetch recent messages in a chat.',
      input_schema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Chat id (oc_*)' },
          page_size: { type: 'number', description: 'Max messages (default 20)' },
        },
        required: ['chat_id'],
      },
    },
  ],

  async handleToolCall(name, args) {
    try {
      switch (name) {
        case 'lark_send_message': {
          if (!args.receive_id || !args.text) {
            return JSON.stringify({ error: 'receive_id and text are required' });
          }
          const receiveIdType = inferReceiveIdType(args.receive_id);
          const data = await larkApi(
            'POST',
            `/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
            {
              receive_id: args.receive_id,
              msg_type: 'text',
              content: textContent(args.text),
            }
          );
          return JSON.stringify({ ok: true, message_id: data.message_id });
        }
        case 'lark_reply': {
          if (!args.message_id || !args.text) {
            return JSON.stringify({ error: 'message_id and text are required' });
          }
          const data = await larkApi(
            'POST',
            `/open-apis/im/v1/messages/${encodeURIComponent(args.message_id)}/reply`,
            {
              msg_type: 'text',
              content: textContent(args.text),
            }
          );
          return JSON.stringify({ ok: true, message_id: data.message_id });
        }
        case 'lark_list_chats': {
          const pageSize = args.page_size || 50;
          const data = await larkApi('GET', `/open-apis/im/v1/chats?page_size=${pageSize}`);
          const chats = (data.items || []).map((c) => ({
            chat_id: c.chat_id,
            name: c.name,
            description: c.description,
            owner_id: c.owner_id,
            chat_mode: c.chat_mode,
          }));
          return JSON.stringify({ chats });
        }
        case 'lark_get_chat_history': {
          if (!args.chat_id) return JSON.stringify({ error: 'chat_id is required' });
          const pageSize = args.page_size || 20;
          const data = await larkApi(
            'GET',
            `/open-apis/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(args.chat_id)}&page_size=${pageSize}&sort_type=ByCreateTimeDesc`
          );
          const messages = (data.items || []).map((m) => ({
            message_id: m.message_id,
            sender_id: m.sender?.id,
            sender_type: m.sender?.sender_type,
            msg_type: m.msg_type,
            content: m.body?.content,
            create_time: m.create_time,
          }));
          return JSON.stringify({ messages });
        }
        default:
          return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  },
};

// Test-only: lets vitest reset the token cache between cases.
export function _resetLarkTokenCache() {
  tokenCache = null;
}
