/**
 * A store this run did not bind, but that exists in the project — this agent's
 * own from an earlier run (ensure_store), or one a teammate made — is found by
 * a READ of the project's store list (never created).
 * run_log/magnum/2026-10-29-teammate-store-unreachable: QA runs got
 * "unknown store 'developer-evidence'" on a developer's evidence store, and a
 * developer's next run could not reach its own; 12 runs hit it in one day.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.PROJECT_API_TOKEN = 'zby_test_token';
process.env.ZIBBY_ACCOUNT_API_URL = 'http://cp.local';
process.env.WORKFLOW_TYPE = 'product-qa';
process.env.ZIBBY_STORE__qa_notes = 'store_qa_notes';

const { datasetStoreSkill, __clearEnsuredStores } = await import('../datasetStore.js');

const call = async (name, args) => JSON.parse(await datasetStoreSkill.handleToolCall(name, args));
const okJson = (body) => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });

const STORES = { ok: true, stores: [
  { storeId: 'store_dev_evidence', name: 'developer-evidence', key: 'agent:developer:developer-evidence', type: 'file', status: 'ready' },
  { storeId: 'store_qa_old', name: 'qa-scratch', key: 'agent:product-qa:qa-scratch', type: 'file', status: 'ready' },
  { storeId: 'store_gone', name: 'old', key: 'agent:developer:old', type: 'file', status: 'deleted' },
  { storeId: 'store_declared', name: 'ledger', key: 'magnum:Write it down:ledger', type: 'sqlite', status: 'ready' },
] };

let fetchMock;
beforeEach(() => { __clearEnsuredStores(); fetchMock = vi.fn(); global.fetch = fetchMock; });
afterEach(() => { delete global.fetch; });

describe('a store made by a teammate', () => {
  it('a QA reads the developer evidence store by its bare name (was: unknown store, no way through)', async () => {
    fetchMock
      .mockResolvedValueOnce(okJson(STORES))
      .mockResolvedValueOnce(okJson({ ok: true, files: [{ path: '876/m.json' }] }));
    const out = await call('file_list', { store: 'developer-evidence', prefix: '876/' });
    expect(out.error).toBeUndefined();
    expect(out).toMatchObject({ store: 'developer-evidence', storeId: 'store_dev_evidence', owner: 'developer' });
    expect(fetchMock.mock.calls[0][0]).toBe('http://cp.local/datasets/stores');
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    expect(fetchMock.mock.calls[1][0]).toBe('http://cp.local/datasets/stores/store_dev_evidence/list');
  });

  it('names it <agent>:<name> for any tool', async () => {
    fetchMock.mockResolvedValueOnce(okJson(STORES)).mockResolvedValueOnce(okJson({ ok: true }));
    const out = await call('file_put', { store: 'developer:developer-evidence', path: 'qa/readback.txt', content: 'ok' });
    expect(out).toMatchObject({ storeId: 'store_dev_evidence', owner: 'developer' });
    expect(fetchMock.mock.calls[1][0]).toBe('http://cp.local/datasets/stores/store_dev_evidence/put');
  });

  it('a write by a bare name never lands in a teammate store; the answer names it', async () => {
    fetchMock.mockResolvedValueOnce(okJson(STORES));
    const out = await call('file_put', { store: 'developer-evidence', path: 'a.txt', content: 'x' });
    expect(out.error).toMatch(/unknown store 'developer-evidence'/);
    expect(out.error).toMatch(/developer:developer-evidence/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('a store this agent made in an earlier run', () => {
  it('binds by name as ensure_store would, without creating anything', async () => {
    fetchMock.mockResolvedValueOnce(okJson(STORES)).mockResolvedValueOnce(okJson({ ok: true }));
    const out = await call('file_put', { store: 'qa-scratch', path: 'a.txt', content: 'x' });
    expect(out).toMatchObject({ storeId: 'store_qa_old' });
    expect(out.owner).toBeUndefined();
    expect(fetchMock.mock.calls.some(([url]) => /\/ensure$/.test(url))).toBe(false);
    // bound for the rest of the run: no second list call
    fetchMock.mockResolvedValueOnce(okJson({ ok: true }));
    await call('file_put', { store: 'qa-scratch', path: 'b.txt', content: 'y' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('a name nobody made', () => {
  it('keeps the refusal and lists the on-demand stores that exist (deleted ones left out)', async () => {
    fetchMock.mockResolvedValueOnce(okJson(STORES));
    const out = await call('file_get', { store: 'nope', path: 'a.txt' });
    expect(out.error).toMatch(/unknown store 'nope'; available: qa_notes/);
    expect(out.error).toMatch(/developer:developer-evidence/);
    expect(out.error).not.toMatch(/developer:old/);
  });

  it('a bound name never lists anything (no extra call)', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ ok: true, files: [] }));
    await call('file_list', { store: 'qa_notes' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://cp.local/datasets/stores/store_qa_notes/list');
  });

  it('a failed list keeps the original refusal', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}), text: async () => '' });
    const out = await call('file_get', { store: 'developer-evidence', path: 'a' });
    expect(out.error).toBe("unknown store 'developer-evidence'; available: qa_notes");
  });
});
