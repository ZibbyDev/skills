/**
 * artifactSkill tests — the tool dispatch + the two-layer split:
 *   - CONTENT goes to the control-plane blob write (POST /artifacts).
 *   - INDEX goes to kv-memory (POST /credits/review-memory, op 'store') under the
 *     SAME auto-namespaced scope kv-memory reads (`<WORKFLOW_TYPE>:artifact:<id>`)
 *     so a later kv_recall_prefix('artifact:') lists exactly what was published.
 * No real network — global.fetch is mocked and we assert on the requests made.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.PROJECT_API_TOKEN = 'zby_pat_test';
process.env.ZIBBY_ACCOUNT_API_URL = 'http://cp.local';
process.env.WORKFLOW_TYPE = 'zibby-copilot';

const { artifactSkill, __resetPublishBudget } = await import('../artifact.js');

// Route the mocked fetch by URL + parse the JSON body for assertions.
function mockFetch(routes) {
  return vi.fn(async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null;
    for (const [match, resp] of routes) {
      if (url.includes(match)) {
        const r = typeof resp === 'function' ? resp(body, url) : resp;
        return { ok: r.ok !== false, status: r.status || 200, json: async () => r.json, text: async () => JSON.stringify(r.json) };
      }
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
}

let calls;
beforeEach(() => { calls = []; __resetPublishBudget(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('artifact_publish', () => {
  it('writes the blob then indexes it in kv-memory under the auto-namespaced scope', async () => {
    global.fetch = mockFetch([
      ['/artifacts', (body, url) => { calls.push(['write', url, body]); return { json: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', url: 'http://box/a/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', createdAt: '2026-07-17T00:00:00Z' } }; }],
      ['/credits/review-memory', (body, url) => { calls.push(['index', url, body]); return { json: { stored: true } }; }],
    ]);

    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
      title: 'Status Report', html: '<h1>hi</h1>', kind: 'report', summary: 'weekly status',
    }));
    expect(out).toEqual({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', url: 'http://box/a/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });

    // 1) blob write carried the content + title, NOT account/project.
    const write = calls.find((c) => c[0] === 'write');
    expect(write[1]).toBe('http://cp.local/credits/artifacts');
    expect(write[2]).toMatchObject({ title: 'Status Report', html: '<h1>hi</h1>', kind: 'report' });

    // 2) index write hit kv-memory at scope `<WORKFLOW_TYPE>:artifact:<id>`.
    const index = calls.find((c) => c[0] === 'index');
    expect(index[1]).toBe('http://cp.local/credits/review-memory');
    expect(index[2].op).toBe('store');
    expect(index[2].scope).toBe('zibby-copilot:artifact:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    const rec = JSON.parse(index[2].content);
    expect(rec).toMatchObject({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: 'Status Report', kind: 'report', summary: 'weekly status' });
  });

  it('rejects missing title or neither content form', async () => {
    global.fetch = mockFetch([]);
    expect(JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { html: '<p>x</p>' })).error).toMatch(/title/);
    expect(JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { title: 'T' })).error).toMatch(/markdown \(preferred\) or html/);
  });

  // The two fields are DIFFERENT rendering paths, so silently picking one is how
  // you ship the wrong format. Previously html won without a word.
  it('refuses BOTH markdown and html rather than silently choosing', async () => {
    global.fetch = mockFetch([]);
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { title: 'T', markdown: '# a', html: '<h1>a</h1>' }));
    expect(out.error).toMatch(/EITHER markdown OR html, not both/);
  });

  it('sends markdown as `markdown` (the default path — our renderer owns the skeleton)', async () => {
    global.fetch = mockFetch([
      ['/credits/artifacts', (body, url) => { calls.push(['write', url, body]); return { json: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', url: 'http://box/artifact/x' } }; }],
      ['/credits/review-memory', () => ({ json: { stored: true } })],
    ]);
    await artifactSkill.handleToolCall('artifact_publish', { title: 'Q3', markdown: '# Q3\n\n| A | B |\n|---|---|\n| 1 | 2 |' });
    const write = calls.find((c) => c[0] === 'write');
    expect(write[2].markdown).toContain('| A | B |');
    expect(write[2].html).toBeUndefined();
  });
});

// ── the retry budget (the ONLY thing this skill owns besides the contract) ────
// The RULES live in backend/src/utils/artifact-validate.js — this skill
// implements none of them. What it owns is turn-local state the stateless
// handler cannot hold: after MAX_PUBLISH_ATTEMPTS rejections, stop and be honest.
describe('publish retry budget', () => {
  const DEFECTS = [{ code: 'zero-width-bar', line: 12, message: '<span class="bar"> has no width.' }];
  function rejectingFetch(times) {
    let n = 0;
    return mockFetch([
      ['/credits/artifacts', () => {
        n += 1;
        if (n <= times) return { ok: false, status: 422, json: { error: 'Artifact NOT published — the page has 1 defect:\n1. [zero-width-bar] line 12: <span class="bar"> has no width.', defects: DEFECTS } };
        return { json: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', url: 'http://box/artifact/x' } };
      }],
      ['/credits/review-memory', () => ({ json: { stored: true } })],
    ]);
  }

  it('1st rejection: relays the exact defects and grants ONE more attempt', async () => {
    global.fetch = rejectingFetch(1);
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<h1>Bars</h1><span class="bar"></span>' }));
    expect(out.published).toBe(false);
    expect(out.stop).toBe(false);
    expect(out.attemptsRemaining).toBe(1);
    expect(out.defects).toEqual(DEFECTS);
    expect(out.error).toMatch(/line 12/);
    // On the html path the advice is to switch to markdown — the evidence-backed
    // fix, since later repair iterations rarely fix what the first got wrong.
    expect(out.instruction).toMatch(/re-send the SAME content as `markdown`/);
  });

  it('2nd rejection: STOPS and tells the model to report the failure honestly', async () => {
    global.fetch = rejectingFetch(2);
    await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<span class="bar"></span>' });
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<span class="bar"></span>' }));
    expect(out.stop).toBe(true);
    expect(out.attemptsUsed).toBe(2);
    expect(out.instruction).toMatch(/Do NOT call artifact_publish or artifact_update again/);
    expect(out.instruction).toMatch(/A broken link is worse than an honest/);
    expect(out.url).toBeUndefined();
  });

  it('a 3rd call short-circuits without even reaching the backend', async () => {
    let hits = 0;
    global.fetch = mockFetch([
      ['/credits/artifacts', () => { hits += 1; return { ok: false, status: 422, json: { error: 'broken', defects: DEFECTS } }; }],
    ]);
    for (let i = 0; i < 3; i += 1) await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<span class="bar"></span>' });
    expect(hits).toBe(2); // the 3rd never left the process
  });

  it('the budget covers artifact_update too — one shared budget, not two', async () => {
    global.fetch = rejectingFetch(9);
    await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<span class="bar"></span>' });
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_update', { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', html: '<span class="bar"></span>' }));
    expect(out.stop).toBe(true);
  });

  it('a SUCCESS resets the budget — a long run publishing several pages is not penalised', async () => {
    global.fetch = rejectingFetch(1); // 1st call 422, everything after succeeds
    const first = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<span class="bar"></span>' }));
    expect(first.stop).toBe(false);
    const ok = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { title: 'T2', markdown: '# fine' }));
    expect(ok.url).toBe('http://box/artifact/x');
    // budget is back to full: a later single rejection must NOT stop us
    global.fetch = rejectingFetch(1);
    const later = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { title: 'T3', html: '<span class="bar"></span>' }));
    expect(later.stop).toBe(false);
    expect(later.attemptsRemaining).toBe(1);
  });

  it('a NON-422 failure (auth/quota/outage) does NOT consume the budget', async () => {
    global.fetch = mockFetch([['/credits/artifacts', () => ({ ok: false, status: 503, json: { error: 'upstream down' } })]]);
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { title: 'T', markdown: '# a' }));
    expect(out.error).toMatch(/503/);
    expect(out.stop).toBeUndefined();
    // still has both attempts
    global.fetch = rejectingFetch(1);
    const next = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<span class="bar"></span>' }));
    expect(next.attemptsRemaining).toBe(1);
  });
});

// ── the contract the model reads ─────────────────────────────────────────────
// The template freeze is delivered ENTIRELY through the declaration (description
// + prompt fragment), not through a per-caller branch. If the wording stops
// saying "prefer markdown", the freeze silently stops happening.
describe('the tool contract makes markdown the default', () => {
  const publish = () => artifactSkill.tools.find((t) => t.name === 'artifact_publish');

  it('tells the model to use markdown and that html is the exception', () => {
    const d = publish().description;
    expect(d).toMatch(/USE `markdown`/);
    expect(d).toMatch(/Use `html` ONLY when/);
  });

  it('states what markdown CAN express — including tables', () => {
    const d = publish().description;
    expect(d).toMatch(/GitHub-style pipe tables/);
    expect(d).toMatch(/bullet \+ numbered lists/);
    expect(publish().input_schema.properties.markdown.description).toMatch(/PREFERRED/);
  });

  it('states what markdown CANNOT express, so the html path stays justified', () => {
    const d = publish().description;
    expect(d).toMatch(/does NOT support raw HTML/);
    expect(d).toMatch(/images/);
  });

  it('nudges figures toward tool results rather than prose arithmetic', () => {
    expect(publish().description).toMatch(/do not do arithmetic in prose/i);
  });

  it('warns that content is validated before a URL exists and the retries are capped', () => {
    expect(publish().description).toMatch(/VALIDATED before any URL exists/);
    expect(publish().description).toMatch(/ONE retry/);
  });

  it('the prompt fragment carries the same defaults', () => {
    expect(artifactSkill.promptFragment).toMatch(/WRITE IT AS MARKDOWN/);
    expect(artifactSkill.promptFragment).toMatch(/pipe tables/);
    expect(artifactSkill.promptFragment).toMatch(/must come from a tool result/);
  });
});

describe('artifact_update', () => {
  it('recalls the prior index record to preserve createdAt, then re-stores', async () => {
    const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    global.fetch = mockFetch([
      ['/artifacts', (body, url) => { calls.push(['write', url, body]); return { json: { id: ID, url: `http://box/a/${ID}`, updatedAt: '2026-07-18T00:00:00Z' } }; }],
      ['/credits/review-memory', (body, url) => {
        calls.push([body.op, url, body]);
        if (body.op === 'recall') return { json: { found: true, memory: { content: JSON.stringify({ id: ID, title: 'Old', createdAt: '2026-07-01T00:00:00Z', url: `http://box/a/${ID}` }) } } };
        return { json: { stored: true } };
      }],
    ]);

    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_update', { id: ID, title: 'New', markdown: '# new' }));
    expect(out).toEqual({ id: ID, url: `http://box/a/${ID}` });
    const stored = calls.find((c) => c[0] === 'store');
    const rec = JSON.parse(stored[2].content);
    expect(rec.createdAt).toBe('2026-07-01T00:00:00Z'); // preserved
    expect(rec.title).toBe('New');
    expect(rec.updatedAt).toBe('2026-07-18T00:00:00Z');
  });

  it('requires an id', async () => {
    global.fetch = mockFetch([]);
    expect(JSON.parse(await artifactSkill.handleToolCall('artifact_update', { title: 'x' })).error).toMatch(/id is required/);
  });
});

describe('artifact_get', () => {
  it('fetches metadata + content by id', async () => {
    const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    global.fetch = mockFetch([
      [`/artifacts/${ID}`, () => ({ json: { metadata: { id: ID, title: 'G' }, content: '# hi', format: 'markdown' } })],
    ]);
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_get', { id: ID }));
    expect(out.metadata.title).toBe('G');
    expect(out.content).toBe('# hi');
  });
});

describe('skill shape', () => {
  it('exposes exactly the three artifact tools (list is delegated to kv-memory)', () => {
    expect(artifactSkill.id).toBe('artifact');
    expect(artifactSkill.tools.map((t) => t.name).sort()).toEqual(['artifact_get', 'artifact_publish', 'artifact_update']);
    expect(artifactSkill.allowedTools).toContain('mcp__artifact__*');
  });
});
