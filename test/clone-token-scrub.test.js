import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scrubClonedRemoteSync, gitSkill } from '../src/git.js';

/**
 * SECURITY (CLAUDE.md §5) — on-disk token residual. The clone tools bake an
 * authenticated remote URL (`x-access-token:<tok>@github.com`) into the cloned
 * repo's `.git/config`. A Fargate agent then reads UNTRUSTED PR/issue content
 * with Bash and could `cat .git/config` / `git remote -v` to exfiltrate the
 * tenant token. These REAL-git tests prove the token is stripped from the
 * repo's on-disk git state after cloning, while clone (and re-pull) still work.
 */

const TOKEN = 'ghp_SUPERSECRETtoken0123456789';

let tmp;
let source;

function git(args, cwd) {
  return execSync(`git ${args}`, { cwd, stdio: 'pipe', encoding: 'utf-8' });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'clone-scrub-'));
  source = join(tmp, 'source');
  execSync(`mkdir -p "${source}"`);
  git('init -q', source);
  git('config user.email t@t.co', source);
  git('config user.name t', source);
  writeFileSync(join(source, 'README.md'), '# fixture\n');
  git('add -A', source);
  git('commit -q -m init', source);
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITLAB_TOKEN;
  delete process.env.GITLAB_URL;
});

describe('scrubClonedRemoteSync (skills, real git)', () => {
  it('strips a baked token from .git/config, leaving a tokenless origin', () => {
    const clone = join(tmp, 'clone');
    git(`clone -q "${source}" "${clone}"`, tmp);
    const authOrigin = `https://x-access-token:${TOKEN}@github.com/acme/api.git`;
    git(`remote set-url origin "${authOrigin}"`, clone);
    expect(readFileSync(join(clone, '.git', 'config'), 'utf-8')).toContain(TOKEN); // reproduced

    scrubClonedRemoteSync(execSync, clone, 'https://github.com/acme/api.git', TOKEN, 'test');

    const cfg = readFileSync(join(clone, '.git', 'config'), 'utf-8');
    expect(cfg).not.toContain(TOKEN);
    expect(cfg).not.toContain('x-access-token');
    expect(git('remote -v', clone)).not.toContain(TOKEN);
    expect(git('remote get-url origin', clone).trim()).toBe('https://github.com/acme/api.git');
  });
});

describe('git_checkout (real git, local fixture)', () => {
  const ctx = () => ({ options: { workspace: tmp } });

  it('clones a repo and leaves NO token/userinfo in .git/config', async () => {
    const fileUrl = pathToFileURL(source).href; // file:///…/source
    const res = JSON.parse(await gitSkill.handleToolCall('git_checkout', {
      url: fileUrl, name: 'x', shallow: false,
    }, ctx()));

    expect(res.action).toBe('cloned');
    const cfg = readFileSync(join(tmp, '.zibby', 'repos', 'x', '.git', 'config'), 'utf-8');
    expect(cfg).not.toContain('x-access-token');
    expect(cfg).not.toContain('oauth2:');
    // origin is the plain (tokenless) URL we cloned from
    const origin = git('remote get-url origin', join(tmp, '.zibby', 'repos', 'x')).trim();
    expect(origin).toBe(fileUrl);
  });

  it('re-pull path fetches new commits WITHOUT relying on a token in origin', async () => {
    const fileUrl = pathToFileURL(source).href;
    await gitSkill.handleToolCall('git_checkout', { url: fileUrl, name: 'x', shallow: false }, ctx());

    // Advance the source repo.
    writeFileSync(join(source, 'NEW.md'), 'second\n');
    git('add -A', source);
    git('commit -q -m second', source);

    const res = JSON.parse(await gitSkill.handleToolCall('git_checkout', {
      url: fileUrl, name: 'x', shallow: false,
    }, ctx()));

    expect(res.action).toBe('updated');
    expect(res.head).toContain('second');
    // still no token anywhere in the repo git state
    const cfg = readFileSync(join(tmp, '.zibby', 'repos', 'x', '.git', 'config'), 'utf-8');
    expect(cfg).not.toContain('x-access-token');
  });
});
