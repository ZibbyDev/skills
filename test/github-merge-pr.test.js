import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock backend-client BEFORE importing the skill so resolveIntegrationToken
// (the auth chokepoint every github_* tool — including github_merge_pr — uses)
// is replaced at load time. Same pattern as github-create-pr.test.js.
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

describe('github_merge_pr — registration', () => {
  it('is exposed in tools[] with the documented schema', () => {
    const tool = githubSkill.tools.find((t) => t.name === 'github_merge_pr');
    expect(tool).toBeTruthy();
    expect(tool.input_schema.required).toEqual(['owner', 'repo', 'number']);
    expect(Object.keys(tool.input_schema.properties).sort())
      .toEqual(['commitMessage', 'commitTitle', 'mergeMethod', 'number', 'owner', 'repo'].sort());
  });

  it('is documented in the prompt fragment', () => {
    expect(githubSkill.promptFragment).toContain('github_merge_pr');
  });
});

describe('github_merge_pr — merge a PR', () => {
  it('hits the merge endpoint and returns merged:true with the REAL sha', async () => {
    const put = vi.fn(async () => fetchJson({
      sha: 'abc123def456',
      merged: true,
      message: 'Pull Request successfully merged',
    }));
    vi.stubGlobal('fetch', put);

    const out = JSON.parse(await githubSkill.handleToolCall('github_merge_pr', {
      owner: 'acme', repo: 'widgets', number: 42,
    }));

    expect(out.success).toBe(true);
    expect(out.merged).toBe(true);
    expect(out.sha).toBe('abc123def456'); // straight from the mocked body
    expect(out.number).toBe(42);
    expect(out.provider).toBe('github');

    // Assert the call: PUT to the merge endpoint, default squash method.
    expect(put).toHaveBeenCalledTimes(1);
    const [url, opts] = put.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/acme/widgets/pulls/42/merge');
    expect(opts.method).toBe('PUT');
    const sent = JSON.parse(opts.body);
    expect(sent.merge_method).toBe('squash'); // default
  });

  it('passes through mergeMethod + commit title/message', async () => {
    const put = vi.fn(async () => fetchJson({ sha: 'deadbeef', merged: true }));
    vi.stubGlobal('fetch', put);

    await githubSkill.handleToolCall('github_merge_pr', {
      owner: 'acme', repo: 'widgets', number: 7,
      mergeMethod: 'rebase', commitTitle: 'T', commitMessage: 'M',
    });
    const sent = JSON.parse(put.mock.calls[0][1].body);
    expect(sent).toMatchObject({ merge_method: 'rebase', commit_title: 'T', commit_message: 'M' });
  });

  it('returns { success:false, skippedReason } on a 405 (not mergeable / draft / checks) — does NOT throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fetchJson(
      { message: 'Pull Request is not mergeable' }, false, 405,
    )));

    const out = JSON.parse(await githubSkill.handleToolCall('github_merge_pr', {
      owner: 'acme', repo: 'widgets', number: 42,
    }));

    expect(out.success).toBe(false);
    expect(out.skippedReason).toMatch(/405/);
    expect(out.error).toBeUndefined(); // a skip, not a hard error
    expect(out.number).toBe(42);
    expect(out.provider).toBe('github');
  });

  it('returns { success:false, skippedReason } on a 409 (head sha moved / conflict) — does NOT throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fetchJson(
      { message: 'Head branch was modified. Review and try the merge again.' }, false, 409,
    )));

    const out = JSON.parse(await githubSkill.handleToolCall('github_merge_pr', {
      owner: 'acme', repo: 'widgets', number: 42,
    }));

    expect(out.success).toBe(false);
    expect(out.skippedReason).toMatch(/409/);
    expect(out.error).toBeUndefined();
  });

  it('throws (→ { error }) on a genuine auth error (401), not a skip', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fetchJson({ message: 'Bad credentials' }, false, 401)));

    const out = JSON.parse(await githubSkill.handleToolCall('github_merge_pr', {
      owner: 'acme', repo: 'widgets', number: 42,
    }));

    expect(out.error).toBeTruthy();
    expect(out.error).toMatch(/401/);
    expect(out.skippedReason).toBeUndefined();
  });

  it('rejects a bad mergeMethod', async () => {
    const out = JSON.parse(await githubSkill.handleToolCall('github_merge_pr', {
      owner: 'acme', repo: 'widgets', number: 42, mergeMethod: 'fast-forward',
    }));
    expect(out.error).toMatch(/mergeMethod/);
  });

  it('validates required args', async () => {
    const out = JSON.parse(await githubSkill.handleToolCall('github_merge_pr', { owner: 'acme', repo: 'widgets' }));
    expect(out.error).toMatch(/required/);
  });
});
