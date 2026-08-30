/**
 * A Jira connection comes in TWO credential shapes, and `jiraFetch` is the ONE
 * place that turns either into a request.
 * ============================================================================
 *
 *   • OAuth      → `https://api.atlassian.com/ex/jira/<cloudId><path>`
 *                  + `Authorization: Bearer <accessToken>`
 *   • API token  → `<instanceUrl><path>`
 *                  + `Authorization: Basic base64(email:apiToken)`
 *
 * WHY THIS FILE EXISTS. A self-host Jira is `instanceUrl + email + API token`
 * (founder ruling: "seflshoted do not need oauth token is enough"). The backend
 * request layer was taught both shapes on 2026-08-22 (`handlers/jira.js
 * jiraApiCall`) and the board picker started listing the operator's real project
 * — but this run-time half still hard-coded the OAuth shape, so deploying that
 * agent died at its FIRST board read: `@zibby/core` threw
 * `Invalid jira token response: missing cloudId`, and with that guard removed
 * this file composed `https://api.atlassian.com/ex/jira/undefined/...`
 * (reproduced against the REAL api.atlassian.com → 404).
 *
 * THE THING THAT MUST NOT DRIFT — and the reason both branches are asserted on
 * the LITERAL url + header string rather than "whatever the helper returns":
 * an Atlassian API token is a Basic-auth PASSWORD, not a bearer. Measured
 * against the founder's instance the same day: instance URL + Basic → 200;
 * the identical token as `Bearer` → 403; `.../ex/jira/undefined/...` → 404.
 * One header cannot serve both. Swap Basic↔Bearer on either branch and these
 * go red naming the drift.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const resolveIntegrationToken = vi.fn();
vi.mock('@zibby/core/backend-client.js', () => ({
  resolveIntegrationToken: (p: string) => resolveIntegrationToken(p),
  clearTokenCache: vi.fn(),
}));

const { jiraFetch, jiraApiCall, resolveJiraCredential } = await import('../jira.js');

const B64_SELFHOST = 'Basic ' + Buffer.from('leo.c@zibby.dev:ATATT_api_token').toString('base64');

const JIRA_ENV = ['JIRA_API_TOKEN', 'JIRA_EMAIL', 'JIRA_BASE_URL', 'ATLASSIAN_INSTANCE_URL'];
const ORIG: Record<string, string | undefined> = {};

/** Capture the ONE request jiraFetch issues. Returns `{ url, headers }`. */
function captureRequest() {
  const seen: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: any, opts: any = {}) => {
    seen.push({ url: String(url), headers: opts.headers || {}, method: opts.method, body: opts.body });
    return { ok: true, status: 200, text: async () => '{"ok":true}' } as any;
  }));
  return seen;
}

beforeEach(() => {
  for (const k of JIRA_ENV) { ORIG[k] = process.env[k]; delete process.env[k]; }
  resolveIntegrationToken.mockReset();
});

afterEach(() => {
  for (const k of JIRA_ENV) {
    if (ORIG[k] === undefined) delete process.env[k]; else process.env[k] = ORIG[k]!;
  }
  vi.unstubAllGlobals();
});

// ── OAuth / cloud: byte-identical to what shipped before ───────────────────
describe('OAuth connection (cloudId) — the CLOUD path, byte-identical', () => {
  it('issues the exact api.atlassian.com URL and the exact Bearer header', async () => {
    resolveIntegrationToken.mockResolvedValue({ token: 'oauth_tok', cloudId: 'cloud-123' });
    const seen = captureRequest();

    await jiraFetch('/rest/api/3/project');

    expect(seen).toHaveLength(1);
    // LITERAL, not derived from the helper — this is the byte-identity assertion.
    expect(seen[0].url).toBe('https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/project');
    expect(seen[0].headers.Authorization).toBe('Bearer oauth_tok');
    expect(seen[0].headers.Accept).toBe('application/json');
    // NEVER Basic on this branch.
    expect(seen[0].headers.Authorization).not.toMatch(/^Basic /);
  });

  it('a POST still carries Content-Type and the JSON body', async () => {
    resolveIntegrationToken.mockResolvedValue({ token: 'oauth_tok', cloudId: 'cloud-123' });
    const seen = captureRequest();

    await jiraFetch('/rest/api/3/issue', { method: 'POST', body: { fields: { summary: 'x' } } });

    expect(seen[0].url).toBe('https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/issue');
    expect(seen[0].headers['Content-Type']).toBe('application/json');
    expect(seen[0].headers.Authorization).toBe('Bearer oauth_tok');
    expect(seen[0].body).toBe(JSON.stringify({ fields: { summary: 'x' } }));
  });

  it('an OAuth credential with no cloudId fails LOUD — never `/ex/jira/undefined/`', () => {
    expect(() => jiraApiCall({ authType: 'oauth', accessToken: 't' }, '/rest/api/3/project'))
      .toThrow(/cloudId: missing/);
  });

  it('the JIRA_* trio is INERT unless all three are set (cannot shadow OAuth)', async () => {
    process.env.JIRA_API_TOKEN = 'ATATT_half';
    process.env.JIRA_EMAIL = 'leo@example.com';
    // JIRA_BASE_URL deliberately absent → not a complete Basic credential.
    resolveIntegrationToken.mockResolvedValue({ token: 'oauth_tok', cloudId: 'cloud-123' });
    const seen = captureRequest();

    await jiraFetch('/rest/api/3/project');

    expect(seen[0].url).toBe('https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/project');
    expect(seen[0].headers.Authorization).toBe('Bearer oauth_tok');
  });
});

// ── API token / self-host: the shape that was broken ───────────────────────
describe('API-token connection (instance + email) — the SELF-HOST path', () => {
  const B64 = 'Basic ' + Buffer.from('leo.c@zibby.dev:ATATT_api_token').toString('base64');

  it('the injected JIRA_* trio addresses the instance with Basic — and never calls the backend', async () => {
    // Exactly what workflow-executor injects for an `authType:'token'` row.
    process.env.JIRA_API_TOKEN = 'ATATT_api_token';
    process.env.JIRA_EMAIL = 'leo.c@zibby.dev';
    process.env.JIRA_BASE_URL = 'https://zibby.atlassian.net';
    const seen = captureRequest();

    await jiraFetch('/rest/api/3/project');

    expect(seen[0].url).toBe('https://zibby.atlassian.net/rest/api/3/project');
    expect(seen[0].headers.Authorization).toBe(B64);
    // NEVER Bearer on this branch — the same instance answers 403 to that.
    expect(seen[0].headers.Authorization).not.toMatch(/^Bearer /);
    // The credential is complete on its own; nothing leaves the box.
    expect(resolveIntegrationToken).not.toHaveBeenCalled();
  });

  it('a trailing slash on the base URL does not double up', async () => {
    process.env.JIRA_API_TOKEN = 'ATATT_api_token';
    process.env.JIRA_EMAIL = 'leo.c@zibby.dev';
    process.env.JIRA_BASE_URL = 'https://zibby.atlassian.net//';
    const seen = captureRequest();

    await jiraFetch('/rest/api/3/project');

    expect(seen[0].url).toBe('https://zibby.atlassian.net/rest/api/3/project');
  });

  it('the backend payload with NO cloudId takes the Basic branch too', async () => {
    // VERBATIM the payload `curl http://localhost:13001/jira/token` returned on
    // the founder's box (2026-08-22) — token + instanceUrl, no cloudId, no email.
    resolveIntegrationToken.mockResolvedValue({
      token: 'ATATT_api_token', instanceUrl: 'https://zibby.atlassian.net',
    });
    process.env.JIRA_EMAIL = 'leo.c@zibby.dev'; // the one field /jira/token omits
    const seen = captureRequest();

    await jiraFetch('/rest/api/3/project');

    expect(seen[0].url).toBe('https://zibby.atlassian.net/rest/api/3/project');
    expect(seen[0].headers.Authorization).toBe(B64);
  });

  it('missing email fails LOUD naming JIRA_EMAIL — not a 403 from Atlassian', () => {
    expect(() => jiraApiCall(
      { authType: 'token', apiToken: 't', baseUrl: 'https://x.atlassian.net' },
      '/rest/api/3/project',
    )).toThrow(/JIRA_EMAIL/);
  });

  it('missing base URL fails LOUD naming JIRA_BASE_URL', () => {
    expect(() => jiraApiCall(
      { authType: 'token', apiToken: 't', email: 'a@b.c' },
      '/rest/api/3/project',
    )).toThrow(/JIRA_BASE_URL/);
  });

  it('missing token fails LOUD naming JIRA_API_TOKEN', () => {
    expect(() => jiraApiCall(
      { authType: 'token', email: 'a@b.c', baseUrl: 'https://x.atlassian.net' },
      '/rest/api/3/project',
    )).toThrow(/JIRA_API_TOKEN/);
  });
});

// ── The shape is chosen by the CREDENTIAL, never by the environment ────────
describe('resolveJiraCredential picks the shape from what the credential carries', () => {
  it('cloudId present → oauth, no env read', async () => {
    resolveIntegrationToken.mockResolvedValue({ token: 't', cloudId: 'c1' });
    await expect(resolveJiraCredential()).resolves.toEqual({
      authType: 'oauth', accessToken: 't', cloudId: 'c1',
    });
  });

  it('cloudId absent → token shape, instance taken from the payload', async () => {
    resolveIntegrationToken.mockResolvedValue({ token: 't', instanceUrl: 'https://i.example' });
    await expect(resolveJiraCredential()).resolves.toMatchObject({
      authType: 'token', apiToken: 't', baseUrl: 'https://i.example',
    });
  });

  // ── The resolver now carries the WHOLE token credential (2026-08-30) ─────
  // Until this date `/integrations/token/jira` answered a token connection with
  // {token, instanceUrl} and NOTHING ELSE, so the email — the Basic-auth
  // USERNAME, half the credential — had to come from JIRA_EMAIL in the env. Any
  // caller without that env died on "Jira token connection has no account
  // email", which is exactly what the Copilot's MCP child did on every call
  // while the dashboard showed the account address it was missing.
  //
  // TWO PLACES THAT MUST AGREE (CLAUDE.md): the emitter is
  // backend/src/handlers/integration-tokens.js `resolveJira`, the reader is
  // here. The payloads below are that response's shape — change one side and
  // these go red naming the field.
  it('authType:token + email + baseUrl from the resolver — NO env needed', async () => {
    resolveIntegrationToken.mockResolvedValue({
      provider: 'jira', authType: 'token', token: 'ATATT_api_token',
      email: 'leo.c@zibby.dev', baseUrl: 'https://zibby.atlassian.net',
      instanceUrl: 'https://zibby.atlassian.net',
    });
    const seen = captureRequest();

    await jiraFetch('/rest/api/3/project');

    expect(seen[0].url).toBe('https://zibby.atlassian.net/rest/api/3/project');
    expect(seen[0].headers.Authorization).toBe(B64_SELFHOST);
  });

  it('a DECLARED authType wins over guessing from cloudId', async () => {
    // A token row that also happens to carry a cloudId must NOT be read as
    // OAuth: the row said what it is, and inference is only the fallback.
    resolveIntegrationToken.mockResolvedValue({
      authType: 'token', token: 'ATATT_api_token', cloudId: 'stale-cloud-id',
      email: 'leo.c@zibby.dev', baseUrl: 'https://zibby.atlassian.net',
    });
    await expect(resolveJiraCredential()).resolves.toMatchObject({
      authType: 'token', email: 'leo.c@zibby.dev', baseUrl: 'https://zibby.atlassian.net',
    });
  });

  it('an OLD backend (no authType, no email) still resolves by inference', async () => {
    // The pre-2026-08-30 payload, verbatim. It stays readable — the inference is
    // a fallback, not a second opinion — it simply needs JIRA_EMAIL as before.
    resolveIntegrationToken.mockResolvedValue({
      token: 'ATATT_api_token', instanceUrl: 'https://zibby.atlassian.net',
    });
    await expect(resolveJiraCredential()).resolves.toMatchObject({
      authType: 'token', apiToken: 'ATATT_api_token', email: '',
    });
  });

  it('ZIBBY_SELF_HOST plays NO part in the choice', async () => {
    // Same credential, both flag states → identical shape. The decision is the
    // credential's, so a cloud token-connection works the day cloud offers one.
    resolveIntegrationToken.mockResolvedValue({ token: 't', cloudId: 'c1' });
    vi.stubEnv('ZIBBY_SELF_HOST', '1');
    const withFlag = await resolveJiraCredential();
    vi.stubEnv('ZIBBY_SELF_HOST', '');
    const without = await resolveJiraCredential();
    expect(withFlag).toEqual(without);
    vi.unstubAllEnvs();
  });
});
