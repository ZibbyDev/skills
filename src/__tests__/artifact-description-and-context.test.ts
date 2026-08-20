/**
 * artifact-description-and-context.test.ts — the SKILL half of "an artifact can
 * say what it is".
 *
 * The backend owns storage and rendering (see backend artifacts-description-and
 * -context.test.js). What is only testable HERE is the skill's two obligations:
 *
 *   1. THE PLATFORM HALF OF A NAME COMES FROM ENV, NOT FROM THE MODEL.
 *      `context.runId` is read off `EXECUTION_ID`. A tool argument can never
 *      supply it — which is the whole reason it can be trusted to disambiguate
 *      two identically-titled artifacts.
 *
 *   2. THE INDEX ROW IS DERIVED, NOT DUPLICATED.
 *      The backend stores provenance on the artifact meta; this skill writes the
 *      kv index row the Artifacts tab lists. Two places, one fact. They are kept
 *      in agreement by construction: the row takes the server's ECHOED context,
 *      never the skill's own. The test proves that by making the server echo
 *      something DIFFERENT from what was sent — a copy-what-I-sent
 *      implementation passes an equality check and fails this one.
 *
 *      And the mirror obligation: the description must NOT reach that row,
 *      because every listing ships each row's whole JSON to the browser.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.PROJECT_API_TOKEN = 'zby_pat_test';
process.env.ZIBBY_ACCOUNT_API_URL = 'http://cp.local';
process.env.WORKFLOW_TYPE = 'frontend-specialist';

const { artifactSkill, __resetPublishBudget } = await import('../artifact.js');

const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const URL_ = `http://box/a/${ID}`;

let calls: any[];

/** Mock the three endpoints a publish touches; `writeExtra` shapes the echo. */
function mockFetch(writeExtra: any = {}) {
  return vi.fn(async (url: string, opts: any) => {
    const body = opts?.body ? JSON.parse(opts.body) : null;
    let json: any;
    if (url.includes('/credits/artifacts/')) {
      // The post-publish read-back — serve back exactly what was written so the
      // happy path stays clean (no `readBack` noise in the tool result).
      json = { metadata: { id: ID }, content: lastContent, format: 'html' };
    } else if (url.includes('/artifacts')) {
      lastContent = body.html ?? body.markdown ?? body.text ?? '';
      calls.push(['write', url, body]);
      json = { id: ID, url: URL_, createdAt: '2026-08-20T00:00:00Z', updatedAt: '2026-08-20T00:00:00Z', ...writeExtra };
    } else if (url.includes('/credits/review-memory')) {
      calls.push(['index', url, body]);
      json = body.op === 'recall' ? { found: false } : { stored: true };
    } else {
      throw new Error(`unexpected fetch to ${url}`);
    }
    return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
  });
}
let lastContent = '';

const indexRecord = () => JSON.parse(calls.find((c) => c[0] === 'index')[2].content);
const writeBody = () => calls.find((c) => c[0] === 'write')[2];

beforeEach(() => { calls = []; lastContent = ''; __resetPublishBudget(); delete process.env.EXECUTION_ID; });
afterEach(() => { vi.restoreAllMocks(); });

// ───────────────────────────────────────────────────────────────────────────
describe('1. provenance comes from the RUN, never from the model', () => {
  it('sends context.runId read off EXECUTION_ID', async () => {
    process.env.EXECUTION_ID = 'exec-7f3a19c2';
    global.fetch = mockFetch({ context: { runId: 'exec-7f3a19c2' } }) as any;

    await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<p>x</p>' });
    expect(writeBody().context).toEqual({ runId: 'exec-7f3a19c2' });
  });

  it('sends NO context outside a run — the field is simply absent', async () => {
    global.fetch = mockFetch() as any; // EXECUTION_ID deleted in beforeEach
    await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<p>x</p>' });
    expect(writeBody().context).toBeUndefined();
    expect(indexRecord().context).toBeUndefined();
  });

  // The point of the whole design: a model that TRIES to name its own run
  // cannot. `context` is not in either tool's input schema, and the skill
  // composes the field itself from env.
  it('a caller-supplied `context` argument is ignored, not forwarded', async () => {
    process.env.EXECUTION_ID = 'exec-real';
    global.fetch = mockFetch({ context: { runId: 'exec-real' } }) as any;

    await artifactSkill.handleToolCall('artifact_publish', {
      title: 'T', html: '<p>x</p>', context: { runId: 'exec-FORGED' },
    } as any);
    expect(writeBody().context).toEqual({ runId: 'exec-real' });
  });

  it('neither tool advertises `context` as an input the model may set', () => {
    for (const name of ['artifact_publish', 'artifact_update']) {
      const tool = artifactSkill.tools.find((t: any) => t.name === name);
      expect(Object.keys(tool.input_schema.properties)).not.toContain('context');
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('2. the index row is DERIVED from the server echo, not duplicated', () => {
  // THE TWO-PLACES TRIPWIRE. The server normalises (trims, drops unknown keys,
  // drops malformed values), so the stored provenance is not always what was
  // sent. Indexing the sent copy would put a value on the Artifacts tab that no
  // artifact actually has. Here the echo differs from the request on purpose:
  // an implementation that copies `payload.context` reads `exec-raw` and fails.
  it('indexes the ECHOED context, so the tab can never show what was not stored', async () => {
    process.env.EXECUTION_ID = 'exec-raw';
    global.fetch = mockFetch({ context: { runId: 'exec-normalised-by-server' } }) as any;

    await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<p>x</p>' });
    expect(writeBody().context).toEqual({ runId: 'exec-raw' });
    expect(indexRecord().context).toEqual({ runId: 'exec-normalised-by-server' });
  });

  it('omits context from the row when the server stored none', async () => {
    process.env.EXECUTION_ID = 'exec-raw';
    global.fetch = mockFetch({}) as any; // server echoes nothing back
    await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<p>x</p>' });
    expect(indexRecord().context).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('3. the description travels to the blob, never onto the index row', () => {
  it('sends description on the write and keeps it OFF the list row', async () => {
    global.fetch = mockFetch() as any;
    await artifactSkill.handleToolCall('artifact_publish', {
      title: 'T', html: '<p>x</p>', description: '## What this shows\n\nThe sort toggle.',
    });
    expect(writeBody().description).toBe('## What this shows\n\nThe sort toggle.');
    // The list ships every row's whole JSON — a description there is paid for on
    // every listing and rendered by nothing.
    expect(indexRecord().description).toBeUndefined();
  });

  it('omits it entirely when not given (an old caller is byte-identical)', async () => {
    global.fetch = mockFetch() as any;
    await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<p>x</p>' });
    expect(Object.keys(writeBody())).not.toContain('description');
  });

  it('a whitespace-only description is treated as absent', async () => {
    global.fetch = mockFetch() as any;
    await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<p>x</p>', description: '   \n ' });
    expect(Object.keys(writeBody())).not.toContain('description');
  });

  it('both tools offer `description`', () => {
    for (const name of ['artifact_publish', 'artifact_update']) {
      const tool = artifactSkill.tools.find((t: any) => t.name === name);
      expect(tool.input_schema.properties.description).toBeTruthy();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('4. artifact_update', () => {
  // A page that was right but unexplained should not have to be re-sent whole
  // just to gain a caption — re-sending is wasteful AND a fresh chance for the
  // publish gate to reject content that was already good.
  it('accepts a description-ALONE update, sending no content', async () => {
    global.fetch = mockFetch() as any;
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_update', {
      id: ID, description: '## Result\n\n3 of 5 checks failed.',
    }));
    expect(out.error).toBeUndefined();
    const body = writeBody();
    expect(body.description).toBe('## Result\n\n3 of 5 checks failed.');
    expect(body.html).toBeUndefined();
    expect(body.markdown).toBeUndefined();
  });

  it('still refuses a genuinely empty update', async () => {
    global.fetch = mockFetch() as any;
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_update', { id: ID }));
    expect(out.error).toMatch(/nothing to update/);
  });

  // Provenance answers "which run PRODUCED this". A revision did not produce
  // it, so re-stamping would rewrite history and destroy the field's only job.
  it('never re-stamps context onto an existing artifact', async () => {
    process.env.EXECUTION_ID = 'exec-a-much-later-run';
    global.fetch = mockFetch() as any;
    await artifactSkill.handleToolCall('artifact_update', { id: ID, title: 'T2' });
    expect(writeBody().context).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('5. the model is told to be SPECIFIC rather than to invent uniqueness', () => {
  it('the prompt asks for a specific subject and explains the platform stamps the run', () => {
    // Anchored on single-line substrings: the fragment is hard-wrapped prose, so
    // a phrase that reads as one sentence may span a newline in the source.
    const p = artifactSkill.promptFragment;
    expect(p).toMatch(/NAME IT FOR SOMEONE SCROLLING A LIST OF FIFTY/);
    expect(p).toMatch(/Name the specific thing/);
    expect(p).toMatch(/You do not have to make it unique/);
    expect(p).toMatch(/Then pass `description`/);
    expect(p).toMatch(/shown UNDER the artifact on/);
  });
});
