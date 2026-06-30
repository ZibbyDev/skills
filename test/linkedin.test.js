import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock backend-client BEFORE importing the skill so resolveIntegrationToken is
// replaced at load time. Resolves a VARIANT-SPECIFIC token per provider:
// linkedin_business (org tools) vs linkedin_personal (member publish — its blob
// also carries memberId). Shape mirrors GET /integrations/token/{provider}.
vi.mock('@zibby/core/backend-client.js', () => ({
  resolveIntegrationToken: vi.fn(async (provider) => {
    if (provider === 'linkedin_personal') {
      return { provider: 'linkedin_personal', token: 'secret_li', memberId: 'abc123' };
    }
    return { provider: 'linkedin_business', token: 'secret_li' };
  }),
  clearTokenCache: vi.fn(),
}));

const { resolveIntegrationToken } = await import('@zibby/core/backend-client.js');
const { linkedinSkill, parseOrgId } = await import('../src/linkedin.js');

// Build a fetch Response-like object. linkedinApi reads res.ok, res.status,
// res.text() and res.headers (a Headers-like object with .get()).
function fetchJson(payload, { ok = true, status = 200, headers = {} } = {}) {
  return {
    ok,
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    headers: { get: (k) => headers[k] ?? headers[k.toLowerCase()] ?? null },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  // restoreAllMocks does NOT clear the module-mock vi.fn() call history, so
  // per-provider toHaveBeenCalledWith assertions would see calls bleed across
  // tests. Clear call history (implementations from the mock factory persist).
  vi.clearAllMocks();
});

describe('linkedinSkill structure', () => {
  it('has correct id and does NOT declare requiresIntegration (gated via backend OR-group)', () => {
    expect(linkedinSkill.id).toBe('linkedin');
    // Two providers (linkedin_personal OR linkedin_business) → no single
    // requiresIntegration; the OR-group lives in the backend map (like git-write).
    expect(linkedinSkill.requiresIntegration).toBeUndefined();
  });

  it('exposes linkedin_list_organizations + linkedin_create_draft_post + linkedin_publish_post', () => {
    const names = linkedinSkill.tools.map((t) => t.name).sort();
    expect(names).toEqual(['linkedin_create_draft_post', 'linkedin_list_organizations', 'linkedin_publish_post']);
  });

  it('resolve() spawns the generic skill MCP server so the AGENT can call linkedin tools', () => {
    const spec = linkedinSkill.resolve();
    expect(spec).not.toBeNull();
    expect(spec.command).toBe('node');
    expect(spec.args).toEqual(expect.arrayContaining(['../dist/linkedin.js', 'linkedinSkill']));
    expect(spec.alwaysLoad).toBe(true);
    expect(linkedinSkill.allowedTools).toEqual(['mcp__linkedin__*']);
  });
});

describe('parseOrgId', () => {
  it('extracts the id from an organization urn', () => {
    expect(parseOrgId('urn:li:organization:12345')).toBe('12345');
  });
  it('passes a bare numeric id through', () => {
    expect(parseOrgId('98765')).toBe('98765');
  });
  it('returns null for junk / empty', () => {
    expect(parseOrgId('not-an-org')).toBeNull();
    expect(parseOrgId('')).toBeNull();
    expect(parseOrgId(null)).toBeNull();
  });
});

describe('linkedin_list_organizations — ACL parsing', () => {
  it('parses the ACL response and resolves each org name/vanity', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      if (url.includes('/rest/organizationAcls')) {
        return fetchJson({
          elements: [
            { organizationalTarget: 'urn:li:organization:111', role: 'ADMINISTRATOR', state: 'APPROVED' },
            { organizationalTarget: 'urn:li:organization:222', role: 'ADMINISTRATOR', state: 'APPROVED' },
          ],
        });
      }
      if (url.includes('/rest/organizations/111')) {
        return fetchJson({ id: 111, localizedName: 'Acme Inc', vanityName: 'acme' });
      }
      if (url.includes('/rest/organizations/222')) {
        return fetchJson({ id: 222, localizedName: 'Globex', vanityName: 'globex' });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = JSON.parse(await linkedinSkill.handleToolCall('linkedin_list_organizations', {}));
    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(result.organizations).toEqual([
      { id: '111', urn: 'urn:li:organization:111', name: 'Acme Inc', vanityName: 'acme' },
      { id: '222', urn: 'urn:li:organization:222', name: 'Globex', vanityName: 'globex' },
    ]);

    // ACL query carried the admin/approved filter + the required headers.
    const aclCall = calls.find((c) => c.url.includes('/rest/organizationAcls'));
    expect(aclCall.url).toContain('q=roleAssignee');
    expect(aclCall.url).toContain('role=ADMINISTRATOR');
    expect(aclCall.url).toContain('state=APPROVED');
    expect(aclCall.init.headers.Authorization).toBe('Bearer secret_li');
    expect(aclCall.init.headers['LinkedIn-Version']).toBe('202506');
    expect(aclCall.init.headers['X-Restli-Protocol-Version']).toBe('2.0.0');
  });

  it('still returns the org (by id/urn) when name resolution fails', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (url.includes('/rest/organizationAcls')) {
        return fetchJson({ elements: [{ organizationalTarget: 'urn:li:organization:999', state: 'APPROVED' }] });
      }
      return fetchJson({ message: 'forbidden' }, { ok: false, status: 403 });
    });
    const result = JSON.parse(await linkedinSkill.handleToolCall('linkedin_list_organizations', {}));
    expect(result.ok).toBe(true);
    expect(result.organizations).toEqual([
      { id: '999', urn: 'urn:li:organization:999', name: '', vanityName: '' },
    ]);
  });
});

describe('linkedin_create_draft_post — body, author, headers', () => {
  it('POSTs a DRAFT post with the org URN author and returns the post URN from the header', async () => {
    let posted;
    globalThis.fetch = vi.fn(async (url, init) => {
      posted = { url, init };
      return fetchJson('', { status: 201, headers: { 'x-restli-id': 'urn:li:share:7777' } });
    });

    const result = JSON.parse(await linkedinSkill.handleToolCall('linkedin_create_draft_post', {
      organizationId: '12345',
      text: 'Hello from Zibby',
    }));

    expect(result.ok).toBe(true);
    expect(result.postUrn).toBe('urn:li:share:7777');
    expect(result.author).toBe('urn:li:organization:12345');
    expect(result.lifecycleState).toBe('DRAFT');

    // Org tools resolve the BUSINESS (Community Management API) provider.
    expect(resolveIntegrationToken).toHaveBeenCalledWith('linkedin_business');
    expect(resolveIntegrationToken).not.toHaveBeenCalledWith('linkedin_personal');

    // The request hit /rest/posts with POST + required headers.
    expect(posted.url).toContain('/rest/posts');
    expect(posted.init.method).toBe('POST');
    expect(posted.init.headers.Authorization).toBe('Bearer secret_li');
    expect(posted.init.headers['LinkedIn-Version']).toBe('202506');
    expect(posted.init.headers['X-Restli-Protocol-Version']).toBe('2.0.0');
    expect(posted.init.headers['Content-Type']).toBe('application/json');

    // The body is a DRAFT post authored by the org urn with the expected shape.
    const body = JSON.parse(posted.init.body);
    expect(body.lifecycleState).toBe('DRAFT');
    expect(body.author).toBe('urn:li:organization:12345');
    expect(body.commentary).toBe('Hello from Zibby');
    expect(body.visibility).toBe('PUBLIC');
    expect(body.isReshareDisabledByAuthor).toBe(false);
    expect(body.distribution).toEqual({
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    });
  });

  it('accepts an organizationUrn and falls back to the x-linkedin-id header', async () => {
    globalThis.fetch = vi.fn(async () =>
      fetchJson('', { status: 201, headers: { 'x-linkedin-id': 'urn:li:share:8888' } }));
    const result = JSON.parse(await linkedinSkill.handleToolCall('linkedin_create_draft_post', {
      organizationUrn: 'urn:li:organization:54321',
      text: 'Body text',
    }));
    expect(result.ok).toBe(true);
    expect(result.postUrn).toBe('urn:li:share:8888');
    expect(result.author).toBe('urn:li:organization:54321');
  });

  it('rejects a missing org reference without throwing', async () => {
    const result = JSON.parse(await linkedinSkill.handleToolCall('linkedin_create_draft_post', { text: 'x' }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/organizationId or organizationUrn/i);
  });

  it('rejects missing text without throwing', async () => {
    const result = JSON.parse(await linkedinSkill.handleToolCall('linkedin_create_draft_post', { organizationId: '1' }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/text/i);
  });
});

describe('linkedin_publish_post — personal/member publish', () => {
  it('PUBLISHES to the member profile with the person URN author + required headers', async () => {
    let posted;
    globalThis.fetch = vi.fn(async (url, init) => {
      posted = { url, init };
      return fetchJson('', { status: 201, headers: { 'x-restli-id': 'urn:li:share:9999' } });
    });

    const result = JSON.parse(await linkedinSkill.handleToolCall('linkedin_publish_post', {
      text: 'Hello from my profile',
    }));

    expect(result.ok).toBe(true);
    expect(result.postUrn).toBe('urn:li:share:9999');
    expect(result.author).toBe('urn:li:person:abc123');
    expect(result.lifecycleState).toBe('PUBLISHED');
    expect(result.visibility).toBe('PUBLIC');

    // Resolves the PERSONAL provider (for the memberId + the POST token).
    expect(resolveIntegrationToken).toHaveBeenCalledWith('linkedin_personal');
    expect(resolveIntegrationToken).not.toHaveBeenCalledWith('linkedin_business');

    // The request hit /rest/posts with POST + the required versioned headers.
    expect(posted.url).toContain('/rest/posts');
    expect(posted.init.method).toBe('POST');
    expect(posted.init.headers.Authorization).toBe('Bearer secret_li');
    expect(posted.init.headers['LinkedIn-Version']).toBe('202506');
    expect(posted.init.headers['X-Restli-Protocol-Version']).toBe('2.0.0');
    expect(posted.init.headers['Content-Type']).toBe('application/json');

    // The body is a PUBLISHED post authored by the person urn.
    const body = JSON.parse(posted.init.body);
    expect(body.lifecycleState).toBe('PUBLISHED');
    expect(body.author).toBe('urn:li:person:abc123');
    expect(body.commentary).toBe('Hello from my profile');
    expect(body.visibility).toBe('PUBLIC');
    expect(body.isReshareDisabledByAuthor).toBe(false);
    expect(body.distribution).toEqual({
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    });
  });

  it('honours an explicit CONNECTIONS visibility (uppercased)', async () => {
    let posted;
    globalThis.fetch = vi.fn(async (url, init) => {
      posted = { url, init };
      return fetchJson('', { status: 201, headers: { 'x-linkedin-id': 'urn:li:share:1010' } });
    });
    const result = JSON.parse(await linkedinSkill.handleToolCall('linkedin_publish_post', {
      text: 'Connections only',
      visibility: 'connections',
    }));
    expect(result.ok).toBe(true);
    expect(result.postUrn).toBe('urn:li:share:1010');
    expect(result.visibility).toBe('CONNECTIONS');
    expect(JSON.parse(posted.init.body).visibility).toBe('CONNECTIONS');
  });

  it('returns { ok:false, error } when the member id is unavailable — never throws', async () => {
    resolveIntegrationToken.mockResolvedValueOnce({ provider: 'linkedin_personal', token: 'secret_li' });
    const result = JSON.parse(await linkedinSkill.handleToolCall('linkedin_publish_post', { text: 'x' }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/member id unavailable|reconnect LinkedIn Personal/i);
  });

  it('rejects missing text without throwing', async () => {
    const result = JSON.parse(await linkedinSkill.handleToolCall('linkedin_publish_post', {}));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/text/i);
  });
});

describe('graceful error path', () => {
  it('returns { ok:false, error } on an HTTP failure — never throws', async () => {
    globalThis.fetch = vi.fn(async () => fetchJson({ message: 'nope' }, { ok: false, status: 422 }));
    const result = JSON.parse(await linkedinSkill.handleToolCall('linkedin_create_draft_post', {
      organizationId: '1', text: 'x',
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/LinkedIn API 422/);
  });

  it('unknown tool returns { ok:false, error }', async () => {
    const result = JSON.parse(await linkedinSkill.handleToolCall('linkedin_bogus', {}));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown tool/);
  });
});
