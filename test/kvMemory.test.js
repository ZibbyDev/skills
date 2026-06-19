import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { kvMemorySkill } from '../src/kvMemory.js';

// kv-memory reuses the EXACT backend route + ops + table that review-memory
// used (POST {base}/credits/review-memory { op, ... }) but auto-namespaces the
// caller's plain `key` with WORKFLOW_TYPE before sending it as `scope`. These
// tests assert: structure, op dispatch, the namespacing + fallback, and disjoint
// SKs across workflow types.

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
  process.env.WORKFLOW_TYPE = 'github-ai-scout';
  delete process.env.ZIBBY_USER_TOKEN;
});

afterEach(() => {
  delete process.env.PROJECT_API_TOKEN;
  delete process.env.ZIBBY_ACCOUNT_API_URL;
  delete process.env.WORKFLOW_TYPE;
});

describe('kvMemorySkill structure', () => {
  it('registers under id kv-memory with neutral serverName + allowedTools', () => {
    expect(kvMemorySkill.id).toBe('kv-memory');
    expect(kvMemorySkill.serverName).toBe('kv_memory');
    expect(kvMemorySkill.allowedTools).toEqual(['mcp__kv_memory__*']);
  });

  it('exposes the expected neutral tools', () => {
    const names = kvMemorySkill.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'kv_recall',
      'kv_recall_prefix',
      'kv_store',
    ]);
  });

  it('tools take a plain key/keyPrefix (not scope)', () => {
    const store = kvMemorySkill.tools.find((t) => t.name === 'kv_store');
    expect(store.input_schema.required).toEqual(['key', 'content']);
    const recall = kvMemorySkill.tools.find((t) => t.name === 'kv_recall');
    expect(recall.input_schema.required).toEqual(['key']);
    const prefix = kvMemorySkill.tools.find((t) => t.name === 'kv_recall_prefix');
    expect(prefix.input_schema.required).toEqual(['keyPrefix']);
  });
});

describe('resolve() spawns the generic MCP bin (NOT command:null)', () => {
  it('returns a node stdio server pointing at ../dist/kvMemory.js and forwards WORKFLOW_TYPE', () => {
    const r = kvMemorySkill.resolve();
    expect(r.command).toBe('node');
    expect(r.args).toEqual([expect.stringContaining('mcp-skill.mjs'), '../dist/kvMemory.js', 'kvMemorySkill']);
    expect(r.type).toBe('stdio');
    expect(r.alwaysLoad).toBe(true);
    expect(r.env.PROJECT_API_TOKEN).toBe('zby_testprojecttoken');
    expect(r.env.ZIBBY_ACCOUNT_API_URL).toBe('https://api-test.zibby.app');
    expect(r.env.WORKFLOW_TYPE).toBe('github-ai-scout');
  });
});

describe('handleToolCall — reuses review-memory backend, auto-namespaces by WORKFLOW_TYPE', () => {
  it('recall posts op=recall to /credits/review-memory with scope = <WORKFLOW_TYPE>:<key>', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({ found: false, memory: null }));
    const out = await kvMemorySkill.handleToolCall('kv_recall', { key: 'seen#owner/repo#42' });
    expect(JSON.parse(out)).toEqual({ found: false, memory: null });

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, opts] = spy.mock.calls[0];
    // SAME endpoint as review-memory — proves no backend change.
    expect(url).toBe('https://api-test.zibby.app/credits/review-memory');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer zby_testprojecttoken');
    expect(JSON.parse(opts.body)).toEqual({ op: 'recall', scope: 'github-ai-scout:seen#owner/repo#42' });
  });

  it('store posts op=store with namespaced scope + content/metadata (no headSha)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({ stored: true }));
    await kvMemorySkill.handleToolCall('kv_store', {
      key: 'lastRun', content: 'processed 12 PRs', metadata: { count: 12 },
    });
    const body = JSON.parse(spy.mock.calls[0][1].body);
    expect(body).toEqual({ op: 'store', scope: 'github-ai-scout:lastRun', content: 'processed 12 PRs', metadata: { count: 12 } });
  });

  it('recall_prefix posts op=recall-prefix with namespaced scopePrefix', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({ count: 0, memories: [] }));
    await kvMemorySkill.handleToolCall('kv_recall_prefix', { keyPrefix: 'seen#' });
    const body = JSON.parse(spy.mock.calls[0][1].body);
    expect(body).toEqual({ op: 'recall-prefix', scopePrefix: 'github-ai-scout:seen#' });
  });

  it('falls back to the literal "agent:" namespace when WORKFLOW_TYPE is unset', async () => {
    delete process.env.WORKFLOW_TYPE;
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({ found: false }));
    await kvMemorySkill.handleToolCall('kv_recall', { key: 'k' });
    expect(JSON.parse(spy.mock.calls[0][1].body).scope).toBe('agent:k');
  });

  it('falls back when WORKFLOW_TYPE is empty/whitespace', async () => {
    process.env.WORKFLOW_TYPE = '   ';
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({ found: false }));
    await kvMemorySkill.handleToolCall('kv_recall', { key: 'k' });
    expect(JSON.parse(spy.mock.calls[0][1].body).scope).toBe('agent:k');
  });

  it('two different workflow types land on DISJOINT scopes (SKs) for the SAME key', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({ found: false }));

    process.env.WORKFLOW_TYPE = 'github-ai-scout';
    await kvMemorySkill.handleToolCall('kv_recall', { key: 'dup#owner/repo#7' });

    process.env.WORKFLOW_TYPE = 'github-code-review';
    await kvMemorySkill.handleToolCall('kv_recall', { key: 'dup#owner/repo#7' });

    const scopes = spy.mock.calls.map((c) => JSON.parse(c[1].body).scope);
    expect(scopes).toEqual(['github-ai-scout:dup#owner/repo#7', 'github-code-review:dup#owner/repo#7']);
    expect(scopes[0]).not.toBe(scopes[1]);
  });

  it('namespaced scopes never collide with review-memory "review:" scopes', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({ found: false }));
    await kvMemorySkill.handleToolCall('kv_recall', { key: 'review:owner/repo#42' });
    const scope = JSON.parse(spy.mock.calls[0][1].body).scope;
    // Even if an agent picks a key that looks like a review scope, the auto
    // namespace prefixes it → it cannot land on review-memory's SK.
    expect(scope).toBe('github-ai-scout:review:owner/repo#42');
    expect(scope.startsWith('review:')).toBe(false);
  });

  it('validates required args before hitting the network', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({}));
    expect(JSON.parse(await kvMemorySkill.handleToolCall('kv_recall', {}))).toEqual({ error: 'key is required' });
    expect(JSON.parse(await kvMemorySkill.handleToolCall('kv_store', { key: 'k' }))).toMatchObject({ error: expect.stringContaining('content is required') });
    expect(JSON.parse(await kvMemorySkill.handleToolCall('kv_recall_prefix', {}))).toEqual({ error: 'keyPrefix is required' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('surfaces a backend non-2xx as an error string', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchErr(403, 'Project access denied'));
    const out = JSON.parse(await kvMemorySkill.handleToolCall('kv_recall', { key: 'k' }));
    expect(out.error).toContain('403');
  });

  it('errors clearly when no backend credential is present', async () => {
    delete process.env.PROJECT_API_TOKEN;
    delete process.env.ZIBBY_USER_TOKEN;
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = '/nonexistent-zibby-test-home';
    process.env.USERPROFILE = '/nonexistent-zibby-test-home';
    try {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({}));
      const out = JSON.parse(await kvMemorySkill.handleToolCall('kv_recall', { key: 'k' }));
      expect(out.error).toContain('PROJECT_API_TOKEN');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    }
  });

  it('unknown tool returns an error', async () => {
    const out = JSON.parse(await kvMemorySkill.handleToolCall('kv_bogus', {}));
    expect(out.error).toContain('Unknown tool');
  });
});
