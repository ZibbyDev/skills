/**
 * agentMessagingSkill tests — the three tools over a mocked door, plus the
 * contract pin against the platform's message declaration.
 *
 *   - list_running_agents: the descendants walk (transitive, self excluded, a
 *     chain that leaves the active set is not ours) and the derived clocks.
 *   - message_agent: argument validation, executionId → workflowType resolution
 *     through the active list, the body sent, a refusal surfaced as {error}.
 *   - check_messages: takes ONLY the notes addressed to THIS execution and
 *     deletes exactly those; notes without an executionId or for another run
 *     are left for the agent's own tick reader.
 *   - 🔗 TWO-PLACES: the message shape is declared once, in
 *     backend/src/services/agent-inbox.js. This suite reads that file from the
 *     sibling checkout and pins every field name parseInboxNote relies on.
 *
 * No real network — `fetchWithDeadline` (the package's one HTTP door) is
 * mocked and the requests it saw are asserted on.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const door = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../lib/http-deadline.js', () => ({ fetchWithDeadline: door.fetch }));

const SELF = 'exec-self-0001';
const ENV = {
  PROJECT_API_TOKEN: 'contract-test-placeholder', // deliberately NOT credential-shaped (public repo)
  ZIBBY_ACCOUNT_API_URL: 'http://cp.local',
  EXECUTION_ID: SELF,
  PROJECT_ID: 'proj-1',
  WORKFLOW_TYPE: 'project-manager',
};
Object.assign(process.env, ENV);

const {
  agentMessagingSkill, descendantsOf, compactRun, parseInboxNote, mailboxPrefix, DRAIN_MAX_PAGES, INBOX_TTL_DAYS, LIST_LIMIT_MAX,
  logsQuery, LOG_LINES_MAX, LOG_LINE_MAX_CHARS,
} = await import('../agentMessaging.js');

const call = (name: string, args: any = {}) => agentMessagingSkill.handleToolCall(name, args).then(JSON.parse);

/** Route the mocked door by URL (+ body op for the kv route); record every request. */
type Seen = { url: string; method: string; body: any };
let seen: Seen[];
function mockDoor(routes: Array<[string | ((url: string, body: any) => boolean), (body: any, url: string) => any]>) {
  door.fetch.mockImplementation(async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    seen.push({ url, method: init?.method || 'GET', body });
    for (const [match, resp] of routes) {
      const hit = typeof match === 'function' ? match(url, body) : url.includes(match);
      if (!hit) continue;
      const r = resp(body, url);
      return {
        ok: r.ok !== false,
        status: r.status || (r.ok === false ? 400 : 200),
        json: async () => r.json,
        text: async () => JSON.stringify(r.json),
      };
    }
    throw new Error(`unexpected request ${init?.method || 'GET'} ${url}`);
  });
}

/** The inbox ACK route of THIS agent's mailbox (marks the row; nothing is deleted). */
const ACK_URL = /\/projects\/proj-1\/workflows\/project-manager\/inbox\/([^/?]+)\/ack$/;
const isAck = (url: string) => ACK_URL.test(url);
const ackedIds = () => seen.filter((x) => isAck(x.url)).map((x) => decodeURIComponent(ACK_URL.exec(x.url)![1]));
const ackOk = () => ({ json: { ok: true, found: true, ackedAt: '2026-09-13T10:00:05.000Z', ackedBy: { kind: 'member', workflowType: 'project-manager', executionId: SELF } } });

beforeEach(() => { seen = []; door.fetch.mockReset(); Object.assign(process.env, ENV); });
afterEach(() => { vi.clearAllMocks(); });

const NOW = Date.parse('2026-09-13T10:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

/** A project with: us, our child A (with grandchild A1), a sibling B (parent
 * not in the set), an unrelated C, and a run parented on a FINISHED run. */
const RUNS = [
  { executionId: SELF, workflowType: 'project-manager', status: 'running', createdAt: ago(30), updatedAt: ago(1) },
  { executionId: 'child-A', workflowType: 'developer', parentExecutionId: SELF, ticketKey: 'ZB-1', status: 'running', createdAt: ago(20), updatedAt: ago(5), currentStep: 'implement' },
  { executionId: 'grandchild-A1', workflowType: 'reviewer', parentExecutionId: 'child-A', status: 'running', createdAt: ago(10), updatedAt: ago(10) },
  { executionId: 'sibling-B', workflowType: 'developer', parentExecutionId: 'finished-parent', status: 'running', createdAt: ago(40), updatedAt: ago(2) },
  { executionId: 'unrelated-C', workflowType: 'scout', status: 'running', createdAt: ago(5), updatedAt: ago(0) },
];

describe('descendantsOf (pure)', () => {
  it('walks parentExecutionId transitively, excludes self, and stops when the chain leaves the set', () => {
    const ids = descendantsOf(RUNS as any, SELF).map((r: any) => r.executionId);
    expect(ids).toEqual(['child-A', 'grandchild-A1']);
  });

  it('survives a cycle in the data', () => {
    const cyc = [
      { executionId: 'x', parentExecutionId: 'y' },
      { executionId: 'y', parentExecutionId: 'x' },
      { executionId: 'z', parentExecutionId: SELF },
    ];
    expect(descendantsOf(cyc as any, SELF).map((r: any) => r.executionId)).toEqual(['z']);
  });
});

describe('list_running_agents', () => {
  it('descendants: only our subtree, with ageMinutes / idleMinutes computed locally', async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      mockDoor([['/projects/proj-1/runs/active', () => ({ json: { runs: RUNS } })]]);
      const out = await call('list_running_agents', { scope: 'descendants' });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ method: 'GET', url: 'http://cp.local/projects/proj-1/runs/active' });
      expect(out.scope).toBe('descendants');
      expect(out.runs.map((r: any) => r.executionId)).toEqual(['child-A', 'grandchild-A1']);
      expect(out.runs[0]).toEqual({
        executionId: 'child-A', workflowType: 'developer', parentExecutionId: SELF, ticketKey: 'ZB-1',
        status: 'running', currentStep: 'implement', ageMinutes: 20, idleMinutes: 5, relation: 'child',
      });
      // Nothing leaks that the model does not need (no raw timestamps).
      expect(Object.keys(out.runs[0])).not.toContain('createdAt');
    } finally {
      vi.useRealTimers();
    }
  });

  it('project (default): every active run except this one, each tagged with its relation to us', async () => {
    mockDoor([['/runs/active', () => ({ json: { runs: RUNS } })]]);
    const out = await call('list_running_agents');
    expect(out.scope).toBe('project');
    expect(out.runs.map((r: any) => [r.executionId, r.relation])).toEqual([
      ['child-A', 'child'], ['grandchild-A1', 'child'], ['sibling-B', 'other'], ['unrelated-C', 'other'],
    ]);
  });

  it('a WORKER sees its teammates: the manager that started it as "parent", the other runs that manager started as "sibling"', async () => {
    const pm = 'pm-tick-1';
    const runs = [
      { executionId: pm, workflowType: 'board-runner', status: 'running', createdAt: ago(3), updatedAt: ago(0) },
      { executionId: SELF, workflowType: 'developer', parentExecutionId: pm, status: 'running', createdAt: ago(2), updatedAt: ago(0) },
      { executionId: 'dev-2', workflowType: 'developer', parentExecutionId: pm, ticketKey: 'KAN-14', status: 'running', createdAt: ago(2), updatedAt: ago(1) },
      { executionId: 'po-1', workflowType: 'product-owner', parentExecutionId: pm, status: 'running', createdAt: ago(1), updatedAt: ago(0) },
      { executionId: 'qa-solo', workflowType: 'product-qa', status: 'running', createdAt: ago(9), updatedAt: ago(4) },
    ];
    mockDoor([['/runs/active', () => ({ json: { runs } })]]);
    const out = await call('list_running_agents');
    expect(out.runs.map((r: any) => [r.executionId, r.relation])).toEqual([
      [pm, 'parent'], ['dev-2', 'sibling'], ['po-1', 'sibling'], ['qa-solo', 'other'],
    ]);
    // A worker started nothing, so the descendants view is honestly empty.
    expect(await call('list_running_agents', { scope: 'descendants' })).toEqual({ scope: 'descendants', note: 'no active runs' });
  });

  it('tolerates the {data:{runs}} envelope', async () => {
    mockDoor([['/runs/active', () => ({ json: { data: { runs: RUNS } } })]]);
    const out = await call('list_running_agents', { scope: 'project' });
    expect(out.runs).toHaveLength(4);
  });

  it('says "no active runs" when the list is empty after filtering', async () => {
    mockDoor([['/runs/active', () => ({ json: { runs: [RUNS[0]] } })]]);
    expect(await call('list_running_agents')).toEqual({ scope: 'project', note: 'no active runs' });
  });

  it('errors without PROJECT_ID, and never opens the door', async () => {
    delete process.env.PROJECT_ID;
    mockDoor([]);
    const out = await call('list_running_agents');
    expect(out.error).toMatch(/PROJECT_ID/);
    expect(seen).toHaveLength(0);
  });

  it('surfaces a backend refusal as {error}', async () => {
    mockDoor([['/runs/active', () => ({ ok: false, status: 403, json: { error: 'This token is not authorized for that project' } })]]);
    expect((await call('list_running_agents')).error).toBe('This token is not authorized for that project');
  });
});

describe('message_agent', () => {
  it('requires text', async () => {
    mockDoor([]);
    expect((await call('message_agent', { workflowType: 'developer' })).error).toMatch(/text is required/);
    expect(seen).toHaveLength(0);
  });

  it('requires exactly one of executionId / workflowType', async () => {
    mockDoor([]);
    expect((await call('message_agent', { text: 'hi' })).error).toMatch(/exactly one of executionId/);
    expect((await call('message_agent', { text: 'hi', executionId: 'child-A', workflowType: 'developer' })).error).toMatch(/not both/);
    expect(seen).toHaveLength(0);
  });

  it('by workflowType: POSTs the inbox with text/ticketKey/from and passes the reply through', async () => {
    mockDoor([['/workflows/developer/inbox', (body) => ({
      json: { ok: true, messageId: 'note-1', agent: 'developer', woke: false, delivered: 'Stored in the agent\'s inbox; it reads it on its next run.' },
    })]]);
    const out = await call('message_agent', { workflowType: 'developer', text: 'please pick up ZB-7', ticketKey: 'ZB-7' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: 'http://cp.local/projects/proj-1/workflows/developer/inbox',
      body: { text: 'please pick up ZB-7', ticketKey: 'ZB-7', from: 'project-manager' },
    });
    expect(seen[0].body).not.toHaveProperty('executionId');
    expect(out).toEqual({
      ok: true, messageId: 'note-1', woke: false,
      delivered: 'Stored in the agent\'s inbox; it reads it on its next run.',
      to: { workflowType: 'developer' },
      receipt: expect.stringMatching(/store-and-ring/),
    });
  });

  it('by executionId: resolves the type from runs/active (one extra GET), then POSTs with executionId', async () => {
    mockDoor([
      ['/runs/active', () => ({ json: { runs: RUNS } })],
      ['/workflows/reviewer/inbox', () => ({ json: { ok: true, messageId: 'note-2', woke: true, delivered: 'The agent is waking up to read it now.' } })],
    ]);
    const out = await call('message_agent', { executionId: 'grandchild-A1', text: 'the diff moved to main' });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET http://cp.local/projects/proj-1/runs/active',
      'POST http://cp.local/projects/proj-1/workflows/reviewer/inbox',
    ]);
    expect(seen[1].body).toEqual({ text: 'the diff moved to main', executionId: 'grandchild-A1', from: 'project-manager' });
    expect(out).toMatchObject({ ok: true, messageId: 'note-2', woke: true, to: { executionId: 'grandchild-A1', workflowType: 'reviewer' } });
  });

  it('by executionId: an id that is not running is an error, and nothing is posted', async () => {
    mockDoor([['/runs/active', () => ({ json: { runs: RUNS } })]]);
    const out = await call('message_agent', { executionId: 'gone-9', text: 'hello?' });
    expect(out.error).toMatch(/no running run gone-9/);
    expect(seen.filter((s) => s.method === 'POST')).toHaveLength(0);
  });

  // WAKE-MY-FUTURE-SELF. The incident: a member told to wait could only stand
  // guard in sleep loops until the watchdog killed the run. The move that
  // exists now is a note to a LATER round — and the refusals have to TEACH it,
  // or the model simply retries the thing that does not work.
  it('refuses to address its OWN LIVE RUN, and the refusal names the move that works', async () => {
    mockDoor([['/runs/active', () => ({ json: { runs: RUNS } })]]);
    const out = await call('message_agent', { executionId: SELF, text: 'note to self' });
    expect(out.code).toBe('self_run_addressed');
    expect(out.error).toMatch(/delaySeconds/);
    expect(out.error).toMatch(/workflowType/);
    expect(out.error).toMatch(/no memory/);
    expect(seen).toHaveLength(0);          // not even a lookup
  });

  it('addressed to its OWN AGENT with a delay: posted, and the reply says when it is held until', async () => {
    mockDoor([['/workflows/project-manager/inbox', () => ({
      json: { ok: true, messageId: 'note-3', woke: false, notBefore: '2026-09-19T10:05:00.000Z', delivered: 'Held until 2026-09-19T10:05:00.000Z.' },
    })]]);
    const out = await call('message_agent', { workflowType: 'project-manager', text: 'CI job 8123: check it and continue ZB-7', delaySeconds: 300 });
    expect(seen[0].body).toMatchObject({ text: 'CI job 8123: check it and continue ZB-7', delaySeconds: 300 });
    expect(out).toMatchObject({ ok: true, notBefore: '2026-09-19T10:05:00.000Z' });
  });

  it('a delay aimed at a specific run is refused here, before the round-trip', async () => {
    mockDoor([['/runs/active', () => ({ json: { runs: RUNS } })]]);
    const out = await call('message_agent', { executionId: 'grandchild-A1', text: 'later', delaySeconds: 300 });
    expect(out.code).toBe('deferred_run_refused');
    expect(out.error).toMatch(/workflowType/);
    expect(seen).toHaveLength(0);
  });

  it('a 400 credential_refused comes back as a plain {error} sentence', async () => {
    const refused = 'The message contains something shaped like a key or token, so it was not delivered.';
    mockDoor([['/inbox', () => ({ ok: false, status: 400, json: { error: refused, code: 'credential_refused' } })]]);
    const out = await call('message_agent', { workflowType: 'developer', text: 'use this: contract-test-placeholder' });
    expect(out).toEqual({ error: refused });
  });
});

describe('check_messages', () => {
  const PREFIX = 'project-manager:doorbell:';
  const note = (id: string, m: Record<string, any>) => ({
    scope: `${PREFIX}${id}`,
    content: JSON.stringify({ id, at: '2026-09-13T09:59:00.000Z', from: { kind: 'human', name: 'leo' }, about: {}, text: 'x', needsAck: true, ...m }),
    createdAt: '2026-09-13T09:59:00.000Z',
  });

  it('takes ONLY notes addressed to this execution, acknowledges exactly those (kept as history), leaves the rest', async () => {
    const rows = [
      note('n1', { about: { executionId: SELF, ticketKey: 'ZB-1' }, text: 'for you, about ZB-1' }),
      note('n2', { about: { ticketKey: 'ZB-2' }, text: 'for the tick reader (no executionId)' }),
      note('n3', { about: { executionId: 'someone-else' }, text: 'for another run' }),
      // A platform child_done note — not an inbox message at all; must stay.
      { scope: `${PREFIX}n4`, content: JSON.stringify({ why: 'child_done', worker: 'developer', outcome: 'success', executionId: 'child-A' }) },
      note('n5', { about: { executionId: SELF }, from: { kind: 'member', name: 'developer' }, text: 'second one for you' }),
      // A corrupt row — left alone (the tick reader owns junk).
      { scope: `${PREFIX}n6`, content: '{not json' },
    ];
    mockDoor([
      [isAck, () => ackOk()],
      [
        (url, body) => url.endsWith('/credits/review-memory'),
        (body) => {
          if (body.op === 'recall-prefix') return { json: { count: rows.length, truncated: false, memories: rows } };
          return { ok: false, status: 400, json: { error: `unexpected op ${body.op}` } };
        },
      ],
    ]);

    const out = await call('check_messages');
    expect(seen[0].body).toEqual({ op: 'recall-prefix', scopePrefix: PREFIX });
    expect(out.messages).toEqual([
      { id: 'n1', at: '2026-09-13T09:59:00.000Z', from: { kind: 'human', name: 'leo' }, ticketKey: 'ZB-1', text: 'for you, about ZB-1' },
      { id: 'n5', at: '2026-09-13T09:59:00.000Z', from: { kind: 'member', name: 'developer' }, text: 'second one for you' },
    ]);
    expect(out.left).toBe(4);
    // ACKNOWLEDGED through the inbox route (marked, kept) — never a kv delete.
    expect(ackedIds()).toEqual(['n1', 'n5']);
    expect(seen.filter((x) => x.body?.op === 'delete')).toHaveLength(0);
    // …and the plumbing never reaches the model.
    for (const m of out.messages) { expect(m).not.toHaveProperty('ackedAt'); expect(m).not.toHaveProperty('ackedBy'); }
    expect(out).not.toHaveProperty('more');
    expect(out).not.toHaveProperty('error');
  });

  it('follows nextCursor page by page, capped at DRAIN_MAX_PAGES, and reports more', async () => {
    const pages: any[] = [];
    mockDoor([[isAck, () => ackOk()], [
      (url) => url.endsWith('/credits/review-memory'),
      (body) => {
        pages.push(body.cursor || null);
        const n = pages.length;
        return { json: { truncated: true, nextCursor: `${PREFIX}p${n}`, memories: [note(`p${n}`, { about: { executionId: SELF }, text: `page ${n}` })] } };
      },
    ]]);
    const out = await call('check_messages');
    expect(pages).toHaveLength(DRAIN_MAX_PAGES);
    expect(pages[1]).toBe(`${PREFIX}p1`);
    expect(out.messages.map((m: any) => m.text)).toEqual(['page 1', 'page 2', 'page 3', 'page 4']);
    expect(out.more).toBe(true);
  });

  it('fail-soft: an unreadable page ends the check with what it has, as {messages, left, error}', async () => {
    mockDoor([[
      (url) => url.endsWith('/credits/review-memory'),
      () => ({ ok: false, status: 502, json: { error: 'upstream down' } }),
    ]]);
    expect(await call('check_messages')).toEqual({ messages: [], left: 0, error: 'upstream down' });
  });

  // ⛔ THE CLASS: a tool that reports a write it never read the answer to.
  // Live 2026-09-20 (board-runner): the mailbox refused an acknowledgement with
  // a 400, the tool had already said "acknowledged", and the manager answered
  // the same message seven rounds in six minutes. Here the mark is made at tool
  // time, so the only defence is the RESULT saying which ids the mailbox
  // actually took and which it refused, in the platform's own words.
  it('an ack the mailbox REFUSES is reported per id, with the reason, and never as success', async () => {
    const rows = [
      note('n1', { about: { executionId: SELF }, text: 'first' }),
      note('n2', { about: { executionId: SELF }, text: 'second' }),
    ];
    mockDoor([
      [isAck, (_body, url) => (url.includes('/n2/') ? { ok: false, status: 400, json: { error: 'message n2 is not in this mailbox' } } : ackOk())],
      [(url: string) => url.endsWith('/credits/review-memory'), () => ({ json: { truncated: false, memories: rows } })],
    ]);

    const out = await call('check_messages');
    // Both notes are still handed over — losing one is the worse direction.
    expect(out.messages.map((m: any) => m.id)).toEqual(['n1', 'n2']);
    // …but the result tells the truth about the MARK, per id.
    expect(out.acknowledged).toEqual(['n1']);
    expect(out.ackFailed).toEqual([{ id: 'n2', reason: 'message n2 is not in this mailbox' }]);
    expect(out.ackNote).toMatch(/STILL in your mailbox/);
    expect(out.ackNote).toMatch(/ONCE/);
  });

  it('a completion whose acknowledgement is refused is named in ackFailed, not silently re-listed', async () => {
    const receipt = {
      scope: `${PREFIX}c1`,
      content: JSON.stringify({ why: 'child_done', worker: 'developer', outcome: 'success', executionId: 'child-A', completion: { summary: 'done' }, at: '2026-09-13T09:59:00.000Z' }),
    };
    mockDoor([
      [isAck, () => ({ ok: false, status: 502, json: { error: 'the mailbox is unavailable' } })],
      [(url: string) => url.endsWith('/credits/review-memory'), () => ({ json: { truncated: false, memories: [receipt] } })],
    ]);

    const out = await call('check_messages', { acknowledgeCompletions: ['c1'] });
    expect(out).not.toHaveProperty('acknowledged');
    expect(out.ackFailed).toEqual([{ id: 'c1', reason: 'the mailbox is unavailable' }]);
    // The receipt comes back too, so the manager can see what it still owes.
    expect(out.completions.map((c: any) => c.id)).toEqual(['c1']);
  });

  it('when every mark lands, the result names the ids and carries no failure shape', async () => {
    mockDoor([
      [isAck, () => ackOk()],
      [(url: string) => url.endsWith('/credits/review-memory'), () => ({ json: { truncated: false, memories: [note('n1', { about: { executionId: SELF }, text: 'x' })] } })],
    ]);
    const out = await call('check_messages');
    expect(out.acknowledged).toEqual(['n1']);
    expect(out).not.toHaveProperty('ackFailed');
    expect(out).not.toHaveProperty('ackNote');
  });

  it('errors without EXECUTION_ID or WORKFLOW_TYPE, and never opens the door', async () => {
    mockDoor([]);
    delete process.env.EXECUTION_ID;
    expect((await call('check_messages')).error).toMatch(/EXECUTION_ID/);
    process.env.EXECUTION_ID = SELF;
    delete process.env.WORKFLOW_TYPE;
    expect((await call('check_messages')).error).toMatch(/WORKFLOW_TYPE/);
    expect(seen).toHaveLength(0);
  });
});

describe('a note held for later is not handed over early', () => {
  const PREFIX = 'project-manager:doorbell:';
  it('leaves a not-yet-due note where it is, and takes it once the instant passes', async () => {
    const row = (notBefore: string | null) => ({
      scope: `${PREFIX}n1`,
      content: JSON.stringify({
        id: 'n1', at: '2026-09-13T09:59:00.000Z', from: { kind: 'member', name: 'developer' },
        about: { executionId: SELF }, text: 'x', needsAck: true, ...(notBefore ? { notBefore } : {}),
      }),
    });
    const future = new Date(Date.now() + 600000).toISOString();
    mockDoor([[isAck, () => ackOk()], [(u: string) => u.includes('/credits/review-memory'), (body: any) => (
      body.op === 'recall-prefix' ? { json: { memories: [row(future)] } } : { json: { ok: true } })]]);
    const held = await call('check_messages');
    expect(held).toMatchObject({ messages: [], left: 1 });
    expect(ackedIds()).toEqual([]);

    seen = [];
    const past = new Date(Date.now() - 1000).toISOString();
    mockDoor([[isAck, () => ackOk()], [(u: string) => u.includes('/credits/review-memory'), (body: any) => (
      body.op === 'recall-prefix' ? { json: { memories: [row(past)] } } : { json: { ok: true } })]]);
    const due = await call('check_messages');
    expect(due.messages).toHaveLength(1);
    // The plumbing field never reaches the model.
    expect(due.messages[0]).not.toHaveProperty('notBefore');
    expect(ackedIds()).toEqual(['n1']);
  });
});

describe('the skill object', () => {
  it('spawns the generic MCP server pointing at dist/agentMessaging.js, forwarding identity + session env', () => {
    const spec = agentMessagingSkill.resolve();
    expect(spec.command).toBe('node');
    expect(spec.args.slice(1)).toEqual(['../dist/agentMessaging.js', 'agentMessagingSkill']);
    for (const k of ['PROJECT_API_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'EXECUTION_ID', 'PROJECT_ID', 'WORKFLOW_TYPE']) {
      expect(spec.env[k], k).toBe(ENV[k as keyof typeof ENV]);
    }
    expect(agentMessagingSkill.serverName).toBe('agent_messaging');
    expect(agentMessagingSkill.allowedTools).toEqual(['mcp__agent_messaging__*']);
    expect(agentMessagingSkill.tools.map((t: any) => t.name)).toEqual(['list_running_agents', 'read_run_logs', 'message_agent', 'check_messages', 'list_messages']);
  });

  it('unknown tool → {error}', async () => {
    expect(await call('nope')).toEqual({ error: 'Unknown tool: nope' });
  });

  it('is registered under its id with the shared toggle metadata', async () => {
    const { SKILL_IDS, SKILL_META } = await import('@zibby/skill-ids');
    expect(SKILL_IDS.AGENT_MESSAGING).toBe(agentMessagingSkill.id);
    expect(agentMessagingSkill.meta).toBe(SKILL_META['agent-messaging']);
    expect(agentMessagingSkill.meta).toMatchObject({ toggleable: true, requiresIntegration: false, tier: 1, defaultEnabled: true });
  });
});

/**
 * 🔗 TWO-PLACES — the message contract lives in backend/src/services/agent-inbox.js
 * and this skill cannot import it. When the sibling checkout is present, read the
 * declaration and pin the names parseInboxNote relies on; a rename there fails
 * HERE, not in a run. (Absent checkout — a standalone clone of this public repo —
 * the pin is reported as skipped, never as passed.)
 */
describe('contract pin: agent-inbox.js message shape', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const backendFile = join(here, '..', '..', '..', '..', 'backend', 'src', 'services', 'agent-inbox.js');
  const present = existsSync(backendFile);

  it.skipIf(!present)('the platform declares exactly the fields this skill reads', () => {
    const src = readFileSync(backendFile, 'utf-8');
    // The header's one-line contract.
    expect(src).toMatch(/\{\s*id,\s*at,\s*from:\s*\{kind:\s*'human'\|'member'\|'platform',\s*name,\s*workflowType\?,\s*executionId\?\s*\},?\s*\n?\s*\*?\s*about:\s*\{ticketKey\?,\s*executionId\?\},\s*text,\s*needsAck,\s*notBefore\?,\s*ackedAt\?,\s*ackedBy\?\s*\}/);
    // Every key of the message, declared once — a field this skill reads that
    // the platform no longer writes is drift.
    const list = (name: string) => {
      const m = new RegExp(`const ${name} = Object\\.freeze\\(\\[([^\\]]*)\\]\\)`).exec(src);
      expect(m, `${name} must be declared in agent-inbox.js`).toBeTruthy();
      return m![1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
    };
    expect(list('MESSAGE_FIELDS')).toEqual(['id', 'at', 'from', 'about', 'text', 'needsAck', 'notBefore', 'afterExecutionId', 'ackedAt', 'ackedBy']);
    // The address vocabulary, declared once.
    expect(list('ABOUT_FIELDS')).toEqual(['ticketKey', 'executionId']);
    // The SENDER vocabulary: what parseInboxNote reads off `from` is exactly this.
    expect(list('FROM_FIELDS')).toEqual(['kind', 'name', 'workflowType', 'executionId']);
    // The acknowledgement keys, and the retention window both ends age on.
    expect(list('ACK_FIELDS')).toEqual(['ackedAt', 'ackedBy']);
    const ttl = /const INBOX_TTL_DAYS = (\d+)/.exec(src);
    expect(Number(ttl && ttl[1])).toBe(INBOX_TTL_DAYS);
    const lim = /const LIST_LIMIT_MAX = (\d+)/.exec(src);
    expect(Number(lim && lim[1])).toBe(LIST_LIMIT_MAX);
    // The sender kinds.
    const kinds = /const SENDER_KINDS = Object\.freeze\(\[([^\]]*)\]\)/.exec(src);
    expect(kinds).toBeTruthy();
    expect(kinds![1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))).toEqual(['human', 'member', 'platform']);
    // The built message object literal carries every key in the order declared.
    for (const key of ['id,', 'at:', 'about: {', 'text: body,', 'needsAck: true']) {
      expect(src, `agent-inbox.js buildInboxMessage must still write \`${key}\``).toContain(key);
    }
    expect(src, 'agent-inbox.js buildInboxMessage must still write `from: { kind, …`').toMatch(/from:\s*\{\s*kind,/);
  });

  it.skipIf(!present)('the delay bounds the model is shown are the platform\'s own', () => {
    const src = readFileSync(backendFile, 'utf-8');
    const min = /const DELAY_MIN_SECONDS = (\d+)/.exec(src);
    const max = /const DELAY_MAX_SECONDS = (\d+)/.exec(src);
    expect(min && max, 'agent-inbox.js must declare the delay bounds').toBeTruthy();
    const tool = agentMessagingSkill.tools.find((t: any) => t.name === 'message_agent');
    const field = tool.input_schema.properties.delaySeconds;
    // A schema that offers a range the backend refuses spends a round per try.
    expect(field.minimum).toBe(Number(min![1]));
    expect(field.maximum).toBe(Number(max![1]));
  });

  // A CAPABILITY NOBODY IS TAUGHT TO USE IS NOT SHIPPED. The same mistake was
  // made hours earlier: the default build gained public network access while
  // the skill text still told members to enumerate every host, so the new
  // default never fired once. These assertions are on the WORDS the model reads.
  it('the tool description and the prompt teach WHEN to use a delayed note, not just how', () => {
    const tool = agentMessagingSkill.tools.find((t: any) => t.name === 'message_agent');
    const d = tool.description as string;
    expect(d).toMatch(/delaySeconds/);
    expect(d).toMatch(/instead of sleeping or polling/i);
    expect(d).toMatch(/platform will NOT announce|not announce/i);
    expect(d).toMatch(/build/i);                       // the case it is NOT for
    const p = agentMessagingSkill.promptFragment as string;
    expect(p).not.toMatch(/Never sleep, never loop|END YOUR ROUND/);
    expect(p).toContain('Sending a build request does not require handing the work to a manager');
    expect(p).toContain('Use delayed delivery for follow-ups');
    expect(p).toContain('external CI');
    expect(p).toContain('another agent');
    // And the note must carry its own context.
    expect(p).toMatch(/no memory of this round|remembers nothing/i);
  });

  it('parseInboxNote reads a message built to that declaration (sample fixture)', () => {
    // The sample is the shape buildInboxMessage() returns for a member post with
    // both address keys — if the declaration above changes, so must this fixture.
    const sample = {
      id: '000001757757600000-ab12', at: '2026-09-13T09:00:00.000Z',
      from: { kind: 'member', name: 'project-manager' },
      about: { ticketKey: 'ZB-9', executionId: SELF },
      text: 'hello', needsAck: true,
    };
    const parsed = parseInboxNote({ scope: `${mailboxPrefix()}${sample.id}`, content: JSON.stringify(sample) });
    expect(parsed).toEqual({
      id: sample.id, at: sample.at, from: { kind: 'member', name: 'project-manager' },
      ticketKey: 'ZB-9', executionId: SELF, text: 'hello', notBefore: null, afterExecutionId: null, ackedAt: null, ackedBy: null,
    });
    // A member's identity and an acknowledgement travel through the parser.
    const withIdentity = parseInboxNote({ scope: 'x', content: JSON.stringify({ ...sample, from: { ...sample.from, workflowType: 'project-manager', executionId: 'run-pm-1' }, ackedAt: '2026-09-13T10:00:05.000Z', ackedBy: { kind: 'member', workflowType: 'developer' } }) });
    expect(withIdentity).toMatchObject({ from: { kind: 'member', name: 'project-manager', workflowType: 'project-manager', executionId: 'run-pm-1' }, ackedAt: '2026-09-13T10:00:05.000Z', ackedBy: { kind: 'member', workflowType: 'developer' } });
    // A platform note (parent-bell child_done) is NOT an inbox message.
    expect(parsedNull({ why: 'child_done', worker: 'developer' })).toBeNull();
  });

  const parsedNull = (obj: any) => parseInboxNote({ scope: 'x', content: JSON.stringify(obj) });
});


describe('read_run_logs', () => {
  const PAGE = {
    workflowType: 'developer', status: 'running', pagingMode: 'line-tail', totalLines: 900, hasOlder: true,
    lines: [{ timestamp: null, line: 899, message: '[developer] running tests' }, { timestamp: null, line: 900, message: 'x'.repeat(LOG_LINE_MAX_CHARS + 5) }],
  };

  it('defaults to THIS run, tail, 100 lines — on the existing logs route', async () => {
    mockDoor([['/logs/', () => ({ json: PAGE })]]);
    const out = await call('read_run_logs');
    expect(seen).toHaveLength(1);
    const u = new URL(seen[0].url);
    expect(u.pathname).toBe(`/logs/proj-1/${SELF}`);
    expect(Object.fromEntries(u.searchParams)).toEqual({ limit: '100', from: 'tail' });
    expect(out.executionId).toBe(SELF);
    expect(out.status).toBe('running');
    expect(out.lines[0]).toEqual({ line: 899, text: '[developer] running tests' });
    expect(out.lines[1].text).toMatch(/… \[5 more chars\]$/);
    expect(out.hasOlder).toBe(true);
  });

  it('head / search / lines / cursor map onto the route knobs', async () => {
    mockDoor([['/logs/', () => ({ json: { lines: [], nextToken: 'cw-next' } })]]);
    await call('read_run_logs', { executionId: 'child-A', mode: 'head', lines: 20 });
    const out = await call('read_run_logs', { executionId: 'child-A', mode: 'search', query: 'FAIL', lines: 9999, cursor: 'c1' });
    expect(Object.fromEntries(new URL(seen[0].url).searchParams)).toEqual({ limit: '20', from: 'head' });
    expect(Object.fromEntries(new URL(seen[1].url).searchParams)).toEqual({ limit: String(LOG_LINES_MAX), q: 'FAIL', nextToken: 'c1' });
    expect(new URL(seen[1].url).pathname).toBe('/logs/proj-1/child-A');
    expect(out.cursor).toBe('cw-next');
  });

  it('uses RUN_LOGS_API_URL when the platform injects it (cloud), the account API otherwise', async () => {
    mockDoor([['/logs/', () => ({ json: { lines: [] } })]]);
    process.env.RUN_LOGS_API_URL = 'https://logs.example.test/';
    try { await call('read_run_logs', { executionId: 'child-A' }); } finally { delete process.env.RUN_LOGS_API_URL; }
    await call('read_run_logs', { executionId: 'child-A' });
    expect(new URL(seen[0].url).origin).toBe('https://logs.example.test');
    expect(new URL(seen[1].url).origin).toBe('http://cp.local');
  });

  it('bad arguments are refused before any request', async () => {
    mockDoor([]);
    expect((await call('read_run_logs', { mode: 'search' })).error).toMatch(/query is required/);
    expect((await call('read_run_logs', { mode: 'middle' })).error).toMatch(/mode must be/);
    expect((await call('read_run_logs', { lines: 0 })).error).toMatch(/lines must be/);
    expect(seen).toHaveLength(0);
    expect('error' in logsQuery({ mode: 'search', query: 'q'.repeat(201) })).toBe(true);
  });

  it('a refusal from the platform comes back as {error}', async () => {
    mockDoor([['/logs/', () => ({ ok: false, status: 403, json: { error: 'This token is not authorized for that project' } })]]);
    const out = await call('read_run_logs', { executionId: 'other' });
    expect(out.error).toMatch(/not authorized/);
  });

  it('is declared as a tool and mentioned in the prompt', () => {
    expect(agentMessagingSkill.tools.map((t: any) => t.name)).toContain('read_run_logs');
    expect(agentMessagingSkill.promptFragment).toMatch(/read_run_logs/);
  });
});

it('a due reminder reaches a future run but never the run that wrote it', async () => {
  const row = (id:string, afterExecutionId:string, notBefore:string) => ({scope:`project-manager:doorbell:${id}`,
    content:JSON.stringify({id,text:'Check external CI for Vikunja, then continue setup',from:{kind:'member',name:'developer'},about:{},needsAck:true,notBefore,afterExecutionId})});
  mockDoor([[isAck,()=>ackOk()],[(u:string)=>u.includes('/credits/review-memory'),(body:any)=>body.op==='recall-prefix'
    ? {json:{memories:[row('past','old-run',new Date(Date.now()-1000).toISOString()),row('self',SELF,new Date(Date.now()-1000).toISOString()),row('future','old-run',new Date(Date.now()+60000).toISOString())]}}
    : {json:{ok:true}}]]);
  const result = await call('check_messages');
  expect(result.messages.map((m:any)=>m.id)).toEqual(['past']);
  expect(result.left).toBe(2);
});
it('immediate self messages by agent type are refused without HTTP', async () => {
  expect(await call('message_agent',{workflowType:ENV.WORKFLOW_TYPE,text:'loop'})).toMatchObject({code:'self_delay_required'});
  expect(seen).toHaveLength(0);
});

it('any parent reads ticketless completion context and explicitly acknowledges it only after handling', async () => {
 const scope=mailboxPrefix()+'completion:child:completed';
 const row={scope,content:JSON.stringify({why:'child_done',worker:'any-member',executionId:'child',completion:{result:{summary:'Ready at http://example.test'}}})};
 // The ack route MARKS the row (kept); the next read sees it as history.
 mockDoor([[isAck,(_b,url)=>{ expect(decodeURIComponent(ACK_URL.exec(url)![1])).toBe('completion:child:completed'); const stored=JSON.parse(row.content); stored.ackedAt='2026-09-13T10:00:05.000Z'; stored.ackedBy={kind:'member',workflowType:'project-manager'}; row.content=JSON.stringify(stored); return ackOk(); }],
  ['/credits/review-memory',body=>{
  if(body.op==='recall-prefix') return {json:{memories:[row]}};
  throw new Error('Unexpected op '+body.op);
 }]]);
 const first=await call('check_messages');
 expect(first.completions[0].completion.result.summary).toContain('http://example.test');
 expect(ackedIds()).toEqual([]);
 expect((await call('check_messages')).completions).toHaveLength(1);
 await call('check_messages',{acknowledgeCompletions:[first.completions[0].id]});
 expect(ackedIds()).toEqual(['completion:child:completed']);
 // Marked, not deleted: the row is still in the mailbox, and is now history —
 // not handed over again, not counted as left.
 expect(JSON.parse(row.content).ackedAt).toBe('2026-09-13T10:00:05.000Z');
 const after=await call('check_messages');
 expect(after).toEqual({messages:[],left:0});
});

describe('history: acknowledged rows are never re-delivered, and old history is pruned', () => {
  const PREFIX = 'project-manager:doorbell:';
  const row = (id: string, m: Record<string, any>) => ({ scope: `${PREFIX}${id}`, content: JSON.stringify({ id, at: '2026-09-13T09:59:00.000Z', from: { kind: 'human', name: 'leo' }, about: { executionId: SELF }, text: 'x', needsAck: true, ...m }) });
  it('an acked note for this run is skipped (not returned, not counted, not acked again); one past the TTL is pruned', async () => {
    const old = new Date(Date.now() - (INBOX_TTL_DAYS + 1) * 86400000).toISOString();
    // "Fresh" has to be fresh AGAINST THE CLOCK THAT RUNS THE TEST. A literal
    // date is fresh only until it is INBOX_TTL_DAYS old, and then this row is
    // pruned instead of skipped and the suite goes red on a calendar day rather
    // than on a change — which is exactly what happened here.
    const fresh = new Date(Date.now() - 60_000).toISOString();
    const rows = [
      row('fresh-acked', { at: fresh, ackedAt: fresh, ackedBy: { kind: 'member', workflowType: 'project-manager' } }),
      row('old-acked', { at: old, ackedAt: old, ackedBy: { kind: 'human' } }),
      row('pending', { text: 'still for you' }),
    ];
    const deleted: string[] = [];
    mockDoor([[isAck, () => ackOk()], ['/credits/review-memory', (body) => {
      if (body.op === 'recall-prefix') return { json: { memories: rows } };
      if (body.op === 'delete') { deleted.push(body.scope); return { json: { deleted: true } }; }
      throw new Error(`Unexpected op ${body.op}`);
    }]]);
    const out = await call('check_messages');
    expect(out.messages.map((m: any) => m.id)).toEqual(['pending']);
    expect(out.left).toBe(0);
    expect(ackedIds()).toEqual(['pending']);
    expect(deleted).toEqual([`${PREFIX}old-acked`]);
  });
});

describe('list_messages — what this agent still owes, or its history', () => {
  const LIST_URL = 'http://cp.local/projects/proj-1/workflows/project-manager/inbox';
  const listed = { ok: true, agent: 'project-manager', unacked: true, count: 1, truncated: false, messages: [
    { id: 'm1', at: '2026-09-13T09:59:00.000Z', from: { kind: 'member', name: 'developer', workflowType: 'developer', executionId: 'run-dev-1' }, about: { ticketKey: 'ZB-1' }, text: 'blocked on the build', needsAck: true },
  ] };
  it('default: GET the own mailbox, pending only, rows passed through with the sender identity', async () => {
    mockDoor([[(u) => u.startsWith(LIST_URL), () => ({ json: listed })]]);
    const out = await call('list_messages');
    expect(seen[0]).toMatchObject({ url: LIST_URL, method: 'GET' });
    expect(out).toMatchObject({ unacked: true, count: 1, messages: listed.messages });
    expect(out.note).toMatch(/still yours/);
    expect(out.messages[0].from).toEqual({ kind: 'member', name: 'developer', workflowType: 'developer', executionId: 'run-dev-1' });
  });
  it('a pending self-reminder with a future notBefore is reported as a wake already scheduled', async () => {
    const future = new Date(Date.now() + 8 * 60000).toISOString();
    const rows = [
      { id: 'r1', at: '2026-09-13T09:59:00.000Z', from: { kind: 'member', name: 'project-manager', workflowType: 'project-manager', executionId: 'pm-old' }, about: { ticketKey: 'ZB-1' }, text: 're-check', needsAck: true, notBefore: future },
      { id: 'r0', at: '2026-09-13T09:00:00.000Z', from: { kind: 'member', name: 'project-manager', workflowType: 'project-manager' }, about: {}, text: 'old, due', needsAck: true, notBefore: new Date(Date.now() - 1000).toISOString() },
      { id: 'm2', at: '2026-09-13T09:59:00.000Z', from: { kind: 'member', name: 'developer', workflowType: 'developer' }, about: {}, text: 'x', needsAck: true, notBefore: future },
    ];
    mockDoor([[(u) => u.startsWith(LIST_URL), () => ({ json: { ...listed, count: rows.length, messages: rows } })]]);
    const out = await call('list_messages');
    expect(out.wakeAlreadyScheduled).toBe(true);
    expect(out.pendingWakes).toEqual([{ id: 'r1', notBefore: future, dueInMinutes: 8, ticketKey: 'ZB-1' }]);
    expect(out.note).toMatch(/ALREADY scheduled .*r1 in ~8 min.*do not schedule another/);
    // No pending self-wake → said plainly as false.
    mockDoor([[(u) => u.startsWith(LIST_URL), () => ({ json: listed })]]);
    const none = await call('list_messages');
    expect(none.wakeAlreadyScheduled).toBe(false);
    expect(none).not.toHaveProperty('pendingWakes');
  });
  it('unacked:false / ticketKey / limit map onto the route query; a bad limit is refused before any request', async () => {
    mockDoor([[(u) => u.startsWith(LIST_URL), () => ({ json: { data: { ...listed, unacked: false } } })]]);
    const out = await call('list_messages', { unacked: false, ticketKey: 'ZB-1', limit: 5 });
    const u = new URL(seen[0].url);
    expect(Object.fromEntries(u.searchParams)).toEqual({ unacked: 'false', ticketKey: 'ZB-1', limit: '5' });
    expect(out.unacked).toBe(false);
    expect(out.note).toMatch(/history/i);
    seen = [];
    expect((await call('list_messages', { limit: 0 })).error).toMatch(/limit/);
    expect((await call('list_messages', { limit: 101 })).error).toMatch(/limit/);
    expect(seen).toHaveLength(0);
  });
  it('a refusal (another agent\'s mailbox, per the platform) comes back as {error}; missing identity never opens the door', async () => {
    mockDoor([[(u) => u.startsWith(LIST_URL), () => ({ ok: false, status: 403, json: { error: 'A run reads and acknowledges only its own agent\'s mailbox' } })]]);
    expect((await call('list_messages')).error).toMatch(/own agent/);
    seen = [];
    delete process.env.WORKFLOW_TYPE;
    expect((await call('list_messages')).error).toMatch(/WORKFLOW_TYPE/);
    expect(seen).toHaveLength(0);
  });
  it('is declared as a tool and the prompt teaches the take-over rules around it', () => {
    const tool = agentMessagingSkill.tools.find((t: any) => t.name === 'list_messages');
    expect(tool).toBeTruthy();
    expect(tool.input_schema.properties.unacked.type).toBe('boolean');
    expect(tool.input_schema.properties.limit.maximum).toBe(LIST_LIMIT_MAX);
    const p = agentMessagingSkill.promptFragment as string;
    expect(p).toContain('list_messages');
    expect(p).toMatch(/TICKET FIRST/);
    expect(p).toMatch(/assignee field cannot tell agents apart/);
    expect(p).toMatch(/dispatch worker=<agent> exec=<executionId>/);
    expect(p).toMatch(/SELF-SUFFICIENT/);
    expect(p).toMatch(/ON WAKING/);
    expect(p).toMatch(/ONE wake/);
    expect(p).toMatch(/3 self-wakes/);
    expect(p).toMatch(/human column/);
    expect(p).toMatch(/from\.workflowType/);
    expect(p).toMatch(/No receipt will ever come/);
    expect(p).toMatch(/run\s+log is evidence to cite/);
  });
  it('message_agent says on every result that no receipt will come', async () => {
    mockDoor([['/workflows/developer/inbox', () => ({ json: { ok: true, messageId: 'note-1', woke: false } })]]);
    const out = await call('message_agent', { workflowType: 'developer', text: 'please pick up ZB-7' });
    expect(out.receipt).toMatch(/store-and-ring/);
    expect(out.receipt).toMatch(/No receipt/i);
    expect(agentMessagingSkill.tools.find((t: any) => t.name === 'message_agent').description).toMatch(/NO receipt/);
  });
});
