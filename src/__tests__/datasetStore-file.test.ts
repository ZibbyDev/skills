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

// ── files on the run's own disk: fromPath (upload) / toPath (download) ──────
// The bytes move between the run's disk and the store without passing through
// the model or a JSON body. Real files in a temp dir; the network is the same
// fetch mock as above.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

/** A loopback server standing in for the object store's signed-link route. */
async function linkServer(handler) {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    if (handler.drain !== false) for await (const c of req) chunks.push(c);
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    handler.reply(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

const THRESHOLD = Math.floor(3.5 * 1024 * 1024);
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'file-store-disk-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('file_put fromPath', () => {
  it('a small file goes up as the ordinary put, its bytes base64 in the body', async () => {
    const src = join(dir, 'notes.bin');
    writeFileSync(src, Buffer.from([1, 2, 3, 0, 255]));
    fetchMock.mockResolvedValueOnce(okJson({ ok: true, path: 'keep/notes.bin', size: 5, contentType: 'application/octet-stream' }));
    const out = await call('file_put', { store: 'artifacts', path: 'keep/notes.bin', fromPath: src });
    expect(out).toMatchObject({ ok: true, path: 'keep/notes.bin', size: 5, fromPath: src, store: 'artifacts' });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://cp.local/datasets/stores/store_file123/put');
    const body = JSON.parse(opts.body);
    expect(Buffer.from(body.contentBase64, 'base64').equals(Buffer.from([1, 2, 3, 0, 255]))).toBe(true);
    expect(body.content).toBeUndefined();
  });

  it('a file over the 3.5 MiB threshold streams from disk through put-url, with its Content-Length, never as JSON', async () => {
    const src = join(dir, 'evidence.tar');
    const bytes = Buffer.alloc(THRESHOLD + 4096, 7);
    bytes[0] = 1; bytes[bytes.length - 1] = 9;
    writeFileSync(src, bytes);
    const store = await linkServer({ reply: (_q, r) => { r.writeHead(200); r.end(); } });
    try {
      fetchMock.mockResolvedValueOnce(okJson({ ok: true, path: 'evidence/run.tar', method: 'PUT', url: `${store.url}/objects/v1/b/k/run.tar?sig=x`, headers: { 'Content-Type': 'application/x-tar' }, contentType: 'application/x-tar' }));
      const out = await call('file_put', { store: 'artifacts', path: 'evidence/run.tar', fromPath: src, contentType: 'application/x-tar' });
      expect(out).toMatchObject({ ok: true, path: 'evidence/run.tar', size: bytes.length, via: 'presign', fromPath: src });
      const [mintUrl, mintOpts] = fetchMock.mock.calls[0];
      expect(mintUrl).toBe('http://cp.local/datasets/stores/store_file123/put-url');
      expect(JSON.parse(mintOpts.body)).toEqual({ path: 'evidence/run.tar', contentType: 'application/x-tar' });
      // Only the mint went through fetch: the bytes went straight to the link.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(store.seen).toHaveLength(1);
      const put = store.seen[0];
      expect(put).toMatchObject({ method: 'PUT', url: '/objects/v1/b/k/run.tar?sig=x' });
      expect(put.headers['content-type']).toBe('application/x-tar');
      expect(put.headers['content-length']).toBe(String(bytes.length));
      expect(put.body.equals(bytes)).toBe(true);
    } finally { await store.close(); }
  });

  it('a refused direct upload (full disk) comes back as the store\'s own words', async () => {
    const src = join(dir, 'big.bin');
    writeFileSync(src, Buffer.alloc(THRESHOLD + 1));
    const words = "The box's storage is almost full: 1.0 GB free and 2.0 GB is kept in reserve, so a 0.0 GB write was refused.";
    const store = await linkServer({ drain: false, reply: (q, r) => { q.resume(); r.writeHead(507, { 'Content-Type': 'text/plain' }); r.end(words); } });
    try {
      fetchMock.mockResolvedValueOnce(okJson({ ok: true, url: `${store.url}/objects/v1/x`, headers: { 'Content-Type': 'application/octet-stream' } }));
      const out = await call('file_put', { store: 'artifacts', path: 'big.bin', fromPath: src });
      expect(out.error).toBe(`direct upload failed (507): ${words}`);
    } finally { await store.close(); }
  });

  it('a missing file / a directory is reported as the fact, before any network call', async () => {
    const missing = join(dir, 'nope.tar');
    expect((await call('file_put', { store: 'artifacts', path: 'a', fromPath: missing })).error).toBe(`fromPath ${missing} does not exist on this run's disk`);
    expect((await call('file_put', { store: 'artifacts', path: 'a', fromPath: dir })).error).toMatch(/is a directory, not a regular file/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a relative fromPath is resolved against the tool\'s working directory and reported absolute', async () => {
    const prev = process.cwd();
    writeFileSync(join(dir, 'rel.txt'), 'hello');
    process.chdir(dir);
    try {
      fetchMock.mockResolvedValueOnce(okJson({ ok: true, path: 'rel.txt', size: 5 }));
      const out = await call('file_put', { store: 'artifacts', path: 'rel.txt', fromPath: 'rel.txt' });
      expect(out.fromPath).toBe(join(process.cwd(), 'rel.txt'));
    } finally { process.chdir(prev); }
  });
});

describe('file_put takes exactly one of content / contentBase64 / fromPath', () => {
  it('two inputs are refused, naming both, with no network call', async () => {
    const src = join(dir, 'x.txt');
    writeFileSync(src, 'x');
    expect((await call('file_put', { store: 'artifacts', path: 'a', content: 'x', fromPath: src })).error).toBe('pass exactly one of content, contentBase64 or fromPath (got content + fromPath)');
    expect((await call('file_put', { store: 'artifacts', path: 'a', content: 'x', contentBase64: 'eA==' })).error).toMatch(/exactly one .*got content \+ contentBase64/);
    expect((await call('file_put', { store: 'artifacts', path: 'a', contentBase64: 'eA==', fromPath: src })).error).toMatch(/got contentBase64 \+ fromPath/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('none is refused and names all three', async () => {
    expect((await call('file_put', { store: 'artifacts', path: 'a' })).error).toMatch(/content .*contentBase64 .*fromPath .*exactly one/);
  });

  it('an empty `content` beside fromPath is a blank, not a second input; alone it still writes an empty file', async () => {
    const src = join(dir, 'x.txt');
    writeFileSync(src, 'x');
    fetchMock.mockResolvedValueOnce(okJson({ ok: true, path: 'a', size: 1 }));
    expect((await call('file_put', { store: 'artifacts', path: 'a', content: '', fromPath: src })).ok).toBe(true);
    fetchMock.mockResolvedValueOnce(okJson({ ok: true, path: 'e', size: 0 }));
    expect((await call('file_put', { store: 'artifacts', path: 'e', content: '' })).ok).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ path: 'e', content: '' });
  });
});

describe('file_get toPath', () => {
  const big = Buffer.alloc(THRESHOLD + 2048, 3);

  it('streams the stored file to the run\'s disk through get-url and returns path + size, never content', async () => {
    const dest = join(dir, 'restore', 'deep', 'run.tar');
    fetchMock
      .mockResolvedValueOnce(okJson({ ok: true, path: 'evidence/run.tar', method: 'GET', url: 'http://cp.local/objects/v1/b/k/run.tar?sig=y', size: big.length }))
      .mockResolvedValueOnce(new Response(big, { status: 200, headers: { 'content-type': 'application/x-tar' } }));
    const out = await call('file_get', { store: 'artifacts', path: 'evidence/run.tar', toPath: dest });
    expect(out).toEqual({ ok: true, store: 'artifacts', storeId: 'store_file123', path: 'evidence/run.tar', toPath: dest, size: big.length, contentType: 'application/x-tar' });
    expect(readFileSync(dest).equals(big)).toBe(true);
    const [mintUrl, mintOpts] = fetchMock.mock.calls[0];
    expect(mintUrl).toBe('http://cp.local/datasets/stores/store_file123/get-url');
    expect(JSON.parse(mintOpts.body)).toEqual({ path: 'evidence/run.tar' });
    expect(readdirSync(join(dir, 'restore', 'deep'))).toEqual(['run.tar']); // no temp file left behind
  });

  it('an existing folder receives the file under its stored name', async () => {
    mkdirSync(join(dir, 'into'));
    fetchMock
      .mockResolvedValueOnce(okJson({ ok: true, url: 'http://cp.local/objects/v1/z', size: 3 }))
      .mockResolvedValueOnce(new Response(Buffer.from('abc'), { status: 200 }));
    const out = await call('file_get', { store: 'artifacts', path: 'reports/r.txt', toPath: join(dir, 'into') });
    expect(out.toPath).toBe(join(dir, 'into', 'r.txt'));
    expect(readFileSync(join(dir, 'into', 'r.txt'), 'utf8')).toBe('abc');
  });

  it('a missing stored file is the store\'s own 404, and nothing is written', async () => {
    const dest = join(dir, 'never', 'x.tar');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => '{"error":"file not found: x.tar"}' });
    const out = await call('file_get', { store: 'artifacts', path: 'x.tar', toPath: dest });
    expect(out.error).toMatch(/404.*file not found: x\.tar/);
    expect(existsSync(join(dir, 'never'))).toBe(false);
  });

  it('a download that breaks part-way leaves no file under the asked-for name', async () => {
    const dest = join(dir, 'half.tar');
    const broken = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.error(new Error('connection reset')); } });
    fetchMock
      .mockResolvedValueOnce(okJson({ ok: true, url: 'http://cp.local/objects/v1/h', size: 100 }))
      .mockResolvedValueOnce(new Response(broken, { status: 200 }));
    const out = await call('file_get', { store: 'artifacts', path: 'half.tar', toPath: dest });
    expect(out.error).toMatch(/connection reset/);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('the store boundary still holds for the disk paths', () => {
  it('an unbound store name is refused before the file is read or anything is sent', async () => {
    const src = join(dir, 'secret.tar');
    writeFileSync(src, 'x');
    expect((await call('file_put', { store: 'someone-elses', path: 'a', fromPath: src })).error).toMatch(/unknown store 'someone-elses'/);
    expect((await call('file_get', { store: 'someone-elses', path: 'a', toPath: join(dir, 'out') })).error).toMatch(/unknown store 'someone-elses'/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'out'))).toBe(false);
  });

  it('the upload link is minted by the server for the resolved store id — the skill never builds a storage key', async () => {
    const src = join(dir, 'big.bin');
    writeFileSync(src, Buffer.alloc(THRESHOLD + 1));
    const store = await linkServer({ reply: (_q, r) => { r.writeHead(200); r.end(); } });
    try {
      fetchMock.mockResolvedValueOnce(okJson({ ok: true, url: `${store.url}/objects/v1/k`, headers: { 'Content-Type': 'application/octet-stream' } }));
      await call('file_put', { store: 'artifacts', path: 'big.bin', fromPath: src });
      const [mintUrl, mintOpts] = fetchMock.mock.calls[0];
      expect(mintUrl).toBe('http://cp.local/datasets/stores/store_file123/put-url');
      expect(mintOpts.headers.Authorization).toBe('Bearer zby_test_token');
      expect(Object.keys(JSON.parse(mintOpts.body)).sort()).toEqual(['contentType', 'path']); // no account / project / key
      expect(store.seen[0].url).toBe('/objects/v1/k'); // the bytes go only where the server's link points
    } finally { await store.close(); }
  });
});

describe('disk-path tool surface', () => {
  it('file_put declares fromPath and file_get declares toPath, both optional', () => {
    const put = datasetStoreSkill.tools.find((t) => t.name === 'file_put');
    const get = datasetStoreSkill.tools.find((t) => t.name === 'file_get');
    expect(put.input_schema.properties.fromPath.type).toBe('string');
    expect(get.input_schema.properties.toPath.type).toBe('string');
    expect(put.input_schema.required).toEqual(['path']);
    expect(get.input_schema.required).toEqual(['path']);
  });
});
