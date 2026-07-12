import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * SECURITY (C3): the clone tools embed the VCS token in the authenticated
 * remote URL (`x-access-token:<tok>@github.com` / `oauth2:<tok>@host`). git's
 * stderr / execSync's error echo the full `git clone <url>` command — so the
 * token would leak back to the model in the tool's error text unless redacted.
 * These tests force the clone to FAIL with a token-bearing error and assert the
 * returned error never contains the live token or the URL userinfo.
 */

// child_process is dynamically imported inside the clone handlers; mock execSync
// to throw a realistic git error that embeds the token.
const execSyncMock = vi.fn();
vi.mock('child_process', () => ({ execSync: (...a) => execSyncMock(...a) }));

const { gitlabSkill } = await import('../src/gitlab.js');

let tmp;
beforeEach(() => {
  vi.restoreAllMocks();
  execSyncMock.mockReset();
  tmp = mkdtempSync(join(tmpdir(), 'clone-redact-'));
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.GITLAB_TOKEN;
  delete process.env.GITLAB_OAUTH_TOKEN;
});

describe('gitlab_clone error redaction', () => {
  it('never echoes the token or oauth2 URL userinfo on failure', async () => {
    const TOKEN = 'glpat-SUPERSECRET123';
    process.env.GITLAB_TOKEN = TOKEN;
    execSyncMock.mockImplementation((cmd) => {
      // git echoes the full authenticated URL in its fatal error.
      throw new Error(`Command failed: ${cmd}\nfatal: could not read from https://oauth2:${TOKEN}@gitlab.com/group/repo.git`);
    });

    const res = JSON.parse(await gitlabSkill.handleToolCall('gitlab_clone', {
      projectPath: 'group/repo',
      destination: tmp,
    }));

    expect(res.error).toBeTruthy();
    expect(res.error).not.toContain(TOKEN);
    expect(res.error).not.toMatch(/oauth2:[^*]/); // no live userinfo
  });
});

describe('github_clone error redaction', () => {
  it('never echoes the token or x-access-token URL userinfo on failure', async () => {
    const TOKEN = 'ghs_SUPERSECRET456';
    // github_clone resolves its token via resolveIntegrationToken('github');
    // mock the backend-client so no network/creds are needed.
    vi.doMock('@zibby/core/backend-client.js', () => ({
      resolveIntegrationToken: async () => ({ token: TOKEN }),
    }));
    vi.resetModules();
    const { githubSkill: gh } = await import('../src/github.js');

    execSyncMock.mockImplementation((cmd) => {
      throw new Error(`Command failed: ${cmd}\nremote: Repository not found for https://x-access-token:${TOKEN}@github.com/o/r.git`);
    });

    const res = JSON.parse(await gh.handleToolCall('github_clone', {
      owner: 'o',
      repo: 'r',
      destination: tmp,
    }));

    expect(res.error).toBeTruthy();
    expect(res.error).not.toContain(TOKEN);
    expect(res.error).not.toMatch(/x-access-token:[^*]/);
  });
});
