import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const TOKEN = 'oauth-na1-secret-token';

// Mock backend-client BEFORE importing the skill (same setup as figma-tools.test.js)
// so hubspotFetch's resolveIntegrationToken('hubspot') yields a fixed access token.
vi.mock('@zibby/core/backend-client.js', () => ({
  resolveIntegrationToken: vi.fn(async () => ({ provider: 'hubspot', token: TOKEN })),
  clearTokenCache: vi.fn(),
}));

const { resolveIntegrationToken } = await import('@zibby/core/backend-client.js');
const { hubspotSkill, INTEGRATIONS } = await (async () => ({
  hubspotSkill: (await import('../src/hubspot.js')).hubspotSkill,
  INTEGRATIONS: (await import('../src/integrations.js')).INTEGRATIONS,
}))();

// A fetch Response-like object (mirrors the figma/linkedin tests).
function fetchJson(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the resolver hands back a valid token (individual tests override).
  resolveIntegrationToken.mockResolvedValue({ provider: 'hubspot', token: TOKEN });
});

afterEach(() => {
  delete globalThis.fetch;
});

describe('hubspot tool surface', () => {
  it('(e) exposes exactly 9 tools, all named hubspot_*', () => {
    expect(hubspotSkill.tools).toHaveLength(9);
    const names = hubspotSkill.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'hubspot_associate',
      'hubspot_create_note',
      'hubspot_create_object',
      'hubspot_get_object',
      'hubspot_list_objects',
      'hubspot_list_properties',
      'hubspot_search',
      'hubspot_update_object',
      'hubspot_whoami',
    ]);
    for (const t of hubspotSkill.tools) {
      expect(t.name.startsWith('hubspot_')).toBe(true);
    }
  });

  it('declares the backend-session env keys and requires the hubspot integration', () => {
    // hubspotFetch calls resolveIntegrationToken() from INSIDE the MCP child,
    // whose env is only what resolve() copies from envKeys — so the session
    // allowlist must be declared (see backend-session-env-contract.test.ts).
    // No provider token key: the OAuth token itself always comes via the backend.
    expect(hubspotSkill.envKeys).toEqual(['PROJECT_API_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_ENV']);
    expect(hubspotSkill.requiresIntegration).toBe(INTEGRATIONS.HUBSPOT);
  });
});

describe('hubspot auth', () => {
  it('(a) resolver returns no token → hubspot_whoami returns {error} to Connect HubSpot, no fetch', async () => {
    // Simulate the backend resolver returning no token (HubSpot not connected).
    resolveIntegrationToken.mockResolvedValue({ provider: 'hubspot', token: undefined });
    globalThis.fetch = vi.fn(async () => { throw new Error('fetch must NOT be called without a token'); });

    const result = JSON.parse(await hubspotSkill.handleToolCall('hubspot_whoami', {}));
    expect(result.error).toMatch(/HubSpot not connected|Connect HubSpot/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('hubspot_search', () => {
  it('(b) POSTs to /crm/v3/objects/contacts/search with a Bearer header and a full-text query body', async () => {
    let captured;
    globalThis.fetch = vi.fn(async (url, init) => {
      captured = { url, init };
      return fetchJson({ total: 1, results: [{ id: '501', properties: { email: 'a@b.com' } }] });
    });

    const result = JSON.parse(await hubspotSkill.handleToolCall('hubspot_search', {
      objectType: 'contacts',
      query: 'acme',
      properties: ['email'],
    }));

    expect(captured.url).toBe('https://api.hubapi.com/crm/v3/objects/contacts/search');
    expect(captured.init.method).toBe('POST');
    expect(captured.init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(captured.init.body);
    expect(body.query).toBe('acme');
    expect(body.limit).toBe(20);
    expect(body.properties).toEqual(['email']);
    expect(result.total).toBe(1);
    expect(result.results[0].id).toBe('501');
  });

  it('(b2) wraps structured filters into filterGroups', async () => {
    let captured;
    globalThis.fetch = vi.fn(async (url, init) => {
      captured = { url, init };
      return fetchJson({ total: 0, results: [] });
    });

    await hubspotSkill.handleToolCall('hubspot_search', {
      objectType: 'deals',
      filters: [{ propertyName: 'dealstage', operator: 'EQ', value: 'closedwon' }],
      limit: 5,
    });

    const body = JSON.parse(captured.init.body);
    expect(captured.url).toContain('/crm/v3/objects/deals/search');
    expect(body.limit).toBe(5);
    expect(body.filterGroups).toEqual([{ filters: [{ propertyName: 'dealstage', operator: 'EQ', value: 'closedwon' }] }]);
    expect(body.query).toBeUndefined();
  });
});

describe('hubspot_create_object', () => {
  it('(c) POSTs { properties } to /crm/v3/objects/<type>', async () => {
    let captured;
    globalThis.fetch = vi.fn(async (url, init) => {
      captured = { url, init };
      return fetchJson({ id: '999', properties: { name: 'Acme' } });
    });

    const result = JSON.parse(await hubspotSkill.handleToolCall('hubspot_create_object', {
      objectType: 'companies',
      properties: { name: 'Acme' },
    }));

    expect(captured.url).toBe('https://api.hubapi.com/crm/v3/objects/companies');
    expect(captured.init.method).toBe('POST');
    expect(JSON.parse(captured.init.body)).toEqual({ properties: { name: 'Acme' } });
    expect(result.id).toBe('999');
  });

  it('rejects a missing properties object with an {error}', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('should not fetch'); });
    const result = JSON.parse(await hubspotSkill.handleToolCall('hubspot_create_object', { objectType: 'contacts' }));
    expect(result.error).toMatch(/properties is required/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('hubspot_update_object', () => {
  it('(d) uses PATCH on /crm/v3/objects/<type>/<id>', async () => {
    let captured;
    globalThis.fetch = vi.fn(async (url, init) => {
      captured = { url, init };
      return fetchJson({ id: '42', properties: { phase: 'won' } });
    });

    const result = JSON.parse(await hubspotSkill.handleToolCall('hubspot_update_object', {
      objectType: 'deals',
      id: '42',
      properties: { phase: 'won' },
    }));

    expect(captured.url).toBe('https://api.hubapi.com/crm/v3/objects/deals/42');
    expect(captured.init.method).toBe('PATCH');
    expect(JSON.parse(captured.init.body)).toEqual({ properties: { phase: 'won' } });
    expect(result.id).toBe('42');
  });
});

describe('hubspot API error handling', () => {
  it('surfaces a 401 with a scope/token hint as {error}', async () => {
    globalThis.fetch = vi.fn(async () => fetchJson('unauthorized', { ok: false, status: 401 }));
    const result = JSON.parse(await hubspotSkill.handleToolCall('hubspot_whoami', {}));
    expect(result.error).toMatch(/HubSpot API 401/);
    expect(result.error).toMatch(/scope|invalid|expired/i);
  });
});
