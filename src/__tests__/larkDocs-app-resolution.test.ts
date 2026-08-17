/**
 * Lark Docs auth resolution — the DOCS app, not the CHAT app.
 *
 * THE BUG THIS PINS (reproduced on two boxes, 2026-08-12)
 * ──────────────────────────────────────────────────────
 * The platform grew a dedicated Lark Docs app: its own `lark_docs` integration
 * row + connect/disconnect (backend handlers/lark.js), its own card (labelled
 * "Lark Docs" then, "Lark App" since — the id never moved),
 * its own LARK_DOCS_* injection (workflow-executor), and its own DECLARATION
 * (`skill-integrations.js` maps skill `lark-docs` → provider `lark_docs`).
 * This skill's auth chokepoint never moved: it asked
 * `resolveIntegrationToken('lark')`, the CHAT provider.
 *
 * The failure mode is the nasty one — an account with the docs app connected and
 * the chat app NOT connected passed every gate (green "Lark Docs · Connected"
 * card, green per-agent toggle, deploy allowed) and then died at CALL time with
 * `lark is not connected`. Two places that had to agree, nothing screaming when
 * they drifted (CLAUDE.md TWO-PLACES RULE). Its backend twin is pinned in
 * backend/src/handlers/__tests__/integration-tokens.test.js.
 *
 * Properties pinned here:
 *   - LARK_DOCS_* env wins (the docs app the executor injected)
 *   - LARK_* env is the single-app fallback, unchanged behaviour for one-app orgs
 *   - with no env, the backend is asked for `lark_docs` — NEVER bare `lark`
 *   - an OLD backend answering 400 "Unknown provider" retries the chat provider,
 *     and NO other error is swallowed by that retry
 *   - requiresIntegration accepts either app (an array = "any one")
 *   - TRIPWIRE: envKeys covers every process.env.LARK* the module reads
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGINAL = { ...process.env };
const AUTH_PATH = '/open-apis/auth/v3/tenant_access_token/internal';

const resolveIntegrationToken = vi.fn();
vi.mock('@zibby/core/backend-client.js', () => ({
  resolveIntegrationToken: (...args: any[]) => resolveIntegrationToken(...args),
}));

/**
 * Drive ONE doc read and report the app credential the skill minted its tenant
 * token from. Uses a fresh module instance so the module-level token cache
 * (keyed by appId) can never leak an earlier test's app into this one.
 */
async function mintedWith(): Promise<{ url: string; appId: string; appSecret: string } | null> {
  vi.resetModules();
  let minted: any = null;
  vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
    const u = String(url);
    if (u.includes(AUTH_PATH)) {
      const body = JSON.parse(init.body);
      minted = { url: u, appId: body.app_id, appSecret: body.app_secret };
      return { json: async () => ({ code: 0, tenant_access_token: 't-abc' }) };
    }
    return { json: async () => ({ code: 0, data: { document: { title: 'T' } } }) };
  }));
  const { larkDocsSkill } = await import('../larkDocs.js');
  await larkDocsSkill.handleToolCall('larkdoc_get', { documentId: 'DocumentTokenAAAA' });
  return minted;
}

beforeEach(() => {
  resolveIntegrationToken.mockReset();
  for (const k of Object.keys(process.env)) if (k.startsWith('LARK')) delete process.env[k];
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL };
});

describe('Lark Docs app resolution', () => {
  test('LARK_DOCS_* env wins — the dedicated docs app the executor injected', async () => {
    process.env.LARK_DOCS_APP_ID = 'cli_docs';
    process.env.LARK_DOCS_APP_SECRET = 'docs-secret';
    process.env.LARK_DOCS_HOST = 'https://open.feishu.cn';
    process.env.LARK_APP_ID = 'cli_chat';
    process.env.LARK_APP_SECRET = 'chat-secret';

    const minted = await mintedWith();
    expect(minted?.appId).toBe('cli_docs');
    expect(minted?.appSecret).toBe('docs-secret');
    expect(minted?.url.startsWith('https://open.feishu.cn')).toBe(true);
    // Env satisfied it — no backend round-trip at all.
    expect(resolveIntegrationToken).not.toHaveBeenCalled();
  });

  test('LARK_* env is the single-app fallback (one Lark app carrying both scopes)', async () => {
    process.env.LARK_APP_ID = 'cli_chat';
    process.env.LARK_APP_SECRET = 'chat-secret';

    const minted = await mintedWith();
    expect(minted?.appId).toBe('cli_chat');
    // No host env → the documented default origin, absolute so `${host}/...` works.
    expect(minted?.url.startsWith('https://open.larksuite.com')).toBe(true);
  });

  test('a host without a scheme is still an absolute origin', async () => {
    process.env.LARK_DOCS_APP_ID = 'cli_docs';
    process.env.LARK_DOCS_APP_SECRET = 'docs-secret';
    process.env.LARK_DOCS_HOST = 'open.feishu.cn/';

    const minted = await mintedWith();
    expect(minted?.url).toBe(`https://open.feishu.cn${AUTH_PATH}`);
  });

  test('with no env it asks the backend for lark_docs — never bare lark', async () => {
    resolveIntegrationToken.mockResolvedValue({
      appId: 'cli_from_backend', appSecret: 's', host: 'https://open.larksuite.com',
    });

    const minted = await mintedWith();
    const asked = resolveIntegrationToken.mock.calls.map((c) => c[0]);
    expect(asked).toContain('lark_docs');
    expect(asked).not.toContain('lark');
    expect(minted?.appId).toBe('cli_from_backend');
  });

  test('an OLD backend (400 Unknown provider) falls back to the chat provider', async () => {
    resolveIntegrationToken.mockImplementation(async (provider: string) => {
      if (provider === 'lark_docs') {
        throw new Error('Failed to resolve lark_docs token (400): {"error":"Unknown provider: lark_docs"}');
      }
      return { appId: 'cli_chat', appSecret: 's', host: 'https://open.larksuite.com' };
    });

    const minted = await mintedWith();
    // Docs FIRST, chat only after the old backend disowned the provider.
    expect(resolveIntegrationToken.mock.calls.map((c) => c[0]).slice(0, 2)).toEqual(['lark_docs', 'lark']);
    expect(minted?.appId).toBe('cli_chat');
  });

  test('any OTHER backend failure is NOT swallowed by that retry', async () => {
    resolveIntegrationToken.mockRejectedValue(new Error('lark_docs is not connected. Connect it at …'));

    const minted = await mintedWith();
    // The chat provider is NEVER tried, and no token was minted — a real
    // "not connected" must surface, not be re-asked as a different provider.
    expect(resolveIntegrationToken.mock.calls.map((c) => c[0])).not.toContain('lark');
    expect(minted).toBeNull();
  });
});

describe('Lark Docs declaration', () => {
  test('requiresIntegration accepts EITHER app, docs app first', async () => {
    vi.resetModules();
    const { larkDocsSkill } = await import('../larkDocs.js');
    // An array means "any ONE of these" to both availability gates
    // (agent-workflow strategy-registry.ts + core strategies/index.js), so a
    // docs-app-only account keeps the prompt fragment it used to lose.
    expect(larkDocsSkill.requiresIntegration).toEqual(['lark_docs', 'lark']);
  });

  test('TRIPWIRE: envKeys lists every process.env.LARK* the resolution reads', async () => {
    vi.resetModules();
    const { larkDocsSkill } = await import('../larkDocs.js');
    // The app-credential resolution moved to the SHARED larkApp.ts (one decider
    // for every tenant-wide Lark reader: docs + attendance), so the reader-side
    // scan must follow it there — scanning larkDocs.ts alone would now match
    // nothing and pass vacuously. Both files are read so the tripwire keeps
    // working whichever side a future env name is added on.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = ['larkDocs.ts', 'larkApp.ts']
      .map((f) => readFileSync(join(here, '..', f), 'utf8'))
      .join('\n');
    const read = new Set(Array.from(src.matchAll(/\bLARK[A-Z0-9_]*\b/g), (m) => m[0])
      .filter((n) => /^LARK(_DOCS)?_(APP_ID|APP_SECRET|HOST)$/.test(n)));
    expect(read.size).toBeGreaterThan(0);
    for (const key of read) {
      // envKeys IS the spawned MCP child's ENTIRE environment — a key the module
      // reads but does not declare is simply absent there, and the failure shows
      // up as a confusing auth error rather than a missing-env one.
      expect(larkDocsSkill.envKeys).toContain(key);
    }
    // The backend-session half must survive too (the child pays a round-trip
    // whenever no app env was injected — e.g. every Copilot turn).
    for (const key of ['PROJECT_API_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_ENV']) {
      expect(larkDocsSkill.envKeys).toContain(key);
    }
  });
});
