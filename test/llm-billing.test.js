/**
 * Unit tests for @zibby/skills/llm-billing.
 *
 * Coverage:
 *  - Skill objects (id + requiresIntegration match INTEGRATIONS source-of-truth)
 *  - fetchOpenAICosts: URL shape, Bearer header, response normalize, pagination
 *  - fetchAnthropicCosts: x-api-key + anthropic-version header, ISO timestamps
 *  - fetchCursorSpend: YYYY-MM-DD dates, flattens userMetrics × modelUsage
 *  - Provider catalog fetchers (fetchOpenAIProjects, fetchAnthropicWorkspaces)
 *  - fetchAllProviders: parallel + partial-failure (Promise.allSettled)
 *  - groupByKey + meanStddev helpers
 *  - Error propagation on non-OK HTTP
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the token resolver — returns a stub token per provider. The
// real impl hits the backend; tests don't need that round-trip.
vi.mock('@zibby/core/backend-client.js', () => ({
  resolveIntegrationToken: vi.fn(async (provider) => ({
    token: `stub-${provider}-key`,
    expiresInSec: 3000,
  })),
  clearTokenCache: vi.fn(),
}));

const {
  openaiBillingSkill,
  anthropicBillingSkill,
  cursorAdminSkill,
  fetchOpenAICosts,
  fetchOpenAIProjects,
  fetchAnthropicCosts,
  fetchAnthropicWorkspaces,
  fetchCursorSpend,
  fetchAllProviders,
  groupByKey,
  meanStddev,
} = await import('../src/llm-billing.js');
const { INTEGRATIONS } = await import('../src/integrations.js');

// Helpers ────────────────────────────────────────────────────────────

function okResponse(json) {
  return {
    ok: true,
    status: 200,
    json: async () => json,
    text: async () => JSON.stringify(json),
  };
}

function errResponse(status, bodyText = '') {
  return {
    ok: false,
    status,
    json: async () => {
      throw new Error('not json');
    },
    text: async () => bodyText,
  };
}

let originalFetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

// ───────────────────────── skill declarations ─────────────────────────

describe('skill declarations', () => {
  it('openaiBillingSkill: id + requiresIntegration', () => {
    expect(openaiBillingSkill.id).toBe('openai_billing');
    expect(openaiBillingSkill.requiresIntegration).toBe(INTEGRATIONS.OPENAI_BILLING);
    expect(Object.isFrozen(openaiBillingSkill)).toBe(true);
  });

  it('anthropicBillingSkill: id + requiresIntegration', () => {
    expect(anthropicBillingSkill.id).toBe('anthropic_billing');
    expect(anthropicBillingSkill.requiresIntegration).toBe(INTEGRATIONS.ANTHROPIC_BILLING);
  });

  it('cursorAdminSkill: id + requiresIntegration', () => {
    expect(cursorAdminSkill.id).toBe('cursor_admin');
    expect(cursorAdminSkill.requiresIntegration).toBe(INTEGRATIONS.CURSOR_ADMIN);
  });
});

// ───────────────────────── fetchOpenAICosts ─────────────────────────

describe('fetchOpenAICosts', () => {
  it('builds correct URL + Bearer header, normalizes single-page response', async () => {
    const fetchMock = vi.fn(async () => okResponse({
      object: 'page',
      data: [
        {
          object: 'bucket',
          start_time: 1747526400,
          end_time: 1747612800,
          results: [
            { amount: { value: 12.34, currency: 'usd' }, project_id: 'proj_a', line_item: 'gpt-4o' },
            { amount: { value: 0.50,  currency: 'usd' }, project_id: 'proj_b', line_item: 'gpt-4o-mini' },
          ],
        },
      ],
      has_more: false,
    }));
    globalThis.fetch = fetchMock;

    const startMs = 1747526400 * 1000;
    const endMs = startMs + 86400 * 1000;
    const result = await fetchOpenAICosts({ startMs, endMs });

    // URL
    const url = fetchMock.mock.calls[0][0];
    expect(url).toMatch(/^https:\/\/api\.openai\.com\/v1\/organization\/costs\?/);
    expect(url).toContain(`start_time=${Math.floor(startMs / 1000)}`);
    expect(url).toContain(`end_time=${Math.floor(endMs / 1000)}`);
    expect(url).toContain('bucket_width=1d');
    expect(url).toMatch(/group_by\[\]=project_id/);

    // Auth
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer stub-openai_billing-key');

    // Normalized output
    expect(result.ok).toBe(true);
    expect(result.rawBuckets).toBe(1);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual({
      provider: 'openai',
      day: '2025-05-18',
      costUsd: 12.34,
      projectId: 'proj_a',
      apiKeyId: undefined,
      model: 'gpt-4o',
    });
    expect(result.items[1].projectId).toBe('proj_b');
  });

  it('paginates via next_page until has_more=false', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse({
        data: [{ start_time: 1, end_time: 2, results: [{ amount: { value: 1 } }] }],
        has_more: true,
        next_page: 'cursor-2',
      }))
      .mockResolvedValueOnce(okResponse({
        data: [{ start_time: 3, end_time: 4, results: [{ amount: { value: 2 } }] }],
        has_more: false,
      }));
    globalThis.fetch = fetchMock;

    const result = await fetchOpenAICosts({ startMs: 1000, endMs: 5000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.items).toHaveLength(2);
    expect(result.items.map((i) => i.costUsd)).toEqual([1, 2]);

    // Page param on second call
    expect(fetchMock.mock.calls[1][0]).toContain('page=cursor-2');
  });

  it('bails on safety bound (no infinite loop)', async () => {
    // Upstream always returns has_more: true — we should stop at safety limit.
    const fetchMock = vi.fn(async () => okResponse({
      data: [{ start_time: 1, end_time: 2, results: [] }],
      has_more: true,
      next_page: 'always',
    }));
    globalThis.fetch = fetchMock;

    await fetchOpenAICosts({ startMs: 1000, endMs: 5000 });
    expect(fetchMock).toHaveBeenCalledTimes(50);
  });

  it('throws when OpenAI returns non-OK status', async () => {
    globalThis.fetch = vi.fn(async () => errResponse(500, 'Internal Server Error'));
    await expect(fetchOpenAICosts({ startMs: 0, endMs: 1000 }))
      .rejects.toThrow(/OpenAI costs API 500/);
  });

  it('respects custom groupBy', async () => {
    const fetchMock = vi.fn(async () => okResponse({ data: [], has_more: false }));
    globalThis.fetch = fetchMock;
    await fetchOpenAICosts({ startMs: 0, endMs: 1000, groupBy: ['api_key_id'] });
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('group_by[]=api_key_id');
    expect(url).not.toContain('group_by[]=project_id');
  });
});

// ───────────────────────── fetchOpenAIProjects ─────────────────────────

describe('fetchOpenAIProjects', () => {
  it('returns Map of id → name', async () => {
    globalThis.fetch = vi.fn(async () => okResponse({
      data: [
        { id: 'proj_a', name: 'acme-prod' },
        { id: 'proj_b', name: 'globex-staging' },
      ],
    }));
    const map = await fetchOpenAIProjects();
    expect(map).toBeInstanceOf(Map);
    expect(map.get('proj_a')).toBe('acme-prod');
    expect(map.get('proj_b')).toBe('globex-staging');
  });
});

// ───────────────────────── fetchAnthropicCosts ─────────────────────────

describe('fetchAnthropicCosts', () => {
  it('builds correct URL + x-api-key + anthropic-version headers', async () => {
    const fetchMock = vi.fn(async () => okResponse({
      data: [
        {
          starting_at: '2026-05-13T00:00:00Z',
          ending_at: '2026-05-14T00:00:00Z',
          currency: 'USD',
          results: [
            {
              amount: '4.20',
              workspace_id: 'ws_a',
              model: 'claude-opus-4',
              uncached_input_tokens: 1000,
              cached_input_tokens: 200,
              output_tokens: 500,
            },
          ],
        },
      ],
      has_more: false,
    }));
    globalThis.fetch = fetchMock;

    const startMs = new Date('2026-05-13T00:00:00Z').getTime();
    const endMs = startMs + 86400 * 1000;
    const result = await fetchAnthropicCosts({ startMs, endMs });

    const url = fetchMock.mock.calls[0][0];
    expect(url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/organizations\/cost_report\?/);
    expect(url).toContain('starting_at=2026-05-13T00%3A00%3A00.000Z');
    expect(url).toContain('ending_at=2026-05-14T00%3A00%3A00.000Z');
    expect(url).toContain('bucket=1d');
    expect(url).toContain('group_by[]=workspace_id');

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['x-api-key']).toBe('stub-anthropic_billing-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');

    expect(result.items).toEqual([{
      provider: 'anthropic',
      day: '2026-05-13',
      costUsd: 4.2,
      workspaceId: 'ws_a',
      apiKeyId: undefined,
      model: 'claude-opus-4',
      tokensIn: 1000,
      tokensOut: 500,
      cachedTokens: 200,
    }]);
  });

  it('throws on non-OK', async () => {
    globalThis.fetch = vi.fn(async () => errResponse(401, '{"error":"unauthorized"}'));
    await expect(fetchAnthropicCosts({ startMs: 0, endMs: 1000 }))
      .rejects.toThrow(/Anthropic cost_report 401/);
  });
});

describe('fetchAnthropicWorkspaces', () => {
  it('returns Map id → name with correct headers', async () => {
    const fetchMock = vi.fn(async () => okResponse({
      data: [{ id: 'ws_a', name: 'Production' }, { id: 'ws_b', name: 'Staging' }],
    }));
    globalThis.fetch = fetchMock;
    const map = await fetchAnthropicWorkspaces();
    expect(fetchMock.mock.calls[0][1].headers['anthropic-version']).toBe('2023-06-01');
    expect(map.get('ws_a')).toBe('Production');
  });
});

// ───────────────────────── fetchCursorSpend ─────────────────────────

describe('fetchCursorSpend', () => {
  it('flattens userMetrics × modelUsage with acceptance rate', async () => {
    const fetchMock = vi.fn(async () => okResponse({
      data: [
        {
          date: '2026-05-19',
          totalCents: 5000,
          userMetrics: [
            {
              email: 'alice@zibby.app',
              totalCents: 3000,
              modelUsage: [
                { model: 'claude-opus-4', totalCents: 2000, requestCount: 12, acceptedLines: 80, suggestedLines: 100 },
                { model: 'gpt-4o',         totalCents: 1000, requestCount: 5,  acceptedLines: 5,  suggestedLines: 50 },
              ],
            },
            {
              email: 'bob@zibby.app',
              totalCents: 2000,
              modelUsage: [],
            },
          ],
        },
      ],
    }));
    globalThis.fetch = fetchMock;

    const startMs = new Date('2026-05-19T00:00:00Z').getTime();
    const endMs = startMs + 86400 * 1000;
    const result = await fetchCursorSpend({ startMs, endMs });

    const url = fetchMock.mock.calls[0][0];
    expect(url).toMatch(/^https:\/\/api\.cursor\.com\/teams\/daily-usage-data\?startDate=2026-05-19&endDate=2026-05-20$/);

    // alice: 2 modelUsage entries, bob: empty modelUsage → fall-back row
    expect(result.items).toHaveLength(3);

    const aliceOpus = result.items.find((i) => i.userEmail === 'alice@zibby.app' && i.model === 'claude-opus-4');
    expect(aliceOpus.costUsd).toBe(20);
    expect(aliceOpus.requestCount).toBe(12);
    expect(aliceOpus.acceptanceRate).toBeCloseTo(0.8);

    const aliceGpt = result.items.find((i) => i.model === 'gpt-4o');
    expect(aliceGpt.acceptanceRate).toBeCloseTo(0.1);

    const bob = result.items.find((i) => i.userEmail === 'bob@zibby.app');
    expect(bob.model).toBeUndefined();
    expect(bob.costUsd).toBe(20);
  });

  it('omits acceptanceRate when suggested=0 (no divide-by-zero)', async () => {
    globalThis.fetch = vi.fn(async () => okResponse({
      data: [{
        date: '2026-05-19',
        userMetrics: [{
          email: 'c@x.com',
          modelUsage: [{ model: 'm', totalCents: 100, requestCount: 1, acceptedLines: 0, suggestedLines: 0 }],
        }],
      }],
    }));
    const result = await fetchCursorSpend({ startMs: 0, endMs: 86400000 });
    expect(result.items[0].acceptanceRate).toBeUndefined();
  });
});

// ───────────────────────── fetchAllProviders ─────────────────────────

describe('fetchAllProviders', () => {
  it('runs all three in parallel + sums per-provider totals', async () => {
    // Each call returns one item with a fixed cost so totals are predictable.
    globalThis.fetch = vi.fn(async (url) => {
      if (url.includes('openai.com')) {
        return okResponse({
          data: [{ start_time: 1747526400, results: [{ amount: { value: 10 } }] }],
          has_more: false,
        });
      }
      if (url.includes('anthropic.com')) {
        return okResponse({
          data: [{ starting_at: '2026-05-19T00:00:00Z', results: [{ amount: '20' }] }],
          has_more: false,
        });
      }
      if (url.includes('cursor.com')) {
        return okResponse({
          data: [{ date: '2026-05-19', userMetrics: [{ email: 'a@x', modelUsage: [{ model: 'm', totalCents: 3000 }] }] }],
        });
      }
      return errResponse(404, '');
    });

    const result = await fetchAllProviders({ startMs: 0, endMs: 86400000 });
    expect(result.openai.ok).toBe(true);
    expect(result.anthropic.ok).toBe(true);
    expect(result.cursor.ok).toBe(true);
    expect(result.totals).toEqual([
      { provider: 'openai',    totalUsd: 10 },
      { provider: 'anthropic', totalUsd: 20 },
      { provider: 'cursor',    totalUsd: 30 },
    ]);
  });

  it('partial failure: one provider errors, others still return data', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (url.includes('openai.com')) return errResponse(500, 'OpenAI is down');
      if (url.includes('anthropic.com')) {
        return okResponse({
          data: [{ starting_at: '2026-05-19T00:00:00Z', results: [{ amount: '15' }] }],
          has_more: false,
        });
      }
      if (url.includes('cursor.com')) {
        return okResponse({
          data: [{ date: '2026-05-19', userMetrics: [{ email: 'a@x', totalCents: 500 }] }],
        });
      }
      return errResponse(404, '');
    });

    const result = await fetchAllProviders({ startMs: 0, endMs: 86400000 });
    expect(result.openai.ok).toBe(false);
    expect(result.openai.error).toMatch(/OpenAI costs API 500/);
    expect(result.openai.items).toEqual([]);
    expect(result.anthropic.ok).toBe(true);
    expect(result.anthropic.items[0].costUsd).toBe(15);
    expect(result.cursor.ok).toBe(true);
    expect(result.totals.find((t) => t.provider === 'openai').totalUsd).toBe(0);
    expect(result.totals.find((t) => t.provider === 'anthropic').totalUsd).toBe(15);
    expect(result.totals.find((t) => t.provider === 'cursor').totalUsd).toBe(5);
  });
});

// ───────────────────────── helpers: groupByKey + meanStddev ─────────────────────────

describe('groupByKey', () => {
  it('groups + sums costUsd, returns sorted desc', () => {
    const items = [
      { provider: 'openai', day: 'x', costUsd: 5,  projectId: 'a' },
      { provider: 'openai', day: 'x', costUsd: 10, projectId: 'b' },
      { provider: 'openai', day: 'y', costUsd: 7,  projectId: 'a' },
    ];
    const out = groupByKey(items, (it) => it.projectId);
    expect(out).toEqual([
      { key: 'b', totalUsd: 10, count: 1 },
      { key: 'a', totalUsd: 12, count: 2 },
    ].sort((p, q) => q.totalUsd - p.totalUsd));
  });

  it('skips items where keyFn returns falsy', () => {
    const items = [
      { costUsd: 1, projectId: 'a' },
      { costUsd: 2, projectId: null },
      { costUsd: 3, projectId: undefined },
    ];
    const out = groupByKey(items, (it) => it.projectId);
    expect(out).toEqual([{ key: 'a', totalUsd: 1, count: 1 }]);
  });
});

describe('meanStddev', () => {
  it('computes population mean + stddev', () => {
    const { mean, stddev } = meanStddev([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(mean).toBe(5);
    expect(stddev).toBeCloseTo(2, 5);
  });

  it('returns zeros on empty input', () => {
    expect(meanStddev([])).toEqual({ mean: 0, stddev: 0 });
  });
});
