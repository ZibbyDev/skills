// PlatformTokenStore — the token store backed by the platform's Stores-v2
// `sqlite` store instead of a private file in this container.
//
// The datasets API answers POSITIONALLY (`{columns:[…], rows:[[…]]}`). Reading a
// row as if it were an object returns `undefined` for EVERY column, which does
// not throw — it looks exactly like "this user was never authorized", forever.
// That silent shape mismatch shipped once; these tests are its tripwire.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PlatformTokenStore } from '../src/platform-store.js';

const KEY = Buffer.alloc(32, 7);

/**
 * A stand-in datasets API over an in-memory table. Deliberately answers in the
 * REAL positional shape so a regression to object-row reads fails here.
 */
function fakeApi() {
  const table = new Map();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const { sql, params = [] } = JSON.parse(init.body);
    calls.push({ url: String(url), sql, params });
    if (/^CREATE TABLE/i.test(sql)) return json({ ok: true, columns: [], rows: [] });
    if (/^INSERT/i.test(sql)) {
      const [mcp, acc, ref, exp, granted, created, uid, appId, extra] = params;
      table.set(mcp, {
        mcp_token: mcp,
        access_token_enc: acc,
        refresh_token_enc: ref,
        expires_at: exp,
        granted_at: granted,
        created_at: created,
        pingcode_user_id: uid,
        pingcode_app_id: appId,
        extra_json: extra,
      });
      return json({ ok: true, columns: [], rows: [] });
    }
    if (/^DELETE/i.test(sql)) {
      table.delete(params[0]);
      return json({ ok: true, columns: [], rows: [] });
    }
    // SELECT — positional, exactly like the real API.
    const row = table.get(params[0]);
    const columns = [
      'mcp_token', 'access_token_enc', 'refresh_token_enc', 'expires_at',
      'granted_at', 'created_at', 'pingcode_user_id', 'pingcode_app_id', 'extra_json',
    ];
    return json({
      ok: true,
      columns,
      rows: row ? [columns.map((c) => row[c] ?? null)] : [],
    });
  };
  return {
    calls,
    table,
    restore() { globalThis.fetch = originalFetch; },
  };
}

const json = (body) => ({ ok: true, status: 200, json: async () => body });

const store = (storeId = 'store_abc') => new PlatformTokenStore({
  apiBase: 'http://control-plane:3001',
  apiToken: 'zby_pat_test',
  storeId,
  key: KEY,
});

test('a slot round-trips through POSITIONAL rows, read back by column NAME', async () => {
  const api = fakeApi();
  try {
    const s = store();
    await s.set('mcp_a', {
      access_token: 'AT', refresh_token: 'RT', expires_at: 111,
      pingcode_user_id: 'u1', pingcode_app_id: 'app1', unknown_field: 'keep-me',
    });
    const got = await s.get('mcp_a');
    assert.equal(got.access_token, 'AT');
    assert.equal(got.refresh_token, 'RT');
    assert.equal(got.expires_at, 111);
    assert.equal(got.pingcode_app_id, 'app1');
    // Unknown fields survive, same as the file store.
    assert.equal(got.unknown_field, 'keep-me');
  } finally { api.restore(); }
});

test('credentials are CIPHERTEXT at rest — a store reader sees no token', async () => {
  const api = fakeApi();
  try {
    await store().set('mcp_b', { access_token: 'PLAINTEXT-CANARY', refresh_token: 'RT-CANARY' });
    const stored = JSON.stringify([...api.table.values()]);
    assert.ok(!stored.includes('PLAINTEXT-CANARY'), 'access token leaked in plaintext');
    assert.ok(!stored.includes('RT-CANARY'), 'refresh token leaked in plaintext');
    assert.match(api.table.get('mcp_b').access_token_enc, /^gcm1:/);
  } finally { api.restore(); }
});

test('a WRONG key cannot read a slot back', async () => {
  const api = fakeApi();
  try {
    await store().set('mcp_c', { access_token: 'AT' });
    const other = new PlatformTokenStore({
      apiBase: 'http://control-plane:3001', apiToken: 'zby_pat_test',
      storeId: 'store_abc', key: Buffer.alloc(32, 9),
    });
    await assert.rejects(() => other.get('mcp_c'), /TOKEN_STORE_KEY does not match/);
  } finally { api.restore(); }
});

test('delete removes the slot', async () => {
  const api = fakeApi();
  try {
    const s = store();
    await s.set('mcp_d', { access_token: 'AT' });
    await s.delete('mcp_d');
    assert.equal(await s.get('mcp_d'), null);
  } finally { api.restore(); }
});

test('each store id is addressed on its OWN store — two agents never share rows', async () => {
  const api = fakeApi();
  try {
    await store('store_one').set('mcp_e', { access_token: 'AT' });
    await store('store_two').get('mcp_e');
    const urls = api.calls.map((c) => c.url);
    assert.ok(urls.some((u) => u.includes('/datasets/stores/store_one/sql')));
    assert.ok(urls.some((u) => u.includes('/datasets/stores/store_two/sql')));
  } finally { api.restore(); }
});

test('a failed request never echoes the response body (it can carry row values)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false, status: 500, json: async () => ({ rows: [['secret-value']] }),
  });
  try {
    await assert.rejects(
      () => store().get('mcp_f'),
      (err) => /HTTP 500/.test(err.message) && !/secret-value/.test(err.message),
    );
  } finally { globalThis.fetch = originalFetch; }
});

test('the wiring is required — an absent store id/token is a loud constructor error', () => {
  assert.throws(() => new PlatformTokenStore({ apiBase: 'x', apiToken: 'y', key: KEY }), /storeId is required/);
  assert.throws(() => new PlatformTokenStore({ apiBase: 'x', storeId: 'z', key: KEY }), /apiToken is required/);
  assert.throws(() => new PlatformTokenStore({ apiToken: 'y', storeId: 'z', key: KEY }), /apiBase is required/);
});
