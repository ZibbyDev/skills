import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Force the local-CLI-session fallback in getSessionToken() to find NO config
// file, so the "no-token" tests are deterministic regardless of whether the test
// machine has a real ~/.zibby/config.json. The token-present tests never reach
// existsSync (PROJECT_API_TOKEN short-circuits), so this mock is inert for them.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, existsSync: () => false };
});

import {
  scopeForReviewMemory,
  storeReviewRecord,
  recallReviewRecord,
} from '../src/reviewMemoryIo.js';
import { buildReviewRecord, serializeReviewRecord } from '../src/reviewRecord.js';

const REAL_FINDINGS = [
  { file: 'src/a.ts', line: 38, severity: '🔴', category: 'security', claim: 'SQLi', evidence: 'concat', suggestion: 'params', confidence: 0.9 },
  { file: 'src/b.ts', line: 7, severity: '🟡', category: 'correctness', claim: 'off-by-one', evidence: 'loop' },
];

const OLD_ENV = { ...process.env };

beforeEach(() => {
  // A backend credential + a known API base so the request is deterministic.
  process.env.PROJECT_API_TOKEN = 'tok-123';
  process.env.ZIBBY_ACCOUNT_API_URL = 'https://api-test.zibby.app';
  process.env.WORKFLOW_TYPE = 'github-code-review';
  delete process.env.ZIBBY_USER_TOKEN;
  delete process.env.ZIBBY_ENV;
  delete process.env.ZIBBY_PROD_ACCOUNT_API_URL;
});

afterEach(() => {
  vi.restoreAllMocks();
  // Restore env keys we touched.
  for (const k of ['PROJECT_API_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'WORKFLOW_TYPE', 'ZIBBY_USER_TOKEN', 'ZIBBY_ENV', 'ZIBBY_PROD_ACCOUNT_API_URL']) {
    if (k in OLD_ENV) process.env[k] = OLD_ENV[k];
    else delete process.env[k];
  }
});

describe('scopeForReviewMemory', () => {
  it('prepends the WORKFLOW_TYPE namespace to a plain key', () => {
    process.env.WORKFLOW_TYPE = 'github-code-review';
    expect(scopeForReviewMemory('pr:acme/web#42')).toBe('github-code-review:pr:acme/web#42');
  });
  it("falls back to 'agent' when WORKFLOW_TYPE is empty/whitespace (mirrors kv-memory)", () => {
    process.env.WORKFLOW_TYPE = '   ';
    expect(scopeForReviewMemory('mr:grp/repo!7')).toBe('agent:mr:grp/repo!7');
    delete process.env.WORKFLOW_TYPE;
    expect(scopeForReviewMemory('mr:grp/repo!7')).toBe('agent:mr:grp/repo!7');
  });
});

describe('storeReviewRecord', () => {
  it('POSTs op:store with the right url, bearer, scope + serialized content', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);

    const rec = buildReviewRecord({ verdict: 'REQUEST_CHANGES', objectivesChecked: true, findings: REAL_FINDINGS, nowIso: '2026-07-05T00:00:00.000Z' });
    const res = await storeReviewRecord('pr:acme/web#42', rec);
    expect(res).toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api-test.zibby.app/credits/review-memory');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer tok-123');
    expect(opts.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(opts.body);
    expect(body.op).toBe('store');
    expect(body.scope).toBe('github-code-review:pr:acme/web#42');
    // content is the deterministic serialization of the record.
    expect(body.content).toBe(serializeReviewRecord(rec));
    // sanity: the serialized content round-trips to a record.
    expect(JSON.parse(body.content).kind).toBe('review-record');
  });

  it('swallows a fetch/network error → { ok:false }, never throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);
    const rec = buildReviewRecord({ findings: REAL_FINDINGS, nowIso: '2026-07-05T00:00:00.000Z' });
    const res = await storeReviewRecord('pr:acme/web#42', rec);
    expect(res.ok).toBe(false);
  });

  it('swallows a non-2xx response → { ok:false }, never throws', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'too big' });
    vi.stubGlobal('fetch', fetchMock);
    const rec = buildReviewRecord({ findings: REAL_FINDINGS, nowIso: '2026-07-05T00:00:00.000Z' });
    const res = await storeReviewRecord('pr:acme/web#42', rec);
    expect(res.ok).toBe(false);
  });

  it('no-token path is a no-op { ok:false, reason:"no-token" } and never calls fetch', async () => {
    delete process.env.PROJECT_API_TOKEN;
    delete process.env.ZIBBY_USER_TOKEN;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const rec = buildReviewRecord({ findings: REAL_FINDINGS, nowIso: '2026-07-05T00:00:00.000Z' });
    const res = await storeReviewRecord('pr:acme/web#42', rec);
    expect(res).toEqual({ ok: false, reason: 'no-token' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('recallReviewRecord', () => {
  it('POSTs op:recall and parses the returned content into a record', async () => {
    const rec = buildReviewRecord({ verdict: 'COMMENT', findings: REAL_FINDINGS, nowIso: '2026-07-05T00:00:00.000Z' });
    const stored = serializeReviewRecord(rec);
    // Real backend recall shape (verified via live e2e): { found, memory:{ content, ... } }.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ found: true, memory: { content: stored, metadata: null } }) });
    vi.stubGlobal('fetch', fetchMock);

    const parsed = await recallReviewRecord('pr:acme/web#42');
    expect(parsed.kind).toBe('record');
    expect(parsed.record.verdict).toBe('COMMENT');
    expect(parsed.record.findings.length).toBe(2);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api-test.zibby.app/credits/review-memory');
    const body = JSON.parse(opts.body);
    expect(body.op).toBe('recall');
    expect(body.scope).toBe('github-code-review:pr:acme/web#42');
  });

  it('returns { kind:"empty" } when the store has nothing (found:false)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ found: false }) });
    vi.stubGlobal('fetch', fetchMock);
    const parsed = await recallReviewRecord('pr:acme/web#42');
    expect(parsed).toEqual({ kind: 'empty' });
  });

  it('treats a legacy prose note as kind:"legacy" (backward-compat)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ found: true, memory: { content: 'human pushed back on finding X; held' } }) });
    vi.stubGlobal('fetch', fetchMock);
    const parsed = await recallReviewRecord('pr:acme/web#42');
    expect(parsed.kind).toBe('legacy');
    expect(parsed.legacyNote).toMatch(/pushed back/);
  });

  it('swallows a fetch error → { kind:"empty" }, never throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('boom'));
    vi.stubGlobal('fetch', fetchMock);
    const parsed = await recallReviewRecord('pr:acme/web#42');
    expect(parsed).toEqual({ kind: 'empty' });
  });

  it('no-token path returns { kind:"empty" } without calling fetch', async () => {
    delete process.env.PROJECT_API_TOKEN;
    delete process.env.ZIBBY_USER_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const parsed = await recallReviewRecord('pr:acme/web#42');
    expect(parsed).toEqual({ kind: 'empty' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
