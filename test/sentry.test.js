import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock backend-client BEFORE importing the skill so resolveIntegrationToken
// (the auth chokepoint every sentry_* call uses) is replaced at load time.
// Same pattern as github-create-pr.test.js / notion.test.js.
vi.mock('@zibby/core/backend-client.js', () => ({
  resolveIntegrationToken: vi.fn(async () => ({
    provider: 'sentry', token: 'sntrys_test', organizationSlug: 'acme',
  })),
  clearTokenCache: vi.fn(),
}));

const { resolveIntegrationToken } = await import('@zibby/core/backend-client.js');
const { sentrySkill, sentryUpdateIssue, sentryAddComment, sentryFetch } = await import('../src/sentry.js');

// Build a fetch Response-like object (res.ok + res.json()/res.text()).
function fetchJson(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sentry write tools — registration', () => {
  it('exposes sentry_update_issue + sentry_add_comment in toolsForAssistant with the documented schema', () => {
    const upd = sentrySkill.tools.find((t) => t.name === 'sentry_update_issue');
    const com = sentrySkill.tools.find((t) => t.name === 'sentry_add_comment');
    expect(upd).toBeTruthy();
    expect(upd.input_schema.required).toEqual(['issueId']);
    expect(Object.keys(upd.input_schema.properties).sort())
      .toEqual(['assignedTo', 'hasSeen', 'isBookmarked', 'issueId', 'status', 'statusDetails'].sort());
    expect(com).toBeTruthy();
    expect(com.input_schema.required.sort()).toEqual(['issueId', 'text'].sort());
  });

  it('documents both write tools in the prompt fragment', () => {
    expect(sentrySkill.promptFragment).toContain('sentry_update_issue');
    expect(sentrySkill.promptFragment).toContain('sentry_add_comment');
  });
});

describe('sentryFetch — JSON body forwarding (the write-path fix)', () => {
  it('serializes an object body for a PUT and sends it', async () => {
    const f = vi.fn(async () => fetchJson({ ok: true }));
    vi.stubGlobal('fetch', f);

    await sentryFetch('/issues/42/', { method: 'PUT', body: { status: 'resolved' } });

    const [url, opts] = f.mock.calls[0];
    expect(url).toBe('https://sentry.io/api/0/organizations/acme/issues/42/');
    expect(opts.method).toBe('PUT');
    expect(JSON.parse(opts.body)).toEqual({ status: 'resolved' });
  });

  it('passes a pre-serialized string body through unchanged', async () => {
    const f = vi.fn(async () => fetchJson({ ok: true }));
    vi.stubGlobal('fetch', f);
    await sentryFetch('/issues/42/', { method: 'PUT', body: '{"status":"ignored"}' });
    expect(f.mock.calls[0][1].body).toBe('{"status":"ignored"}');
  });

  it('omits the body entirely for a GET', async () => {
    const f = vi.fn(async () => fetchJson([]));
    vi.stubGlobal('fetch', f);
    await sentryFetch('/issues/');
    expect(f.mock.calls[0][1].body).toBeUndefined();
  });
});

describe('sentryUpdateIssue', () => {
  it('PUTs the global issue endpoint with only the fields provided', async () => {
    const f = vi.fn(async () => fetchJson({ id: '42', status: 'resolvedInNextRelease' }));
    vi.stubGlobal('fetch', f);

    const out = await sentryUpdateIssue('42', { status: 'resolvedInNextRelease' });

    const [url, opts] = f.mock.calls[0];
    expect(url).toBe('https://sentry.io/api/0/issues/42/'); // global, NOT org-scoped
    expect(opts.method).toBe('PUT');
    expect(opts.headers.Authorization).toBe('Bearer sntrys_test');
    // undefined fields must NOT leak into the body (Sentry treats any present key as "change this").
    expect(JSON.parse(opts.body)).toEqual({ status: 'resolvedInNextRelease' });
    expect(out.status).toBe('resolvedInNextRelease');
  });

  it('forwards statusDetails / assignedTo / isBookmarked when set, drops undefined', async () => {
    const f = vi.fn(async () => fetchJson({ id: '7', status: 'resolved' }));
    vi.stubGlobal('fetch', f);
    await sentryUpdateIssue('7', { status: 'resolved', statusDetails: { inRelease: 'latest' }, assignedTo: 'user:1' });
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({
      status: 'resolved', statusDetails: { inRelease: 'latest' }, assignedTo: 'user:1',
    });
  });

  it('throws on a missing issueId and on an empty update', async () => {
    await expect(sentryUpdateIssue()).rejects.toThrow(/issueId is required/);
    await expect(sentryUpdateIssue('42', {})).rejects.toThrow(/nothing to update/);
  });

  it('a 403 throws a CLEAR error mentioning the event:write scope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fetchJson('forbidden', false, 403)));
    await expect(sentryUpdateIssue('42', { status: 'resolved' }))
      .rejects.toThrow(/event:write/);
  });
});

describe('sentryAddComment', () => {
  it('POSTs the comments endpoint with the text body', async () => {
    const f = vi.fn(async () => fetchJson({ id: 'note_1' }));
    vi.stubGlobal('fetch', f);

    const out = await sentryAddComment('42', 'Zibby opened a fix PR');

    const [url, opts] = f.mock.calls[0];
    expect(url).toBe('https://sentry.io/api/0/issues/42/comments/');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ text: 'Zibby opened a fix PR' });
    expect(out.id).toBe('note_1');
  });

  it('throws on a missing issueId / empty text', async () => {
    await expect(sentryAddComment()).rejects.toThrow(/issueId is required/);
    await expect(sentryAddComment('42', '  ')).rejects.toThrow(/text is required/);
  });

  it('a 403 throws a CLEAR error mentioning the event:write scope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fetchJson('forbidden', false, 403)));
    await expect(sentryAddComment('42', 'hi')).rejects.toThrow(/event:write/);
  });
});

describe('self-hosted Sentry — configurable base URL + org', () => {
  afterEach(() => {
    delete process.env.SENTRY_URL;
    delete process.env.SENTRY_ORG;
  });

  it('sentryFetch targets SENTRY_URL (trailing slash trimmed) on the org-scoped endpoint', async () => {
    process.env.SENTRY_URL = 'https://sentry-pro.example.com/';
    const f = vi.fn(async () => fetchJson([]));
    vi.stubGlobal('fetch', f);
    await sentryFetch('/issues/');
    expect(f.mock.calls[0][0]).toBe('https://sentry-pro.example.com/api/0/organizations/acme/issues/');
  });

  it('sentryUpdateIssue + sentryAddComment hit the self-hosted host on the GLOBAL issue endpoint', async () => {
    process.env.SENTRY_URL = 'https://sentry.example.com';
    const f = vi.fn(async () => fetchJson({ id: '9' }));
    vi.stubGlobal('fetch', f);
    await sentryUpdateIssue('9', { status: 'resolved' });
    expect(f.mock.calls[0][0]).toBe('https://sentry.example.com/api/0/issues/9/');
    await sentryAddComment('9', 'hi');
    expect(f.mock.calls[1][0]).toBe('https://sentry.example.com/api/0/issues/9/comments/');
  });

  it('falls back to SENTRY_ORG when the integration provides no organizationSlug (self-hosted env path)', async () => {
    resolveIntegrationToken.mockResolvedValueOnce({ provider: 'sentry', token: 'sntrys_test' });
    process.env.SENTRY_URL = 'https://sentry.example.com';
    process.env.SENTRY_ORG = 'sentry'; // the self-hosted installer's default org slug
    const f = vi.fn(async () => fetchJson([]));
    vi.stubGlobal('fetch', f);
    await sentryFetch('/projects/');
    expect(f.mock.calls[0][0]).toBe('https://sentry.example.com/api/0/organizations/sentry/projects/');
  });

  it('throws a CLEAR, actionable error when no org can be resolved', async () => {
    resolveIntegrationToken.mockResolvedValueOnce({ provider: 'sentry', token: 'sntrys_test' });
    vi.stubGlobal('fetch', vi.fn(async () => fetchJson([])));
    await expect(sentryFetch('/issues/')).rejects.toThrow(/SENTRY_ORG/);
  });

  it('honors baseUrl from the token resolver (CLOUD account connected to a self-hosted Sentry)', async () => {
    resolveIntegrationToken.mockResolvedValueOnce({
      provider: 'sentry', token: 'sntrys_test', organizationSlug: 'acme', baseUrl: 'https://sentry.corp.internal',
    });
    const f = vi.fn(async () => fetchJson([]));
    vi.stubGlobal('fetch', f);
    await sentryFetch('/issues/');
    // token-resolver baseUrl WINS over env + the sentry.io default
    expect(f.mock.calls[0][0]).toBe('https://sentry.corp.internal/api/0/organizations/acme/issues/');
  });

  it('defaults to sentry.io when SENTRY_URL is unset (cloud unchanged)', async () => {
    const f = vi.fn(async () => fetchJson([]));
    vi.stubGlobal('fetch', f);
    await sentryFetch('/issues/');
    expect(f.mock.calls[0][0]).toBe('https://sentry.io/api/0/organizations/acme/issues/');
  });
});

describe('handleToolCall (assistant path) wiring', () => {
  it('sentry_update_issue → ok envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fetchJson({ id: '42', status: 'ignored' })));
    const raw = await sentrySkill.handleToolCall('sentry_update_issue', { issueId: '42', status: 'ignored' });
    const out = JSON.parse(raw);
    expect(out.ok).toBe(true);
    expect(out.id).toBe('42');
    expect(out.status).toBe('ignored');
  });

  it('sentry_add_comment → ok envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fetchJson({ id: 'note_9' })));
    const raw = await sentrySkill.handleToolCall('sentry_add_comment', { issueId: '42', text: 'hello' });
    const out = JSON.parse(raw);
    expect(out.ok).toBe(true);
    expect(out.id).toBe('note_9');
    expect(out.issueId).toBe('42');
  });

  it('a 403 on the write tool surfaces as { error } via the outer try/catch (never throws out)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fetchJson('forbidden', false, 403)));
    const out = JSON.parse(await sentrySkill.handleToolCall('sentry_update_issue', { issueId: '42', status: 'resolved' }));
    expect(out.error).toMatch(/event:write/);
  });
});
