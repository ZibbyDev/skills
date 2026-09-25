/**
 * The project's repository selection is an access boundary for every token.
 *
 * The rule: if a project did not select a repository (Project Settings →
 * Repository access), that project's agents must not have access to it. A
 * GitHub App token can be minted scoped to the selection; a personal access
 * token cannot — so before this, a PAT-connected box handed every project's
 * agents everything the PAT owner could reach. These tests pin that the
 * selection (REPO_ALLOWLIST, @zibby/core/utils/repo-access) is enforced at every
 * tool, at the node-side ghFetch/glFetch chokepoints and at git_checkout —
 * regardless of token type — and that "nothing selected" means NO access.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import { githubSkill, ghFetch } from '../github.js';
import { gitlabSkill, glFetch } from '../gitlab.js';
import { gitSkill } from '../git.js';
import { gitWriteSkill } from '../git-write.js';

const ORIGINAL = { ...process.env };

const scoped = (github: string[] = [], gitlab: string[] = []) => JSON.stringify({ github, gitlab });

let calls: string[] = [];
function stubApi(handler: (url: string) => any) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: any) => {
    calls.push(String(url));
    const body = handler(String(url));
    return {
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as any;
  }));
}

beforeEach(() => {
  // A PAT, delivered the self-host way (fast path, no backend round-trip).
  process.env.ZIBBY_SELF_HOST = '1';
  process.env.GITHUB_TOKEN = 'ghp_personal_access_token';
  process.env.GITLAB_TOKEN = 'glpat-test';
  delete process.env.REPO_ALLOWLIST;
  delete process.env.GITLAB_ALLOWED_REPOS;
  delete process.env.GITLAB_INSTANCES;
  delete process.env.GITLAB_URL;
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllGlobals();
});

const PR = { number: 1, title: 't', head: { ref: 'b', sha: 's' }, base: { ref: 'main' }, labels: [] };

describe('GitHub with a personal access token', () => {
  test('selected repo → allowed', async () => {
    process.env.REPO_ALLOWLIST = scoped(['acme/web']);
    stubApi(() => PR);
    const res = JSON.parse(await githubSkill.handleToolCall('github_get_pr', { owner: 'acme', repo: 'web', number: 1 }));
    expect(res.code).toBeUndefined();
    expect(res.number).toBe(1);
    expect(calls).toEqual(['https://api.github.com/repos/acme/web/pulls/1']);
  });

  test('unselected repo → refused with code REPO_NOT_SELECTED, and GitHub is never called', async () => {
    process.env.REPO_ALLOWLIST = scoped(['acme/web']);
    stubApi(() => PR);
    const res = JSON.parse(await githubSkill.handleToolCall('github_get_pr', { owner: 'acme', repo: 'core', number: 1 }));
    expect(res.code).toBe('REPO_NOT_SELECTED');
    expect(res.repo).toBe('acme/core');
    expect(res.allowedRepos).toEqual(['acme/web']);
    expect(res.error).toMatch(/not selected for this project/);
    expect(calls).toEqual([]);
  });

  test('nothing selected → every repo refused (NOT "everything allowed")', async () => {
    process.env.REPO_ALLOWLIST = scoped();
    stubApi(() => PR);
    const res = JSON.parse(await githubSkill.handleToolCall('github_get_pr', { owner: 'acme', repo: 'web', number: 1 }));
    expect(res.code).toBe('REPO_NOT_SELECTED');
    expect(res.error).toMatch(/no GitHub repositories selected/);
    expect(calls).toEqual([]);
  });

  test('writes are bounded too: github_create_pr / git_open_pr on an unselected repo', async () => {
    process.env.REPO_ALLOWLIST = scoped(['acme/web']);
    stubApi(() => ({ html_url: 'x', number: 9 }));
    const a = JSON.parse(await githubSkill.handleToolCall('github_create_pr', { owner: 'acme', repo: 'core', head: 'b', base: 'main', title: 't' }));
    expect(a.code).toBe('REPO_NOT_SELECTED');
    const b = JSON.parse(await gitWriteSkill.handleToolCall('git_open_pr', { repoUrl: 'https://github.com/acme/core', head: 'b', base: 'main', title: 't' }));
    expect(b.code).toBe('REPO_NOT_SELECTED');
    expect(calls).toEqual([]);
  });

  test('github_clone of an unselected repo is refused before the token is used', async () => {
    process.env.REPO_ALLOWLIST = scoped(['acme/web']);
    const res = JSON.parse(await githubSkill.handleToolCall('github_clone', { owner: 'acme', repo: 'core', destination: '/nonexistent-dir-for-test' }));
    expect(res.code).toBe('REPO_NOT_SELECTED');
  });

  test('enumeration shows only the selection (list_repos reads the selection; search is filtered)', async () => {
    process.env.REPO_ALLOWLIST = scoped(['acme/web']);
    stubApi((url) => {
      if (url.endsWith('/repos/acme/web')) return { name: 'web', full_name: 'acme/web', private: true, html_url: 'u' };
      if (url.includes('/search/code')) {
        return { total_count: 2, items: [
          { name: 'a.js', path: 'a.js', repository: { full_name: 'acme/web' } },
          { name: 'b.js', path: 'b.js', repository: { full_name: 'acme/core' } },
        ] };
      }
      return undefined;
    });
    const list = JSON.parse(await githubSkill.handleToolCall('github_list_repos', {}));
    expect(list.repos.map((r: any) => r.fullName)).toEqual(['acme/web']);
    expect(calls.some((u) => u.includes('/user/repos') || u.includes('/installation/repositories'))).toBe(false);

    const search = JSON.parse(await githubSkill.handleToolCall('github_search_code', { query: 'x' }));
    expect(search.items.map((i: any) => i.repo)).toEqual(['acme/web']);
    expect(search.total).toBe(1);
  });

  test('node-side ghFetch (template nodes) is the same chokepoint', async () => {
    process.env.REPO_ALLOWLIST = scoped(['acme/web']);
    stubApi(() => PR);
    await expect(ghFetch('/repos/acme/core/pulls/1')).rejects.toMatchObject({ code: 'REPO_NOT_SELECTED' });
    await expect(ghFetch('https://api.github.com/repos/acme/core/pulls/1')).rejects.toMatchObject({ code: 'REPO_NOT_SELECTED' });
    // An id-addressed or GraphQL request cannot be matched to a repository.
    await expect(ghFetch('/repositories/12345')).rejects.toMatchObject({ code: 'REPO_NOT_SELECTED' });
    await expect(ghFetch('/graphql', { method: 'POST', body: {} })).rejects.toMatchObject({ code: 'REPO_NOT_SELECTED' });
    expect(calls).toEqual([]);
    await expect(ghFetch('/repos/acme/web/pulls/1')).resolves.toMatchObject({ number: 1 });
  });

  test('an unscoped run (no REPO_ALLOWLIST — e.g. a developer\'s own CLI) is unchanged', async () => {
    stubApi(() => PR);
    const res = JSON.parse(await githubSkill.handleToolCall('github_get_pr', { owner: 'any', repo: 'thing', number: 1 }));
    expect(res.number).toBe(1);
  });
});

describe('git_checkout', () => {
  test('an unselected github repo is refused before any clone', async () => {
    process.env.REPO_ALLOWLIST = scoped(['acme/web']);
    const res = JSON.parse(await gitSkill.handleToolCall('git_checkout', { url: 'acme/core' }, { options: { workspace: '/nonexistent-dir-for-test' } }));
    expect(res.code).toBe('REPO_NOT_SELECTED');
  });
  test('an unselected repo on the configured self-hosted gitlab is refused', async () => {
    process.env.GITLAB_URL = 'http://gitlab.internal:8929';
    process.env.REPO_ALLOWLIST = scoped([], ['root/kb-demo']);
    const res = JSON.parse(await gitSkill.handleToolCall('git_checkout', { url: 'http://gitlab.internal:8929/root/hono.git' }, { options: { workspace: '/nonexistent-dir-for-test' } }));
    expect(res.code).toBe('REPO_NOT_SELECTED');
    expect(res.provider).toBe('gitlab');
  });
});

describe('GitLab', () => {
  test('REPO_ALLOWLIST with nothing selected → refused, enumeration empty', async () => {
    process.env.REPO_ALLOWLIST = scoped(['acme/web'], []);
    stubApi((url) => (url.includes('/projects?') ? [{ path_with_namespace: 'root/hono', name: 'hono' }] : { iid: 1 }));
    const res = JSON.parse(await gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: 'root/hono', iid: 1 }));
    expect(res.code).toBe('REPO_NOT_SELECTED');
    const list = JSON.parse(await gitlabSkill.handleToolCall('gitlab_list_projects', {}));
    expect(list.projects).toEqual([]);
  });

  test('REPO_ALLOWLIST is the selection; the older GITLAB_ALLOWED_REPOS cannot widen it', async () => {
    process.env.REPO_ALLOWLIST = scoped([], ['root/kb-demo']);
    process.env.GITLAB_ALLOWED_REPOS = 'root/kb-demo,root/hono';
    stubApi(() => ({ iid: 1, title: 'x', diff_refs: {} }));
    const no = JSON.parse(await gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: 'root/hono', iid: 1 }));
    expect(no.code).toBe('REPO_NOT_SELECTED');
    const yes = JSON.parse(await gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: 'root/kb-demo', iid: 1 }));
    expect(yes.code).toBeUndefined();
  });

  test('node-side glFetch checks path-addressed and numeric-id requests', async () => {
    process.env.REPO_ALLOWLIST = scoped([], ['root/kb-demo']);
    stubApi((url) => (url.endsWith('/projects/42') ? { path_with_namespace: 'root/hono' } : { iid: 1 }));
    await expect(glFetch(`/projects/${encodeURIComponent('root/hono')}/merge_requests/1/changes`)).rejects.toMatchObject({ code: 'REPO_NOT_SELECTED' });
    await expect(glFetch('/projects/42/merge_requests/1')).rejects.toMatchObject({ code: 'REPO_NOT_SELECTED' });
    await expect(glFetch('/merge_requests?scope=all')).rejects.toMatchObject({ code: 'REPO_NOT_SELECTED' });
    await expect(glFetch(`/projects/${encodeURIComponent('root/kb-demo')}/merge_requests/1`)).resolves.toMatchObject({ iid: 1 });
  });
});

describe('the channel reaches every tool process', () => {
  test.each([
    ['github', githubSkill],
    ['gitlab', gitlabSkill],
    ['git', gitSkill],
    ['git-write', gitWriteSkill],
  ])('%s declares REPO_ALLOWLIST in envKeys (the child\'s whole env — a miss silently lifts the boundary)', (_n, skill: any) => {
    expect(skill.envKeys).toContain('REPO_ALLOWLIST');
  });
});
