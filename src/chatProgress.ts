/**
 * chat-progress — THE ONE "tell the people watching" primitive (founder,
 * 2026-10-07: one tool, not two). `report_progress(message)` ALWAYS records the
 * line as the run's OWN line (the run's `statusLine`, through the run's own
 * progress door with the run's token — the same field the run's final answer
 * writes; the control plane scrubs and caps it, utils/run-status-line). The
 * activity feed hands each new line on, so a team's office view shows it over
 * that member's head and its manager reads it. It ALSO posts to the triggering
 * chat when a target resolves (below). A line over PROGRESS_MAX_CHARS is
 * returned to be rewritten, never cut.
 *
 * Originally: a GENERAL "report progress back to the chat" skill for any
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
 *
 * A REPLY THAT NAMES WHAT IT ANSWERED MARKS IT READ (2026-10-25, run_log/
 * product-owner/2026-10-25-handled-mail-stays-unread). `answeredMessageIds` is
 * the agent's own explicit receipt. It used to reach only the run's in-memory
 * ledger, so a mailbox message the agent had answered stayed "unread" in its
 * mailbox for good — nobody else acknowledges a person's words. A successful
 * reply now acknowledges each named id through the platform's inbox door
 * (`POST …/workflows/<own type>/inbox/<id>/ack`, with the run's own token: the
 * door lets a run mark only its own agent's mail and records who did). The
 * ledger receipt (`answeredMessageIds` in the result) is unchanged.
 * WHAT IT RESTRICTS: nothing — a failed acknowledgement is reported in the
 * result and never fails the reply.
 */

import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve as resolvePath } from 'path';
import { slackSkill } from './slack.js';
import { larkSkill } from './lark.js';
import { fetchWithDeadline } from './lib/http-deadline.js';

/** The control plane keeps 280 characters of a run's line; a longer one is handed back to be rewritten. */
export const PROGRESS_MAX_CHARS = 280;

/** The ONE body the run-line write sends — the field is the progress report's own (`statusLine`). */
export function progressBody(message: string) {
  return { statusLine: message };
}

/**
 * Record the line as this run's own, through the run's progress door. Returns
 * true when the control plane took it. Never throws: no door (a run outside the
 * platform), a refusal or a network error is simply "not recorded".
 */
async function recordRunLine(message: string, env: any = process.env): Promise<boolean> {
  const base = String(env.PROGRESS_API_URL || '').replace(/\/+$/, '');
  const executionId = String(env.EXECUTION_ID || '').trim();
  if (!base || !executionId) return false;
  try {
    const res: any = await fetchWithDeadline(`${base}/${encodeURIComponent(executionId)}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(env.PROJECT_API_TOKEN ? { Authorization: `Bearer ${env.PROJECT_API_TOKEN}` } : {}) },
      body: JSON.stringify(progressBody(message)),
    }, { kind: 'api', what: 'chat-progress POST run line' });
    return !!res?.ok;
  } catch {
    return false;
  }
}

/** At most this many ids are acknowledged per reply (a bound, not a judgement). */
export const ANSWERED_ACK_MAX = 20;

/**
 * Acknowledge the mailbox messages a successful reply names, in THIS run's
 * own agent's mailbox. Identity comes from the shared-serving context when
 * there is one, else the run's env. Never throws.
 */
export async function acknowledgeAnswered(ids: unknown[], context: any = {}, env: any = process.env) {
  const out: { acknowledged: string[]; notAcknowledged: Array<{ id: string; reason: string }> } = { acknowledged: [], notAcknowledged: [] };
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter((id): id is string => typeof id === 'string' && !!id.trim()).map((id) => id.trim()))].slice(0, ANSWERED_ACK_MAX);
  if (!list.length) return out;
  const fromDoor = String(env.PROGRESS_API_URL || '').replace(/\/+$/, '').replace(/\/executions$/, '');
  const base = String(context?.apiBase || fromDoor || '').replace(/\/+$/, '');
  const token = String(env.PROJECT_API_TOKEN || context?.bearerToken || '');
  const projectId = String(context?.projectId || env.PROJECT_ID || '').trim();
  const workflowType = String(context?.workflowType || env.WORKFLOW_TYPE || '').trim();
  for (const id of list) {
    if (!base || !token || !projectId || !workflowType) { out.notAcknowledged.push({ id, reason: 'this run has no platform address, credential or agent name for its mailbox' }); continue; }
    try {
      const res: any = await fetchWithDeadline(`${base}/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowType)}/inbox/${encodeURIComponent(id)}/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: '{}',
      }, { kind: 'api', what: 'chat-progress POST mailbox ack' });
      let body: any = null;
      try { body = await res.json(); } catch { /* no body */ }
      if (!res?.ok) out.notAcknowledged.push({ id, reason: `HTTP ${res?.status}${body?.error ? `: ${String(body.error).slice(0, 160)}` : ''}` });
      else if (body?.found === false) out.notAcknowledged.push({ id, reason: 'no such message in your mailbox' });
      else out.acknowledged.push(id);
    } catch (e: any) {
      out.notAcknowledged.push({ id, reason: String(e?.message || e).slice(0, 160) });
    }
  }
  return out;
}

function resolveSkillBin() {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

/** Resolve { provider, chatId, mention } from args → env, first hit wins. */
function resolveTarget(args: any = {}) {
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

export const chatProgressSkill: any = {
  id: 'chat-progress',
  serverName: 'chat_progress',
  allowedTools: ['mcp__chat_progress__*'],
  // Reuse both providers' env so posting works whichever is connected, PLUS
  // the progress-target env the runtime may set from the trigger's notify.
  envKeys: [
    ...(slackSkill.envKeys || []), ...(larkSkill.envKeys || []),
    'ZIBBY_PROGRESS_PROVIDER', 'ZIBBY_PROGRESS_CHAT_ID', 'ZIBBY_PROGRESS_MENTION',
    'SLACK_CHANNEL', 'LARK_RECEIVE_ID',
    // the run's own line: its identity and its progress door
    'PROGRESS_API_URL', 'EXECUTION_ID',
  ],
  description: 'Tell the people watching what you are doing while you work — recorded as your run\'s own line (what an office view and your manager see) and posted to the triggering chat when there is one. Fire-and-forget.',

  promptFragment: [
    '## Progress updates (report_progress)',
    'People watching your run see what you post with report_progress — over your head in the office view, to your manager, and in the chat that started this run. Your final answer reaches them only at the end.',
    'Post one as soon as you start, saying what job you took on. After that: when the plan changes, when something important is done, and at once when you are blocked (say what you need). Routine work needs no update.',
    'Treat successfully delivered progress updates and other messages as part of the same conversation: the person has already received their content.',
    'Your final reply may add the outcome, a correction or useful next steps; avoid repeating what you already told the person unless they ask for a recap. Keep meaningful progress updates while work continues.',
    `One or two short sentences (at most ${PROGRESS_MAX_CHARS} characters), in the language of your task, said the way you would tell a coworker who walks past your desk. They have read neither the code nor the ticket, the plan or any document you are working from, so a heading or a term taken from those means nothing to them: say in everyday words what you are doing and what it will change for the people who use the product, and name the ticket. No branches, commits, file names or test counts. When your \`notify\` input names a chat, pass its provider and chatId. A failed post never stops your work.`,
  ].join('\n'),

  resolve() {
    // Our OWN generic MCP server (report_progress), NOT slack's/lark's — so the
    // model sees ONE simple tool. handleToolCall delegates the actual post to
    // the slack/lark skills in-process, so forward the env they need.
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env: {}, description: this.description };
    const env: any = {};
    for (const key of [
      // slack/lark auth via resolveIntegrationToken (backend-client)
      'PROJECT_API_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_ENV', 'ZIBBY_PROD_ACCOUNT_API_URL', 'ZIBBY_USER_TOKEN',
      // the run's own line (recordRunLine)
      'PROGRESS_API_URL', 'EXECUTION_ID',
      // the run's own mailbox (acknowledgeAnswered)
      'PROJECT_ID', 'WORKFLOW_TYPE',
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
      // PINNED (`alwaysLoad`): the one tool sits in front of the model on every
      // vendor — on a broker vendor (codex) beside the toolbox, not behind
      // list_tools. Deciding whether to tell the people watching is a judgement
      // made between steps; a tool the model must first search for is a tool it
      // does not reach for (live, 2026-10-07: codex members searched the toolbox
      // for report_progress and never called it). One tool, a few hundred tokens.
      alwaysLoad: true,
      // …and on a CHAT CALL, where everything else sits behind the search, it
      // is one of the few things every chat turn needs in front (@zibby/core
      // mcp-server-config.js CHAT_PINNED).
      chatAlwaysLoad: true,
    };
  },

  async handleToolCall(name, args, context?: any) {
    if (name !== 'report_progress') return JSON.stringify({ error: `Unknown tool: ${name}` });
    const receipt = async (result: any) => {
      if (result.ok !== true || !Array.isArray(args?.answeredMessageIds)) return JSON.stringify(result);
      const answered = args.answeredMessageIds.filter((id: unknown) => typeof id === 'string');
      const acks = await acknowledgeAnswered(answered, context);
      return JSON.stringify({
        ...result,
        answeredMessageIds: answered,
        ...(acks.acknowledged.length ? { acknowledged: acks.acknowledged } : {}),
        ...(acks.notAcknowledged.length ? { notAcknowledged: acks.notAcknowledged } : {}),
      });
    };
    try {
      const message = String(args?.message || '').replace(/\s+/g, ' ').trim();
      if (!message) return JSON.stringify({ ok: false, skipped: 'empty message' });
      if (message.length > PROGRESS_MAX_CHARS) {
        return JSON.stringify({ ok: false, error: `message is ${message.length} characters; keep it to one or two short sentences (at most ${PROGRESS_MAX_CHARS}) and post it again` });
      }
      // 1. Always: the run's own line — what the people watching the run see.
      const recorded = await recordRunLine(message);
      // 2. Also: the chat this run came from, when one resolves.
      const { provider, chatId, mention } = resolveTarget(args);
      if (!provider || !chatId) {
        return receipt(recorded ? { ok: true, recorded: true, posted: false } : { ok: false, recorded: false, skipped: 'no chat target' });
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
      if (parsed && parsed.error) return receipt({ ok: recorded, recorded, skipped: `post failed: ${parsed.error}` });
      return receipt({ ok: true, provider, posted: true, recorded });
    } catch (e) {
      // Fire-and-forget: a progress ping never fails the node.
      return JSON.stringify({ ok: false, skipped: `error: ${e.message}` });
    }
  },

  tools: [
    {
      name: 'report_progress',
      description: 'Post a short update for the people watching this work: it becomes your run\'s own line (shown over you in an office view and read by your manager) and goes to the chat that triggered this run, when there is one. It reads best as one or two plain sentences a coworker who has read neither the code nor the ticket would follow: what you are doing and where, or what blocks you and what you need. Fire-and-forget: never fails the run. Never a credential.',
      input_schema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: `The update, at most ${PROGRESS_MAX_CHARS} characters.` },
          answeredMessageIds: { type: 'array', items: { type: 'string' }, description: 'Inbox message ids this update answers.' },
          provider: { type: 'string', enum: ['lark', 'slack'], description: 'Chat provider (from your notify input); default from the runtime.' },
          chatId: { type: 'string', description: 'Chat/channel id (from your notify input); default from the runtime.' },
        },
        required: ['message'],
      },
    },
  ],
};

export default chatProgressSkill;
