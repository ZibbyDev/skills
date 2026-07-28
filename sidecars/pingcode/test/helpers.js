// Shared test scaffolding: a PingCodeOAuth test double + an app-on-an-
// ephemeral-port harness with just enough cookie handling to model a browser.

import { once } from 'node:events';
import { createApp, NONCE_COOKIE } from '../src/app.js';
import { appIdFor, currentAppConfig, SIDECAR_CONFIG_HEADER } from '../src/app-config.js';

export { SIDECAR_CONFIG_HEADER };

/**
 * A PingCodeOAuth stand-in. Every method the app touches, plus recorders so a
 * test can assert on what was sent to PingCode (redirect_uri, state, …) and
 * flip identity resolution on/off.
 */
export function fakePc({
  identity = { identity: null, userId: 'user-alice', error: null },
  app = { clientId: 'client-A', clientSecret: 'secret-A', restRoot: 'https://pc.example.test/open', authRoot: 'https://pc.example.test' },
} = {}) {
  const slots = new Map();
  const pc = {
    slots,
    identity,
    authorizeCalls: [],
    exchangeCalls: [],
    saveCalls: [],
    // The app config the double reports. `currentAppConfig()` (the real ALS
    // context the middleware installs) overrides it per request, so a test can
    // drive multi-tenant behaviour by sending the header — exactly like prod.
    fixedApp: app,
    get app() { return { ...pc.fixedApp, ...(currentAppConfig() || {}) }; },
    get appId() { return appIdFor(pc.app.clientId); },
    requireApp() {
      const a = pc.app;
      if (!a.clientId || !a.clientSecret) {
        const e = new Error('not configured');
        e.code = 'APP_NOT_CONFIGURED';
        e.missing = ['PINGCODE_CLIENT_ID'];
        throw e;
      }
      return a;
    },
    // (user, app) resolution — same contract as the real PingCodeOAuth.
    async slotFor(t) {
      const slot = slots.get(t);
      if (!slot) return { ok: false, reason: 'unknown' };
      const bound = slot.pingcode_app_id || null;
      const current = pc.appId;
      if (bound && current && bound !== current) return { ok: false, reason: 'other_app' };
      if (!bound && current) slot.pingcode_app_id = current;
      return { ok: true, slot };
    },
    async hasSlot(t) { return (await pc.slotFor(t)).ok; },
    authorizeUrl(state, opts = {}) {
      const a = pc.requireApp();
      pc.authorizeCalls.push({ state, clientId: a.clientId, ...opts });
      const qs = new URLSearchParams({ state, client_id: a.clientId, redirect_uri: opts.redirectUri || '' });
      return `${a.authRoot}/oauth2/authorize?${qs}`;
    },
    async exchangeCode(code, opts = {}) {
      const a = pc.requireApp();
      pc.exchangeCalls.push({ code, clientId: a.clientId, ...opts });
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
      const stamped = { ...tokens };
      if (stamped.pingcode_app_id === undefined) stamped.pingcode_app_id = pc.appId;
      pc.saveCalls.push({ mcpToken: t, tokens: stamped });
      slots.set(t, stamped);
    },
  };
  return pc;
}

/** base64 header value the control-plane would send for an agent's config. */
export function configHeader(bag) {
  return Buffer.from(JSON.stringify(bag), 'utf8').toString('base64');
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
export async function startAuth(h, { renew, config, agent } = {}) {
  const url = new URL(`${h.base}/oauth/start`);
  if (renew) url.searchParams.set('renew', renew);
  const headers = {};
  if (config) headers[SIDECAR_CONFIG_HEADER] = configHeader(config);
  if (agent) headers['x-sidecar-agent'] = agent;
  const res = await fetch(url, { headers, redirect: 'manual' });
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
export async function callback(h, { cookie, path, state, code = 'code-1', config } = {}) {
  const p = path ? `/oauth/callback/${encodeURIComponent(path)}` : '/oauth/callback';
  const url = new URL(`${h.base}${p}`);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  const headers = {};
  if (cookie) headers.cookie = `${NONCE_COOKIE}=${encodeURIComponent(cookie)}`;
  if (config) headers[SIDECAR_CONFIG_HEADER] = configHeader(config);
  const res = await fetch(url, { headers, redirect: 'manual' });
  return { res, body: await res.text() };
}
