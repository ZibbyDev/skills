/**
 * artifact-description.test.ts — the SKILL half of "an artifact can say what
 * it is".
 *
 * The backend owns storage and rendering. What is only testable HERE is the
 * skill's obligations around `description`:
 *
 *   1. THE DESCRIPTION TRAVELS TO THE BLOB, NEVER ONTO THE INDEX ROW —
 *      every listing ships each row's whole JSON to the browser, and no list
 *      surface renders a description.
 *
 *   2. A DESCRIPTION-ALONE UPDATE IS LEGITIMATE — the page was right, the
 *      explanation of it was missing; forcing a full re-send would be wasteful
 *      and a fresh chance to break a page that was already good.
 *
 *   3. THE GUIDANCE ASKS FOR A SELF-EXPLANATORY STORY — context + goal, what
 *      happened, what to conclude — and forbids arrow-chain shorthand.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.PROJECT_API_TOKEN = 'zby_pat_test';
process.env.ZIBBY_ACCOUNT_API_URL = 'http://cp.local';
process.env.WORKFLOW_TYPE = 'frontend-specialist';

const { artifactSkill, __resetPublishBudget, ARTIFACT_DESCRIPTION_RULE } = await import('../artifact.js');

const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const URL_ = `http://box/a/${ID}`;

let calls: any[];

/** Mock the three endpoints a publish touches. */
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

beforeEach(() => { calls = []; lastContent = ''; __resetPublishBudget(); });
afterEach(() => { vi.restoreAllMocks(); });

// ───────────────────────────────────────────────────────────────────────────
describe('1. the description travels to the blob, never onto the index row', () => {
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
describe('2. artifact_update', () => {
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
});

// ───────────────────────────────────────────────────────────────────────────
describe('3. the guidance demands a self-explanatory story, not a procedure log', () => {
  it('the prompt asks for a specific subject and a story-shaped description', () => {
    // Anchored on single-line substrings: the fragment is hard-wrapped prose, so
    // a phrase that reads as one sentence may span a newline in the source.
    const p = artifactSkill.promptFragment;
    expect(p).toMatch(/NAME IT FOR SOMEONE SCROLLING A LIST OF FIFTY/);
    expect(p).toMatch(/Name the specific thing/);
    expect(p).toMatch(/Then pass `description`/);
    expect(p).toMatch(/shown UNDER the artifact on/);
  });

  it('the description rule requires context+goal, story, conclusion — and bans arrow-chains', () => {
    expect(ARTIFACT_DESCRIPTION_RULE).toMatch(/context \+ goal/);
    expect(ARTIFACT_DESCRIPTION_RULE).toMatch(/what was done and what happened/);
    expect(ARTIFACT_DESCRIPTION_RULE).toMatch(/what the reader should conclude/);
    expect(ARTIFACT_DESCRIPTION_RULE).toMatch(/arrow-chains/);
    expect(ARTIFACT_DESCRIPTION_RULE).toMatch(/procedure logs/);
  });
});
