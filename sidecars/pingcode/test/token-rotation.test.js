// TOKEN ROTATION — the platform credential is PER-REQUEST, never pinned.
//
// The control-plane injects a short-lived `zby_run_v1.` PROJECT_API_TOKEN that
// rotates every ~15 minutes, while this sidecar is `warm: true` (the process
// lives indefinitely). Before 0.2.3, resolveTokenStore cached the
// PlatformTokenStore by storeId alone with the token frozen at construction —
// the FIRST request's token was used for every later request forever, so once
// it expired every MCP call 401'd until the box restarted. Each test here FAILS
// under that cache and pins the fix (north-star #9: a per-request secret is
// never container-global state).

import test from 'node:test';
import assert from 'node:assert/strict';

// resolveTokenStore builds the store key via loadTokenStoreKey(), which reads
// this env var. Set it BEFORE importing the modules under test.
process.env.TOKEN_STORE_KEY = 'ab'.repeat(32); // 64 hex chars = 32 bytes

const { PingCodeOAuth } = await import('../src/pingcode.js');
const { withAppConfig } = await import('../src/app-config.js');
const { PlatformTokenStore } = await import('../src/platform-store.js');

/** The per-request config bag the control-plane would inject. */
const cfg = (token, storeId) => ({
  ZIBBY_API_BASE: 'http://control-plane:3001',
  PROJECT_API_TOKEN: token,
  ZIBBY_STORE__oauth_tokens: storeId,
});

/** Capture every Authorization header the store sends to the datasets API. */
function captureFetch({ failWhile } = {}) {
  const auths = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    auths.push((init && init.headers && init.headers.Authorization) || '');
    if (failWhile && failWhile()) {
      return { ok: false, status: 401, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ columns: [], rows: [] }) };
  };
  return { auths, restore: () => { globalThis.fetch = original; } };
}

test('two requests with different tokens do NOT share a pinned credential', async () => {
  const f = captureFetch();
  try {
    const pc = new PingCodeOAuth({ tokenStorePath: '/tmp/unused-token-rotation.db' });
    // Same store, two requests, two tokens — exactly what a warm container
    // sees across a run-scoped-token rotation.
    await withAppConfig(cfg('run-token-FIRST', 'store_rotation'), () => pc.store.get('mcp_x'));
    await withAppConfig(cfg('run-token-SECOND', 'store_rotation'), () => pc.store.get('mcp_x'));
    assert.equal(
      f.auths.at(-1), 'Bearer run-token-SECOND',
      `the SECOND request's token must reach the wire (pinned-first-token bug); sent: ${f.auths.join(', ')}`,
    );
    // …and the first request used its own.
    assert.equal(f.auths[0], 'Bearer run-token-FIRST');
  } finally { f.restore(); }
});

test('a failed table-create under a dead token is NOT memoized — the next request recovers', async () => {
  let failing = true;
  const f = captureFetch({ failWhile: () => failing });
  try {
    const pc = new PingCodeOAuth({ tokenStorePath: '/tmp/unused-token-rotation.db' });
    // First request arrives with an expired token: the CREATE fails, the call fails.
    await assert.rejects(
      () => withAppConfig(cfg('run-token-EXPIRED', 'store_recovery'), () => pc.store.get('mcp_y')),
      /HTTP 401/,
    );
    // The token rotates; the next request must succeed instead of replaying the
    // cached rejection forever.
    failing = false;
    const got = await withAppConfig(cfg('run-token-FRESH', 'store_recovery'), () => pc.store.get('mcp_y'));
    assert.equal(got, null, 'the call went through (empty result set)');
    assert.equal(f.auths.at(-1), 'Bearer run-token-FRESH');
  } finally { f.restore(); }
});

test('setApiToken refuses an empty credential', () => {
  const s = new PlatformTokenStore({
    apiBase: 'http://control-plane:3001', apiToken: 'zby_pat_test',
    storeId: 'store_z', key: Buffer.alloc(32, 7),
  });
  assert.throws(() => s.setApiToken(''), /apiToken is required/);
});
