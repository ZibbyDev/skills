/**
 * artifact-verdict-and-provenance.test.ts — the SKILL half of "an artifact can
 * say HOW IT WENT and WHERE IT CAME FROM".
 *
 * The backend owns the enum, the storage and the rendering (see backend
 * artifacts-verdict-and-provenance.test.js). Four things are only testable here:
 *
 *   1. PROVENANCE COMES FROM THE RUN, NOT THE MODEL. Four fields, four env
 *      vars, and `context` is in neither tool's input schema — so a model that
 *      names its own run/node cannot.
 *
 *   2. THE ENV ALLOWLIST COVERS EVERYTHING runContext READS. This is the
 *      sharpest test in the file and it guards the codebase's most repeated
 *      bug: a skill's `resolve().env` IS its MCP child's ENTIRE environment,
 *      not an addition to it. An env var this skill reads but does not copy is
 *      absent in the process that reads it, and the symptom is a field that is
 *      quietly always missing — never an error. It hides from every in-process
 *      test, because a code node importing this skill directly has the full run
 *      env and works fine.
 *
 *   3. THE NODE NAME IS STAMPED BY resolve(), NOT BY THE EXECUTOR. Nothing at
 *      run launch knows which node will publish, so the engine hands the graph
 *      node KEY to resolve() per node and resolve() puts it on the child.
 *
 *   4. THE VERDICT ON THE ROW IS THE SERVER'S ECHO. The backend owns the enum;
 *      this skill validates nothing (a second validator would be a second
 *      decider). So a word the server refused produces NO chip — the cross-repo
 *      pair fails to "nobody judged this", never to a fake pass.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.PROJECT_API_TOKEN = 'zby_pat_test';
process.env.ZIBBY_ACCOUNT_API_URL = 'http://cp.local';

const { artifactSkill, __resetPublishBudget } = await import('../artifact.js');

const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const URL_ = `http://box/a/${ID}`;

let calls: any[];
let lastContent = '';

/** Mock the three endpoints a publish touches; `writeExtra` shapes the echo. */
function mockFetch(writeExtra: any = {}) {
  return vi.fn(async (url: string, opts: any) => {
    const body = opts?.body ? JSON.parse(opts.body) : null;
    let json: any;
    if (url.includes('/credits/artifacts/')) {
      json = { metadata: { id: ID }, content: lastContent, format: 'html' };
    } else if (url.includes('/artifacts')) {
      lastContent = body.html ?? body.markdown ?? body.text ?? '';
      calls.push(['write', url, body]);
      json = { id: ID, url: URL_, createdAt: '2026-08-21T00:00:00Z', updatedAt: '2026-08-21T00:00:00Z', ...writeExtra };
    } else if (url.includes('/credits/review-memory')) {
      calls.push(['index', url, body]);
      json = body.op === 'recall' ? { found: false } : { stored: true };
    } else {
      throw new Error(`unexpected fetch to ${url}`);
    }
    return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
  });
}

// The kv row that was WRITTEN. `artifact_update` hits review-memory twice — a
// `recall` to merge the prior row, then the store — so this must not simply
// take the first index call, which carries no `content` at all.
const indexRecord = () => JSON.parse(calls.filter((c) => c[0] === 'index' && c[2]?.content).pop()[2].content);
const writeBody = () => calls.find((c) => c[0] === 'write')[2];

const PROV_ENV = ['EXECUTION_ID', 'WORKFLOW_TYPE', 'WORKFLOW_UUID', 'WORKFLOW_NODE_NAME'];

beforeEach(() => {
  calls = [];
  lastContent = '';
  __resetPublishBudget();
  for (const k of PROV_ENV) delete process.env[k];
});
afterEach(() => { vi.restoreAllMocks(); });

// ───────────────────────────────────────────────────────────────────────────
describe('1. provenance is read from the RUN — four fields, four env vars', () => {
  it('sends every field the env supplies', async () => {
    process.env.EXECUTION_ID = 'exec-7f3a19c2';
    process.env.WORKFLOW_TYPE = 'frontend-specialist';
    process.env.WORKFLOW_UUID = '9a9a9a9a-1111-4222-8333-444444444444';
    process.env.WORKFLOW_NODE_NAME = 'qa_verify';
    global.fetch = mockFetch() as any;

    await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<p>x</p>' });
    expect(writeBody().context).toEqual({
      runId: 'exec-7f3a19c2',
      workflowType: 'frontend-specialist',
      workflowUuid: '9a9a9a9a-1111-4222-8333-444444444444',
      nodeName: 'qa_verify',
    });
  });

  it('each field is INDEPENDENTLY optional — a partial env sends a partial block', async () => {
    process.env.WORKFLOW_TYPE = 'code-review';
    process.env.WORKFLOW_NODE_NAME = 'develop';
    global.fetch = mockFetch() as any;

    await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<p>x</p>' });
    expect(writeBody().context).toEqual({ workflowType: 'code-review', nodeName: 'develop' });
  });

  it('outside a run there is NO context at all', async () => {
    global.fetch = mockFetch() as any;
    await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<p>x</p>' });
    expect(writeBody().context).toBeUndefined();
  });

  // The point of the whole design: a model that TRIES to name its own node
  // cannot. `context` is in neither input schema and the skill composes it.
  it('a caller-supplied `context` argument is ignored, not forwarded', async () => {
    process.env.WORKFLOW_NODE_NAME = 'qa_verify';
    global.fetch = mockFetch() as any;
    await artifactSkill.handleToolCall('artifact_publish', {
      title: 'T', html: '<p>x</p>', context: { nodeName: 'develop', runId: 'exec-FORGED' },
    } as any);
    expect(writeBody().context).toEqual({ nodeName: 'qa_verify' });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('2. THE ENV ALLOWLIST — resolve().env is the child\'s ENTIRE environment', () => {
  // The bug this exists to stop has happened at least four times in this
  // codebase (github, gitlab, lark twice). It is invisible in-process.
  it('copies EVERY provenance var runContext reads', () => {
    for (const k of PROV_ENV) process.env[k] = `v-${k}`;
    try {
      const r: any = artifactSkill.resolve();
      for (const k of PROV_ENV) {
        if (k === 'WORKFLOW_NODE_NAME') continue; // stamped by resolve, not copied — see below
        expect(r.env[k]).toBe(`v-${k}`);
      }
    } finally {
      for (const k of PROV_ENV) delete process.env[k];
    }
  });

  it('still copies the credentials the child cannot work without', () => {
    const r: any = artifactSkill.resolve();
    expect(r.env.PROJECT_API_TOKEN).toBe('zby_pat_test');
    expect(r.env.ZIBBY_ACCOUNT_API_URL).toBe('http://cp.local');
  });

  it('never hands the child an LLM key or AWS credentials', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-should-not-travel';
    process.env.AWS_SECRET_ACCESS_KEY = 'should-not-travel';
    try {
      const r: any = artifactSkill.resolve();
      expect(r.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(r.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.AWS_SECRET_ACCESS_KEY;
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('3. the NODE NAME is stamped by resolve(), from the engine', () => {
  it('puts the graph node KEY on the child env', () => {
    const r: any = artifactSkill.resolve({ nodeName: 'qa_verify' });
    expect(r.env.WORKFLOW_NODE_NAME).toBe('qa_verify');
  });

  it('trims, and omits the var entirely when the engine passes nothing', () => {
    expect((artifactSkill.resolve({ nodeName: '  develop  ' }) as any).env.WORKFLOW_NODE_NAME).toBe('develop');
    // An engine old enough not to pass nodeName leaves the field OFF rather
    // than guessing — absent is honest, a wrong node name is not.
    expect(Object.keys((artifactSkill.resolve() as any).env)).not.toContain('WORKFLOW_NODE_NAME');
    expect(Object.keys((artifactSkill.resolve({ nodeName: '   ' }) as any).env)).not.toContain('WORKFLOW_NODE_NAME');
  });

  it('is the SAME name runContext reads, so the two halves cannot drift', async () => {
    // resolve() writes it; the child reads it. Simulated end-to-end by feeding
    // resolve's own output back in as the child's process.env.
    const childEnv = (artifactSkill.resolve({ nodeName: 'checkpoint_push' }) as any).env;
    Object.assign(process.env, childEnv);
    global.fetch = mockFetch() as any;
    await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<p>x</p>' });
    expect(writeBody().context.nodeName).toBe('checkpoint_push');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('4. the VERDICT — sent through, indexed from the ECHO', () => {
  it('forwards the verdict on the write', async () => {
    global.fetch = mockFetch() as any;
    await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<p>x</p>', verdict: 'failed' });
    expect(writeBody().verdict).toBe('failed');
  });

  it('sends NOTHING when the model offers no verdict — most artifacts have none', async () => {
    global.fetch = mockFetch() as any;
    await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<p>x</p>' });
    expect(Object.keys(writeBody())).not.toContain('verdict');
    expect(Object.keys(indexRecord())).not.toContain('verdict');
  });

  // THE TWO-PLACES TRIPWIRE. The echo differs from the request on purpose: an
  // implementation that copies `payload.verdict` reads 'passed' and fails.
  it('indexes the ECHOED verdict, so the tab can never show what was not stored', async () => {
    global.fetch = mockFetch({ verdict: 'unanswered' }) as any;
    await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<p>x</p>', verdict: 'passed' });
    expect(writeBody().verdict).toBe('passed');
    expect(indexRecord().verdict).toBe('unanswered');
  });

  // The safe failure direction for a cross-repo pair: a word this skill offers
  // that the backend's enum refuses is never echoed, so no chip appears.
  it('a verdict the server did not echo NEVER reaches the row', async () => {
    global.fetch = mockFetch({}) as any;
    await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<p>x</p>', verdict: 'passed' });
    expect(Object.keys(indexRecord())).not.toContain('verdict');
  });

  it('a verdict-ONLY update is a real update, not "nothing to update"', async () => {
    global.fetch = mockFetch({ verdict: 'passed' }) as any;
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_update', { id: ID, verdict: 'passed' }));
    expect(out.error).toBeUndefined();
    expect(writeBody().verdict).toBe('passed');
    expect(indexRecord().verdict).toBe('passed');
  });

  it('an update NEVER re-stamps context — a revision did not produce the artifact', async () => {
    process.env.EXECUTION_ID = 'exec-later-run';
    global.fetch = mockFetch({ verdict: 'passed' }) as any;
    await artifactSkill.handleToolCall('artifact_update', { id: ID, verdict: 'passed' });
    expect(Object.keys(writeBody())).not.toContain('context');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('5. what the MODEL is offered', () => {
  it('both tools offer the SAME three words, and no fourth', () => {
    for (const name of ['artifact_publish', 'artifact_update']) {
      const tool: any = artifactSkill.tools.find((t: any) => t.name === name);
      expect(tool.input_schema.properties.verdict.enum).toEqual(['passed', 'failed', 'unanswered']);
    }
  });

  it('tells the model that ❔ is not ❌, and that omitting it is correct', () => {
    const tool: any = artifactSkill.tools.find((t: any) => t.name === 'artifact_publish');
    const d = tool.input_schema.properties.verdict.description;
    expect(d).toMatch(/NOT "failed"|is NOT/i);
    expect(d).toMatch(/OMIT IT ENTIRELY/);
  });

  it('still advertises NO `context` input on either tool', () => {
    for (const name of ['artifact_publish', 'artifact_update']) {
      const tool: any = artifactSkill.tools.find((t: any) => t.name === name);
      expect(Object.keys(tool.input_schema.properties)).not.toContain('context');
    }
  });
});
