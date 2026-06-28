import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { datasetStoreSkill } from '../src/datasetStore.js';

// Stores v2: stores are auto-provisioned at deploy and resolved at runtime BY
// NAME via `ZIBBY_STORE__<name>=<storeId>` env. That name→storeId map is BOTH
// the allowlist AND the resolver. These tests assert: structure, env→map
// enumeration, default-single / multiple-needs-store / zero / unknown-name
// resolution (with the exact agent-facing error strings), and that append/query
// hit the RIGHT storeId path with the project token (mocked fetch).

function fetchOk(payload = {}) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}
function fetchErr(status, body = '') {
  return { ok: false, status, json: async () => ({}), text: async () => body };
}

// Clear any ZIBBY_STORE__* leaked from a prior test/env.
function clearStoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (/^ZIBBY_STORE__/.test(key)) delete process.env[key];
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.PROJECT_API_TOKEN = 'zby_testprojecttoken';
  process.env.ZIBBY_ACCOUNT_API_URL = 'https://api-test.zibby.app';
  process.env.WORKFLOW_TYPE = 'github-ai-scout';
  delete process.env.ZIBBY_USER_TOKEN;
  clearStoreEnv();
});

afterEach(() => {
  delete process.env.PROJECT_API_TOKEN;
  delete process.env.ZIBBY_ACCOUNT_API_URL;
  delete process.env.WORKFLOW_TYPE;
  clearStoreEnv();
});

describe('datasetStoreSkill structure', () => {
  it('registers under id dataset-store with neutral serverName + allowedTools', () => {
    expect(datasetStoreSkill.id).toBe('dataset-store');
    expect(datasetStoreSkill.serverName).toBe('dataset_store');
    expect(datasetStoreSkill.allowedTools).toEqual(['mcp__dataset_store__*']);
  });

  it('exposes the expected tools', () => {
    const names = datasetStoreSkill.tools.map((t) => t.name).sort();
    expect(names).toEqual(['dataset_append', 'dataset_query']);
  });

  it('tools take a logical `store` name (not a storeId/dataset) and only require record/none', () => {
    const append = datasetStoreSkill.tools.find((t) => t.name === 'dataset_append');
    expect(append.input_schema.required).toEqual(['record']);
    expect(append.input_schema.properties).toHaveProperty('store');
    expect(append.input_schema.properties).toHaveProperty('description');
    // No legacy storeId/dataset surface anymore.
    expect(append.input_schema.properties).not.toHaveProperty('storeId');
    expect(append.input_schema.properties).not.toHaveProperty('dataset');

    const query = datasetStoreSkill.tools.find((t) => t.name === 'dataset_query');
    expect(query.input_schema.required).toEqual([]);
    expect(query.input_schema.properties).toHaveProperty('store');
    expect(query.input_schema.properties).not.toHaveProperty('storeId');
    expect(query.input_schema.properties).not.toHaveProperty('dataset');
  });
});

describe('resolve() spawns the generic MCP bin and forwards bound-store env', () => {
  it('returns a node stdio server pointing at ../dist/datasetStore.js, NOT auto-loaded', () => {
    const r = datasetStoreSkill.resolve();
    expect(r.command).toBe('node');
    expect(r.args).toEqual([expect.stringContaining('mcp-skill.mjs'), '../dist/datasetStore.js', 'datasetStoreSkill']);
    expect(r.type).toBe('stdio');
    expect(r.alwaysLoad).toBe(false);
    expect(r.env.PROJECT_API_TOKEN).toBe('zby_testprojecttoken');
    expect(r.env.WORKFLOW_TYPE).toBe('github-ai-scout');
  });

  it('forwards EVERY ZIBBY_STORE__* mapping to the spawned process', () => {
    process.env.ZIBBY_STORE__scorecards = 'store_abc';
    process.env.ZIBBY_STORE__metrics = 'store_def';
    const r = datasetStoreSkill.resolve();
    expect(r.env.ZIBBY_STORE__scorecards).toBe('store_abc');
    expect(r.env.ZIBBY_STORE__metrics).toBe('store_def');
  });

  it('does not forward empty-valued store vars', () => {
    process.env.ZIBBY_STORE__unbound = '';
    const r = datasetStoreSkill.resolve();
    expect(r.env).not.toHaveProperty('ZIBBY_STORE__unbound');
  });
});

describe('name→storeId resolution from ZIBBY_STORE__* env', () => {
  it('default-single: omitting `store` with exactly one bound store uses it', async () => {
    process.env.ZIBBY_STORE__scorecards = 'store_only';
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({ ok: true, id: 'r1' }));
    const out = JSON.parse(await datasetStoreSkill.handleToolCall('dataset_append', { record: { a: 1 } }));
    expect(out).toMatchObject({ ok: true, id: 'r1', store: 'scorecards', storeId: 'store_only' });

    const [url] = spy.mock.calls[0];
    expect(url).toBe('https://api-test.zibby.app/datasets/stores/store_only/append');
  });

  it('multiple-needs-store: omitting `store` with >1 bound store errors and lists names', async () => {
    process.env.ZIBBY_STORE__scorecards = 'store_a';
    process.env.ZIBBY_STORE__metrics = 'store_b';
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({}));
    const out = JSON.parse(await datasetStoreSkill.handleToolCall('dataset_query', {}));
    expect(out.error).toBe('multiple stores are bound; pass `store` (one of: scorecards, metrics)');
    expect(spy).not.toHaveBeenCalled();
  });

  it('zero: no bound stores errors with "no stores bound to this agent"', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({}));
    const out = JSON.parse(await datasetStoreSkill.handleToolCall('dataset_append', { store: 'whatever', record: { a: 1 } }));
    expect(out.error).toBe('unknown store \'whatever\'; available: ');
    const out2 = JSON.parse(await datasetStoreSkill.handleToolCall('dataset_query', {}));
    expect(out2.error).toBe('no stores bound to this agent');
    expect(spy).not.toHaveBeenCalled();
  });

  it('unknown-name: a `store` not in the map is rejected with the available list', async () => {
    process.env.ZIBBY_STORE__scorecards = 'store_a';
    process.env.ZIBBY_STORE__metrics = 'store_b';
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({}));
    const out = JSON.parse(await datasetStoreSkill.handleToolCall('dataset_append', { store: 'bogus', record: { a: 1 } }));
    expect(out.error).toBe("unknown store 'bogus'; available: scorecards, metrics");
    expect(spy).not.toHaveBeenCalled();
  });

  it('an empty-valued ZIBBY_STORE__* var is NOT bound (skipped from the map)', async () => {
    process.env.ZIBBY_STORE__real = 'store_real';
    process.env.ZIBBY_STORE__placeholder = '   ';
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({}));
    const out = JSON.parse(await datasetStoreSkill.handleToolCall('dataset_append', { store: 'placeholder', record: { a: 1 } }));
    expect(out.error).toBe("unknown store 'placeholder'; available: real");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('handleToolCall — append/query hit the right storeId with the project token', () => {
  beforeEach(() => {
    process.env.ZIBBY_STORE__scorecards = 'store_sc';
    process.env.ZIBBY_STORE__metrics = 'store_mx';
  });

  it('append posts record + auto agent tag to the chosen store, returns store+storeId', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({ ok: true, id: 'row1', ts: 123 }));
    const out = JSON.parse(await datasetStoreSkill.handleToolCall('dataset_append', {
      store: 'metrics', record: { repo: 'owner/x', stars: 1200 },
    }));
    expect(out).toMatchObject({ ok: true, id: 'row1', ts: 123, store: 'metrics', storeId: 'store_mx' });

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, opts] = spy.mock.calls[0];
    expect(url).toBe('https://api-test.zibby.app/datasets/stores/store_mx/append');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer zby_testprojecttoken');
    expect(JSON.parse(opts.body)).toEqual({ record: { repo: 'owner/x', stars: 1200 }, agent: 'github-ai-scout' });
  });

  it('append passes `description` through when provided (informational, no-op)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({ ok: true }));
    await datasetStoreSkill.handleToolCall('dataset_append', {
      store: 'scorecards', record: { x: 1 }, description: 'weekly scorecard',
    });
    const body = JSON.parse(spy.mock.calls[0][1].body);
    expect(body.description).toBe('weekly scorecard');
  });

  it('append works without `description` (absent → not sent)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({ ok: true }));
    await datasetStoreSkill.handleToolCall('dataset_append', { store: 'scorecards', record: { x: 1 } });
    const body = JSON.parse(spy.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('description');
  });

  it('append rejects a non-object record before any network call', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({}));
    const out = JSON.parse(await datasetStoreSkill.handleToolCall('dataset_append', { store: 'scorecards', record: [1, 2] }));
    expect(out.error).toContain('record is required');
    expect(spy).not.toHaveBeenCalled();
  });

  it('query forwards only the provided DSL keys to the chosen storeId', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({ ok: true, rowCount: 2, columns: ['c'], rows: [] }));
    const out = JSON.parse(await datasetStoreSkill.handleToolCall('dataset_query', {
      store: 'metrics',
      select: [{ field: 'stars', agg: 'sum', as: 'total' }],
      where: [{ field: 'repo', op: 'eq', value: 'owner/x' }],
      groupBy: ['repo'],
      limit: 10,
    }));
    expect(out).toMatchObject({ ok: true, rowCount: 2, store: 'metrics', storeId: 'store_mx' });

    const [url, opts] = spy.mock.calls[0];
    expect(url).toBe('https://api-test.zibby.app/datasets/stores/store_mx/query');
    expect(JSON.parse(opts.body)).toEqual({
      select: [{ field: 'stars', agg: 'sum', as: 'total' }],
      where: [{ field: 'repo', op: 'eq', value: 'owner/x' }],
      groupBy: ['repo'],
      limit: 10,
    });
    // orderBy/since/until/agent were not provided → not forwarded.
    expect(JSON.parse(opts.body)).not.toHaveProperty('orderBy');
  });

  it('surfaces a backend non-2xx as an error string', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchErr(403, 'Project access denied'));
    const out = JSON.parse(await datasetStoreSkill.handleToolCall('dataset_append', { store: 'scorecards', record: { a: 1 } }));
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
      const out = JSON.parse(await datasetStoreSkill.handleToolCall('dataset_append', { store: 'scorecards', record: { a: 1 } }));
      expect(out.error).toContain('PROJECT_API_TOKEN');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    }
  });

  it('unknown tool returns an error', async () => {
    const out = JSON.parse(await datasetStoreSkill.handleToolCall('dataset_bogus', {}));
    expect(out.error).toContain('Unknown tool');
  });
});
