// The Express app, built as a FUNCTION of its dependencies (the PingCodeOAuth
// instance + this deployment's public URL). `src/server.js` is the thin
// entrypoint that reads env, constructs the real dependencies and listens;
// keeping the app itself injectable is what makes the OAuth flow testable
// without a live PingCode or a bound port.

import express from 'express';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from './tools.js';
import {
  SIDECAR_AGENT_HEADER, SIDECAR_MCP_URL_HEADER, appConfigMiddleware, withAppConfig,
} from './app-config.js';

// The product this app fronts. Held in ONE place so the page copy stays
// service-neutral — every user-visible noun below reads these, so the shell and
// the success page are reusable by the next sidecar that ends a browser flow
// rather than carrying a product name in twenty string literals.
const SERVICE_NAME = 'PingCode';
const SERVICE_SLUG = 'pingcode';

// Base-path awareness: when this app sits behind a reverse proxy under a
// prefix (e.g. https://host/sidecars/pingcode/... with the prefix STRIPPED
// before the request reaches us), every in-page link must carry that prefix —
// a root-relative <a href="/oauth/start"> would escape the mount. The prefix
// comes from PUBLIC_BASE_PATH, or is derived from PUBLIC_BASE_URL's path.
// Empty (direct exposure) keeps today's behaviour byte-identical.
export function normalizeBasePath(p) {
  if (!p) return '';
  let s = String(p).trim().replace(/\/+$/, '');
  if (!s || s === '/') return '';
  if (!s.startsWith('/')) s = `/${s}`;
  return s;
}

export const STATE_TTL_MS = 10 * 60 * 1000;

// Name of the per-attempt nonce cookie. Brand-neutral on purpose.
export const NONCE_COOKIE = 'oauth_nonce';

const newMcpToken = () => 'mcp_' + randomBytes(32).toString('hex');

// Opaque, single-use, unguessable. This is the ONLY thing that links an
// /oauth/callback hit back to the /oauth/start that created it — see the long
// comment on the callback route for why "the newest pending entry" was unsafe.
const newNonce = () => randomBytes(24).toString('base64url');

// Escape text placed inside <pre>. Critical for the install prompts: they carry
// a `pingcode-<slug>` placeholder, and a raw `<slug>` is parsed as an HTML tag —
// the browser drops it, so both the visible text AND the copy button (which
// reads innerText) lose the placeholder, yielding a broken `pingcode-` command.
export const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Minimal cookie reader — express 4 does not parse cookies without
// cookie-parser, and one header split is not worth a dependency (the lockfile
// is committed and reproduced byte-for-byte by `npm ci` in the image).
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

/**
 * The page shell.
 *
 * STYLE PROVENANCE — this is a deliberate HAND-MIRROR of the cloud's
 * `frontend/src/pages/CliAuthorizePage` (the page a `zibby login` lands on):
 * the morphing grid backdrop, the Georgia display title, the green success
 * line, and the design tokens it reads from `frontend/src/styles/globals.css`
 * (--bg-primary #000, --text-primary #e1dddd, --text-secondary #b0b0b0,
 * --text-muted #888888, --border-primary #27241c, --spacing-md/lg/xl).
 *
 * It is a COPY on purpose and cannot be anything else: the cloud page is a
 * React route served from CloudFront, this is a static string rendered by a
 * container that ships as its own image — zero shared code, exactly like the
 * self-host dashboard already mirroring the same tokens. The consequence is
 * the usual one: a restyle over there does NOT reach here. Keep the copied
 * surface as small as it is, and re-mirror deliberately.
 *
 * Copy is ENGLISH and SERVICE-NEUTRAL — every product noun arrives from the
 * caller, so this shell is reusable by any sidecar that ends a browser flow.
 */
const html = (body, opts = {}) =>
  `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title || 'MCP setup')}</title>
<style>
  :root {
    --bg-primary: #000000;
    --text-primary: #e1dddd;
    --text-secondary: #b0b0b0;
    --text-muted: #888888;
    --border-primary: #27241c;
    --spacing-md: 0.8rem;
    --spacing-lg: 1.5rem;
    --spacing-xl: 2rem;
    --success: #4ade80;
    --danger: #f87171;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; position: relative; overflow-x: hidden;
    background: var(--bg-primary); color: var(--text-primary);
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  /* Animated grid backdrop — mirrored from CliAuthorizePage.css */
  body::before, body::after {
    content: ''; position: fixed; inset: -50%; pointer-events: none; z-index: 0;
    background-image:
      linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px);
    background-size: 112px 112px;
  }
  body::before { animation: gridMorphA 36s ease-in-out infinite; }
  body::after  { animation: gridMorphB 36s ease-in-out infinite; }
  @keyframes gridMorphA {
    0%,100% { transform: perspective(800px) rotateX(0) rotateY(0) scale(1); opacity: .6; }
    25%     { transform: perspective(800px) rotateX(25deg) rotateY(-15deg) scale(1.1); opacity: .4; }
    50%     { transform: perspective(800px) rotateX(-20deg) rotateY(20deg) rotate(45deg) scale(1.2); opacity: .3; }
    75%     { transform: perspective(800px) rotateX(15deg) rotateY(-25deg) rotate(20deg) scaleX(1.3) scaleY(.9); opacity: .5; }
  }
  @keyframes gridMorphB {
    0%,100% { transform: perspective(800px) rotateX(-15deg) rotateY(20deg) rotate(45deg) scale(1.1); opacity: .3; }
    25%     { transform: perspective(800px) rotateX(20deg) rotateY(10deg) rotate(0) scale(1); opacity: .6; }
    50%     { transform: perspective(800px) rotateX(-25deg) rotateY(-20deg) rotate(60deg) scaleX(.8) scaleY(1.3); opacity: .4; }
    75%     { transform: perspective(800px) rotateX(10deg) rotateY(25deg) rotate(30deg) scale(1.15); opacity: .35; }
  }
  .page {
    position: relative; z-index: 1; min-height: 100vh; display: flex;
    align-items: center; justify-content: center; padding: 48px 24px;
  }
  .card { width: 100%; max-width: 760px; }
  h1, h2 {
    font-family: Georgia, 'Times New Roman', Times, serif;
    font-weight: 400; line-height: 1.2; color: #fff;
    margin: 0 0 var(--spacing-md); text-align: center;
  }
  h1 { font-size: 42px; }
  h2 { font-size: 28px; }
  /* Colour only, so it reads the same on a heading or a paragraph. */
  .ok  { color: var(--success); }
  .err { color: var(--danger); }
  p.ok, p.err { font-size: 17px; text-align: center; margin: 0 0 var(--spacing-xl); }
  p { margin: var(--spacing-md) 0; color: var(--text-secondary); }
  pre {
    background: rgba(255,255,255,0.04); border: 1px solid var(--border-primary);
    border-radius: 10px; padding: 16px; margin: 0; color: var(--text-primary);
    font: 13px/1.6 'SF Mono', SFMono-Regular, Menlo, monospace;
    overflow-x: auto; white-space: pre-wrap; word-break: break-all;
  }
  /* The Copy button sits INSIDE the block, bottom-right. The reserved space is
     at the BOTTOM (padding-bottom), never the top: a top reservation reads as a
     blank first line on every single-line value, while trailing space just
     reads as the block's own padding. */
  .codeblock { position: relative; margin: var(--spacing-lg) 0 0; }
  .cbhead {
    font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
    color: var(--text-muted); margin-bottom: 6px;
  }
  .codeblock pre { padding-bottom: 46px; }
  .copy {
    position: absolute; right: 10px; bottom: 10px;
    cursor: pointer; background: transparent; color: var(--text-secondary);
    border: 1px solid rgba(255,255,255,0.35); border-radius: 8px;
    padding: 3px 12px; font-size: 12px; font-weight: 500;
    transition: all .15s ease;
  }
  .copy:hover { background: rgba(255,255,255,0.05); color: #fff; }
  .center { text-align: center; }
  .muted { color: var(--text-muted); font-size: 14px; }
  .warn {
    background: rgba(248,113,113,0.08); border: 1px solid rgba(248,113,113,0.25);
    border-radius: 10px; padding: 12px 16px; margin: var(--spacing-lg) 0;
    font-size: 14px; color: var(--text-secondary);
  }
  code { font-family: 'SF Mono', Menlo, monospace; font-size: .92em; }
  a { color: var(--text-primary); }
  a.btn {
    display: inline-block; text-decoration: none; font-weight: 500;
    border: 1px solid rgba(255,255,255,0.35); border-radius: 15px;
    padding: 10px 24px; color: var(--text-secondary);
  }
  a.btn:hover { background: rgba(255,255,255,0.05); color: #fff; }
  hr { border: 0; border-top: 1px solid var(--border-primary); margin: var(--spacing-xl) 0; }
  @media (max-width: 480px) { h1 { font-size: 32px; } }
</style>
<div class="page"><div class="card">
${body}
</div></div>
<script>
function copyBlock(b){
  // The button lives in the block's header row, so reach the <pre> through the
  // block wrapper rather than the button's immediate parent.
  var box=b.closest('.codeblock')||b.parentElement;
  var p=box.querySelector('pre');var text=p.innerText;
  var ok=function(){var t=b.getAttribute('data-label')||b.textContent;b.setAttribute('data-label',t);b.textContent='Copied ✓';setTimeout(function(){b.textContent=t;},1500);};
  function legacy(){var ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.top='-1000px';ta.setAttribute('readonly','');document.body.appendChild(ta);ta.select();var done=false;try{done=document.execCommand('copy');}catch(e){}document.body.removeChild(ta);if(done)ok();else window.prompt('Copy manually (Ctrl/Cmd+C):',text);}
  // navigator.clipboard only exists in a secure context (HTTPS/localhost); this
  // page may be served over plain HTTP, so fall back to execCommand there.
  if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(text).then(ok,legacy);}else{legacy();}
}
</script>`;

export { html };

/**
 * Build the Express app.
 *
 * @param {object}  deps
 * @param {object}  deps.pc                 PingCodeOAuth (or a test double)
 * @param {string}  deps.publicBaseUrl      absolute public URL, no trailing slash
 * @param {string} [deps.basePath]          in-page link prefix (reverse proxy mount)
 * @param {boolean}[deps.callbackPathNonce] put the per-attempt nonce in the
 *        redirect_uri PATH (`/oauth/callback/<nonce>`). Off by default because
 *        PingCode validates redirect_uri against the app's registered list, so
 *        turning it on requires registering a wildcard/extra path (README).
 */
export function createApp({ pc, publicBaseUrl, basePath = '', callbackPathNonce = false }) {
  const PUBLIC_BASE_URL = String(publicBaseUrl || '').replace(/\/$/, '');
  const BASE_PATH = normalizeBasePath(basePath);

  // nonce → { mcpToken: <existing-for-renew> | null, createdAt }
  // Keyed by the per-attempt nonce, NOT by a shared counter/"newest" pointer:
  // the key IS the capability to complete that specific authorization.
  const pendingAuth = new Map();
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pendingAuth.entries()) {
      if (now - v.createdAt > STATE_TTL_MS) pendingAuth.delete(k);
    }
  }, 60_000);
  sweeper.unref();

  // The nonce cookie must be scoped to the path the BROWSER sees (a reverse
  // proxy strips the prefix before we get the request, but the browser keeps
  // it), otherwise it is never sent back to the callback.
  const COOKIE_PATH = `${BASE_PATH}/oauth`;
  const cookieOpts = {
    httpOnly: true,
    sameSite: 'lax',              // still sent on PingCode's top-level GET redirect back
    secure: PUBLIC_BASE_URL.startsWith('https://'),
    path: COOKIE_PATH,
    maxAge: STATE_TTL_MS,
  };

  // redirect_uri MUST be byte-identical on authorize and on token exchange
  // (RFC 6749 §4.1.3), so both sides derive it from the same function.
  const callbackUriFor = (nonce) =>
    callbackPathNonce
      ? `${PUBLIC_BASE_URL}/oauth/callback/${nonce}`
      : `${PUBLIC_BASE_URL}/oauth/callback`;

  const app = express();
  // PER-REQUEST TENANT CONFIG, FIRST. The control-plane injects this agent's
  // PingCode app credentials + API roots on every proxied request; this
  // middleware decodes them and runs the WHOLE request inside an
  // AsyncLocalStorage context (app-config.js), so nothing downstream needs a new
  // parameter and two agents' requests in flight cannot see each other's
  // config. With no header, every field falls back to this container's own env.
  app.use(appConfigMiddleware);
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'healthy', service: 'pingcode-mcp', uptime: process.uptime() });
  });

  app.get('/', (_req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html(`
      <h1>${esc(SERVICE_NAME)} MCP</h1>
      <p class="center">Authorize your ${esc(SERVICE_NAME)} account to get your editor setup.</p>
      <p class="center" style="margin-top:24px"><a class="btn" href="${BASE_PATH}/oauth/start">Connect ${esc(SERVICE_NAME)}</a></p>
    `, { title: `${SERVICE_NAME} MCP` }));
  });

  // ─── OAuth: kick off ─────────────────────────────────────────────
  // /oauth/start              → first-time: callback will mint a new MCP_TOKEN
  // /oauth/start?renew=mcp_xx → renew: callback updates the existing slot's
  //                              PingCode tokens, MCP_TOKEN unchanged
  app.get('/oauth/start', async (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    // SNAPSHOT the app identity this attempt runs under, BEFORE the redirect.
    // The callback is a fresh request from PingCode carrying no agent hint, so
    // the identity has to ride the round-trip inside the nonce binding we
    // already keep — otherwise the code would be exchanged against whatever app
    // happened to be resolvable then, which is exactly the confusion the
    // per-tenant model exists to prevent.
    let appConfig;
    try {
      appConfig = pc.requireApp ? pc.requireApp() : (pc.app || null);
    } catch (e) {
      if (e && e.code === 'APP_NOT_CONFIGURED') {
        console.warn(`[oauth] start refused: ${e.message}`);
        return res.status(503).send(html(`
          <h2 class="err">No ${esc(SERVICE_NAME)} app configured</h2>
          <p>Missing: <code>${esc((e.missing || []).join(', '))}</code></p>
          <p class="muted">Set these on the Env tab of the agent that declares this service,
          then open this link again. No restart needed.</p>
        `, { title: 'Not configured' }));
      }
      throw e;
    }
    const renewToken = req.query.renew ? String(req.query.renew) : null;
    if (renewToken) {
      const slot = pc.slotFor ? await pc.slotFor(renewToken) : { ok: await pc.hasSlot(renewToken) };
      if (!slot.ok) {
        // 'other_app' is a DIFFERENT failure from 'unknown' and says so: the
        // token is real, it just belongs to another PingCode app.
        const otherApp = slot.reason === 'other_app';
        return res.status(400).send(html(otherApp ? `
        <h2 class="err">This token belongs to a different ${esc(SERVICE_NAME)} app</h2>
        <p>It was issued under another OAuth app (a different <code>client_id</code>) and cannot be
        renewed here. Renew it from the entry point of the app that issued it, or
        <a href="${BASE_PATH}/oauth/start">authorize as a new user</a> to get a fresh one.</p>
      ` : `
        <h2 class="err">Unknown token</h2>
        <p>The value you passed to renew does not exist or has been revoked.
        <a href="${BASE_PATH}/oauth/start">Authorize as a new user</a> to get a fresh one.</p>
      `, { title: 'Cannot renew' }));
      }
    }
    const nonce = newNonce();
    // `app` is the per-attempt app identity: the callback exchanges the code
    // against THIS config, never against whatever is ambient at callback time.
    pendingAuth.set(nonce, {
      mcpToken: renewToken,
      createdAt: Date.now(),
      app: appConfig,
      agent: req.header(SIDECAR_AGENT_HEADER) || '',
      // Captured HERE, with the agent handle, for the same reason: the callback
      // is a redirect from the third party, and pinning both to the attempt
      // that started it keeps the success page describing the agent the user
      // actually authorized against — not whatever the callback resolves to.
      mcpUrl: req.header(SIDECAR_MCP_URL_HEADER) || '',
    });
    // Belt: the nonce rides back in a cookie (works with the plain, already
    // registered redirect URI). Braces: optionally also in the redirect_uri
    // path, for deployments whose PingCode app allows the extra segment.
    res.cookie(NONCE_COOKIE, nonce, cookieOpts);
    // `state` carries the same value: harmless if PingCode drops it (it does),
    // and a free extra corroboration if any instance ever echoes it back.
    res.redirect(302, pc.authorizeUrl(nonce, { redirectUri: callbackUriFor(nonce) }));
  });

  // ─── OAuth: callback ─────────────────────────────────────────────
  // PingCode redirects the user here after consent. MUST match the redirect
  // URI configured in the PingCode app.
  //
  // SECURITY — why this is nonce-keyed and not "the newest pending entry":
  // PingCode does not echo `state`, so the original code correlated a callback
  // with whichever /oauth/start happened most recently. That is a confused
  // deputy: an attacker who completes THEIR OWN PingCode authorization while a
  // victim's renew is pending lands the ATTACKER's tokens in the VICTIM's slot,
  // and the victim's agent then operates the attacker's PingCode account. The
  // callback now must PRESENT the nonce minted at /oauth/start (path segment
  // and/or cookie and/or state). No nonce, an unknown nonce, or two sources
  // that disagree ⇒ refuse. There is no fallback.
  async function handleCallback(req, res) {
    res.set('Content-Type', 'text/html; charset=utf-8');
    const code = String(req.query.code || '');
    if (!code) {
      return res.status(400).send(html(`<h2 class="err">Missing authorization code</h2>`));
    }

    // Collect every nonce the request presents; they must all agree.
    const seen = new Set();
    if (req.params && req.params.nonce) seen.add(String(req.params.nonce));
    const cookieNonce = parseCookies(req.headers.cookie)[NONCE_COOKIE];
    if (cookieNonce) seen.add(cookieNonce);
    if (req.query.state) seen.add(String(req.query.state));

    const restart = `<p class="center" style="margin-top:24px">
      <a class="btn" href="${BASE_PATH}/oauth/start">Start over</a></p>`;
    if (seen.size === 0) {
      console.warn('[oauth] callback refused: no nonce presented (cookie/path/state all absent)');
      return res.status(400).send(html(`
        <h2 class="err">Could not verify this request</h2>
        <p class="muted center">Blocked cookies, a different browser, or a link older than 10 minutes.</p>
        ${restart}`, { title: 'Refused' }));
    }
    if (seen.size > 1) {
      console.warn('[oauth] callback refused: conflicting nonces presented');
      return res.status(400).send(html(`
        <h2 class="err">Could not verify this request</h2>
        <p class="muted center">Two authorization pages were open at once.</p>
        ${restart}`, { title: 'Refused' }));
    }
    const nonce = [...seen][0];
    const entry = pendingAuth.get(nonce);
    if (!entry) {
      // Unknown / already-used / expired. Deliberately NOT consumed and NOT
      // guessed at — this is the branch that used to fall back to "newest".
      console.warn('[oauth] callback refused: nonce did not match any pending authorization');
      return res.status(400).send(html(`
        <h2 class="err">This authorization has expired</h2>
        <p class="muted center">Already used, or older than 10 minutes.</p>
        ${restart}`, { title: 'Expired' }));
    }
    // Matched exactly one pending entry → consume it (single use).
    pendingAuth.delete(nonce);
    res.clearCookie(NONCE_COOKIE, { path: COOKIE_PATH });

    // THE ROUND-TRIP BINDING. Everything below runs under the app identity that
    // was captured at /oauth/start and carried on this nonce's pending entry —
    // NOT under whatever config happens to be ambient on this callback request
    // (PingCode's redirect carries no agent hint, so there may be none at all).
    // That is what guarantees the code is exchanged against the SAME client_id
    // that requested it, and that the resulting slot is stamped with that app.
    return withAppConfig(entry.app, async () => {
      try {
        const tokens = await pc.exchangeCode(code, { redirectUri: callbackUriFor(nonce) });

        // Who just authorized? Identity is the second, independent guard: even if
        // a nonce leaks (it travels in a URL / browser history), a renew may only
        // ever be completed by the SAME PingCode user the slot already belongs to.
        const identity = await pc.fetchIdentity(tokens.access_token);
        const userId = identity && identity.userId ? String(identity.userId) : null;

        if (entry.mcpToken) {
          // ── renew flow: update existing slot, keep MCP_TOKEN unchanged ──
          //
          // FAIL CLOSED. If we cannot establish who just consented, we refuse —
          // for a bound slot AND for a legacy/unbound one. The previous code
          // skipped the check when `pingcode_user_id` was absent, which made the
          // whole identity guard a no-op in the default configuration (an empty
          // PINGCODE_SCOPE makes GET /v1/myself 403 → userId null → check
          // skipped) and left the slot overwritable by whoever raced the callback.
          if (!userId) {
            console.warn(
              `[oauth] renew REFUSED for slot ${String(entry.mcpToken).slice(0, 12)}…: ` +
              `PingCode identity could not be established (${identity?.error || 'unknown error'}) — ` +
              'nothing was written',
            );
            return res.status(403).send(html(`
              <h2 class="err">Renewal refused — could not confirm who authorized</h2>
              <p>The server could not establish which ${esc(SERVICE_NAME)} account just consented
              (<code>GET /v1/myself</code> failed), so it refused to write those tokens into this
              slot — better to refuse than to put someone else's credentials in your slot.
              <strong>Your existing authorization was not touched.</strong></p>
              <p class="muted">For the administrator: the OAuth app needs permission to call
              <code>GET /v1/myself</code> (it returned: ${esc(identity?.error || 'unknown error')}).
              Most apps work on default permissions; if yours requires explicit scopes, set
              <code>PINGCODE_SCOPE</code>. Then have the user click renew again.</p>
              ${restart}`, { title: 'Renewal refused' }));
          }

          const existing = (await pc.store.get(entry.mcpToken)) || {};
          const boundId = existing.pingcode_user_id ? String(existing.pingcode_user_id) : null;
          if (boundId && userId !== boundId) {
            console.warn(
              `[oauth] renew REFUSED for slot ${String(entry.mcpToken).slice(0, 12)}…: ` +
              'consenting PingCode user differs from the bound one — nothing was written',
            );
            return res.status(403).send(html(`
              <h2 class="err">Renewal refused — different account</h2>
              <p>This renew link belongs to another ${esc(SERVICE_NAME)} account. Sign in as the
              account that originally authorized this token and try again, or
              <a href="${BASE_PATH}/oauth/start">authorize as a new user</a> to get your own.</p>
            `, { title: 'Renewal refused' }));
          }
          // Legacy slot with no recorded identity (pre-migration): bind it now —
          // safe because reaching here required the nonce from THIS slot's own
          // /oauth/start AND a resolvable identity.
          await pc.saveTokens(entry.mcpToken, {
            ...existing,
            ...tokens,
            pingcode_user_id: boundId || userId,
          });
          return res.send(html(`
            <h1>Renewed</h1>
            <p class="ok">${esc(SERVICE_NAME)} is authorized again.</p>
            <p class="muted center">Your token is unchanged — no config to update.</p>
          `, { title: `${SERVICE_NAME} renewed` }));
        }

        // ── first-time flow: mint a fresh MCP_TOKEN ──
        // No slot exists yet, so there is nothing to hijack: a missing identity
        // here cannot hand anyone else's tokens to anyone. We therefore still
        // issue the token (an app that cannot call /v1/myself but can call the
        // business endpoints keeps working) — but we say LOUDLY that the slot is
        // unbindable, because every future renew WILL be refused above.
        const mcpToken = newMcpToken();
        await pc.saveTokens(mcpToken, {
          ...tokens,
          created_at: Date.now(),
          // Remember whose slot this is, so future renews can be identity-bound.
          pingcode_user_id: userId,
        });
        if (!userId) {
          console.warn(
            '[oauth] new slot created WITHOUT a PingCode identity ' +
            `(${identity?.error || 'unknown error'}) — renews for it will be refused. ` +
            'Grant the OAuth app access to GET /v1/myself and set PINGCODE_SCOPE.',
          );
        }

        // ── THE ADDRESS ──────────────────────────────────────────────────
        // ONE address per agent, and the platform decides which one it is: the
        // control-plane derives it (agent-entry-points) and hands it over on a
        // proxy-owned header, so THIS page and the agent's detail page can
        // never print two different install URLs for the same agent — the
        // drift that had a connected user holding an address the product no
        // longer advertised. Nothing here knows the platform's route grammar.
        //
        // FALLBACK — an older control-plane sends no such header. Then the
        // sidecar's own public mount is still the correct (and only) address,
        // carrying the agent handle so a box with SEVERAL declaring agents can
        // still tell whose config to inject. Byte-identical to what shipped.
        const agentQs = entry.agent ? `?agent=${encodeURIComponent(entry.agent)}` : '';
        const mcpUrl = entry.mcpUrl || `${PUBLIC_BASE_URL}/mcp${agentQs}`;
        // ── THE SERVER NAME ──────────────────────────────────────────────
        // Must be UNIQUE PER HUMAN: an MCP client keys its config by name and
        // refuses to overwrite one, and (verified live) teammates here share
        // BOTH the home dir and the workspace — so a fixed `pingcode` makes the
        // second person's install collide with the first's.
        //
        // The old page solved this by instructing the AGENT to slugify
        // $GIT_AUTHOR_EMAIL, because the server could not see any per-person
        // value. It can: the callback just resolved this user's PingCode
        // identity. Deriving the name here keeps the uniqueness and costs the
        // reader nothing — no placeholder to substitute, no prompt to run.
        // With no identity (the warning below), a short digest of the bearer
        // stands in — one-way, stable across renews, and never the token.
        const userSuffix = userId
          ? String(userId).replace(/[^a-zA-Z0-9]/g, '').slice(-8).toLowerCase()
          : createHash('sha256').update(String(mcpToken)).digest('hex').slice(0, 8);
        const serverKey = `${SERVICE_SLUG}-${userSuffix}`;
        // The universal form: Claude Code, Cursor and Gemini all read this
        // shape. Codex (TOML) and Claude Desktop (stdio only — a `url` entry is
        // silently skipped, so it needs the mcp-remote bridge) each get their
        // own block rather than a footnote telling the reader to translate.
        const jsonCfg = JSON.stringify(
          { mcpServers: { [serverKey]: { url: mcpUrl, headers: { Authorization: `Bearer ${mcpToken}` } } } },
          null, 2,
        );
        const tomlCfg = `[mcp_servers.${serverKey}]
url = "${mcpUrl}"
http_headers = { "Authorization" = "Bearer ${mcpToken}" }`;
        const bridgeCmd = `npx mcp-remote ${mcpUrl} --header "Authorization:Bearer ${mcpToken}"`;
        const identityWarning = userId ? '' : `
          <div class="warn">
            <strong>This authorization is not bound to a ${esc(SERVICE_NAME)} identity.</strong>
            The server could not confirm your account through <code>GET /v1/myself</code>
            (${esc(identity?.error || 'unknown error')}), so <strong>renewal will be refused</strong>
            when it expires. Ask an administrator to grant the OAuth app access to
            <code>/v1/myself</code> and set <code>PINGCODE_SCOPE</code>, then authorize once more.
          </div>`;
        // ONE block per thing to copy, each labelled in its own header row.
        // No standing prose: the labels carry the whole instruction, which is
        // what "add this to that file" actually needs.
        //
        // The URL and the token are NOT given their own blocks: every config
        // below already contains both verbatim, so separate rows for them were
        // the same two values printed a fourth and fifth time. A reader who
        // needs the raw pair reads it off the JSON.
        const block = (label, text) => `
          <div class="codeblock">
            <div class="cbhead">${esc(label)}</div>
            <pre>${esc(text)}</pre>
            <button class="copy" onclick="copyBlock(this)">Copy</button>
          </div>`;
        return res.send(html(`
          <h1>Connected</h1>
          <p class="ok">${esc(SERVICE_NAME)} is authorized.</p>
          ${identityWarning}
          ${block('Claude Code · Cursor · Gemini', jsonCfg)}
          ${block('Codex — ~/.codex/config.toml', tomlCfg)}
          ${block('Claude Desktop — bridge (stdio only)', bridgeCmd)}
        `, { title: `${SERVICE_NAME} connected` }));
      } catch (e) {
        console.error('OAuth callback failed:', e);
        return res.status(500).send(html(
          `<h2 class="err">Authorization failed</h2><pre>${esc(e.message)}</pre>`,
          { title: 'Authorization failed' },
        ));
      }
    });
  }

  // Both shapes are served: the plain path (nonce arrives by cookie/state) and
  // the per-attempt path segment. Which one PingCode redirects to is decided by
  // the redirect_uri we sent at /oauth/start (callbackPathNonce).
  app.get('/oauth/callback', handleCallback);
  app.get('/oauth/callback/:nonce', handleCallback);

  // ─── MCP: Streamable HTTP transport ──────────────────────────────
  // Sessions must persist across requests: the client sends `initialize`
  // first (no session id) and the server returns a Mcp-Session-Id header;
  // every later request (tools/list, tools/call, ...) carries that header.
  // We key live transports by session id. Each session is bound to the
  // mcpToken that created it, so a session always acts as that one user.
  const sessions = new Map(); // sessionId -> { transport, mcpToken }

  // The bearer identifies a SLOT, and a slot is keyed by (USER, APP) — a token
  // minted under PingCode app A is meaningless under app B (PingCode itself will
  // not refresh it), so serving it would be a silent cross-tenant reach. The
  // mismatch is REFUSED with its own status + message, never conflated with
  // "unknown token".
  async function requireBearer(req, res, next) {
    const auth = req.header('authorization') || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'missing bearer token' });
    const slot = pc.slotFor ? await pc.slotFor(m[1]) : { ok: await pc.hasSlot(m[1]) };
    if (!slot.ok) {
      if (slot.reason === 'other_app') {
        return res.status(403).json({
          error: 'mcp_token belongs to a different PingCode app',
          authorize_url: `${PUBLIC_BASE_URL}/oauth/start`,
        });
      }
      return res.status(401).json({
        error: 'unknown or revoked mcp_token',
        authorize_url: `${PUBLIC_BASE_URL}/oauth/start`,
      });
    }
    req.mcpToken = m[1];
    next();
  }

  function buildMcpServer(mcpToken) {
    const server = new McpServer(
      { name: 'pingcode-mcp', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    registerTools(server, { mcpToken, publicBaseUrl: PUBLIC_BASE_URL });
    return server;
  }

  app.post('/mcp', requireBearer, async (req, res) => {
    const sid = req.header('mcp-session-id');
    try {
      let transport;
      if (sid && sessions.has(sid)) {
        const sess = sessions.get(sid);
        if (sess.mcpToken !== req.mcpToken) {
          return res.status(403).json({ error: 'session does not belong to this token' });
        }
        transport = sess.transport;
      } else if (!sid && isInitializeRequest(req.body)) {
        const mcpToken = req.mcpToken;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (newId) => { sessions.set(newId, { transport, mcpToken }); },
        });
        transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
        const server = buildMcpServer(mcpToken);
        await server.connect(transport);
      } else {
        return res.status(400).json({
          jsonrpc: '2.0', id: null,
          error: { code: -32000, message: 'Bad Request: no valid session id (send initialize first)' },
        });
      }
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP request failed:', err);
      if (!res.headersSent) res.status(500).json({ error: 'internal' });
    }
  });

  // GET = server->client SSE stream, DELETE = explicit session teardown.
  async function replaySession(req, res) {
    const sid = req.header('mcp-session-id');
    const sess = sid && sessions.get(sid);
    if (!sess || sess.mcpToken !== req.mcpToken) return res.status(404).end();
    await sess.transport.handleRequest(req, res);
  }
  app.get('/mcp', requireBearer, replaySession);
  app.delete('/mcp', requireBearer, replaySession);

  // Exposed for tests/diagnostics; not a route.
  app.locals.pendingAuth = pendingAuth;
  return app;
}
