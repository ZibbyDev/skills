import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// git_merge_pr DELEGATES to github_merge_pr / gitlab_accept_mr, which use the
// same auth chokepoints those skills' own tests stub. github_merge_pr resolves
// its token via @zibby/core/backend-client.js (mock it at load time);
// gitlab_accept_mr reads GITLAB_TOKEN from env. We stub global fetch to drive
// both provider APIs so we can assert the REAL merge sha is passed straight
// back through git_merge_pr (never fabricated), and that dispatch picks the
// right provider from the repoUrl.
vi.mock('@zibby/core/backend-client.js', () => ({
  resolveIntegrationToken: vi.fn(async () => ({ provider: 'github', token: 'gho_test' })),
  clearTokenCache: vi.fn(),
}));

const { gitWriteSkill } = await import('../src/git-write.js');

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

describe('git-write — git_merge_pr registration + prompt', () => {
  it('git_merge_pr is in tools[] alongside git_open_pr + inherited read tools', () => {
    const names = gitWriteSkill.tools.map((t) => t.name).sort();
    expect(names).toEqual(['git_checkout', 'git_explore', 'git_list_repos', 'git_merge_pr', 'git_open_pr'].sort());
  });

  it('git_merge_pr has the documented schema', () => {
    const tool = gitWriteSkill.tools.find((t) => t.name === 'git_merge_pr');
    expect(tool).toBeTruthy();
    expect(tool.input_schema.required).toEqual(['repoUrl', 'number']);
    expect(Object.keys(tool.input_schema.properties).sort())
      .toEqual(['mergeMethod', 'number', 'repoUrl'].sort());
  });

  it('git_merge_pr is advertised in the prompt fragment (and git_open_pr is still there)', () => {
    expect(gitWriteSkill.promptFragment).toContain('git_merge_pr');
    expect(gitWriteSkill.promptFragment).toContain('git_open_pr');
  });

  it('still has no requiresIntegration (the OR-gate is unchanged)', () => {
    expect(gitWriteSkill.requiresIntegration).toBeUndefined();
  });
});

describe('git_merge_pr — dispatch + real-sha passthrough', () => {
  it('GitHub url → delegates to github_merge_pr → returns the REAL merge sha', async () => {
    const put = vi.fn(async () => fetchJson({ sha: 'gh-merge-sha-1', merged: true }));
    vi.stubGlobal('fetch', put);

    const out = JSON.parse(await gitWriteSkill.handleToolCall('git_merge_pr', {
      repoUrl: 'https://github.com/acme/web',
      number: 42,
      mergeMethod: 'squash',
    }));

    expect(out.success).toBe(true);
    expect(out.merged).toBe(true);
    expect(out.provider).toBe('github');
    expect(out.sha).toBe('gh-merge-sha-1'); // straight from the provider response

    // It really hit the GitHub merge endpoint (proves delegation, not a stub).
    const [url, opts] = put.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/acme/web/pulls/42/merge');
    expect(opts.method).toBe('PUT');
    expect(JSON.parse(opts.body).merge_method).toBe('squash');
  });

  it('GitLab url → delegates to gitlab_accept_mr → returns the REAL merge_commit_sha', async () => {
    const put = vi.fn(async () => fetchJson({ iid: 9, state: 'merged', merge_commit_sha: 'gl-merge-sha-2' }));
    vi.stubGlobal('fetch', put);

    const out = JSON.parse(await gitWriteSkill.handleToolCall('git_merge_pr', {
      repoUrl: 'https://gitlab.com/acme/web',
      number: 9,
    }));

    expect(out.success).toBe(true);
    expect(out.merged).toBe(true);
    expect(out.provider).toBe('gitlab');
    expect(out.sha).toBe('gl-merge-sha-2'); // straight from merge_commit_sha

    const [url, opts] = put.mock.calls[0];
    expect(url).toBe('https://gitlab.com/api/v4/projects/acme%2Fweb/merge_requests/9/merge');
    expect(opts.method).toBe('PUT');
  });

  it('accepts the GitLab-style alias iid for the number', async () => {
    const put = vi.fn(async () => fetchJson({ iid: 4, state: 'merged', merge_commit_sha: 's' }));
    vi.stubGlobal('fetch', put);

    const out = JSON.parse(await gitWriteSkill.handleToolCall('git_merge_pr', {
      repoUrl: 'https://gitlab.com/acme/web', iid: 4,
    }));

    expect(out.success).toBe(true);
    expect(put.mock.calls[0][0]).toBe('https://gitlab.com/api/v4/projects/acme%2Fweb/merge_requests/4/merge');
  });

  it('an expected non-mergeable error (GitHub 405) passes through as { success:false, skippedReason } — no throw, no fake sha', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fetchJson({ message: 'Pull Request is not mergeable' }, false, 405)));
    const out = JSON.parse(await gitWriteSkill.handleToolCall('git_merge_pr', {
      repoUrl: 'https://github.com/acme/web', number: 42,
    }));
    expect(out.success).toBe(false);
    expect(out.skippedReason).toMatch(/405/);
    expect(out.sha).toBeUndefined();
    expect(out.error).toBeUndefined();
  });

  it('an unknown repo host → { success:false, skippedReason } (no provider call, no fabricated sha)', async () => {
    const put = vi.fn();
    vi.stubGlobal('fetch', put);
    const out = JSON.parse(await gitWriteSkill.handleToolCall('git_merge_pr', {
      repoUrl: 'https://bitbucket.org/acme/web', number: 1,
    }));
    expect(out.success).toBe(false);
    expect(out.skippedReason).toMatch(/Unrecognized repo host/);
    expect(put).not.toHaveBeenCalled();
  });

  it('validates required args (repoUrl, number)', async () => {
    expect(JSON.parse(await gitWriteSkill.handleToolCall('git_merge_pr', { number: 1 })).error).toMatch(/repoUrl is required/);
    expect(JSON.parse(await gitWriteSkill.handleToolCall('git_merge_pr', { repoUrl: 'https://github.com/a/b' })).error).toMatch(/number.*required/i);
  });
});
