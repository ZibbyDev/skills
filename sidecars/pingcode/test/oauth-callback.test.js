// OAuth start/callback security tests.
//
// These cover the two halves of the slot-hijack (confused deputy) fix:
//   (a) a renew is refused whenever the consenting PingCode identity cannot be
//       established — for BOUND and for LEGACY/UNBOUND slots alike;
//   (b) a callback must present the one-time nonce minted at /oauth/start.
//       There is no "newest pending entry" fallback any more.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakePc, startApp, startAuth, callback } from './helpers.js';
import { appIdFor } from '../src/app-config.js';

// The app the default fakePc runs under. Slots are keyed by (USER, APP), so an
// ordinary fixture carries the stamp a real slot would.
const APP_A = appIdFor('client-A');

const boundSlot = (userId) => ({
  access_token: 'old-at',
  refresh_token: 'old-rt',
  expires_at: 1,
  granted_at: 1,
  created_at: 1,
  pingcode_user_id: userId,
  pingcode_app_id: APP_A,
});

// ── /health + plumbing ────────────────────────────────────────────
test('health is 200', async (t) => {
  const h = await startApp(fakePc());
  t.after(h.close);
  const res = await fetch(`${h.base}/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'healthy');
});

test('/oauth/start mints a nonce, sets it as a cookie and sends it as state', async (t) => {
  const h = await startApp(fakePc());
  t.after(h.close);
  const { res, cookieNonce, authorizeCall } = await startAuth(h);
  assert.equal(res.status, 302);
  assert.ok(cookieNonce, 'a nonce cookie is set');
  assert.equal(authorizeCall.state, cookieNonce, 'state carries the same nonce');
  assert.equal(authorizeCall.redirectUri, 'http://mcp.example.test/oauth/callback');
  assert.equal(h.pending().size, 1);
});

test('/oauth/start?renew=<unknown> is refused and creates no pending entry', async (t) => {
  const h = await startApp(fakePc());
  t.after(h.close);
  const { res } = await startAuth(h, { renew: 'mcp_nope' });
  assert.equal(res.status, 400);
  assert.equal(h.pending().size, 0);
});

// ── happy paths ───────────────────────────────────────────────────
test('HAPPY: fresh authorization mints a slot bound to the PingCode identity', async (t) => {
  const h = await startApp(fakePc());
  t.after(h.close);
  const { nonce } = await startAuth(h);
  const { res, body } = await callback(h, { cookie: nonce });

  assert.equal(res.status, 200);
  assert.match(body, /PingCode 授权成功/);
  assert.equal(h.pc.saveCalls.length, 1);
  const { mcpToken, tokens } = h.pc.saveCalls[0];
  assert.match(mcpToken, /^mcp_[0-9a-f]{64}$/);
  assert.equal(tokens.pingcode_user_id, 'user-alice');
  assert.equal(tokens.access_token, 'at-code-1');
  assert.equal(h.pending().size, 0, 'pending entry consumed');
  // No unbindable-slot warning on the page when identity resolved.
  assert.doesNotMatch(body, /没有绑定 PingCode 身份/);
});

test('HAPPY: a legitimate renew keeps the MCP token and refreshes the slot', async (t) => {
  const pc = fakePc();
  pc.slots.set('mcp_alice', boundSlot('user-alice'));
  const h = await startApp(pc);
  t.after(h.close);

  const { nonce } = await startAuth(h, { renew: 'mcp_alice' });
  const { res, body } = await callback(h, { cookie: nonce, code: 'code-renew' });

  assert.equal(res.status, 200);
  assert.match(body, /重新授权完成/);
  assert.equal(pc.saveCalls.length, 1);
  assert.equal(pc.saveCalls[0].mcpToken, 'mcp_alice', 'same slot, MCP token unchanged');
  assert.equal(pc.slots.get('mcp_alice').access_token, 'at-code-renew');
  assert.equal(pc.slots.get('mcp_alice').pingcode_user_id, 'user-alice');
  assert.equal(pc.slots.get('mcp_alice').created_at, 1, 'pre-existing fields preserved');
});

test('a legacy UNBOUND slot is bound on renew when the identity IS resolvable', async (t) => {
  const pc = fakePc();
  pc.slots.set('mcp_legacy', { access_token: 'old-at', refresh_token: 'old-rt' });
  const h = await startApp(pc);
  t.after(h.close);

  const { nonce } = await startAuth(h, { renew: 'mcp_legacy' });
  const { res } = await callback(h, { cookie: nonce });

  assert.equal(res.status, 200);
  assert.equal(pc.slots.get('mcp_legacy').pingcode_user_id, 'user-alice');
});

// ── FIX 1(a): identity fail-closed ────────────────────────────────
test('RENEW REFUSED: no resolvable identity, LEGACY/UNBOUND slot (the fail-open hole)', async (t) => {
  // This is the exact default-config hole: an empty PINGCODE_SCOPE makes
  // GET /v1/myself 403 → identity null → the old code SKIPPED the check for an
  // unbound slot and wrote the tokens anyway.
  const pc = fakePc({ identity: { userId: null, error: 'GET /v1/myself → HTTP 403' } });
  // A genuinely LEGACY slot: minted before slots were keyed by (user, app), so
  // it carries no app stamp.
  const before = { access_token: 'old-at', refresh_token: 'old-rt' };
  pc.slots.set('mcp_legacy', { ...before });
  const h = await startApp(pc);
  t.after(h.close);

  const { nonce } = await startAuth(h, { renew: 'mcp_legacy' });
  const { res, body } = await callback(h, { cookie: nonce, code: 'attacker-code' });

  assert.equal(res.status, 403);
  assert.match(body, /无法确认授权者身份/);
  assert.match(body, /PINGCODE_SCOPE/, 'the error names the config that fixes it');
  assert.equal(pc.saveCalls.length, 0, 'NOTHING was written');
  // The TOKENS are untouched. The only thing that changed is the additive
  // (user, app) migration stamp applied when a legacy slot is first resolved —
  // it records the app that already owned it and grants nothing.
  assert.deepEqual(
    pc.slots.get('mcp_legacy'),
    { ...before, pingcode_app_id: APP_A },
    'tokens untouched; legacy slot merely app-stamped',
  );
});

test('RENEW REFUSED: no resolvable identity, BOUND slot', async (t) => {
  const pc = fakePc({ identity: { userId: null, error: 'GET /v1/myself network error: EAI_AGAIN' } });
  const before = boundSlot('user-alice');
  pc.slots.set('mcp_alice', { ...before });
  const h = await startApp(pc);
  t.after(h.close);

  const { nonce } = await startAuth(h, { renew: 'mcp_alice' });
  const { res, body } = await callback(h, { cookie: nonce, code: 'attacker-code' });

  assert.equal(res.status, 403);
  assert.match(body, /无法确认授权者身份/);
  assert.equal(pc.saveCalls.length, 0);
  assert.deepEqual(pc.slots.get('mcp_alice'), before, 'slot untouched');
});

test('RENEW REFUSED: identity differs from the slot binding', async (t) => {
  const pc = fakePc({ identity: { userId: 'user-mallory', error: null } });
  const before = boundSlot('user-alice');
  pc.slots.set('mcp_alice', { ...before });
  const h = await startApp(pc);
  t.after(h.close);

  const { nonce } = await startAuth(h, { renew: 'mcp_alice' });
  const { res, body } = await callback(h, { cookie: nonce, code: 'mallory-code' });

  assert.equal(res.status, 403);
  assert.match(body, /账号不一致/);
  assert.equal(pc.saveCalls.length, 0);
  assert.deepEqual(pc.slots.get('mcp_alice'), before, 'slot untouched');
});

test('a FRESH authorization with no resolvable identity still works but warns loudly', async (t) => {
  // Nothing to hijack (no slot exists yet), so we mint — but the page must say
  // the slot is unbindable, because every future renew will be refused.
  const pc = fakePc({ identity: { userId: null, error: 'GET /v1/myself → HTTP 403' } });
  const h = await startApp(pc);
  t.after(h.close);

  const { nonce } = await startAuth(h);
  const { res, body } = await callback(h, { cookie: nonce });

  assert.equal(res.status, 200);
  assert.match(body, /没有绑定 PingCode 身份/);
  assert.equal(pc.saveCalls[0].tokens.pingcode_user_id, null);
});

// ── FIX 1(b): nonce binding ───────────────────────────────────────
test('CALLBACK REFUSED: no nonce at all — and the pending entry survives', async (t) => {
  const h = await startApp(fakePc());
  t.after(h.close);
  await startAuth(h);
  assert.equal(h.pending().size, 1);

  const { res, body } = await callback(h, {}); // no cookie, no path, no state
  assert.equal(res.status, 400);
  assert.match(body, /无法校验/);
  assert.equal(h.pc.exchangeCalls.length, 0, 'the code was never exchanged');
  assert.equal(h.pc.saveCalls.length, 0);
  assert.equal(h.pending().size, 1, 'pending entry NOT consumed');
});

test('CALLBACK REFUSED: wrong nonce — and the pending entry survives', async (t) => {
  const pc = fakePc();
  pc.slots.set('mcp_alice', boundSlot('user-alice'));
  const h = await startApp(pc);
  t.after(h.close);

  const { nonce } = await startAuth(h, { renew: 'mcp_alice' });
  const { res, body } = await callback(h, { cookie: 'not-the-nonce', code: 'attacker-code' });

  assert.equal(res.status, 400);
  assert.match(body, /已失效/);
  assert.equal(pc.exchangeCalls.length, 0);
  assert.equal(pc.saveCalls.length, 0);
  assert.equal(h.pending().size, 1, 'the victim can still complete their own renew');
  // …and they can: the real nonce still works.
  const ok = await callback(h, { cookie: nonce });
  assert.equal(ok.res.status, 200);
});

test('CALLBACK REFUSED: two sources present a conflicting nonce', async (t) => {
  const h = await startApp(fakePc(), { callbackPathNonce: true });
  t.after(h.close);
  const { nonce } = await startAuth(h);

  const { res, body } = await callback(h, { path: nonce, cookie: 'someone-elses-nonce' });
  assert.equal(res.status, 400);
  assert.match(body, /互相矛盾/);
  assert.equal(h.pending().size, 1, 'pending entry NOT consumed');
});

test('a nonce is SINGLE USE — a replay is refused', async (t) => {
  const h = await startApp(fakePc());
  t.after(h.close);
  const { nonce } = await startAuth(h);

  assert.equal((await callback(h, { cookie: nonce })).res.status, 200);
  const replay = await callback(h, { cookie: nonce, code: 'replayed' });
  assert.equal(replay.res.status, 400);
  assert.match(replay.body, /已失效/);
  assert.equal(h.pc.saveCalls.length, 1, 'no second slot written');
});

test('REGRESSION: a callback can no longer steal "the newest pending entry"', async (t) => {
  // The attack the review found: the victim starts a renew (pending entry with
  // the victim's mcp_token), the attacker completes THEIR OWN PingCode consent
  // and hits the callback. Before the fix, the attacker's tokens landed in the
  // victim's slot. The attacker has no nonce, so now it is simply refused.
  const pc = fakePc({ identity: { userId: 'user-mallory', error: null } });
  const before = boundSlot('user-alice');
  pc.slots.set('mcp_alice', { ...before });
  const h = await startApp(pc);
  t.after(h.close);

  await startAuth(h, { renew: 'mcp_alice' });        // victim's pending renew
  const { res } = await callback(h, { code: 'mallory-code' }); // attacker's callback

  assert.equal(res.status, 400);
  assert.equal(pc.saveCalls.length, 0);
  assert.deepEqual(pc.slots.get('mcp_alice'), before);
});

// ── per-attempt redirect_uri (opt-in path nonce) ──────────────────
test('callbackPathNonce puts the nonce in redirect_uri and the callback path works', async (t) => {
  const h = await startApp(fakePc(), { callbackPathNonce: true });
  t.after(h.close);

  const { nonce, authorizeCall } = await startAuth(h);
  assert.equal(authorizeCall.redirectUri, `http://mcp.example.test/oauth/callback/${nonce}`);

  const { res } = await callback(h, { path: nonce, cookie: nonce });
  assert.equal(res.status, 200);
  // RFC 6749 §4.1.3: the exchange must repeat the SAME redirect_uri.
  assert.equal(h.pc.exchangeCalls[0].redirectUri, authorizeCall.redirectUri);
});

test('with the path nonce on, a cookie-less browser can still finish', async (t) => {
  const h = await startApp(fakePc(), { callbackPathNonce: true });
  t.after(h.close);
  const { nonce } = await startAuth(h);
  const { res } = await callback(h, { path: nonce }); // cookie dropped
  assert.equal(res.status, 200);
});

test('a callback with no authorization code is refused before anything else', async (t) => {
  const h = await startApp(fakePc());
  t.after(h.close);
  const { nonce } = await startAuth(h);
  const res = await fetch(`${h.base}/oauth/callback`, {
    headers: { cookie: `oauth_nonce=${nonce}` },
    redirect: 'manual',
  });
  assert.equal(res.status, 400);
  assert.equal(h.pending().size, 1, 'pending entry NOT consumed');
});
