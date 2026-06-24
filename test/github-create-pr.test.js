import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock backend-client BEFORE importing the skill so resolveIntegrationToken
// (the auth chokepoint every github_* tool — including github_create_pr — uses)
// is replaced at load time. Same pattern as notion.test.js.
vi.mock('@zibby/core/backend-client.js', () => ({
  resolveIntegrationToken: vi.fn(async () => ({ provider: 'github', token: 'gho_test' })),
  clearTokenCache: vi.fn(),
}));

const { githubSkill } = await import('../src/github.js');

// Build a fetch Response-like object. ghFetch reads res.ok + res.json()/res.text().
function fetchJson(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('github_create_pr — registration', () => {
  it('is exposed in tools[] with the documented schema', () => {
    const tool = githubSkill.tools.find((t) => t.name === 'github_create_pr');
    expect(tool).toBeTruthy();
    expect(tool.input_schema.required).toEqual(['owner', 'repo', 'head', 'title']);
    expect(Object.keys(tool.input_schema.properties).sort())
      .toEqual(['base', 'body', 'draft', 'head', 'owner', 'repo', 'title'].sort());
  });

  it('is documented in the prompt fragment', () => {
    expect(githubSkill.promptFragment).toContain('github_create_pr');
  });
});

describe('github_create_pr — open a PR', () => {
  it('returns the REAL pr_url from GitHub (html_url), never a fabricated one', async () => {
    // Single POST call: base is supplied so no default-branch lookup happens.
    const post = vi.fn(async () => fetchJson({
      html_url: 'https://github.com/acme/widgets/pull/42',
      number: 42,
      state: 'open',
      draft: false,
    }));
    vi.stubGlobal('fetch', post);

    const raw = await githubSkill.handleToolCall('github_create_pr', {
      owner: 'acme', repo: 'widgets', head: 'fix/login', base: 'main',
      title: 'Fix login', body: 'desc',
    });
    const out = JSON.parse(raw);

    expect(out.success).toBe(true);
    expect(out.pr_url).toBe('https://github.com/acme/widgets/pull/42'); // straight from the mocked body
    expect(out.number).toBe(42);
    expect(out.branch).toBe('fix/login');
    expect(out.base).toBe('main');
    expect(out.repo).toBe('acme/widgets');
    expect(out.provider).toBe('github');

    // Assert the call: POST to the pulls endpoint with the right payload.
    expect(post).toHaveBeenCalledTimes(1);
    const [url, opts] = post.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/acme/widgets/pulls');
    expect(opts.method).toBe('POST');
    const sent = JSON.parse(opts.body);
    expect(sent).toMatchObject({ title: 'Fix login', head: 'fix/login', base: 'main', body: 'desc', draft: false });
  });

  it('defaults base to the repo default branch when base is omitted', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      calls.push({ url, method: opts?.method || 'GET' });
      if ((opts?.method || 'GET') === 'GET') return fetchJson({ default_branch: 'develop' });
      return fetchJson({ html_url: 'https://github.com/acme/widgets/pull/7', number: 7, state: 'open' });
    }));

    const out = JSON.parse(await githubSkill.handleToolCall('github_create_pr', {
      owner: 'acme', repo: 'widgets', head: 'feature/x', title: 'Feature',
    }));

    expect(out.success).toBe(true);
    expect(out.base).toBe('develop'); // resolved from the repo lookup
    // First a GET /repos/acme/widgets, then the POST.
    expect(calls[0]).toEqual({ url: 'https://api.github.com/repos/acme/widgets', method: 'GET' });
    expect(calls[1].method).toBe('POST');
  });

  it('returns { success:false, skippedReason } on a 422 (no commits / already exists) — does NOT throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fetchJson(
      { message: 'No commits between main and fix/login' }, false, 422,
    )));

    const out = JSON.parse(await githubSkill.handleToolCall('github_create_pr', {
      owner: 'acme', repo: 'widgets', head: 'fix/login', base: 'main', title: 'Fix',
    }));

    expect(out.success).toBe(false);
    expect(out.skippedReason).toMatch(/422/);
    expect(out.error).toBeUndefined(); // a skip, not a hard error
    expect(out.branch).toBe('fix/login');
    expect(out.provider).toBe('github');
  });

  it('throws (→ { error }) on a genuine auth error (401), not a skip', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fetchJson({ message: 'Bad credentials' }, false, 401)));

    const out = JSON.parse(await githubSkill.handleToolCall('github_create_pr', {
      owner: 'acme', repo: 'widgets', head: 'fix/login', base: 'main', title: 'Fix',
    }));

    // The outer handleToolCall try/catch turns the throw into { error }.
    expect(out.error).toBeTruthy();
    expect(out.error).toMatch(/401/);
    expect(out.skippedReason).toBeUndefined();
  });

  it('validates required args', async () => {
    const out = JSON.parse(await githubSkill.handleToolCall('github_create_pr', { owner: 'acme', repo: 'widgets' }));
    expect(out.error).toMatch(/required/);
  });
});
