import { describe, it, expect } from 'vitest';
import { isHttpsHost, withCredentials } from '../git.js';

/**
 * git_checkout takes a MODEL-CHOSEN `url` and splices a VCS token into it. The
 * host must therefore be PARSED, never substring-matched: the old
 * `url.includes('github.com')` accepted
 *   https://github.com@attacker.example/x.git
 * and the subsequent string replace produced
 *   https://x-access-token:<TOKEN>@github.com@attacker.example/x.git
 * whose real authority is what follows the LAST '@' — so git sent the tenant's
 * GitHub token to attacker.example as basic auth. This skill is reachable from
 * agents that read untrusted third-party content (code-fix, gitlab-kb-sync,
 * agent-builder), so that argument is attacker-influenceable.
 */
describe('git auth-url host validation', () => {
  const TOKEN = 'ghs_TESTTOKEN0123456789';

  describe('isHttpsHost — accepts', () => {
    it('the exact host over https', () => {
      expect(isHttpsHost('https://github.com/org/repo.git', 'github.com')).toBe(true);
    });

    it('a differently-cased host (DNS is case-insensitive)', () => {
      expect(isHttpsHost('https://GitHub.COM/org/repo.git', 'github.com')).toBe(true);
    });

    it('a self-managed GitLab host', () => {
      expect(isHttpsHost('https://git.acme.internal/team/app.git', 'git.acme.internal')).toBe(true);
    });
  });

  describe('isHttpsHost — refuses', () => {
    it.each([
      ['userinfo trick (the real host is after the last @)', 'https://github.com@attacker.example/x.git'],
      ['suffix domain',                                      'https://github.com.attacker.example/x.git'],
      ['host appearing only in the path',                    'https://attacker.example/github.com/x.git'],
      ['host appearing only in a query string',              'https://attacker.example/x.git?u=github.com'],
      ['prefix domain',                                      'https://notgithub.com/org/repo.git'],
      ['plain http (a token must never go over http)',        'http://github.com/org/repo.git'],
      ['ssh scheme',                                          'ssh://github.com/org/repo.git'],
      ['git scheme',                                          'git://github.com/org/repo.git'],
      ['not a URL at all',                                    'org/repo'],
      ['empty string',                                        ''],
    ])('%s', (_label, url) => {
      expect(isHttpsHost(url as string, 'github.com')).toBe(false);
    });
  });

  describe('withCredentials', () => {
    it('attaches credentials without changing the authority', () => {
      const out = withCredentials('https://github.com/org/repo.git', 'x-access-token', TOKEN);
      expect(new URL(out).host).toBe('github.com');
      expect(out).toContain(TOKEN);
      expect(out).toContain('x-access-token');
    });

    it('keeps the path intact', () => {
      const out = withCredentials('https://github.com/org/repo.git', 'x-access-token', TOKEN);
      expect(new URL(out).pathname).toBe('/org/repo.git');
    });

    it('does not mangle a real token (percent-encoding is a no-op for VCS token charsets)', () => {
      // Redaction elsewhere in this file splits on the RAW token value, so the
      // encoded form must equal the raw form for real tokens or error messages
      // would stop being redacted.
      for (const t of ['ghs_abc123', 'ghp_ABC-123_xyz', 'glpat-AbC_123-xyz']) {
        expect(withCredentials('https://github.com/o/r.git', 'x-access-token', t)).toContain(t);
      }
    });
  });

  it('END TO END: the attack URL gets no credentials attached', () => {
    const attack = 'https://github.com@attacker.example/x.git';
    // This mirrors the call site: credentials are attached ONLY when the host
    // check passes.
    const authUrl = isHttpsHost(attack, 'github.com')
      ? withCredentials(attack, 'x-access-token', TOKEN)
      : attack;
    expect(authUrl).toBe(attack);
    expect(authUrl).not.toContain(TOKEN);
  });
});
