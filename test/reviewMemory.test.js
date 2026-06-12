import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { reviewMemorySkill } from '../src/reviewMemory.js';

// Drive the skill against a mocked global fetch — it calls Zibby's OWN backend
// (POST {base}/memory/review { op, ... }) using PROJECT_API_TOKEN, not a
// 3rd-party API. We assert: shape, scope-as-param, op dispatch, auth header.

function fetchOk(payload = {}) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}
function fetchErr(status, body = '') {
  return { ok: false, status, json: async () => ({}), text: async () => body };
}

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.PROJECT_API_TOKEN = 'zby_testprojecttoken';
  process.env.ZIBBY_ACCOUNT_API_URL = 'https://api-test.zibby.app';
  delete process.env.ZIBBY_USER_TOKEN;
});

afterEach(() => {
  delete process.env.PROJECT_API_TOKEN;
  delete process.env.ZIBBY_ACCOUNT_API_URL;
});

describe('reviewMemorySkill structure', () => {
  it('has correct id, serverName, allowedTools', () => {
    expect(reviewMemorySkill.id).toBe('review-memory');
    expect(reviewMemorySkill.serverName).toBe('review_memory');
    expect(reviewMemorySkill.allowedTools).toEqual(['mcp__review_memory__*']);
  });

  it('exposes the expected tools', () => {
    const names = reviewMemorySkill.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'review_memory_recall',
      'review_memory_recall_prefix',
      'review_memory_store',
    ]);
  });

  it('store requires scope + content; recall requires scope; prefix requires scopePrefix', () => {
    const store = reviewMemorySkill.tools.find((t) => t.name === 'review_memory_store');
    expect(store.input_schema.required).toEqual(['scope', 'content']);
    const recall = reviewMemorySkill.tools.find((t) => t.name === 'review_memory_recall');
    expect(recall.input_schema.required).toEqual(['scope']);
    const prefix = reviewMemorySkill.tools.find((t) => t.name === 'review_memory_recall_prefix');
    expect(prefix.input_schema.required).toEqual(['scopePrefix']);
  });
});

describe('resolve() spawns the generic MCP bin (NOT command:null)', () => {
  it('returns a node stdio server pointing at ../dist/reviewMemory.js', () => {
    const r = reviewMemorySkill.resolve();
    // In this repo bin/mcp-skill.mjs exists, so resolve must spawn it.
    expect(r.command).toBe('node');
    expect(r.args).toEqual([expect.stringContaining('mcp-skill.mjs'), '../dist/reviewMemory.js', 'reviewMemorySkill']);
    expect(r.type).toBe('stdio');
    expect(r.alwaysLoad).toBe(true);
    // Backend-auth env is forwarded to the spawned process.
    expect(r.env.PROJECT_API_TOKEN).toBe('zby_testprojecttoken');
    expect(r.env.ZIBBY_ACCOUNT_API_URL).toBe('https://api-test.zibby.app');
  });
});

describe('handleToolCall — scope is a param end-to-end', () => {
  it('recall posts op=recall with the given scope + Bearer token', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({ found: false, memory: null }));
    const out = await reviewMemorySkill.handleToolCall('review_memory_recall', { scope: 'review:owner/repo#42' });
    expect(JSON.parse(out)).toEqual({ found: false, memory: null });

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, opts] = spy.mock.calls[0];
    expect(url).toBe('https://api-test.zibby.app/memory/review');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer zby_testprojecttoken');
    expect(JSON.parse(opts.body)).toEqual({ op: 'recall', scope: 'review:owner/repo#42' });
  });

  it('store posts op=store with scope/content/metadata/headSha', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({ stored: true }));
    await reviewMemorySkill.handleToolCall('review_memory_store', {
      scope: 'repo:owner/repo', content: 'reasoned about X', metadata: { files: 3 }, headSha: 'abc',
    });
    const body = JSON.parse(spy.mock.calls[0][1].body);
    expect(body).toEqual({ op: 'store', scope: 'repo:owner/repo', content: 'reasoned about X', metadata: { files: 3 }, headSha: 'abc' });
  });

  it('recall_prefix posts op=recall-prefix with the prefix', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({ count: 0, memories: [] }));
    await reviewMemorySkill.handleToolCall('review_memory_recall_prefix', { scopePrefix: 'review:owner/repo#' });
    const body = JSON.parse(spy.mock.calls[0][1].body);
    expect(body).toEqual({ op: 'recall-prefix', scopePrefix: 'review:owner/repo#' });
  });

  it('any scope string flows through unchanged (per-PR / per-repo / per-org)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({ found: false }));
    for (const scope of ['review:o/r#1', 'repo:o/r', 'org:o', 'totally-custom']) {
      await reviewMemorySkill.handleToolCall('review_memory_recall', { scope });
    }
    const scopes = spy.mock.calls.map((c) => JSON.parse(c[1].body).scope);
    expect(scopes).toEqual(['review:o/r#1', 'repo:o/r', 'org:o', 'totally-custom']);
  });

  it('validates required args before hitting the network', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({}));
    expect(JSON.parse(await reviewMemorySkill.handleToolCall('review_memory_recall', {}))).toEqual({ error: 'scope is required' });
    expect(JSON.parse(await reviewMemorySkill.handleToolCall('review_memory_store', { scope: 's' }))).toMatchObject({ error: expect.stringContaining('content is required') });
    expect(JSON.parse(await reviewMemorySkill.handleToolCall('review_memory_recall_prefix', {}))).toEqual({ error: 'scopePrefix is required' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('surfaces a backend non-2xx as an error string', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchErr(403, 'Project access denied'));
    const out = JSON.parse(await reviewMemorySkill.handleToolCall('review_memory_recall', { scope: 'review:o/r#1' }));
    expect(out.error).toContain('403');
  });

  it('errors clearly when no backend credential is present', async () => {
    delete process.env.PROJECT_API_TOKEN;
    delete process.env.ZIBBY_USER_TOKEN;
    // Also neutralize the ~/.zibby/config.json fallback: point HOME at an
    // empty temp dir so getSessionToken() can't pick up a real local CLI
    // session on the dev machine running the tests.
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = '/nonexistent-zibby-test-home';
    process.env.USERPROFILE = '/nonexistent-zibby-test-home';
    try {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({}));
      const out = JSON.parse(await reviewMemorySkill.handleToolCall('review_memory_recall', { scope: 'review:o/r#1' }));
      expect(out.error).toContain('PROJECT_API_TOKEN');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    }
  });

  it('unknown tool returns an error', async () => {
    const out = JSON.parse(await reviewMemorySkill.handleToolCall('review_memory_bogus', {}));
    expect(out.error).toContain('Unknown tool');
  });
});
