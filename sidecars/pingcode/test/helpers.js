// Shared test scaffolding: a PingCodeOAuth test double + an app-on-an-
// ephemeral-port harness with just enough cookie handling to model a browser.

import { once } from 'node:events';
import { createApp, NONCE_COOKIE } from '../src/app.js';

/**
 * A PingCodeOAuth stand-in. Every method the app touches, plus recorders so a
 * test can assert on what was sent to PingCode (redirect_uri, state, …) and
 * flip identity resolution on/off.
 */
export function fakePc({ identity = { userId: 'user-alice', error: null } } = {}) {
  const slots = new Map();
  const pc = {
    slots,
    identity,
    authorizeCalls: [],
    exchangeCalls: [],
    saveCalls: [],
    async hasSlot(t) { return slots.has(t); },
    authorizeUrl(state, opts = {}) {
      pc.authorizeCalls.push({ state, ...opts });
      const qs = new URLSearchParams({ state, redirect_uri: opts.redirectUri || '' });
      return `https://pingcode.example.test/oauth2/authorize?${qs}`;
    },
    async exchangeCode(code, opts = {}) {
      pc.exchangeCalls.push({ code, ...opts });
      return {
        access_token: `at-${code}`,
        refresh_token: `rt-${code}`,
        expires_at: Date.now() + 3_600_000,
        granted_at: Date.now(),
      };
    },
    async fetchIdentity() { return pc.identity; },
    store: { async get(t) { return slots.get(t) || null; } },
    async saveTokens(t, tokens) {
      pc.saveCalls.push({ mcpToken: t, tokens });
      slots.set(t, tokens);
    },
  };
  return pc;
}

/** Boot the app on an ephemeral port. Returns { base, app, pc, close }. */
export async function startApp(pc, opts = {}) {
  const app = createApp({
    pc,
    // http (not https) so the nonce cookie is not Secure-only — a real browser
    // on an http deployment must still send it back.
    publicBaseUrl: 'http://mcp.example.test',
    ...opts,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    app,
    pc,
    base: `http://127.0.0.1:${server.address().port}`,
    pending: () => app.locals.pendingAuth,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Pull the nonce cookie value out of a Set-Cookie header list. */
export function nonceCookieFrom(res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const c of raw) {
    const m = c.match(new RegExp(`^${NONCE_COOKIE}=([^;]*)`));
    if (m && m[1]) return decodeURIComponent(m[1]);
  }
  return null;
}

/** GET /oauth/start, returning { res, nonce, cookieNonce, authorizeCall }. */
export async function startAuth(h, { renew } = {}) {
  const url = new URL(`${h.base}/oauth/start`);
  if (renew) url.searchParams.set('renew', renew);
  const res = await fetch(url, { redirect: 'manual' });
  const cookieNonce = nonceCookieFrom(res);
  const authorizeCall = h.pc.authorizeCalls.at(-1);
  return { res, cookieNonce, authorizeCall, nonce: authorizeCall?.state ?? cookieNonce };
}

/**
 * GET the callback the way a browser would.
 * @param {object} opts
 * @param {string} [opts.cookie]   nonce to send in the cookie ('' = none)
 * @param {string} [opts.path]     nonce to put in the URL path segment
 * @param {string} [opts.state]    nonce to put in ?state=
 * @param {string} [opts.code]     authorization code (default 'code-1')
 */
export async function callback(h, { cookie, path, state, code = 'code-1' } = {}) {
  const p = path ? `/oauth/callback/${encodeURIComponent(path)}` : '/oauth/callback';
  const url = new URL(`${h.base}${p}`);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  const headers = {};
  if (cookie) headers.cookie = `${NONCE_COOKIE}=${encodeURIComponent(cookie)}`;
  const res = await fetch(url, { headers, redirect: 'manual' });
  return { res, body: await res.text() };
}
