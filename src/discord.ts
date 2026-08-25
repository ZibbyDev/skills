/**
 * Discord integration — low-level API-wrapper skill.
 *
 * Lets an agent post messages into a Discord server the user's bot has been
 * invited to, and discover the channels it can post to. Talks the Discord
 * REST API (v10) directly with a static BOT token — no MCP server of its own;
 * served over the GENERIC skill MCP binary (bin/mcp-skill.mjs), exactly like
 * linear.js / github.js.
 *
 * AUTH (single chokepoint: resolveDiscordAuth):
 *   1. resolveIntegrationToken('discord') — the Zibby-cloud path. The backend
 *      stores the bot token on the account's provider='discord' integration
 *      row (paste-based connect) and returns { token, guildId } from
 *      GET /integrations/token/discord.
 *   2. DISCORD_BOT_TOKEN env — the self-host / local fallback (same pattern
 *      as linear.js's LINEAR_API_KEY): when the env token is present it wins,
 *      so a self-hosted run never needs the Zibby cloud at all.
 *
 * Discord auth header semantics (https://discord.com/developers/docs):
 *   Authorization: Bot <token>
 * A raw token pasted without the "Bot " prefix gets it added here.
 *
 * FAIL-SOFT: handleToolCall never throws — every error path returns
 * JSON.stringify({ ok:false, error }) so a notify step can't crash a workflow.
 *
 * Discord hard limit: message `content` is capped at 2000 chars — longer text
 * is CHUNKED into sequential messages (split on line boundaries when possible)
 * rather than truncated or rejected.
 */

import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve as resolvePath } from 'path';
import { resolveIntegrationToken } from '@zibby/core/backend-client.js';
import { INTEGRATIONS } from './integrations.js';
import { fetchWithDeadline } from './lib/http-deadline.js';

/**
 * Resolve the generic skill MCP server binary (bin/mcp-skill.mjs), derived
 * from import.meta.url so it works in src/, dist/, and a published install.
 * See linear.js / github.js for the full rationale.
 */
function resolveSkillBin() {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

const DISCORD_API_BASE = process.env.DISCORD_API_URL || 'https://discord.com/api/v10';
// Discord's hard cap on message content.
export const DISCORD_MAX_CONTENT = 2000;

/**
 * Split `text` into Discord-postable chunks of <= DISCORD_MAX_CONTENT chars.
 * Prefers newline boundaries so code blocks / paragraphs stay readable; falls
 * back to a hard slice for a single overlong line. Pure — exported for tests.
 *
 * @param {string} text
 * @param {number} [max=DISCORD_MAX_CONTENT]
 * @returns {string[]} non-empty chunks (empty input → []).
 */
export function chunkDiscordContent(text, max = DISCORD_MAX_CONTENT) {
  const body = String(text ?? '');
  if (!body.trim()) return [];
  if (body.length <= max) return [body];
  const chunks = [];
  let rest = body;
  while (rest.length > max) {
    // Cut on the last newline inside the window when one exists past the
    // halfway point (avoids degenerate tiny chunks); else hard-slice.
    const window = rest.slice(0, max);
    const nl = window.lastIndexOf('\n');
    const cut = nl > max / 2 ? nl + 1 : max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * Resolve the Discord bot auth for this run.
 *   env DISCORD_BOT_TOKEN (self-host/local) → cloud integration token.
 * Returns { token, guildId } — guildId is the connected server captured at
 * connect time ('' when unknown). Throws a clear "not connected" error when
 * neither source yields a token (callers wrap it fail-soft).
 */
async function resolveDiscordAuth() {
  const envToken = (process.env.DISCORD_BOT_TOKEN || '').trim();
  if (envToken) {
    return { token: envToken, guildId: (process.env.DISCORD_GUILD_ID || '').trim() };
  }
  const data = await resolveIntegrationToken(INTEGRATIONS.DISCORD);
  const token = (data && data.token ? String(data.token) : '').trim();
  if (!token) {
    throw new Error('Discord is not connected: connect Discord in the Zibby dashboard or set DISCORD_BOT_TOKEN.');
  }
  return { token, guildId: (data.guildId || '').trim() };
}

/**
 * Low-level Discord REST helper. Adds the Bot auth header, JSON-encodes the
 * body, throws on HTTP errors with Discord's error message surfaced. The
 * single transport chokepoint for every tool below.
 */
async function discordApi(method, path, { token, body }: any = {}) {
  const auth = token.startsWith('Bot ') ? token : `Bot ${token}`;
  const res = await fetchWithDeadline(`${DISCORD_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: auth,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, { kind: 'api', what: `Discord ${method} ${path}` });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data && (data.message || data.error) ? (data.message || data.error) : `HTTP ${res.status}`;
    throw new Error(`Discord API error (${res.status}): ${msg}`);
  }
  return data;
}

/**
 * Resolve the guild to operate on: explicit arg → connect-time guildId →
 * DISCORD_GUILD_ID env → the bot's ONLY guild (when it is in exactly one).
 * Multiple guilds with no hint → throws listing them so the agent can retry
 * with an explicit guildId.
 */
async function resolveGuildId({ token, guildId: connectedGuildId }: any, argGuildId) {
  const explicit = String(argGuildId || '').trim() || connectedGuildId || (process.env.DISCORD_GUILD_ID || '').trim();
  if (explicit) return explicit;
  const guilds = await discordApi('GET', '/users/@me/guilds', { token });
  const list = Array.isArray(guilds) ? guilds : [];
  if (list.length === 1) return list[0].id;
  if (list.length === 0) throw new Error('The bot is not in any Discord server — invite it to a server first.');
  const names = list.slice(0, 10).map((g) => `${g.name} (${g.id})`).join(', ');
  throw new Error(`The bot is in ${list.length} servers — pass guildId explicitly. Servers: ${names}`);
}

export const discordSkill: any = {
  id: 'discord',
  // Backend-calling: the MCP child talks to Zibby's own backend — the
  // session-env contract is guaranteed by backendSession.ts at registration
  // (declare ONCE here; see backend-session-env-contract.test.ts).
  callsBackend: true,
  serverName: 'discord',
  allowedTools: ['mcp__discord__*'],
  requiresIntegration: INTEGRATIONS.DISCORD, // see sentrySkill.requiresIntegration for semantics
  envKeys: ['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID'],
  description: 'Discord bot tools (send messages, list channels)',

  promptFragment: `## Discord
You can post to the user's Discord server as their bot. Tools:
- discord_send_message(channelId, text) — post a message to a channel (long text is auto-chunked to Discord's 2000-char limit)
- discord_list_channels(guildId?) — list the server's text channels (id + name) to find where to post; guildId is optional when the bot is in one server`,

  /**
   * Spawn spec for the GENERIC skill MCP server (bin/mcp-skill.mjs) pointed at
   * this module's discordSkill export — the model gets real mcp__discord__*
   * tools. Mirrors linear.js resolve() (see its docblock for the dist-relative
   * module-path rationale). Env allow-list: the self-host token/guild vars +
   * the backend-client vars resolveIntegrationToken needs in the child.
   */
  resolve() {
    const env: any = {};
    for (const key of this.envKeys) {
      if (process.env[key]) env[key] = process.env[key];
    }
    // Backend-client env so the spawned child can resolve the integration
    // token through the same endpoint the in-process path uses (see slack.js
    // resolve() for the full rationale).
    for (const k of ['PROJECT_API_TOKEN', 'ZIBBY_USER_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_ENV', 'ZIBBY_PROD_ACCOUNT_API_URL', 'ZIBBY_SELF_HOST', 'DISCORD_API_URL', 'EXECUTION_ID', 'PROJECT_ID', 'STAGE']) {
      if (process.env[k]) env[k] = process.env[k];
    }
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env, description: this.description };
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/discord.js', 'discordSkill'],
      env,
      description: this.description,
      // Force tools into the system prompt (see sentry.js resolve()).
      alwaysLoad: true,
    };
  },

  async handleToolCall(name, args: any = {}) {
    try {
      switch (name) {
        case 'discord_send_message': {
          const channelId = String(args.channelId || '').trim();
          const text = String(args.text || '');
          if (!channelId || !text.trim()) {
            return JSON.stringify({ ok: false, error: 'channelId and text are required' });
          }
          const auth = await resolveDiscordAuth();
          const chunks = chunkDiscordContent(text);
          const ids = [];
          for (const content of chunks) {
            const msg = await discordApi('POST', `/channels/${encodeURIComponent(channelId)}/messages`, {
              token: auth.token,
              body: { content },
            });
            ids.push(msg && msg.id ? msg.id : '');
          }
          return JSON.stringify({ ok: true, channelId, messageIds: ids, chunks: chunks.length });
        }

        case 'discord_list_channels': {
          const auth = await resolveDiscordAuth();
          const guildId = await resolveGuildId(auth, args.guildId);
          const channels = await discordApi('GET', `/guilds/${encodeURIComponent(guildId)}/channels`, { token: auth.token });
          // Text-postable channel types: 0 = GUILD_TEXT, 5 = GUILD_ANNOUNCEMENT.
          const textChannels = (Array.isArray(channels) ? channels : [])
            .filter((c) => c && (c.type === 0 || c.type === 5))
            .map((c) => ({ id: c.id, name: c.name, type: c.type === 5 ? 'announcement' : 'text', ...(c.topic ? { topic: c.topic } : {}) }));
          return JSON.stringify({ ok: true, guildId, channels: textChannels });
        }

        default:
          return JSON.stringify({ ok: false, error: `Unknown tool: ${name}` });
      }
    } catch (e) {
      return JSON.stringify({ ok: false, error: e.message });
    }
  },

  tools: [
    {
      name: 'discord_send_message',
      description: 'Post a message to a Discord channel as the connected bot. Text over 2000 chars is automatically split into sequential messages.',
      input_schema: {
        type: 'object',
        properties: {
          channelId: { type: 'string', description: 'Discord channel id (snowflake). Use discord_list_channels to find it.' },
          text: { type: 'string', description: 'Message text (Discord markdown supported)' },
        },
        required: ['channelId', 'text'],
      },
    },
    {
      name: 'discord_list_channels',
      description: 'List the text channels of the connected Discord server (id + name). Pass guildId only when the bot is in multiple servers.',
      input_schema: {
        type: 'object',
        properties: {
          guildId: { type: 'string', description: 'Discord server (guild) id — optional when the bot is in exactly one server or one was captured at connect time' },
        },
      },
    },
  ],
};
