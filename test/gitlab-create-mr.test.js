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

describe('gitlab_create_mr — registration', () => {
  it('is exposed in tools[] with the documented schema', () => {
    const tool = gitlabSkill.tools.find((t) => t.name === 'gitlab_create_mr');
    expect(tool).toBeTruthy();
    expect(tool.input_schema.required).toEqual(['project', 'source_branch', 'title']);
    expect(Object.keys(tool.input_schema.properties).sort())
      .toEqual(['description', 'project', 'source_branch', 'target_branch', 'title'].sort());
  });

  it('is documented in the prompt fragment', () => {
    expect(gitlabSkill.promptFragment).toContain('gitlab_create_mr');
  });
});

describe('gitlab_create_mr — open an MR', () => {
  it('returns the REAL pr_url from GitLab (web_url), never a fabricated one', async () => {
    const post = vi.fn(async () => fetchJson({
      web_url: 'https://gitlab.com/acme/widgets/-/merge_requests/9',
      iid: 9,
      state: 'opened',
    }));
    vi.stubGlobal('fetch', post);

    const out = JSON.parse(await gitlabSkill.handleToolCall('gitlab_create_mr', {
      project: 'acme/widgets', source_branch: 'fix/login', target_branch: 'main',
      title: 'Fix login', description: 'desc',
    }));

    expect(out.success).toBe(true);
    expect(out.pr_url).toBe('https://gitlab.com/acme/widgets/-/merge_requests/9'); // straight from web_url
    expect(out.number).toBe(9); // the iid
    expect(out.branch).toBe('fix/login');
    expect(out.targetBranch).toBe('main');
    expect(out.provider).toBe('gitlab');

    expect(post).toHaveBeenCalledTimes(1);
    const [url, opts] = post.mock.calls[0];
    // "acme/widgets" path gets URL-encoded into the project segment.
    expect(url).toBe('https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests');
    expect(opts.method).toBe('POST');
    const sent = JSON.parse(opts.body);
    expect(sent).toMatchObject({
      source_branch: 'fix/login', target_branch: 'main', title: 'Fix login', description: 'desc',
    });
  });

  it('defaults target_branch to the project default branch when omitted', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      calls.push({ url, method: opts?.method || 'GET' });
      if ((opts?.method || 'GET') === 'GET') return fetchJson({ default_branch: 'trunk' });
      return fetchJson({ web_url: 'https://gitlab.com/acme/widgets/-/merge_requests/2', iid: 2, state: 'opened' });
    }));

    const out = JSON.parse(await gitlabSkill.handleToolCall('gitlab_create_mr', {
      project: 'acme/widgets', source_branch: 'feature/x', title: 'Feature',
    }));

    expect(out.success).toBe(true);
    expect(out.targetBranch).toBe('trunk');
    expect(calls[0].method).toBe('GET'); // project lookup first
    expect(calls[1].method).toBe('POST');
  });

  it('returns { success:false, skippedReason } on a 409 (MR already exists) — does NOT throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fetchJson(
      { message: ['Another open merge request already exists for this source branch'] }, false, 409,
    )));

    const out = JSON.parse(await gitlabSkill.handleToolCall('gitlab_create_mr', {
      project: 'acme/widgets', source_branch: 'fix/login', target_branch: 'main', title: 'Fix',
    }));

    expect(out.success).toBe(false);
    expect(out.skippedReason).toMatch(/409/);
    expect(out.error).toBeUndefined();
    expect(out.provider).toBe('gitlab');
  });

  it('returns { success:false, skippedReason } on a 400 (source==target / no changes) — does NOT throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fetchJson(
      { error: 'branch_conflict' }, false, 400,
    )));

    const out = JSON.parse(await gitlabSkill.handleToolCall('gitlab_create_mr', {
      project: '123', source_branch: 'main', target_branch: 'main', title: 'No-op',
    }));

    expect(out.success).toBe(false);
    expect(out.skippedReason).toMatch(/400/);
    expect(out.error).toBeUndefined();
  });

  it('throws (→ { error }) on a genuine auth error (401), not a skip', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fetchJson({ message: '401 Unauthorized' }, false, 401)));

    const out = JSON.parse(await gitlabSkill.handleToolCall('gitlab_create_mr', {
      project: 'acme/widgets', source_branch: 'fix/login', target_branch: 'main', title: 'Fix',
    }));

    expect(out.error).toBeTruthy();
    expect(out.error).toMatch(/401/);
    expect(out.skippedReason).toBeUndefined();
  });

  it('validates required args', async () => {
    const out = JSON.parse(await gitlabSkill.handleToolCall('gitlab_create_mr', { project: 'acme/widgets' }));
    expect(out.error).toMatch(/required/);
  });
});
