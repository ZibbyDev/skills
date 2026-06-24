import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// git_open_pr DELEGATES to github_create_pr / gitlab_create_mr, which use the
// same auth chokepoints those skills' own tests stub. github_create_pr resolves
// its token via @zibby/core/backend-client.js (mock it at load time); gitlab_create_mr
// reads GITLAB_TOKEN from env. We stub global fetch to drive both provider APIs
// so we can assert that the REAL provider url is passed straight back through
// git_open_pr (never fabricated), and that dispatch picks the right provider
// from the repoUrl.
vi.mock('@zibby/core/backend-client.js', () => ({
  resolveIntegrationToken: vi.fn(async () => ({ provider: 'github', token: 'gho_test' })),
  clearTokenCache: vi.fn(),
}));

const { gitWriteSkill, detectProvider } = await import('../src/git-write.js');
const { gitSkill } = await import('../src/git.js');

// fetch Response-like object. ghFetch/glFetch read res.ok + res.json()/res.text().
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
  process.env.GITLAB_TOKEN = 'glpat-test';
  delete process.env.GITLAB_OAUTH_TOKEN;
  delete process.env.GITLAB_URL;
  delete process.env.GITLAB_INSTANCE_URL;
  delete process.env.GITLAB_API_URL;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GITLAB_TOKEN;
});

describe('git-write — gate + identity preserved', () => {
  it('keeps id "git-write" and inherits gitSkill resolve()', () => {
    expect(gitWriteSkill.id).toBe('git-write');
    // resolve is the SAME function reference as gitSkill's (spread) → behaviour
    // can't drift, and resolve() still returns null (no MCP server) like git.
    expect(gitWriteSkill.resolve).toBe(gitSkill.resolve);
    expect(gitWriteSkill.resolve()).toBeNull();
  });

  it('does NOT carry requiresIntegration (the OR-gate is the backend\'s {any:[github,gitlab]} map, not an AND on this skill)', () => {
    // If git-write declared requiresIntegration it would force a single provider;
    // the OR-group is applied by the backend keyed on the skill id, so the skill
    // object itself must stay integration-agnostic (same as gitSkill).
    expect(gitWriteSkill.requiresIntegration).toBeUndefined();
  });
});

describe('git-write — inherited read tools still work', () => {
  it('exposes git_checkout / git_list_repos / git_explore alongside git_open_pr + git_merge_pr', () => {
    const names = gitWriteSkill.tools.map((t) => t.name).sort();
    expect(names).toEqual(['git_checkout', 'git_explore', 'git_list_repos', 'git_open_pr', 'git_merge_pr'].sort());
  });

  it('delegates a read tool (git_list_repos) to gitSkill (unchanged behaviour)', async () => {
    // git_list_repos on a fresh cwd with no .zibby/repos → "No repos cloned yet".
    const out = JSON.parse(await gitWriteSkill.handleToolCall('git_list_repos', {}, { options: { workspace: '/tmp/does-not-exist-zibby-xyz' } }));
    expect(out.repos).toEqual([]);
    expect(out.message).toMatch(/No repos cloned/i);
  });

  it('an unknown tool falls through to gitSkill\'s unknown-tool handler', async () => {
    const out = JSON.parse(await gitWriteSkill.handleToolCall('git_nonexistent', {}, {}));
    expect(out.error).toMatch(/Unknown tool/);
  });
});

describe('git-write — registration + prompt', () => {
  it('git_open_pr is in tools[] with the documented schema', () => {
    const tool = gitWriteSkill.tools.find((t) => t.name === 'git_open_pr');
    expect(tool).toBeTruthy();
    expect(tool.input_schema.required).toEqual(['repoUrl', 'head', 'title']);
    expect(Object.keys(tool.input_schema.properties).sort())
      .toEqual(['base', 'body', 'head', 'repoUrl', 'title'].sort());
  });

  it('git_open_pr is advertised in the prompt fragment, and the inherited git prompt is kept', () => {
    expect(gitWriteSkill.promptFragment).toContain('git_open_pr');
    expect(gitWriteSkill.promptFragment).toContain('git_checkout'); // inherited gitSkill fragment
    expect(gitWriteSkill.promptFragment).toMatch(/REAL provider url|real provider/i);
  });
});

describe('detectProvider', () => {
  it('detects github / gitlab / unknown', () => {
    expect(detectProvider('https://github.com/acme/web.git')).toEqual({ provider: 'github', owner: 'acme', repo: 'web' });
    expect(detectProvider('https://gitlab.com/acme/web')).toEqual({ provider: 'gitlab', owner: 'acme', repo: 'web' });
    expect(detectProvider('https://bitbucket.org/a/b')).toBeNull();
  });
});

describe('git_open_pr — dispatch + real-url passthrough', () => {
  it('GitHub url → delegates to github_create_pr → returns the REAL html_url', async () => {
    const post = vi.fn(async () => fetchJson({
      html_url: 'https://github.com/acme/web/pull/42',
      number: 42,
      state: 'open',
      draft: false,
    }));
    vi.stubGlobal('fetch', post);

    const out = JSON.parse(await gitWriteSkill.handleToolCall('git_open_pr', {
      repoUrl: 'https://github.com/acme/web',
      head: 'zibby/sentry-fix-web-42-ab12',
      base: 'main',
      title: 'fix: TypeError',
      body: 'root cause + the fix',
    }));

    expect(out.success).toBe(true);
    expect(out.provider).toBe('github');
    expect(out.pr_url).toBe('https://github.com/acme/web/pull/42'); // straight from the provider response
    expect(out.number).toBe(42);

    // It really hit the GitHub pulls endpoint (proves delegation, not a stub).
    const [url, opts] = post.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/acme/web/pulls');
    expect(opts.method).toBe('POST');
    const sent = JSON.parse(opts.body);
    expect(sent).toMatchObject({ title: 'fix: TypeError', head: 'zibby/sentry-fix-web-42-ab12', base: 'main', body: 'root cause + the fix' });
  });

  it('GitLab url → delegates to gitlab_create_mr → returns the REAL web_url', async () => {
    const post = vi.fn(async () => fetchJson({
      web_url: 'https://gitlab.com/acme/web/-/merge_requests/9',
      iid: 9,
      state: 'opened',
    }));
    vi.stubGlobal('fetch', post);

    const out = JSON.parse(await gitWriteSkill.handleToolCall('git_open_pr', {
      repoUrl: 'https://gitlab.com/acme/web',
      head: 'zibby/sentry-fix-web-42-ab12',
      base: 'main',
      title: 'fix: TypeError',
      body: 'root cause + the fix',
    }));

    expect(out.success).toBe(true);
    expect(out.provider).toBe('gitlab');
    expect(out.pr_url).toBe('https://gitlab.com/acme/web/-/merge_requests/9'); // straight from web_url
    expect(out.number).toBe(9);

    const [url, opts] = post.mock.calls[0];
    expect(url).toBe('https://gitlab.com/api/v4/projects/acme%2Fweb/merge_requests');
    const sent = JSON.parse(opts.body);
    expect(sent).toMatchObject({ source_branch: 'zibby/sentry-fix-web-42-ab12', target_branch: 'main', title: 'fix: TypeError', description: 'root cause + the fix' });
  });

  it('accepts GitLab-style arg names (source_branch / target_branch)', async () => {
    const post = vi.fn(async () => fetchJson({ web_url: 'https://gitlab.com/acme/web/-/merge_requests/1', iid: 1, state: 'opened' }));
    vi.stubGlobal('fetch', post);

    const out = JSON.parse(await gitWriteSkill.handleToolCall('git_open_pr', {
      repoUrl: 'https://gitlab.com/acme/web',
      source_branch: 'feat/x',
      target_branch: 'develop',
      title: 'Feature',
    }));

    expect(out.success).toBe(true);
    const sent = JSON.parse(post.mock.calls[0][1].body);
    expect(sent.source_branch).toBe('feat/x');
    expect(sent.target_branch).toBe('develop');
  });

  it('an expected business error (GitHub 422) passes through as { success:false, skippedReason } — no throw, no fake url', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fetchJson({ message: 'No commits between main and head' }, false, 422)));
    const out = JSON.parse(await gitWriteSkill.handleToolCall('git_open_pr', {
      repoUrl: 'https://github.com/acme/web', head: 'h', base: 'main', title: 'Fix',
    }));
    expect(out.success).toBe(false);
    expect(out.skippedReason).toMatch(/422/);
    expect(out.pr_url).toBeUndefined();
    expect(out.error).toBeUndefined();
  });

  it('an unknown repo host → { success:false, skippedReason } (no provider call, no fabricated url)', async () => {
    const post = vi.fn();
    vi.stubGlobal('fetch', post);
    const out = JSON.parse(await gitWriteSkill.handleToolCall('git_open_pr', {
      repoUrl: 'https://bitbucket.org/acme/web', head: 'h', title: 'Fix',
    }));
    expect(out.success).toBe(false);
    expect(out.skippedReason).toMatch(/Unrecognized repo host/);
    expect(post).not.toHaveBeenCalled();
  });

  it('validates required args (repoUrl, head, title)', async () => {
    expect(JSON.parse(await gitWriteSkill.handleToolCall('git_open_pr', { head: 'h', title: 't' })).error).toMatch(/repoUrl is required/);
    expect(JSON.parse(await gitWriteSkill.handleToolCall('git_open_pr', { repoUrl: 'https://github.com/a/b', title: 't' })).error).toMatch(/head.*required/i);
    expect(JSON.parse(await gitWriteSkill.handleToolCall('git_open_pr', { repoUrl: 'https://github.com/a/b', head: 'h' })).error).toMatch(/required/i);
  });
});
