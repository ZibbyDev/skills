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
  agentMessagingSkill, descendantsOf, compactRun, parseInboxNote, mailboxPrefix, DRAIN_MAX_PAGES,
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

  it('takes ONLY notes addressed to this execution, deletes exactly those, leaves the rest', async () => {
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
    const deleted: string[] = [];
    mockDoor([[
      (url, body) => url.endsWith('/credits/review-memory'),
      (body) => {
        if (body.op === 'recall-prefix') return { json: { count: rows.length, truncated: false, memories: rows } };
        if (body.op === 'delete') { deleted.push(body.scope); return { json: { deleted: true, scope: body.scope } }; }
        return { ok: false, status: 400, json: { error: `unexpected op ${body.op}` } };
      },
    ]]);

    const out = await call('check_messages');
    expect(seen[0].body).toEqual({ op: 'recall-prefix', scopePrefix: PREFIX });
    expect(out.messages).toEqual([
      { id: 'n1', at: '2026-09-13T09:59:00.000Z', from: { kind: 'human', name: 'leo' }, ticketKey: 'ZB-1', text: 'for you, about ZB-1' },
      { id: 'n5', at: '2026-09-13T09:59:00.000Z', from: { kind: 'member', name: 'developer' }, text: 'second one for you' },
    ]);
    expect(out.left).toBe(4);
    expect(deleted).toEqual([`${PREFIX}n1`, `${PREFIX}n5`]);
    expect(out).not.toHaveProperty('more');
    expect(out).not.toHaveProperty('error');
  });

  it('follows nextCursor page by page, capped at DRAIN_MAX_PAGES, and reports more', async () => {
    const pages: any[] = [];
    mockDoor([[
      (url) => url.endsWith('/credits/review-memory'),
      (body) => {
        if (body.op === 'delete') return { json: { deleted: true } };
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
    expect(agentMessagingSkill.tools.map((t: any) => t.name)).toEqual(['list_running_agents', 'message_agent', 'check_messages']);
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
    expect(src).toMatch(/\{\s*id,\s*at,\s*from:\s*\{kind:\s*'human'\|'member'\|'platform',\s*name\s*\},?\s*\n?\s*\*?\s*about:\s*\{ticketKey\?,\s*executionId\?\},\s*text,\s*needsAck\s*\}/);
    // The address vocabulary, declared once.
    const about = /const ABOUT_FIELDS = Object\.freeze\(\[([^\]]*)\]\)/.exec(src);
    expect(about, 'ABOUT_FIELDS must be declared in agent-inbox.js').toBeTruthy();
    const aboutFields = about![1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    expect(aboutFields).toEqual(['ticketKey', 'executionId']);
    // The sender kinds.
    const kinds = /const SENDER_KINDS = Object\.freeze\(\[([^\]]*)\]\)/.exec(src);
    expect(kinds).toBeTruthy();
    expect(kinds![1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))).toEqual(['human', 'member', 'platform']);
    // The built message object literal carries every key in the order declared.
    for (const key of ['id,', 'at:', 'from: { kind,', 'about: {', 'text: body,', 'needsAck: true']) {
      expect(src, `agent-inbox.js buildInboxMessage must still write \`${key}\``).toContain(key);
    }
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
      ticketKey: 'ZB-9', executionId: SELF, text: 'hello',
    });
    // A platform note (parent-bell child_done) is NOT an inbox message.
    expect(parsedNull({ why: 'child_done', worker: 'developer' })).toBeNull();
  });

  const parsedNull = (obj: any) => parseInboxNote({ scope: 'x', content: JSON.stringify(obj) });
});
