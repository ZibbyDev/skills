/**
 * GITLAB_INSTANCES — one project, repos on SEVERAL GitLab servers.
 *
 * An account can connect more than one GitLab. A project selected three repos
 * spanning two of them (two on a self-managed http://gitlab:8929, one on
 * https://gitlab.com) but the run env carries a single GITLAB_TOKEN +
 * GITLAB_URL pair, which names exactly ONE server — so the third repo was
 * unreachable, and the obvious "try the other host" fallback would have sent
 * one server's token to the other. That is not a retry, it is a credential
 * delivered to a host it does not belong to.
 *
 * The optional GITLAB_INSTANCES table answers both questions from one place:
 * which repos are reachable (the UNION of its `repos` — derived, so
 * GITLAB_ALLOWED_REPOS is not a second list that has to agree) and which
 * host+token each call uses.
 *
 * These tests pin the properties that make it safe:
 *   - ABSENT ⇒ the single-server path is untouched (the regression that matters:
 *     every deployed agent today runs without this var)
 *   - a repo reaches ITS server, with ITS token, and never the other one's
 *   - enumeration merges across servers instead of reporting one
 *   - unknown / cross-server-numeric ⇒ refused, never "the first instance"
 *   - no token is ever echoed into a returned string (invariant #4)
 *   - TRIPWIRE: envKeys covers every process.env.GITLAB_* the module reads
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gitlabSkill, glFetch } from '../gitlab.js';

const ORIGINAL = { ...process.env };

// Deliberately not credential-shaped: this is a public repo and a scanner
// should never have to judge whether a fixture is a live key.
const SELF_HOSTED = 'http://gitlab:8929';
const CLOUD = 'https://gitlab.com';
const TOKEN_A = 'token-for-the-self-managed-box';
const TOKEN_B = 'token-for-the-cloud-one';

const TABLE = JSON.stringify([
  { host: SELF_HOSTED, token: TOKEN_A, repos: ['root/kb-demo', 'root/meter-shop'] },
  { host: CLOUD, token: TOKEN_B, repos: ['zibby-group/Zibby-project'] },
]);

beforeEach(() => {
  delete process.env.GITLAB_INSTANCES;
  delete process.env.GITLAB_ALLOWED_REPOS;
  delete process.env.GITLAB_OAUTH_TOKEN;
  delete process.env.GITLAB_API_URL;
  delete process.env.GITLAB_INSTANCE_URL;
  process.env.GITLAB_TOKEN = 'single-server-token';
  process.env.GITLAB_URL = SELF_HOSTED;
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

type Call = { url: string; token: string | undefined };

/**
 * Stub the GitLab API and RECORD (url, PRIVATE-TOKEN) for every call — the
 * pairing is the whole point, so the assertions are on what went on the wire,
 * not on what the code says it intended.
 */
function stubApi(handler: (url: string) => any): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), token: init?.headers?.['PRIVATE-TOKEN'] });
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
  return calls;
}

const MR = { iid: 7, title: 'x', diff_refs: {} };

describe('gitlab multi-instance routing', () => {
  describe('absent ⇒ the single-server path is unchanged', () => {
    test('a call goes to the env host with the env token, and nothing is gated', async () => {
      const calls = stubApi(() => MR);
      const res = JSON.parse(await gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: 'root/hono', iid: 7 }));
      expect(res.iid).toBe(7);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('http://gitlab:8929/api/v4/projects/root%2Fhono/merge_requests/7');
      expect(calls[0].token).toBe('single-server-token');
    });

    test('GITLAB_ALLOWED_REPOS still bounds it on its own', async () => {
      process.env.GITLAB_ALLOWED_REPOS = 'root/kb-demo';
      stubApi(() => MR);
      const res = JSON.parse(await gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: 'root/hono', iid: 7 }));
      expect(res.error).toMatch(/not available to this project/);
    });

    test('enumeration carries no host field (the response shape is byte-identical)', async () => {
      stubApi(() => [{ path_with_namespace: 'root/kb-demo', name: 'kb-demo', web_url: 'u', default_branch: 'main', visibility: 'private' }]);
      const res = JSON.parse(await gitlabSkill.handleToolCall('gitlab_list_projects', {}));
      expect(res.projects[0]).toEqual({
        fullPath: 'root/kb-demo', name: 'kb-demo', webUrl: 'u', defaultBranch: 'main', visibility: 'private',
      });
    });

    test('the OAuth bearer path is untouched', async () => {
      process.env.GITLAB_OAUTH_TOKEN = 'oauth-placeholder';
      const seen: any[] = [];
      vi.stubGlobal('fetch', vi.fn(async (_u: any, init: any) => {
        seen.push(init.headers);
        return { ok: true, status: 200, json: async () => MR, text: async () => '{}' } as any;
      }));
      await gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: 'root/hono', iid: 7 });
      expect(seen[0].Authorization).toBe('Bearer oauth-placeholder');
      expect(seen[0]['PRIVATE-TOKEN']).toBeUndefined();
    });
  });

  describe('present ⇒ each repo reaches its own server', () => {
    beforeEach(() => { process.env.GITLAB_INSTANCES = TABLE; });

    test('a repo on the self-managed box uses that host and that token', async () => {
      const calls = stubApi(() => MR);
      const res = JSON.parse(await gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: 'root/kb-demo', iid: 7 }));
      expect(res.iid).toBe(7);
      expect(calls[0].url).toBe('http://gitlab:8929/api/v4/projects/root%2Fkb-demo/merge_requests/7');
      expect(calls[0].token).toBe(TOKEN_A);
    });

    test('a repo on the OTHER server uses the OTHER host and the OTHER token', async () => {
      // This is the repo that was unreachable: wrong server, and the
      // self-managed token would not have authenticated there anyway.
      const calls = stubApi(() => MR);
      const res = JSON.parse(await gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: 'zibby-group/Zibby-project', iid: 7 }));
      expect(res.iid).toBe(7);
      expect(calls[0].url).toBe('https://gitlab.com/api/v4/projects/zibby-group%2FZibby-project/merge_requests/7');
      expect(calls[0].token).toBe(TOKEN_B);
    });

    test('no call ever pairs one server’s host with the other’s token', async () => {
      const calls = stubApi(() => MR);
      await gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: 'root/kb-demo', iid: 1 });
      await gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: 'zibby-group/Zibby-project', iid: 2 });
      await gitlabSkill.handleToolCall('gitlab_list_projects', {});
      expect(calls.length).toBeGreaterThanOrEqual(3);
      for (const c of calls) {
        const expected = c.url.startsWith(CLOUD) ? TOKEN_B : TOKEN_A;
        expect(c.token, `${c.url} was sent the wrong server's token`).toBe(expected);
      }
    });

    test('routing survives the env host disagreeing with every entry', async () => {
      // The single-server vars are still set (a real run has both). They must
      // lose to the table, or the "wrong server" bug simply moves.
      process.env.GITLAB_URL = 'https://not-a-connected-server.invalid';
      const calls = stubApi(() => MR);
      await gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: 'zibby-group/Zibby-project', iid: 7 });
      expect(calls[0].url.startsWith(CLOUD)).toBe(true);
    });

    test('matching is case- and slash-insensitive, like the allowlist', async () => {
      const calls = stubApi(() => MR);
      await gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: '/Zibby-Group/zibby-PROJECT/', iid: 7 });
      expect(calls[0].token).toBe(TOKEN_B);
    });
  });

  describe('enumeration is merged, not one server’s answer', () => {
    beforeEach(() => { process.env.GITLAB_INSTANCES = TABLE; });

    test('every declared server is asked, with its own token, and the results merge', async () => {
      const calls = stubApi((url) => (url.startsWith(CLOUD)
        ? [{ path_with_namespace: 'zibby-group/Zibby-project', name: 'Zibby-project', web_url: 'c', default_branch: 'main', visibility: 'private' }]
        : [
          { path_with_namespace: 'root/kb-demo', name: 'kb-demo', web_url: 's', default_branch: 'main', visibility: 'private' },
          { path_with_namespace: 'root/meter-shop', name: 'meter-shop', web_url: 's', default_branch: 'main', visibility: 'private' },
          { path_with_namespace: 'root/hono', name: 'hono', web_url: 's', default_branch: 'main', visibility: 'private' },
        ]));
      const res = JSON.parse(await gitlabSkill.handleToolCall('gitlab_list_projects', {}));
      expect(res.projects.map((p: any) => p.fullPath)).toEqual([
        'root/kb-demo', 'root/meter-shop', 'zibby-group/Zibby-project',
      ]);
      // …and each entry says which server it lives on.
      expect(res.projects.map((p: any) => p.host)).toEqual([SELF_HOSTED, SELF_HOSTED, CLOUD]);
      // root/hono is on the instance but not selected → still filtered out.
      expect(calls.map((c) => c.token)).toEqual([TOKEN_A, TOKEN_B]);
    });

    test('a server’s answer is filtered by ITS OWN repos, not by the union', async () => {
      // If the self-managed box also happens to host a path the CLOUD entry
      // claims, union-filtering would let it through under the wrong host.
      stubApi((url) => (url.startsWith(CLOUD)
        ? []
        : [{ path_with_namespace: 'zibby-group/Zibby-project', name: 'impostor', web_url: 's', default_branch: 'main', visibility: 'private' }]));
      const res = JSON.parse(await gitlabSkill.handleToolCall('gitlab_list_projects', {}));
      expect(res.projects).toEqual([]);
    });
  });

  describe('refusals — never a fallback to "the first instance"', () => {
    beforeEach(() => { process.env.GITLAB_INSTANCES = TABLE; });

    test('a repo no server claims is refused, with the existing allowlist error shape', async () => {
      const calls = stubApi(() => MR);
      const res = JSON.parse(await gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: 'root/hono', iid: 7 }));
      expect(res.error).toMatch(/root\/hono.*not available to this project/);
      expect(res.allowedRepos).toEqual(['root/kb-demo', 'root/meter-shop', 'zibby-group/zibby-project']);
      expect(calls, 'a refused call must not have touched any server').toHaveLength(0);
    });

    test('the allowlist is DERIVED — GITLAB_ALLOWED_REPOS need not be set at all', async () => {
      // Requiring both to be set and to agree would be a two-places bug.
      expect(process.env.GITLAB_ALLOWED_REPOS).toBeUndefined();
      stubApi(() => MR);
      const ok = JSON.parse(await gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: 'root/kb-demo', iid: 7 }));
      expect(ok.iid).toBe(7);
      const no = JSON.parse(await gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: 'root/hono', iid: 7 }));
      expect(no.error).toMatch(/not available/);
    });

    test('a numeric id is probed per-server and cannot cross onto another host', async () => {
      // Id 42 exists on BOTH: on the self-managed box it is root/hono (not
      // selected); on cloud it is the selected project. The self-managed
      // resolution must not be accepted just because the resulting path passes
      // the union allowlist — it names a project that server never minted.
      const calls = stubApi((url) => {
        if (!/\/projects\/42$/.test(url)) return MR; // the id LOOKUP, not the MR fetch
        return url.startsWith(CLOUD)
          ? { path_with_namespace: 'zibby-group/Zibby-project' }
          : { path_with_namespace: 'root/hono' };
      });
      const res = JSON.parse(await gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: '42', iid: 7 }));
      expect(res.iid).toBe(7);
      const mrCall = calls.find((c) => c.url.includes('/merge_requests/'));
      expect(mrCall!.url.startsWith(CLOUD)).toBe(true);
      expect(mrCall!.token).toBe(TOKEN_B);
      // The probe on the self-managed box used ITS token, not cloud's.
      expect(calls[0].token).toBe(TOKEN_A);
    });

    test('a numeric id resolving ONLY on the wrong server is refused, selected path or not', async () => {
      // The case the union allowlist alone cannot catch, and the reason the
      // gate checks the OWNER and not just the path: id 7 exists only on the
      // self-managed box, where it names "zibby-group/Zibby-project" — a path
      // that IS selected, but on the OTHER server. Accepting it would send the
      // self-managed token a request for a project cloud owns.
      const calls = stubApi((url) => {
        if (!/\/projects\/7$/.test(url)) return MR;
        return url.startsWith(CLOUD) ? undefined : { path_with_namespace: 'zibby-group/Zibby-project' };
      });
      const res = JSON.parse(await gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: '7', iid: 1 }));
      expect(res.error).toMatch(/not available to this project/);
      expect(calls.every((c) => !c.url.includes('/merge_requests/')), 'no MR call may have gone out').toBe(true);
    });

    test('a numeric id no server claims is refused (fail-closed)', async () => {
      stubApi((url) => (url.includes('/projects/99') ? { path_with_namespace: 'root/hono' } : MR));
      const res = JSON.parse(await gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: '99', iid: 7 }));
      expect(res.error).toMatch(/root\/hono.*not available/);
    });

    test('an UNROUTED call has no host or token to fall back to', async () => {
      // The structural fail-closed: with a table in play, code that reaches the
      // wire without a routing decision must refuse rather than pick a server.
      stubApi(() => MR);
      await expect(glFetch('/projects/1')).rejects.toThrow(/not routed to a connected server/);
    });
  });

  describe('a table that is present but unusable fails LOUD', () => {
    test.each([
      ['not JSON', 'root/kb-demo,root/meter-shop', /not valid JSON/],
      ['not an array', '{"host":"http://gitlab:8929"}', /non-empty JSON array/],
      ['empty', '[]', /non-empty JSON array/],
      ['missing host', '[{"token":"t","repos":["a/b"]}]', /\[0\] is missing "host"/],
      ['missing token', `[{"host":"${SELF_HOSTED}","repos":["a/b"]}]`, /\[0\].*is missing "token"/],
      ['no repos', `[{"host":"${SELF_HOSTED}","token":"t","repos":[]}]`, /declares no "repos"/],
      ['a path claimed twice', `[{"host":"${SELF_HOSTED}","token":"t","repos":["a/b"]},{"host":"${CLOUD}","token":"t2","repos":["A/B"]}]`, /more than one server/],
    ])('%s', async (_label, raw, expected) => {
      process.env.GITLAB_INSTANCES = raw;
      stubApi(() => MR);
      const res = JSON.parse(await gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: 'root/kb-demo', iid: 7 }));
      expect(res.error).toMatch(expected);
    });

    test('a parse error never echoes the value it failed on', async () => {
      process.env.GITLAB_INSTANCES = `[{"host":"${SELF_HOSTED}","token":"${TOKEN_A}"`; // truncated JSON
      stubApi(() => MR);
      const res = JSON.parse(await gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: 'root/kb-demo', iid: 7 }));
      expect(res.error).toMatch(/not valid JSON/);
      expect(res.error).not.toContain(TOKEN_A);
    });
  });

  test('no token reaches a returned string, on any path', async () => {
    process.env.GITLAB_INSTANCES = TABLE;
    stubApi((url) => {
      if (url.includes('boom')) return undefined; // 404 → the error path
      if (url.includes('/projects?')) return [{ path_with_namespace: 'root/kb-demo', name: 'k', web_url: 'u' }];
      return MR;
    });
    const outputs = await Promise.all([
      gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: 'root/kb-demo', iid: 7 }),
      gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: 'zibby-group/Zibby-project', iid: 7 }),
      gitlabSkill.handleToolCall('gitlab_get_mr', { projectId: 'root/hono', iid: 7 }),
      gitlabSkill.handleToolCall('gitlab_list_projects', {}),
      gitlabSkill.handleToolCall('gitlab_get_issue', { projectId: 'root/kb-demo', iid: 'boom' }),
    ]);
    for (const out of outputs) {
      expect(out).not.toContain(TOKEN_A);
      expect(out).not.toContain(TOKEN_B);
    }
  });

  describe('TRIPWIRE — envKeys vs the env this module actually reads', () => {
    // Two places that must agree, with nothing between them: resolve() copies
    // ONLY envKeys into the spawned MCP child, so that list IS the child's
    // whole environment. A GITLAB_* key the module reads but the list omits
    // does not error — it silently disables whatever the key controls, in the
    // fail-OPEN direction. That drifted twice already (GITLAB_ALLOWED_REPOS was
    // caught by hand; GITLAB_URL was NOT, and left the child defaulting to
    // gitlab.com while the run process talked to the self-managed host).
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'gitlab.ts'), 'utf-8');
    const readFromEnv = [...new Set(
      [...src.matchAll(/process\.env\.(GITLAB_[A-Z0-9_]+)/g)].map((m) => m[1]),
    )].sort();

    test('probe: the scan finds the keys we KNOW are read', () => {
      // A negative result means nothing until the probe is shown to find a
      // positive — an empty scan would make every assertion below vacuous.
      expect(readFromEnv).toEqual(expect.arrayContaining([
        'GITLAB_TOKEN', 'GITLAB_OAUTH_TOKEN', 'GITLAB_URL', 'GITLAB_INSTANCE_URL',
        'GITLAB_API_URL', 'GITLAB_ALLOWED_REPOS', 'GITLAB_INSTANCES',
      ]));
    });

    test.each(readFromEnv)('%s is declared in envKeys', (key) => {
      expect(
        gitlabSkill.envKeys,
        `gitlab.ts reads process.env.${key}, but envKeys omits it — the spawned MCP `
        + 'child will never see it, and the feature it controls silently does nothing there',
      ).toContain(key);
    });
  });
});
