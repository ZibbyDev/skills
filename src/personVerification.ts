/**
 * personVerification.ts — ask the person, RIGHT NOW, for a sign-in step only
 * they can give, and wait for it.
 *
 * WHAT IT IS
 * ──────────
 * One tool, `person_verification`. Some steps of a sign-in belong to the
 * person and expire in minutes: a one-time code from their authenticator, an
 * approval on their phone, a QR code they scan. Relayed through a manager they
 * are stale before they arrive. So this is the ONE way a run reaches a person
 * directly even when it has a manager (backend services/human-signal.js — the
 * founder's exception of 2026-09-29): the platform puts a NEEDS YOU card in
 * front of the person, sends the manager a copy, and the person's reply comes
 * back to THIS call, which has been waiting in place (container, session and
 * browser untouched).
 *
 * WHAT IT MAY ASK IS A CLOSED LIST, AND THE PLATFORM HOLDS IT
 * ────────────────────────────────────────────────────────────
 * `kind` is one of `VERIFICATION_ASKS` below; the backend declares the same
 * list (backend/src/constants/person-verification.js) and refuses anything
 * else with a sentence that sends the run back to its manager. The copy here is
 * only the schema the model sees; `__tests__/personVerification.test.ts` reads
 * the backend file from the sibling checkout and fails on drift (🔗 TWO-PLACES).
 *
 * HOW THE ANSWER COMES BACK — the existing "person's message to a running run"
 * ───────────────────────────────────────────────────────────────────────────
 *   1. POST {api}/projects/{PROJECT_ID}/events {kind:'needs_verification'} —
 *      the card. The platform stamps when the wait ends (`expiresAt`).
 *   2. The person's reply on that card is posted into THIS agent's inbox,
 *      addressed to THIS run (about.executionId), under an id DERIVED from the
 *      card (`verify-<card>`), marked `replyTo`. The runtime pump and
 *      check_messages leave such a row alone.
 *   3. This call reads that ONE row by key (the kv `recall` door, a GetItem),
 *      every few seconds, until it is there or the wait is over; then
 *      acknowledges it, which scrubs the words from the mailbox history.
 * No chat turn is involved, so it works for an agent that has no chat at all.
 *
 * THE REPLY IS SECRET-ISH (security invariant 4)
 * ───────────────────────────────────────────────
 * A code comes back as `privateReply` (an approval or a scan as plain `reply`). The engine (@zibby/core credential-scrub)
 * learns any `privateReply` a tool returns and rewrites it out of every log
 * line and persisted transcript for the rest of the run; this module never
 * logs it; the platform never stores it past the moment it is taken.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_IDS } from '@zibby/skill-ids';
import { fetchWithDeadline } from './lib/http-deadline.js';

/** The closed list — the SCHEMA copy of backend constants/person-verification.js (pinned by test). */
export const VERIFICATION_ASKS = Object.freeze(['one_time_code', 'confirm_on_device', 'scan_qr_code'] as const);
/** The platform's event kind for the card. */
export const VERIFICATION_EVENT_KIND = 'needs_verification';
/** Wait bounds (seconds) — the platform clamps to the same numbers (pinned by test). */
export const WAIT_DEFAULT_SECONDS = 600;
export const WAIT_MIN_SECONDS = 60;
export const WAIT_MAX_SECONDS = 600;
/** How often the waiting call looks for the answer. One GetItem each time. */
export const POLL_INTERVAL_MS = 3_000;
/** The mailbox segment the platform writes rows under (parent-bell DOORBELL_SEGMENT). */
export const DOORBELL_SEGMENT = 'doorbell';
/**
 * How long the MCP host may let this one call run. The call blocks for the
 * whole wait, so the host's per-call budget must cover it (claude: none by
 * default; codex: 60s unless told — @zibby/core maps this to its
 * `tool_timeout_sec`; the tool broker passes it to its own client).
 */
export const CALL_TIMEOUT_SECONDS = WAIT_MAX_SECONDS + 60;

/** The card's id → the mailbox id of the person's reply (backend verificationReplyId). PURE. */
export function replyIdFor(cardId: string): string | null {
  const m = /^events:([0-9]+-[a-f0-9]+)$/.exec(String(cardId || ''));
  return m ? `verify-${m[1]}` : null;
}

function resolveSkillBin() {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

function getSessionToken() {
  if (process.env.PROJECT_API_TOKEN) return process.env.PROJECT_API_TOKEN;
  if (process.env.ZIBBY_USER_TOKEN) return process.env.ZIBBY_USER_TOKEN;
  try {
    const p = join(homedir(), '.zibby', 'config.json');
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8')).sessionToken || null;
  } catch {
    return null;
  }
}

function getAccountApiUrl() {
  if (process.env.ZIBBY_ACCOUNT_API_URL) return process.env.ZIBBY_ACCOUNT_API_URL.replace(/\/$/, '');
  const env = process.env.ZIBBY_ENV || 'prod';
  if (env === 'local') return 'http://localhost:3001';
  return process.env.ZIBBY_PROD_ACCOUNT_API_URL || 'https://api-prod.zibby.app';
}

const envStr = (key: string) => (typeof process.env[key] === 'string' ? process.env[key]!.trim() : '');

async function errorTextOf(res: any, what: string): Promise<string> {
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  if (body && typeof body.error === 'string' && body.error.trim()) return body.error.trim();
  return `${what} failed (HTTP ${res.status})`;
}

const sleep = (ms: number) => new Promise((r) => { setTimeout(r, ms); });

/** Test seam: the clock and the pause between looks. */
export const timing = { now: () => Date.now(), sleep };

/** Read the ONE mailbox row the reply lands in. null = not there yet (or unreadable this time). */
async function readReply(token: string, scope: string): Promise<{ text: string } | null> {
  const res = await fetchWithDeadline(`${getAccountApiUrl()}/credits/review-memory`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'recall', scope }),
  }, { kind: 'api', what: 'person-verification recall' });
  if (!res.ok) return null;
  const json: any = await res.json().catch(() => null);
  const mem = json && (json.memory || (json.data && json.data.memory));
  if (!mem || typeof mem.content !== 'string') return null;
  let msg: any;
  try { msg = JSON.parse(mem.content); } catch { return null; }
  if (!msg || typeof msg.text !== 'string' || !msg.text.trim() || msg.ackedAt) return null;
  if (msg.about?.executionId !== envStr('EXECUTION_ID')) return null;
  return { text: msg.text.trim() };
}

/** Take it: the platform marks the row and scrubs the words (agent-inbox ackInboxMessage). Best-effort. */
async function takeReply(token: string, id: string) {
  const url = `${getAccountApiUrl()}/projects/${encodeURIComponent(envStr('PROJECT_ID'))}/workflows/${encodeURIComponent(envStr('WORKFLOW_TYPE'))}/inbox/${encodeURIComponent(id)}/ack`;
  try {
    await fetchWithDeadline(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' }, { kind: 'api', what: 'person-verification take' });
  } catch { /* the row still expires with the mailbox; the words were already delivered */ }
}

export async function askPerson(args: any = {}) {
  const kind = typeof args.kind === 'string' ? args.kind.trim() : '';
  const text = typeof args.text === 'string' ? args.text.replace(/\s+/g, ' ').trim() : '';
  if (!text) return { error: 'text is required: one short sentence for the person — where you are signing in and what you need from them' };
  const token = getSessionToken();
  if (!token) return { error: 'No backend credential (PROJECT_API_TOKEN). A person can only be asked from inside a run.' };
  const projectId = envStr('PROJECT_ID');
  const workflowUuid = envStr('WORKFLOW_UUID');
  const workflowType = envStr('WORKFLOW_TYPE');
  const executionId = envStr('EXECUTION_ID');
  if (!projectId || !workflowUuid || !workflowType || !executionId) return { error: 'This run does not know its project, agent or run id (PROJECT_ID / WORKFLOW_UUID / WORKFLOW_TYPE / EXECUTION_ID), so nothing could wait for an answer.' };
  const data: Record<string, any> = { ask: kind, question: text };
  if (args.waitSeconds !== undefined) data.waitSeconds = args.waitSeconds;
  for (const k of ['ticketKey', 'ticketNumber', 'sendLabel']) if (typeof args[k] === 'string' && args[k].trim()) data[k] = args[k].trim();
  // The platform checks `kind` against the closed list — the refusal is its sentence.
  const res = await fetchWithDeadline(`${getAccountApiUrl()}/projects/${encodeURIComponent(projectId)}/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: VERIFICATION_EVENT_KIND, workflowUuid, workflowType, executionId, data }),
  }, { kind: 'api', what: 'person-verification POST card' });
  if (!res.ok) return { error: await errorTextOf(res, 'asking the person') };
  const json: any = await res.json().catch(() => ({}));
  const cardId = typeof json?.id === 'string' ? json.id : '';
  const replyId = replyIdFor(cardId);
  const until = Date.parse(json?.expiresAt || '');
  if (!replyId || !Number.isFinite(until)) return { error: 'The card went up but the platform did not say where the answer will arrive; ask your manager instead.' };
  const scope = `${workflowType}:${DOORBELL_SEGMENT}:${replyId}`;
  while (timing.now() < until) {
    // eslint-disable-next-line no-await-in-loop
    await timing.sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, until - timing.now())));
    // eslint-disable-next-line no-await-in-loop
    const got = await readReply(token, scope).catch(() => null);
    if (got) {
      // eslint-disable-next-line no-await-in-loop
      await takeReply(token, replyId);
      // A code is the secret: it travels as `privateReply`, the one field the
      // engine learns and masks in every log line for the rest of the run. An
      // approval or a scan comes back as the person's own word ("done").
      if (kind === 'one_time_code') {
        return {
          answered: true,
          kind,
          privateReply: got.text,
          note: 'Use it where the sign-in asks for it, now. Do not repeat it in messages, tickets, notes or memory — it is kept out of the run\'s record.',
        };
      }
      return { answered: true, kind, reply: got.text, note: 'The person has answered. Carry on with the sign-in.' };
    }
  }
  return {
    answered: false,
    kind,
    note: 'Nobody answered in time and the card has closed. Do not ask again. Tell your manager (message_agent) that the sign-in could not be completed and what it needed.',
  };
}

export const personVerificationSkill: any = {
  id: SKILL_IDS.PERSON_VERIFICATION,
  callsBackend: true,
  serverName: 'person_verification',
  allowedTools: ['mcp__person_verification__*'],
  description: 'Person verification — ask the person, right now, for a sign-in step only they can give (a one-time code, a confirmation on their device, a QR code to scan) and wait for the answer',

  resolve() {
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env: {}, description: this.description };
    const env: any = {};
    for (const key of ['PROJECT_API_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_ENV', 'ZIBBY_PROD_ACCOUNT_API_URL', 'ZIBBY_USER_TOKEN',
      'EXECUTION_ID', 'PROJECT_ID', 'WORKFLOW_TYPE', 'WORKFLOW_UUID']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/personVerification.js', 'personVerificationSkill'],
      env,
      description: this.description,
      // PINNED IN THE PROMPT. The tool's description is the only place that
      // says when to use it and what it may ask; deferred behind ToolSearch the
      // model sees a bare name and never reaches for it at the moment a code is
      // on screen (MCP_TOOL_LOADING.md: alwaysLoad only for a tool the model
      // must see before it can act — one small schema).
      alwaysLoad: true,
      // The call blocks for the whole wait; the host must let it.
      callTimeoutSeconds: CALL_TIMEOUT_SECONDS,
    };
  },

  async handleToolCall(name: string, args: any) {
    try {
      if (name === 'person_verification') return JSON.stringify(await askPerson(args));
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    } catch (e: any) {
      return JSON.stringify({ error: e?.message || String(e) });
    }
  },

  tools: [
    {
      name: 'person_verification',
      description: 'Ask the person, right now, for a sign-in step only they can give, and wait here for it. Exactly three kinds, and the platform refuses any other: '
        + '"one_time_code" — a one-time / 2FA code from their authenticator app, a text message or an email; '
        + '"confirm_on_device" — approving a sign-in on their phone or another device; '
        + '"scan_qr_code" — scanning a QR code that is on the screen you are working in. '
        + 'Use it the moment such a step appears in a sign-in you are doing: it expires before a message to your manager could come back. '
        + 'It is NOT for anything else — which account to use, a missing password or key, access, a decision, a question about the work, being stuck: those go to your manager (message_agent), or with no manager to needs_you. '
        + '`text` is the one sentence the person reads, in their language: where you are signing in and what you need, e.g. "I\'m signing in to localhost:3000 and need the 6-digit code from your authenticator." No ids, error codes or internal names. '
        + 'The call waits (up to 10 minutes) with your session and browser left as they are, and returns {answered:true, privateReply} with the code — type it where it is asked and never repeat it anywhere else; it is kept out of logs and records — or {answered:true, reply} (e.g. "done") once they approved or scanned. '
        + 'If nobody answers in time it returns {answered:false}: do not ask again — tell your manager the sign-in could not be completed. Your manager is sent a copy of the ask, never the answer.',
      input_schema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...VERIFICATION_ASKS], description: 'Which of the three sign-in steps this is.' },
          text: { type: 'string', description: 'The one sentence the person reads (up to 300 characters).' },
          waitSeconds: { type: 'integer', minimum: WAIT_MIN_SECONDS, maximum: WAIT_MAX_SECONDS, description: 'Optional: how long to wait for them, 60 to 600 seconds (default 600) — about as long as the code or prompt stays valid.' },
          sendLabel: { type: 'string', description: 'Optional: the words on the card\'s send button, in the card\'s language (up to 16 characters).' },
          ticketKey: { type: 'string', description: 'Optional: the ticket this sign-in is for, as the board keys it.' },
          ticketNumber: { type: 'string', description: 'Optional: the ticket as a person reads it (e.g. "#40").' },
        },
        required: ['kind', 'text'],
      },
    },
  ],
};
