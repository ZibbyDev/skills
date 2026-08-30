/**
 * `github_list_repos` with no `owner` must work for BOTH credential kinds.
 *
 * GitHub has two mutually exclusive listing endpoints and the TOKEN decides
 * which one is legal:
 *   • App installation token → GET /installation/repositories
 *   • user token (OAuth/PAT) → GET /user/repos
 * Calling the other one is a 403 — "You must authenticate with an installation
 * access token in order to list repositories for an installation."
 *
 * The tool used to call the installation endpoint unconditionally, so on a
 * user-token connection listing the user's OWN repos was a guaranteed 403
 * (observed on the self-host Copilot, 2026-08-30: it could search all of GitHub
 * but could not name one repo of the account it was connected to).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const resolveIntegrationToken = vi.fn();
vi.mock('@zibby/core/backend-client.js', () => ({
  resolveIntegrationToken: (p: string) => resolveIntegrationToken(p),
  clearTokenCache: vi.fn(),
}));

const { githubSkill } = await import('../github.js');

const INSTALLATION_403 =
  'You must authenticate with an installation access token in order to list '
  + 'repositories for an installation.';

function repo(name: string) {
  return {
    name, full_name: `acme/${name}`, private: true, description: '', html_url: `https://github.com/acme/${name}`,
    default_branch: 'main', updated_at: '2026-08-30T00:00:00Z', language: 'TypeScript', stargazers_count: 0,
  };
}

/** Serve GitHub by path; records every path asked for. */
function stubGithub(handler: (path: string) => { status: number; body: any }) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: any) => {
    const path = String(url).replace('https://api.github.com', '');
    asked.push(path);
    const { status, body } = handler(path);
    return { ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body } as any;
  }));
  return asked;
}

beforeEach(() => {
  resolveIntegrationToken.mockReset();
  resolveIntegrationToken.mockResolvedValue({ token: 'gh_token' });
});
afterEach(() => vi.unstubAllGlobals());

describe('github_list_repos — no owner', () => {
  it('an APP INSTALLATION token lists through /installation/repositories, unchanged', async () => {
    const asked = stubGithub((path) => path.startsWith('/installation/repositories')
      ? { status: 200, body: { repositories: [repo('alpha')] } }
      : { status: 500, body: { message: `unexpected ${path}` } });

    const out = JSON.parse(await githubSkill.handleToolCall('github_list_repos', {}));

    expect(out.count).toBe(1);
    expect(out.repos[0].fullPath).toBe('acme/alpha');
    // No wasted request: the App path costs exactly what it always did.
    expect(asked.every((p) => p.startsWith('/installation/repositories'))).toBe(true);
  });

  it('a USER token falls back to /user/repos instead of returning the 403', async () => {
    const asked = stubGithub((path) => {
      if (path.startsWith('/installation/repositories')) return { status: 403, body: { message: INSTALLATION_403 } };
      if (path.startsWith('/user/repos')) return { status: 200, body: [repo('beta')] };
      return { status: 500, body: { message: `unexpected ${path}` } };
    });

    const out = JSON.parse(await githubSkill.handleToolCall('github_list_repos', {}));

    expect(out.count).toBe(1);
    expect(out.repos[0].fullPath).toBe('acme/beta');
    expect(asked.some((p) => p.startsWith('/user/repos'))).toBe(true);
    // The whole accessible set, not only what the user personally owns.
    expect(asked.find((p) => p.startsWith('/user/repos'))).toContain('affiliation=owner,collaborator,organization_member');
  });

  it('a NON-permission failure is still a failure — no silent fallback', async () => {
    // 500 is not "wrong token kind"; swallowing it would turn an outage into
    // "you have no repos", which is the worst possible answer.
    stubGithub((path) => path.startsWith('/installation/repositories')
      ? { status: 500, body: { message: 'github is down' } }
      : { status: 200, body: [repo('never-reached')] });

    const out = JSON.parse(await githubSkill.handleToolCall('github_list_repos', {}));
    expect(out.error).toMatch(/500/);
  });
});
