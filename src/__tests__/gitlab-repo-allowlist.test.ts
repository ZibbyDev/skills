/**
 * The GitLab repo allowlist — the only thing that keeps a promise the product
 * makes in writing.
 *
 * Project Settings says: "Agents in this project can only use the selected repos.
 * Anything you leave unchecked stays invisible to this project's agents." GitHub
 * keeps it at the credential layer (resolveAgentGithubToken mints an App token
 * scoped to the selection, fail-closed). GitLab cannot: a PAT carries its owner's
 * whole reach and has no repo scope. So on the GitLab side that sentence was true
 * of nothing — every gitlab-using agent could read every project on the instance.
 * It stayed invisible because only the Copilot ever ENUMERATES; asked to list, it
 * returned 12 repositories for a project that had selected one.
 *
 * The gate therefore lives at the tool layer, and these tests pin the three
 * properties that make it worth having:
 *   - it denies by PATH, including via a numeric id (no walking around it)
 *   - it filters ENUMERATION, not just named access (the half that was missing)
 *   - absent ⇒ unrestricted, byte-identical to before (the settings page already
 *     promises "leave empty to make all repositories available")
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import { gitlabSkill } from '../gitlab.js';

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.GITLAB_TOKEN = 'test-token';
  delete process.env.GITLAB_ALLOWED_REPOS;
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

/** Stub the GitLab API so nothing leaves the process. */
function stubApi(handler: (url: string) => any) {
  vi.stubGlobal('fetch', vi.fn(async (url: any) => {
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

const PROJECTS = [
  { path_with_namespace: 'root/kb-demo', name: 'kb-demo', web_url: 'u', default_branch: 'main', visibility: 'private' },
  { path_with_namespace: 'root/hono', name: 'hono', web_url: 'u', default_branch: 'main', visibility: 'private' },
  { path_with_namespace: 'zibby-grp/ga', name: 'ga', web_url: 'u', default_branch: 'main', visibility: 'private' },
];

describe('gitlab repo allowlist', () => {
  test('with no allowlist, enumeration returns everything (unchanged behaviour)', async () => {
    stubApi(() => PROJECTS);
    const res = JSON.parse(await gitlabSkill.handleToolCall('gitlab_list_projects', {}));
    expect(res.projects.map((p: any) => p.fullPath)).toEqual(
      ['root/kb-demo', 'root/hono', 'zibby-grp/ga'],
    );
  });

  test('enumeration is filtered to the selection', async () => {
    process.env.GITLAB_ALLOWED_REPOS = 'root/kb-demo';
    stubApi(() => PROJECTS);
    const res = JSON.parse(await gitlabSkill.handleToolCall('gitlab_list_projects', {}));
    expect(res.projects.map((p: any) => p.fullPath)).toEqual(['root/kb-demo']);
    expect(res.count).toBe(1);
  });

  test('a named non-selected project is refused, and the error says what IS allowed', async () => {
    process.env.GITLAB_ALLOWED_REPOS = 'root/kb-demo';
    stubApi(() => ({}));
    const res = JSON.parse(await gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: 'root/hono', iid: 1 }));
    expect(res.error).toMatch(/root\/hono.*not available to this project/);
    // A bare "denied" reads to the model as a transient failure and it retries.
    expect(res.allowedRepos).toEqual(['root/kb-demo']);
  });

  test('a selected project passes the gate', async () => {
    process.env.GITLAB_ALLOWED_REPOS = 'root/kb-demo';
    stubApi(() => ({ iid: 1, title: 'x', diff_refs: {} }));
    const res = JSON.parse(await gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: 'root/kb-demo', iid: 1 }));
    expect(String(res.error || '')).not.toMatch(/not available to this project/);
  });

  test('a NUMERIC project id is resolved to its path before the check', async () => {
    // Otherwise `projectId: 42` is a hole straight through the allowlist.
    process.env.GITLAB_ALLOWED_REPOS = 'root/kb-demo';
    stubApi((url) => (url.includes('/projects/42') ? { path_with_namespace: 'root/hono' } : {}));
    const res = JSON.parse(await gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: '42', iid: 1 }));
    expect(res.error).toMatch(/root\/hono.*not available/);
  });

  test('an unresolvable id is refused rather than allowed (fail-closed)', async () => {
    process.env.GITLAB_ALLOWED_REPOS = 'root/kb-demo';
    stubApi(() => undefined); // every lookup 404s
    const res = JSON.parse(await gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: '999', iid: 1 }));
    expect(res.error).toMatch(/not available to this project/);
  });

  test('matching is case- and slash-insensitive', async () => {
    process.env.GITLAB_ALLOWED_REPOS = ' Root/KB-Demo , ';
    stubApi(() => ({ iid: 1 }));
    const res = JSON.parse(await gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: '/root/kb-demo/', iid: 1 }));
    expect(String(res.error || '')).not.toMatch(/not available to this project/);
  });

  test('the env key is declared, or the child never receives the list', async () => {
    // envKeys IS the spawned MCP child's whole environment. Omitting the key
    // does not error — it silently disables the gate, which is the fail-OPEN
    // direction on a permission boundary.
    expect(gitlabSkill.envKeys).toContain('GITLAB_ALLOWED_REPOS');
  });
});
