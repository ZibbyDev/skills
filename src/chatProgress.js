/**
 * chat-progress — a GENERAL "report progress back to the chat" skill for any
 * LONG-RUNNING workflow node. One dead-simple tool, `report_progress(message)`:
 * the node posts a one-line status to the SAME chat that triggered the run,
 * while it's still working, so a human watching the conversation sees the job
 * is alive (not a black box until the completion notify fires).
 *
 * Why a dedicated skill (not "just call slack/lark"):
 *   - Zero fumbling: the node calls report_progress("scored 60/188") — it does
 *     NOT need to know the provider, channel id, or bot token. The target +
 *     auth are resolved here.
 *   - General + reusable: ANY agent's long-running node declares
 *     SKILLS.CHAT_PROGRESS and gets the same primitive for free.
 *   - Fire-and-forget: a post failure is NEVER a run failure (a progress ping
 *     is a courtesy, not the work).
 *
 * TARGET resolution (where the ping goes) — first hit wins:
 *   1. explicit args { provider, chatId } (the node passes state.notify)
 *   2. env ZIBBY_PROGRESS_PROVIDER + ZIBBY_PROGRESS_CHAT_ID (set by the runtime
 *      from the trigger's `notify` — the same coordinates the completion
 *      notification uses, so progress + done land in one conversation)
 *   3. env SLACK_CHANNEL / LARK_RECEIVE_ID (the chat_notify convention)
 * No target resolvable → soft no-op (never an error; the run proceeds).
 *
 * POSTING reuses the slack/lark skills' own handleToolCall (their auth via
 * resolveIntegrationToken, their message APIs) — zero duplication.
 */

import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve as resolvePath } from 'path';
import { slackSkill } from './slack.js';
import { larkSkill } from './lark.js';

function resolveSkillBin() {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

/** Resolve { provider, chatId, mention } from args → env, first hit wins. */
function resolveTarget(args = {}) {
  const provider = String(
    args.provider || process.env.ZIBBY_PROGRESS_PROVIDER
      || (process.env.LARK_RECEIVE_ID ? 'lark' : (process.env.SLACK_CHANNEL || process.env.SLACK_BOT_TOKEN ? 'slack' : '')),
  ).toLowerCase();
  const chatId = String(
    args.chatId || args.channel
      || process.env.ZIBBY_PROGRESS_CHAT_ID
      || (provider === 'lark' ? process.env.LARK_RECEIVE_ID : process.env.SLACK_CHANNEL) || '',
  ).trim();
  const mention = String(args.mention || process.env.ZIBBY_PROGRESS_MENTION || '').trim();
  return { provider, chatId, mention };
}

export const chatProgressSkill = {
  id: 'chat-progress',
  serverName: 'chat_progress',
  allowedTools: ['mcp__chat_progress__*'],
  // Reuse both providers' env so posting works whichever is connected, PLUS
  // the progress-target env the runtime may set from the trigger's notify.
  envKeys: [
    ...(slackSkill.envKeys || []), ...(larkSkill.envKeys || []),
    'ZIBBY_PROGRESS_PROVIDER', 'ZIBBY_PROGRESS_CHAT_ID', 'ZIBBY_PROGRESS_MENTION',
    'SLACK_CHANNEL', 'LARK_RECEIVE_ID',
  ],
  description: 'Report progress back to the triggering chat during a long-running job — a one-line status the human sees while the work runs. General + reusable; fire-and-forget.',

  promptFragment: `## Chat Progress (tell the human you're still working — long jobs only)
When a run is LONG (many API pages, a shard-capped backfill, dozens of scored
items), the human who triggered it can't see the middle — only the final
notify. Post brief milestones so they know it's alive:
- report_progress: post a ONE-LINE status to the triggering chat. Call it at
  meaningful milestones (e.g. after listing N commits, every ~50 processed,
  before a long phase), NOT every step. Keep it short and human ("Scored 60/188
  commits, continuing…"). Pass the chat target from your \`notify\` input when
  you have it (provider + chatId); otherwise it resolves from the runtime.
  Fire-and-forget — if it can't post, just keep working; never treat a failed
  progress ping as an error.`,

  resolve() {
    // Our OWN generic MCP server (report_progress), NOT slack's/lark's — so the
    // model sees ONE simple tool. handleToolCall delegates the actual post to
    // the slack/lark skills in-process, so forward the env they need.
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env: {}, description: this.description };
    const env = {};
    for (const key of [
      // slack/lark auth via resolveIntegrationToken (backend-client)
      'PROJECT_API_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_ENV', 'ZIBBY_PROD_ACCOUNT_API_URL', 'ZIBBY_USER_TOKEN',
      'SLACK_BOT_TOKEN', 'SLACK_TEAM_ID',
      // progress target
      'ZIBBY_PROGRESS_PROVIDER', 'ZIBBY_PROGRESS_CHAT_ID', 'ZIBBY_PROGRESS_MENTION',
      'SLACK_CHANNEL', 'LARK_RECEIVE_ID',
    ]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/chatProgress.js', 'chatProgressSkill'],
      env,
      description: this.description,
      alwaysLoad: true,
    };
  },

  async handleToolCall(name, args) {
    if (name !== 'report_progress') return JSON.stringify({ error: `Unknown tool: ${name}` });
    try {
      const message = String(args?.message || '').trim().slice(0, 2000);
      if (!message) return JSON.stringify({ ok: false, skipped: 'empty message' });
      const { provider, chatId, mention } = resolveTarget(args);
      if (!provider || !chatId) {
        // Soft no-op: no chat to post to (e.g. a non-chat-triggered run).
        return JSON.stringify({ ok: false, skipped: 'no chat target' });
      }
      const text = mention && provider === 'slack' ? `<@${mention}> ${message}` : message;
      let res;
      if (provider === 'lark') {
        res = await larkSkill.handleToolCall('lark_send_message', { receive_id: chatId, text: message });
      } else {
        res = await slackSkill.handleToolCall('slack_post_message', { channel: chatId, text });
      }
      // Never surface a raw provider error as a throw; report soft.
      let parsed = null;
      try { parsed = JSON.parse(res); } catch { /* provider returned non-JSON */ }
      if (parsed && parsed.error) return JSON.stringify({ ok: false, skipped: `post failed: ${parsed.error}` });
      return JSON.stringify({ ok: true, provider, posted: true });
    } catch (e) {
      // Fire-and-forget: a progress ping never fails the node.
      return JSON.stringify({ ok: false, skipped: `error: ${e.message}` });
    }
  },

  tools: [
    {
      name: 'report_progress',
      description: 'Post a ONE-LINE progress status to the chat that triggered this run (so the human sees the long job is alive). Fire-and-forget — never fails the run. Target resolves from your notify input (provider + chatId) or the runtime; you usually just pass the message.',
      input_schema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'A short human status line, e.g. "Scored 60/188 commits, continuing…".' },
          provider: { type: 'string', enum: ['lark', 'slack'], description: 'Optional — the chat provider (from your notify input). Defaults from the runtime.' },
          chatId: { type: 'string', description: 'Optional — the target chat/channel id (from your notify input). Defaults from the runtime.' },
        },
        required: ['message'],
      },
    },
  ],
};

export default chatProgressSkill;
