// PER-REQUEST TENANT CONFIG — one shared engine, N isolated tenants.
//
// What these tests pin down (CLAUDE.md north-star #9):
//   • the injected config actually REACHES the OAuth legs (it is not decoration),
//   • two agents' configs DO NOT BLEED into each other, even when their requests
//     interleave inside the same process (the AsyncLocalStorage guarantee),
//   • the app identity that started an authorization is the one the CALLBACK
//     exchanges against — carried on the existing nonce binding, not re-resolved
//     from whatever is ambient when PingCode redirects back,
//   • a slot is keyed by (USER, APP): a token minted under app A is refused under
//     app B, on both the MCP bearer path and the renew path,
//   • with nothing configured at all, /oauth/start fails CLOSED with a message an
//     operator can act on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakePc, startApp, startAuth, callback, configHeader, SIDECAR_CONFIG_HEADER } from './helpers.js';
import { appIdFor } from '../src/app-config.js';

const APP_A = {
  PINGCODE_CLIENT_ID: 'client-A',
  PINGCODE_CLIENT_SECRET: 'secret-A',
  PINGCODE_REST_ROOT: 'https://a.pingcode.test/open',
  PINGCODE_AUTH_ROOT: 'https://a.pingcode.test',
};
const APP_B = {
  PINGCODE_CLIENT_ID: 'client-B',
  PINGCODE_CLIENT_SECRET: 'secret-B',
  PINGCODE_REST_ROOT: 'https://b.pingcode.test/open',
  PINGCODE_AUTH_ROOT: 'https://b.pingcode.test',
};

// A pc double with NO built-in app config: everything must arrive per request.
const bareP = (opts = {}) => fakePc({ app: {}, ...opts });

// ── the injection reaches the engine ──────────────────────────────
test('injected config reaches /oauth/start — the authorize URL uses THAT app', async (t) => {
  const h = await startApp(bareP());
  t.after(h.close);

  const { res, authorizeCall } = await startAuth(h, { config: APP_B });
  assert.equal(res.status, 302);
  assert.equal(authorizeCall.clientId, 'client-B');
  assert.match(res.headers.get('location'), /^https:\/\/b\.pingcode\.test\/oauth2\/authorize\?/);
});

test('with NO config anywhere, /oauth/start fails CLOSED with an actionable message', async (t) => {
  const h = await startApp(bareP());
  t.after(h.close);

  const res = await fetch(`${h.base}/oauth/start`, { redirect: 'manual' });
  assert.equal(res.status, 503);
  const body = await res.text();
  assert.match(body, /No PingCode app configured/);
  assert.match(body, /PINGCODE_CLIENT_ID/, 'names the missing key');
  assert.match(body, /Env/, 'points at the agent Env tab, where the value belongs');
  assert.equal(h.pc.authorizeCalls.length, 0, 'nothing was sent to PingCode');
});

test('a malformed config header degrades to the fallback rather than 500ing', async (t) => {
  const h = await startApp(fakePc()); // has a built-in fallback app
  t.after(h.close);

  const res = await fetch(`${h.base}/oauth/start`, {
    headers: { [SIDECAR_CONFIG_HEADER]: 'not-base64-json!!' },
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.equal(h.pc.authorizeCalls.at(-1).clientId, 'client-A', 'fell back, did not crash');
});

// ── no cross-tenant bleed, under real interleaving ────────────────
test('two agents\' configs DO NOT BLEED across concurrent, interleaved requests', async (t) => {
  // Both callbacks are in flight at once: the FIRST exchange is held open until
  // the SECOND has entered its own exchange, so the two async flows are provably
  // interleaved inside the same process. Each must still see its OWN app.
  let releaseFirst;
  const firstEntered = new Promise((r) => { releaseFirst = r; });
  let secondEntered;
  const secondIn = new Promise((r) => { secondEntered = r; });

  const pc = bareP();
  const realExchange = pc.exchangeCode.bind(pc);
  let n = 0;
  pc.exchangeCode = async (code, opts) => {
    const mine = ++n;
    if (mine === 1) { releaseFirst(); await secondIn; }
    else { await firstEntered; secondEntered(); }
    return realExchange(code, opts);
  };

  const h = await startApp(pc);
  t.after(h.close);

  const a = await startAuth(h, { config: APP_A });
  const b = await startAuth(h, { config: APP_B });
  assert.equal(a.authorizeCall.clientId, 'client-A');
  assert.equal(b.authorizeCall.clientId, 'client-B');

  const [ra, rb] = await Promise.all([
    callback(h, { cookie: a.nonce, code: 'code-a', config: APP_A }),
    callback(h, { cookie: b.nonce, code: 'code-b', config: APP_B }),
  ]);
  assert.equal(ra.res.status, 200);
  assert.equal(rb.res.status, 200);

  const byCode = Object.fromEntries(pc.exchangeCalls.map((c) => [c.code, c.clientId]));
  assert.equal(byCode['code-a'], 'client-A', "A's exchange used A's app");
  assert.equal(byCode['code-b'], 'client-B', "B's exchange used B's app");

  // …and each minted slot is stamped with ITS OWN app.
  const stamps = pc.saveCalls.map((s) => s.tokens.pingcode_app_id).sort();
  assert.deepEqual(stamps, [appIdFor('client-A'), appIdFor('client-B')].sort());
});

// ── the redirect round-trip carries the app identity ──────────────
test('the CALLBACK exchanges against the app that STARTED the flow, not the ambient one', async (t) => {
  // PingCode's redirect carries no agent hint, so the callback may arrive with a
  // different injected config (or none). The nonce binding must decide.
  const pc = bareP();
  const h = await startApp(pc);
  t.after(h.close);

  const { nonce } = await startAuth(h, { config: APP_A });
  // Deliberately inject the WRONG app on the callback leg.
  const { res } = await callback(h, { cookie: nonce, code: 'code-x', config: APP_B });

  assert.equal(res.status, 200);
  assert.equal(pc.exchangeCalls.at(-1).clientId, 'client-A', 'bound to the STARTING app');
  assert.equal(pc.saveCalls.at(-1).tokens.pingcode_app_id, appIdFor('client-A'));
});

test('the callback still works when the callback leg carries NO config at all', async (t) => {
  const pc = bareP();
  const h = await startApp(pc);
  t.after(h.close);

  const { nonce } = await startAuth(h, { config: APP_A });
  const { res } = await callback(h, { cookie: nonce, code: 'code-y' }); // no header
  assert.equal(res.status, 200);
  assert.equal(pc.exchangeCalls.at(-1).clientId, 'client-A');
});

// ── slots are keyed by (USER, APP) ────────────────────────────────
test('a token minted under app A is REFUSED under app B (MCP bearer path)', async (t) => {
  const pc = bareP();
  const h = await startApp(pc);
  t.after(h.close);

  const { nonce } = await startAuth(h, { config: APP_A });
  const { body } = await callback(h, { cookie: nonce, code: 'code-1', config: APP_A });
  const mcpToken = /mcp_[0-9a-f]{64}/.exec(body)[0];

  // Same token, request running under app A → accepted (401 would mean unknown).
  const okRes = await fetch(`${h.base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${mcpToken}`,
      [SIDECAR_CONFIG_HEADER]: configHeader(APP_A),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  assert.notEqual(okRes.status, 401, 'the token is valid under its own app');
  assert.notEqual(okRes.status, 403);

  // Same token, request running under app B → REFUSED, and distinctly so.
  const badRes = await fetch(`${h.base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${mcpToken}`,
      [SIDECAR_CONFIG_HEADER]: configHeader(APP_B),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  assert.equal(badRes.status, 403);
  assert.match((await badRes.json()).error, /different PingCode app/);
});

test('renew under the WRONG app is refused with its own message', async (t) => {
  const pc = bareP();
  const h = await startApp(pc);
  t.after(h.close);

  const { nonce } = await startAuth(h, { config: APP_A });
  const { body } = await callback(h, { cookie: nonce, code: 'code-1', config: APP_A });
  const mcpToken = /mcp_[0-9a-f]{64}/.exec(body)[0];

  const res = await fetch(`${h.base}/oauth/start?renew=${mcpToken}`, {
    headers: { [SIDECAR_CONFIG_HEADER]: configHeader(APP_B) },
    redirect: 'manual',
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /belongs to a different PingCode app/);
});

// ── the emitted MCP URL stays resolvable on a multi-agent box ─────
test('the success page emits an MCP URL carrying the agent handle when one was injected', async (t) => {
  const h = await startApp(bareP());
  t.after(h.close);

  const { nonce } = await startAuth(h, { config: APP_A, agent: 'wf-uuid-123' });
  const { body } = await callback(h, { cookie: nonce, config: APP_A });
  assert.match(body, /\/mcp\?agent=wf-uuid-123/);
});

test('with no agent handle the MCP URL is byte-identical to before', async (t) => {
  const h = await startApp(bareP());
  t.after(h.close);

  const { nonce } = await startAuth(h, { config: APP_A });
  const { body } = await callback(h, { cookie: nonce, config: APP_A });
  assert.match(body, /http:\/\/mcp\.example\.test\/mcp\b/);
  assert.doesNotMatch(body, /\/mcp\?agent=/);
});
