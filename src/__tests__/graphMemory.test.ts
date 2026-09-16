/**
 * graphMemorySkill — the brokered memory-graph tools against a mocked control-plane.
 *
 * No real network — global.fetch is mocked (datasetStore-file.test.ts style).
 * Pinned: name→storeId resolution via ZIBBY_STORE__ env, the route each tool
 * hits, the batch shape of graph_recall, that `provenance` never leaves the
 * skill (a model writes 'claimed', the engine's default), that no platform-owned
 * field is ever sent, and that every fetch carries an abort signal.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.PROJECT_API_TOKEN = 'zby_test_token';
process.env.ZIBBY_ACCOUNT_API_URL = 'http://cp.local';
process.env.WORKFLOW_TYPE = 'test-agent';
process.env.ZIBBY_STORE__memory = 'store_mem123';

const { graphMemorySkill, TOOL_OP } = await import('../graphMemory.js');

const call = async (name: string, args: any) => JSON.parse(await graphMemorySkill.handleToolCall(name, args));

let fetchMock: any;
beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock;
});
afterEach(() => { delete (global as any).fetch; });

const okJson = (body: any) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

describe('identity', () => {
  it('is the graph-memory skill, backend-calling, with its own MCP server name', () => {
    expect(graphMemorySkill.id).toBe('graph-memory');
    expect(graphMemorySkill.callsBackend).toBe(true);
    expect(graphMemorySkill.serverName).toBe('graph_memory');
    expect(graphMemorySkill.allowedTools).toEqual(['mcp__graph_memory__*']);
    expect(graphMemorySkill.meta).toBeTruthy();
    expect(graphMemorySkill.tools.map((t: any) => t.name)).toEqual(Object.keys(TOOL_OP));
  });

  it('offers no provenance argument on a WRITE tool — a model writes claimed', () => {
    for (const t of graphMemorySkill.tools) {
      expect(t.input_schema.properties).toHaveProperty('store');
      // The read tools DO take `provenance` — as a FILTER ("only follow observed
      // edges"), which is the engine's RecallQuery; only the writers may not
      // choose what they are vouched as.
      if (TOOL_OP[t.name] === 'put' || TOOL_OP[t.name] === 'link') {
        expect(t.input_schema.properties).not.toHaveProperty('provenance');
      }
    }
  });
});

describe('graph_put', () => {
  it('resolves the store by name and POSTs /put with the node fields', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ id: 'file:x', version: 1 }));
    const out = await call('graph_put', { store: 'memory', id: 'file:x', kind: 'file', label: 'x.ts', attrs: { lang: 'ts' } });
    expect(out).toMatchObject({ id: 'file:x', version: 1, store: 'memory', storeId: 'store_mem123' });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://cp.local/datasets/stores/store_mem123/put');
    expect(opts.headers.Authorization).toBe('Bearer zby_test_token');
    expect(opts.signal).toBeTruthy();
    expect(JSON.parse(opts.body)).toEqual({ id: 'file:x', kind: 'file', label: 'x.ts', attrs: { lang: 'ts' } });
  });

  it('defaults to the single bound store and DROPS provenance before sending', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ id: 'a' }));
    await call('graph_put', { id: 'a', kind: 'k', label: 'l', provenance: 'observed' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ id: 'a', kind: 'k', label: 'l' });
    expect(body).not.toHaveProperty('provenance');
  });

  it('rejects a missing required field locally (no network)', async () => {
    expect((await call('graph_put', { id: 'a', kind: 'k' })).error).toMatch(/label/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an unbound store name locally', async () => {
    expect((await call('graph_put', { store: 'nope', id: 'a', kind: 'k', label: 'l' })).error).toMatch(/unknown store 'nope'/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('graph_link', () => {
  it('POSTs /link with the edge fields, validity and scope intact', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ id: 'e1' }));
    await call('graph_link', { src: 'a', dst: 'b', rel: 'touched', cost: 2, scope: 'main', validFrom: 1, validTo: null });
    expect(fetchMock.mock.calls[0][0]).toContain('/store_mem123/link');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ src: 'a', dst: 'b', rel: 'touched', cost: 2, scope: 'main', validFrom: 1, validTo: null });
  });

  it('requires src/dst/rel', async () => {
    expect((await call('graph_link', { src: 'a', rel: 'r' })).error).toMatch(/dst/);
  });
});

describe('graph_recall — batched', () => {
  it('POSTs /recall_many with the queries array', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ results: [[]], nodes: {} }));
    const out = await call('graph_recall', { queries: [{ seeds: ['a'], rels: ['touched'] }, { match: { kind: 'file' } }] });
    expect(out).toMatchObject({ results: [[]], nodes: {}, store: 'memory' });
    expect(fetchMock.mock.calls[0][0]).toContain('/store_mem123/recall_many');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ queries: [{ seeds: ['a'], rels: ['touched'] }, { match: { kind: 'file' } }] });
  });

  it('requires a non-empty queries array', async () => {
    expect((await call('graph_recall', { queries: [] })).error).toMatch(/queries is required/);
    expect((await call('graph_recall', { seeds: ['a'] })).error).toMatch(/queries is required/);
  });
});

describe('graph_subgraph / graph_trace', () => {
  it('map to /subgraph and /trace', async () => {
    fetchMock.mockResolvedValue(okJson({ ok: true }));
    await call('graph_subgraph', { seeds: ['a'], maxCost: 3 });
    await call('graph_trace', { id: 'a' });
    expect(fetchMock.mock.calls[0][0]).toContain('/store_mem123/subgraph');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ seeds: ['a'], maxCost: 3 });
    expect(fetchMock.mock.calls[1][0]).toContain('/store_mem123/trace');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ id: 'a' });
  });

  it('graph_trace requires id', async () => {
    expect((await call('graph_trace', {})).error).toMatch(/id/);
  });
});

describe('failures', () => {
  it('surfaces a control-plane refusal with its status and text, structurally', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, text: async () => JSON.stringify({ error: "PermissionError: put: provenance 'observed' is reserved for runtimes" }) });
    const out = await call('graph_put', { id: 'a', kind: 'k', label: 'l' });
    expect(out.error).toMatch(/graph-memory put failed \(403\)/);
    expect(out.error).toMatch(/observed/);
  });

  it('unknown tool', async () => {
    expect((await call('graph_delete', {})).error).toMatch(/Unknown tool/);
  });

  it('never sends a platform-owned field even if a caller adds one', async () => {
    // The control-plane strips these too; this pins that the skill does not
    // ADD them on its own (the tenant, origin and trust are the platform's).
    fetchMock.mockResolvedValueOnce(okJson({ ok: true }));
    await call('graph_put', { id: 'a', kind: 'k', label: 'l' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    for (const k of ['graphId', 'origin', 'trusted', 'privileged', 'embedding', 'kbId']) expect(body).not.toHaveProperty(k);
  });
});

describe('resolve() — the MCP child env', () => {
  it('forwards the session env and every bound store mapping to the spawned server', () => {
    const r = graphMemorySkill.resolve();
    expect(r.command).toBe('node');
    expect(r.args[1]).toBe('../dist/graphMemory.js');
    expect(r.args[2]).toBe('graphMemorySkill');
    expect(r.env.PROJECT_API_TOKEN).toBe('zby_test_token');
    expect(r.env.ZIBBY_ACCOUNT_API_URL).toBe('http://cp.local');
    expect(r.env.ZIBBY_STORE__memory).toBe('store_mem123');
  });
});
