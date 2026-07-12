import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * SECURITY (CLAUDE.md §5) — wiring proof: on a SUCCESSFUL clone, github_clone /
 * gitlab_clone must immediately rewrite `origin` to the TOKENLESS URL so the
 * repo's on-disk `.git/config` never carries the token to the untrusted-input
 * agent. child_process is mocked (no network); we assert a `remote set-url
 * origin <tokenless>` command is issued after `git clone`, and that the set-url
 * command carries no token / userinfo. The real strip against a live
 * `.git/config` is covered by clone-token-scrub.test.js.
 */

const execSyncMock = vi.fn();
vi.mock('child_process', () => ({ execSync: (...a) => execSyncMock(...a) }));

let tmp;
beforeEach(() => {
  vi.restoreAllMocks();
  execSyncMock.mockReset();
  execSyncMock.mockReturnValue(''); // every git/ls command "succeeds"
  tmp = mkdtempSync(join(tmpdir(), 'scrub-wiring-'));
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.GITLAB_TOKEN;
  delete process.env.GITLAB_OAUTH_TOKEN;
});

describe('github_clone token scrub wiring', () => {
  it('rewrites origin to the tokenless URL after cloning', async () => {
    const TOKEN = 'ghs_SECRETgithub789';
    vi.doMock('@zibby/core/backend-client.js', () => ({
      resolveIntegrationToken: async () => ({ token: TOKEN }),
    }));
    vi.resetModules();
    const { githubSkill } = await import('../src/github.js');

    const res = JSON.parse(await githubSkill.handleToolCall('github_clone', {
      owner: 'acme', repo: 'api', destination: tmp,
    }, {}));
    expect(res.success).toBe(true);

    const cmds = execSyncMock.mock.calls.map((c) => String(c[0]));
    const setUrl = cmds.find((c) => c.includes('remote set-url origin'));
    expect(setUrl).toBeTruthy();
    expect(setUrl).toContain('https://github.com/acme/api.git');
    expect(setUrl).not.toContain(TOKEN);
    expect(setUrl).not.toContain('x-access-token');
    // ordering: the clone happens before the scrub.
    const cloneIdx = cmds.findIndex((c) => c.startsWith('git clone'));
    const scrubIdx = cmds.findIndex((c) => c.includes('remote set-url origin'));
    expect(cloneIdx).toBeGreaterThanOrEqual(0);
    expect(scrubIdx).toBeGreaterThan(cloneIdx);
  });
});

describe('gitlab_clone token scrub wiring', () => {
  it('rewrites origin to the tokenless URL after cloning', async () => {
    const TOKEN = 'glpat-SECRETgitlab789';
    process.env.GITLAB_TOKEN = TOKEN;
    vi.resetModules();
    const { gitlabSkill } = await import('../src/gitlab.js');

    const res = JSON.parse(await gitlabSkill.handleToolCall('gitlab_clone', {
      projectPath: 'group/repo', destination: tmp,
    }, {}));
    expect(res.success).toBe(true);

    const cmds = execSyncMock.mock.calls.map((c) => String(c[0]));
    const setUrl = cmds.find((c) => c.includes('remote set-url origin'));
    expect(setUrl).toBeTruthy();
    expect(setUrl).toContain('https://gitlab.com/group/repo.git');
    expect(setUrl).not.toContain(TOKEN);
    expect(setUrl).not.toContain('oauth2:');
  });
});
