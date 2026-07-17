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

const { artifactSkill } = await import('../artifact.js');

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
beforeEach(() => { calls = []; });
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
    expect(write[1]).toBe('http://cp.local/artifacts');
    expect(write[2]).toMatchObject({ title: 'Status Report', html: '<h1>hi</h1>', kind: 'report' });

    // 2) index write hit kv-memory at scope `<WORKFLOW_TYPE>:artifact:<id>`.
    const index = calls.find((c) => c[0] === 'index');
    expect(index[1]).toBe('http://cp.local/credits/review-memory');
    expect(index[2].op).toBe('store');
    expect(index[2].scope).toBe('zibby-copilot:artifact:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    const rec = JSON.parse(index[2].content);
    expect(rec).toMatchObject({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: 'Status Report', kind: 'report', summary: 'weekly status' });
  });

  it('rejects missing title or both/neither content forms', async () => {
    global.fetch = mockFetch([]);
    expect(JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { html: '<p>x</p>' })).error).toMatch(/title/);
    expect(JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { title: 'T' })).error).toMatch(/html or markdown/);
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
