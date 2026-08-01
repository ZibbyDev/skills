/**
 * The env a provider skill hands its spawned MCP child.
 *
 * `resolve()` builds the child's env by copying ONLY the keys in `envKeys` —
 * that list is the child's ENTIRE environment, not an addition to it. A key the
 * child's auth needs but the list omits is simply absent there.
 *
 * That is what broke cloud GitHub reviews: the child got GITHUB_TOKEN, but
 * `resolveIntegrationToken()`'s CLOUD path does not read GITHUB_TOKEN (that is
 * the ZIBBY_SELF_HOST fast path) — it calls Zibby's backend using
 * PROJECT_API_TOKEN. With none in the child, every mcp__github__* call failed
 * with "No session token. Run `zibby login` first." — reads and writes alike —
 * while the template's node-side ghFetch (same process as the run, full env)
 * kept working, which disguised it as a write-permission problem.
 */
import { describe, it, expect } from 'vitest';
import { githubSkill } from '../github';
import { gitlabSkill } from '../gitlab';

// What the cloud auth path reads: the credential, plus the API-base resolution
// (backend-client getAccountApiUrl → ZIBBY_ACCOUNT_API_URL / ZIBBY_ENV).
const CLOUD_AUTH_KEYS = ['PROJECT_API_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_ENV'];

describe.each([
  ['github', githubSkill, 'GITHUB_TOKEN'],
  ['gitlab', gitlabSkill, 'GITLAB_TOKEN'],
])('%s skill MCP child env', (_name, skill: any, providerKey) => {
  it('declares the keys the CLOUD auth path needs', () => {
    for (const k of CLOUD_AUTH_KEYS) expect(skill.envKeys).toContain(k);
  });

  it('still declares the self-host provider token', () => {
    expect(skill.envKeys).toContain(providerKey);
  });

  it('passes those through to the child when set', () => {
    const saved = { ...process.env };
    try {
      process.env[providerKey] = 'provider-token';
      process.env.PROJECT_API_TOKEN = 'zby_pat_runscoped';
      process.env.ZIBBY_ACCOUNT_API_URL = 'https://api-prod.zibby.app';
      const { env } = skill.resolve();
      expect(env[providerKey]).toBe('provider-token');
      expect(env.PROJECT_API_TOKEN).toBe('zby_pat_runscoped');
      expect(env.ZIBBY_ACCOUNT_API_URL).toBe('https://api-prod.zibby.app');
    } finally {
      process.env = saved;
    }
  });

  it('copies ONLY declared keys — the child never gets the whole run env', () => {
    const saved = { ...process.env };
    try {
      process.env[providerKey] = 't';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-must-not-leak';
      process.env.AWS_SECRET_ACCESS_KEY = 'must-not-leak';
      const { env } = skill.resolve();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    } finally {
      process.env = saved;
    }
  });
});
