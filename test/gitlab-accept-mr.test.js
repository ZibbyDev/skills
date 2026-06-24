import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// gitlab.js reads its auth token from env (GITLAB_TOKEN) rather than the
// backend-client, so no module mock is needed — just set the token + mock fetch.
const { gitlabSkill } = await import('../src/gitlab.js');

// glFetch reads res.ok + res.json()/res.text().
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

describe('gitlab_accept_mr — registration', () => {
  it('is exposed in tools[] with the documented schema', () => {
    const tool = gitlabSkill.tools.find((t) => t.name === 'gitlab_accept_mr');
    expect(tool).toBeTruthy();
    expect(tool.input_schema.required).toEqual(['project', 'iid']);
    expect(Object.keys(tool.input_schema.properties).sort())
      .toEqual(['iid', 'mergeCommitMessage', 'mergeWhenPipelineSucceeds', 'project', 'squash'].sort());
  });

  it('is documented in the prompt fragment', () => {
    expect(gitlabSkill.promptFragment).toContain('gitlab_accept_mr');
  });
});

describe('gitlab_accept_mr — accept an MR', () => {
  it('hits the merge endpoint and returns merged:true with the REAL merge_commit_sha', async () => {
    const put = vi.fn(async () => fetchJson({
      iid: 9,
      state: 'merged',
      merge_commit_sha: 'cafef00d1234',
    }));
    vi.stubGlobal('fetch', put);

    const out = JSON.parse(await gitlabSkill.handleToolCall('gitlab_accept_mr', {
      project: 'acme/widgets', iid: 9,
    }));

    expect(out.success).toBe(true);
    expect(out.merged).toBe(true);
    expect(out.sha).toBe('cafef00d1234'); // straight from merge_commit_sha
    expect(out.iid).toBe(9);
    expect(out.provider).toBe('gitlab');

    expect(put).toHaveBeenCalledTimes(1);
    const [url, opts] = put.mock.calls[0];
    // "acme/widgets" path gets URL-encoded into the project segment.
    expect(url).toBe('https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/9/merge');
    expect(opts.method).toBe('PUT');
  });

  it('passes through squash / mergeCommitMessage / mergeWhenPipelineSucceeds', async () => {
    const put = vi.fn(async () => fetchJson({ iid: 3, state: 'merged', merge_commit_sha: 'abc' }));
    vi.stubGlobal('fetch', put);

    await gitlabSkill.handleToolCall('gitlab_accept_mr', {
      project: '123', iid: 3, squash: true, mergeCommitMessage: 'msg', mergeWhenPipelineSucceeds: true,
    });
    const [url, opts] = put.mock.calls[0];
    expect(url).toBe('https://gitlab.com/api/v4/projects/123/merge_requests/3/merge'); // numeric id passes through
    const sent = JSON.parse(opts.body);
    expect(sent).toMatchObject({ squash: true, merge_commit_message: 'msg', merge_when_pipeline_succeeds: true });
  });

  it('returns { success:false, skippedReason } on a 405 (not mergeable / WIP) — does NOT throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fetchJson(
      { message: 'Method Not Allowed' }, false, 405,
    )));

    const out = JSON.parse(await gitlabSkill.handleToolCall('gitlab_accept_mr', {
      project: 'acme/widgets', iid: 9,
    }));

    expect(out.success).toBe(false);
    expect(out.skippedReason).toMatch(/405/);
    expect(out.error).toBeUndefined();
    expect(out.provider).toBe('gitlab');
  });

  it('returns { success:false, skippedReason } on a 406 (merge conflict) — does NOT throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fetchJson(
      { message: 'Branch cannot be merged' }, false, 406,
    )));

    const out = JSON.parse(await gitlabSkill.handleToolCall('gitlab_accept_mr', {
      project: '123', iid: 5,
    }));

    expect(out.success).toBe(false);
    expect(out.skippedReason).toMatch(/406/);
    expect(out.error).toBeUndefined();
  });

  it('throws (→ { error }) on a genuine auth error (401), not a skip', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fetchJson({ message: '401 Unauthorized' }, false, 401)));

    const out = JSON.parse(await gitlabSkill.handleToolCall('gitlab_accept_mr', {
      project: 'acme/widgets', iid: 9,
    }));

    expect(out.error).toBeTruthy();
    expect(out.error).toMatch(/401/);
    expect(out.skippedReason).toBeUndefined();
  });

  it('validates required args', async () => {
    const out = JSON.parse(await gitlabSkill.handleToolCall('gitlab_accept_mr', { project: 'acme/widgets' }));
    expect(out.error).toMatch(/required/);
  });
});
