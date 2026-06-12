import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reviewMemorySkill } from '../src/reviewMemory.js';

// Self-host LOCAL-FILE backend for review-memory. With ZIBBY_SELF_HOST set +
// a memory path configured, the SAME three tool handlers persist to a JSON file
// instead of POSTing /memory/review — no network. We assert the round-trip,
// prefix filtering, the missing-file/none/cloud gates, and the EXACT result
// shapes (so the agent-facing output is identical to the cloud branch).

let tmp;
let memPath;

function readFile() {
  return JSON.parse(readFileSync(memPath, 'utf-8'));
}

beforeEach(() => {
  vi.restoreAllMocks();
  tmp = mkdtempSync(join(tmpdir(), 'zibby-rmem-'));
  memPath = join(tmp, 'nested', 'review-memory.json'); // nested → dirs created on store
  process.env.ZIBBY_SELF_HOST = '1';
  process.env.ZIBBY_REVIEW_MEMORY_PATH = memPath;
  delete process.env.ZIBBY_REVIEW_MEMORY_BACKEND;
  // Ensure no cloud token leaks a real fetch.
  delete process.env.PROJECT_API_TOKEN;
  delete process.env.ZIBBY_USER_TOKEN;
});

afterEach(() => {
  delete process.env.ZIBBY_SELF_HOST;
  delete process.env.ZIBBY_REVIEW_MEMORY_PATH;
  delete process.env.ZIBBY_REVIEW_MEMORY_BACKEND;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('self-host file backend — store → recall round-trip', () => {
  it('persists a note to the JSON file and recalls it back (no network)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');

    const stored = JSON.parse(await reviewMemorySkill.handleToolCall('review_memory_store', {
      scope: 'review:owner/repo#42',
      content: 'pulled X, found Y, reasoned Z',
      metadata: { files: 3 },
      headSha: 'abc123',
    }));
    expect(stored).toMatchObject({ stored: true, scope: 'review:owner/repo#42', headSha: 'abc123' });
    expect(typeof stored.updatedAt).toBe('string');

    // The file exists, dirs were created, and holds the scope→entry map.
    expect(existsSync(memPath)).toBe(true);
    const onDisk = readFile();
    expect(onDisk['review:owner/repo#42']).toMatchObject({
      scope: 'review:owner/repo#42',
      content: 'pulled X, found Y, reasoned Z',
      metadata: { files: 3 },
      headSha: 'abc123',
    });
    expect(onDisk['review:owner/repo#42'].createdAt).toBeTruthy();

    // recall returns the EXACT cloud shape { found, memory }.
    const recalled = JSON.parse(await reviewMemorySkill.handleToolCall('review_memory_recall', {
      scope: 'review:owner/repo#42',
    }));
    expect(recalled).toEqual({
      found: true,
      memory: {
        scope: 'review:owner/repo#42',
        content: 'pulled X, found Y, reasoned Z',
        metadata: { files: 3 },
        headSha: 'abc123',
        createdAt: onDisk['review:owner/repo#42'].createdAt,
        updatedAt: onDisk['review:owner/repo#42'].updatedAt,
      },
    });

    // Never hit the network.
    expect(spy).not.toHaveBeenCalled();
  });

  it('store overwrites content but preserves createdAt across runs', async () => {
    await reviewMemorySkill.handleToolCall('review_memory_store', { scope: 's1', content: 'v1' });
    const created = readFile().s1.createdAt;
    await new Promise((r) => setTimeout(r, 5));
    await reviewMemorySkill.handleToolCall('review_memory_store', { scope: 's1', content: 'v2' });
    const after = readFile().s1;
    expect(after.content).toBe('v2');
    expect(after.createdAt).toBe(created);          // preserved
    expect(after.updatedAt >= created).toBe(true);  // advanced
  });
});

describe('self-host file backend — recall-prefix filtering', () => {
  it('returns only entries whose scope startsWith the prefix', async () => {
    await reviewMemorySkill.handleToolCall('review_memory_store', { scope: 'review:o/r#1', content: 'a' });
    await reviewMemorySkill.handleToolCall('review_memory_store', { scope: 'review:o/r#2', content: 'b' });
    await reviewMemorySkill.handleToolCall('review_memory_store', { scope: 'repo:o/r', content: 'c' });

    const out = JSON.parse(await reviewMemorySkill.handleToolCall('review_memory_recall_prefix', {
      scopePrefix: 'review:o/r#',
    }));
    expect(out.count).toBe(2);
    expect(out.truncated).toBe(false);
    const scopes = out.memories.map((m) => m.scope).sort();
    expect(scopes).toEqual(['review:o/r#1', 'review:o/r#2']);
    // shape parity: every memory has the cloud keys.
    for (const m of out.memories) {
      expect(Object.keys(m).sort()).toEqual(
        ['content', 'createdAt', 'headSha', 'metadata', 'scope', 'updatedAt'],
      );
    }
  });
});

describe('self-host file backend — missing file is a clean miss (never throws)', () => {
  it('recall on a missing file returns { found:false, memory:null }', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const out = JSON.parse(await reviewMemorySkill.handleToolCall('review_memory_recall', { scope: 'nope' }));
    expect(out).toEqual({ found: false, memory: null });
    expect(existsSync(memPath)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('recall-prefix on a missing file returns count 0', async () => {
    const out = JSON.parse(await reviewMemorySkill.handleToolCall('review_memory_recall_prefix', { scopePrefix: 'x' }));
    expect(out).toEqual({ count: 0, truncated: false, memories: [] });
  });
});

describe('backend=none → file backend is skipped (falls through to cloud)', () => {
  it('with backend=none and no token, takes the cloud branch (errors on no credential)', async () => {
    process.env.ZIBBY_REVIEW_MEMORY_BACKEND = 'none';
    // Neutralize the ~/.zibby/config.json fallback.
    const prevHome = process.env.HOME;
    const prevUP = process.env.USERPROFILE;
    process.env.HOME = '/nonexistent-zibby-test-home';
    process.env.USERPROFILE = '/nonexistent-zibby-test-home';
    try {
      const spy = vi.spyOn(globalThis, 'fetch');
      const out = JSON.parse(await reviewMemorySkill.handleToolCall('review_memory_recall', { scope: 's' }));
      // No file was written/read; it tried the cloud path (which has no creds).
      expect(out.error).toContain('PROJECT_API_TOKEN');
      expect(existsSync(memPath)).toBe(false);
      expect(spy).not.toHaveBeenCalled(); // dies before fetch (no credential)
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevUP === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUP;
    }
  });
});

describe('CLOUD RED LINE — ZIBBY_SELF_HOST unset → HTTP branch, file untouched', () => {
  it('store/recall POST /memory/review and never write the local file', async () => {
    delete process.env.ZIBBY_SELF_HOST;            // the gate is OFF
    process.env.PROJECT_API_TOKEN = 'zby_tok';
    process.env.ZIBBY_ACCOUNT_API_URL = 'https://api-test.zibby.app';
    try {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true, status: 200, json: async () => ({ found: false, memory: null }), text: async () => '{}',
      });
      await reviewMemorySkill.handleToolCall('review_memory_store', { scope: 's', content: 'c' });
      await reviewMemorySkill.handleToolCall('review_memory_recall', { scope: 's' });

      // It went over HTTP to the cloud route, NOT to a file.
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[0][0]).toBe('https://api-test.zibby.app/credits/review-memory');
      expect(JSON.parse(spy.mock.calls[0][1].body)).toMatchObject({ op: 'store', scope: 's', content: 'c' });
      // The local file was never created.
      expect(existsSync(memPath)).toBe(false);
    } finally {
      delete process.env.PROJECT_API_TOKEN;
      delete process.env.ZIBBY_ACCOUNT_API_URL;
    }
  });
});
