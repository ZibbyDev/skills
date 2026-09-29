/**
 * personVerificationSkill — the one tool a run uses to ask the person, now,
 * for a sign-in step only they can give, and wait for the answer.
 *
 *   - declared, not special-cased: its own skill id, pinned in the prompt
 *     (alwaysLoad) with a call budget that covers the wait, and NO
 *     promptFragment — the tool's description is the only place that says
 *     when to use it and what it may ask;
 *   - the closed list is the platform's: the tool forwards `kind` and returns
 *     the platform's refusal verbatim (it never widens or second-guesses it);
 *   - the answer arrives by key (the card's derived mailbox id, addressed to
 *     THIS run) and becomes the result as `privateReply`; taking it acks the row;
 *   - no answer by the platform's `expiresAt` → {answered:false}, no retry;
 *   - 🔗 TWO-PLACES: the list, the wait bounds, the reply-id derivation and the
 *     `replyTo` field are pinned against the backend's declaration.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const door = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../lib/http-deadline.js', () => ({ fetchWithDeadline: door.fetch }));

const SELF = 'exec-self-0001';
Object.assign(process.env, {
  PROJECT_API_TOKEN: 'contract-test-placeholder',
  ZIBBY_ACCOUNT_API_URL: 'http://cp.local',
  EXECUTION_ID: SELF,
  PROJECT_ID: 'proj-1',
  WORKFLOW_TYPE: 'product-qa',
  WORKFLOW_UUID: 'uuid-qa',
});

const {
  personVerificationSkill, replyIdFor, timing, VERIFICATION_ASKS, WAIT_DEFAULT_SECONDS, WAIT_MIN_SECONDS, WAIT_MAX_SECONDS, CALL_TIMEOUT_SECONDS,
} = await import('../personVerification.js');

const CARD = 'events:1759140000000-0badcafe';
const res = (status: number, json: any) => ({ ok: status < 400, status, json: async () => json });
let seen: any[] = [];
let clock = 0;
beforeEach(() => {
  seen = [];
  clock = Date.parse('2026-09-29T10:00:00.000Z');
  timing.now = () => clock;
  timing.sleep = async (ms: number) => { clock += ms; };
  door.fetch.mockReset();
});
const call = async (args: any) => JSON.parse(await personVerificationSkill.handleToolCall('person_verification', args));
const route = (handlers: Array<[RegExp, (body: any, n: number) => any]>) => {
  const counts = new Map<RegExp, number>();
  door.fetch.mockImplementation(async (url: string, init: any) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    seen.push({ url, body });
    for (const [re, fn] of handlers) {
      if (re.test(url)) { const n = (counts.get(re) || 0) + 1; counts.set(re, n); return fn(body, n); }
    }
    return res(404, { error: 'no route' });
  });
};
const cardOk = () => res(201, { ok: true, id: CARD, routed: 'person', expiresAt: '2026-09-29T10:10:00.000Z' });
const reply = (text: string, over: any = {}) => res(200, { found: true, memory: { scope: 'x', content: JSON.stringify({ id: 'verify-1759140000000-0badcafe', text, about: { executionId: SELF }, replyTo: CARD, ...over }) } });
const nothing = () => res(200, { found: false, memory: null });

describe('the declaration', () => {
  it('its own id, one tool, pinned in the prompt, a call budget that covers the wait, no prompt fragment', async () => {
    const { SKILL_IDS } = await import('@zibby/skill-ids');
    expect(personVerificationSkill.id).toBe(SKILL_IDS.PERSON_VERIFICATION);
    expect(personVerificationSkill.id).toBe('person-verification');
    expect(personVerificationSkill.tools.map((t: any) => t.name)).toEqual(['person_verification']);
    expect(personVerificationSkill.promptFragment).toBeUndefined();
    const resolved = personVerificationSkill.resolve();
    expect(resolved.alwaysLoad).toBe(true);
    expect(resolved.callTimeoutSeconds).toBeGreaterThan(WAIT_MAX_SECONDS);
    expect(CALL_TIMEOUT_SECONDS).toBe(resolved.callTimeoutSeconds);
  });
  it('the description carries the whole whitelist and when NOT to use it', () => {
    const d = personVerificationSkill.tools[0].description;
    for (const k of VERIFICATION_ASKS) expect(d).toContain(`"${k}"`);
    expect(d).toMatch(/manager/);
    expect(d).toMatch(/NOT for anything else/);
    expect(personVerificationSkill.tools[0].input_schema.properties.kind.enum).toEqual([...VERIFICATION_ASKS]);
  });
});

describe('asking and waiting', () => {
  it('posts ONE card and returns the person\'s answer as privateReply, then takes (acks) it', async () => {
    route([
      [/\/projects\/proj-1\/events$/, cardOk],
      [/\/credits\/review-memory$/, (_b, n) => (n < 3 ? nothing() : reply('482913'))],
      [/\/inbox\/verify-1759140000000-0badcafe\/ack$/, () => res(200, { ok: true })],
    ]);
    const out = await call({ kind: 'one_time_code', text: "I'm signing in to localhost:3000 and need the 6-digit code from your authenticator.", ticketKey: '460' });
    expect(out).toMatchObject({ answered: true, kind: 'one_time_code', privateReply: '482913' });
    expect(seen[0]).toMatchObject({
      url: 'http://cp.local/projects/proj-1/events',
      body: { kind: 'needs_verification', workflowUuid: 'uuid-qa', workflowType: 'product-qa', executionId: SELF, data: { ask: 'one_time_code', ticketKey: '460' } },
    });
    const reads = seen.filter((s) => /review-memory/.test(s.url));
    expect(reads).toHaveLength(3);
    for (const r of reads) expect(r.body).toEqual({ op: 'recall', scope: 'product-qa:doorbell:verify-1759140000000-0badcafe' });
    expect(seen.some((s) => /\/ack$/.test(s.url))).toBe(true);
  });

  it('an approval on the device comes back as a plain reply (only a code is private)', async () => {
    route([[/\/projects\/proj-1\/events$/, cardOk], [/\/credits\/review-memory$/, () => reply('done')], [/\/ack$/, () => res(200, { ok: true })]]);
    const out = await call({ kind: 'confirm_on_device', text: 'Approve the sign-in on your phone, please.' });
    expect(out).toMatchObject({ answered: true, reply: 'done' });
    expect(out).not.toHaveProperty('privateReply');
  });

  it('an answer addressed to ANOTHER run is not this call\'s', async () => {
    route([
      [/\/projects\/proj-1\/events$/, cardOk],
      [/\/credits\/review-memory$/, () => reply('999999', { about: { executionId: 'someone-else' } })],
    ]);
    const out = await call({ kind: 'one_time_code', text: 'code please' });
    expect(out.answered).toBe(false);
  });

  it('no answer by the platform\'s expiresAt → {answered:false} and one card only (no retry)', async () => {
    route([[/\/projects\/proj-1\/events$/, cardOk], [/\/credits\/review-memory$/, nothing]]);
    const out = await call({ kind: 'confirm_on_device', text: 'Approve the sign-in on your phone, please.' });
    expect(out).toMatchObject({ answered: false });
    expect(out.note).toMatch(/Do not ask again/);
    expect(out.note).toMatch(/manager/);
    expect(seen.filter((s) => /\/events$/.test(s.url))).toHaveLength(1);
    expect(clock).toBe(Date.parse('2026-09-29T10:10:00.000Z'));
  });

  it('the platform\'s refusal (a kind off the list) comes back as its own sentence, and nothing waits', async () => {
    route([[/\/projects\/proj-1\/events$/, () => res(400, { error: '"question" is not something a run may ask a person for directly. … tell your manager', code: 'ask-refused' })]]);
    const out = await call({ kind: 'question', text: 'Which account should I use?' });
    expect(out.error).toMatch(/tell your manager/);
    expect(seen).toHaveLength(1);
  });

  it('refuses before any request when there is nothing for the person to read', async () => {
    const out = await call({ kind: 'one_time_code', text: '   ' });
    expect(out.error).toMatch(/text is required/);
    expect(door.fetch).not.toHaveBeenCalled();
  });
});

describe('contract pin: backend constants/person-verification.js + agent-inbox.js', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const constants = join(here, '..', '..', '..', '..', 'backend', 'src', 'constants', 'person-verification.js');
  const inbox = join(here, '..', '..', '..', '..', 'backend', 'src', 'services', 'agent-inbox.js');
  const present = existsSync(constants) && existsSync(inbox);

  it.skipIf(!present)('the same closed list, the same wait bounds, the same reply id, the same replyTo field', async () => {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const V = req(constants);
    expect([...VERIFICATION_ASKS]).toEqual(V.VERIFICATION_ASK_KEYS);
    expect(WAIT_DEFAULT_SECONDS).toBe(V.VERIFICATION_WAIT_DEFAULT_SECONDS);
    expect(WAIT_MIN_SECONDS).toBe(V.VERIFICATION_WAIT_MIN_SECONDS);
    expect(WAIT_MAX_SECONDS).toBe(V.VERIFICATION_WAIT_MAX_SECONDS);
    expect(replyIdFor(CARD)).toBe(V.verificationReplyId(CARD));
    expect(V.VERIFICATION_EVENT_KIND).toBe('needs_verification');
    expect(readFileSync(inbox, 'utf-8')).toMatch(/const REPLY_TO_FIELD = 'replyTo';/);
  });
});
