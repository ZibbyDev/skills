/**
 * datasetStoreSkill FILE-tool tests — file_put / file_get / file_list /
 * file_delete against the brokered /datasets/stores/{id}/{action} routes.
 * No real network — global.fetch is mocked; we assert the requests made
 * (name→storeId resolution via ZIBBY_STORE__ env, payload shape) and the
 * text-vs-binary decode ergonomics of file_get.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.PROJECT_API_TOKEN = 'zby_test_token';
process.env.ZIBBY_ACCOUNT_API_URL = 'http://cp.local';
process.env.WORKFLOW_TYPE = 'test-agent';
process.env.ZIBBY_STORE__artifacts = 'store_file123';

const { datasetStoreSkill, __clearEnsuredStores } = await import('../datasetStore.js');

const call = async (name, args) => JSON.parse(await datasetStoreSkill.handleToolCall(name, args));

let fetchMock;
beforeEach(() => {
  __clearEnsuredStores();
  fetchMock = vi.fn();
  global.fetch = fetchMock;
});
afterEach(() => { delete global.fetch; });

const okJson = (body) => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });

describe('file_put', () => {
  it('resolves the store by name and posts text content to /put', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ ok: true, path: 'dumps/a.json', size: 12, contentType: 'application/json' }));
    const out = await call('file_put', { store: 'artifacts', path: 'dumps/a.json', content: '{"a":1}', contentType: 'application/json' });
    expect(out).toMatchObject({ ok: true, store: 'artifacts', storeId: 'store_file123', path: 'dumps/a.json' });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://cp.local/datasets/stores/store_file123/put');
    expect(opts.headers.Authorization).toBe('Bearer zby_test_token');
    expect(JSON.parse(opts.body)).toEqual({ path: 'dumps/a.json', content: '{"a":1}', contentType: 'application/json' });
  });

  it('defaults to the single bound store when `store` is omitted', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ ok: true }));
    const out = await call('file_put', { path: 'x.txt', content: 'hi' });
    expect(out.store).toBe('artifacts');
    expect(fetchMock.mock.calls[0][0]).toContain('/store_file123/put');
  });

  it('rejects a missing path / missing content locally (no network)', async () => {
    expect((await call('file_put', { store: 'artifacts', content: 'x' })).error).toMatch(/path is required/);
    expect((await call('file_put', { store: 'artifacts', path: 'a.txt' })).error).toMatch(/content .* or contentBase64/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an unbound store name locally', async () => {
    const out = await call('file_put', { store: 'nope', path: 'a.txt', content: 'x' });
    expect(out.error).toMatch(/unknown store 'nope'/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('file_get', () => {
  it('returns UTF-8 text as content (encoding utf8)', async () => {
    const text = '{"hello":"wörld"}';
    fetchMock.mockResolvedValueOnce(okJson({
      ok: true, path: 'a.json', size: Buffer.byteLength(text), contentType: 'application/json',
      lastModified: '2026-07-23T00:00:00.000Z',
      contentBase64: Buffer.from(text, 'utf8').toString('base64'),
    }));
    const out = await call('file_get', { store: 'artifacts', path: 'a.json' });
    expect(out).toMatchObject({ ok: true, path: 'a.json', encoding: 'utf8', content: text });
    expect(out.contentBase64).toBeUndefined();
  });

  it('returns binary as contentBase64 (encoding base64)', async () => {
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    fetchMock.mockResolvedValueOnce(okJson({
      ok: true, path: 'x.png', size: bin.length, contentType: 'image/png',
      contentBase64: bin.toString('base64'),
    }));
    const out = await call('file_get', { store: 'artifacts', path: 'x.png' });
    expect(out.encoding).toBe('base64');
    expect(Buffer.from(out.contentBase64, 'base64').equals(bin)).toBe(true);
    expect(out.content).toBeUndefined();
  });

  it('surfaces a backend error (404) as an error string', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => '{"error":"file not found: a.json"}' });
    const out = await call('file_get', { store: 'artifacts', path: 'a.json' });
    expect(out.error).toMatch(/404/);
  });
});

describe('file_list / file_delete', () => {
  it('lists with prefix + forwards pagination', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ ok: true, files: [{ path: 'dumps/a.json', size: 3 }], count: 1, nextCursor: 'tok' }));
    const out = await call('file_list', { store: 'artifacts', prefix: 'dumps/', limit: 10 });
    expect(out.files).toHaveLength(1);
    expect(out.nextCursor).toBe('tok');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://cp.local/datasets/stores/store_file123/list');
    expect(JSON.parse(opts.body)).toEqual({ prefix: 'dumps/', limit: 10 });
  });

  it('deletes by path', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ ok: true, path: 'dumps/a.json', deleted: true }));
    const out = await call('file_delete', { store: 'artifacts', path: 'dumps/a.json' });
    expect(out).toMatchObject({ ok: true, deleted: true, store: 'artifacts' });
    expect(fetchMock.mock.calls[0][0]).toContain('/store_file123/delete');
  });
});

describe('tool surface', () => {
  it('declares the four file tools with path-required schemas', () => {
    const names = datasetStoreSkill.tools.map((t) => t.name);
    for (const n of ['file_put', 'file_get', 'file_list', 'file_delete']) expect(names).toContain(n);
    const put = datasetStoreSkill.tools.find((t) => t.name === 'file_put');
    expect(put.input_schema.required).toEqual(['path']);
    expect(datasetStoreSkill.tools.find((t) => t.name === 'ensure_store').input_schema.properties.type.enum).toContain('file');
  });
});
