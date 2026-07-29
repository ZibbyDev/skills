// PER-REQUEST APP CONFIG — one shared engine, N isolated tenants.
//
// WHY (CLAUDE.md north-star #9, and the anti-pattern this file removes)
// ────────────────────────────────────────────────────────────────────
// This sidecar used to read PINGCODE_CLIENT_ID / _SECRET / _REST_ROOT /
// _AUTH_ROOT / _SCOPE from its own process env at boot and hold them in a
// module singleton. That makes the OAuth app CONTAINER-GLOBAL MUTABLE STATE:
// two projects on the same box wanting two different PingCode apps collide, and
// "who wins?" has no good answer. The platform's fix is not one container per
// agent — it is to keep ONE shared container and ISOLATE the config, injecting
// it PER REQUEST from the DECLARING AGENT's encrypted Env bag.
//
// This is the same shape GBrain uses for its per-agent embedding model+key:
// the control-plane resolves the values and sends them WITH the request, and the
// engine threads them through the call with AsyncLocalStorage
// (`gbrain/brain.js withEmbedding`) instead of touching every signature. Here
// the transport is a HEADER rather than a JSON body field, because the
// control-plane reaches this sidecar through a TRANSPARENT reverse proxy that
// streams bodies verbatim — and the OAuth consent leg is a browser GET with no
// body at all.
//
// CONTRACT
// ────────
//   header:  x-sidecar-config: base64(JSON of { PINGCODE_CLIENT_ID: '…', … }))
//   set by:  the control-plane ONLY (selfhosted/sidecar/public-proxy.js and
//            handlers/mcp-broker.js). Both DROP any client-supplied copy before
//            setting their own, and the broker attaches it only when the target
//            resolves to a declared local sidecar. This container lives on the
//            infra network and is unreachable from run containers, so the
//            control-plane is the only ingress.
//   absent:  every field falls back to this process's own env — the operator
//            who prefers to configure the box through `.env` keeps working
//            exactly as before.
//
// PARALLEL-SAFE BY CONSTRUCTION: the context is per-async-flow, so two agents'
// requests in flight at the same time each see their own config. There is no
// module-level mutable config left in this app.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

/** The header the control-plane sends the per-request config bag on. */
export const SIDECAR_CONFIG_HEADER = 'x-sidecar-config';

/**
 * The header naming WHICH agent's config was injected (an opaque handle).
 * Identity, never a credential — it exists so a page this app renders can emit
 * links that keep working on a box where SEVERAL agents declare this sidecar
 * (the control-plane needs `?agent=<handle>` to know whose config to inject).
 */
export const SIDECAR_AGENT_HEADER = 'x-sidecar-agent';

/** Env keys this app accepts as PER-TENANT config (mirrors the spec's declaration). */
export const REQUEST_CONFIG_KEYS = [
  'PINGCODE_CLIENT_ID',
  'PINGCODE_CLIENT_SECRET',
  'PINGCODE_REST_ROOT',
  'PINGCODE_AUTH_ROOT',
  'PINGCODE_SCOPE',
];

const _appCtx = new AsyncLocalStorage();

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** Map a raw env-shaped bag onto this app's config shape. Missing ⇒ undefined. */
export function appConfigFrom(bag) {
  const b = bag || {};
  const cfg = {};
  if (str(b.PINGCODE_CLIENT_ID)) cfg.clientId = str(b.PINGCODE_CLIENT_ID);
  if (str(b.PINGCODE_CLIENT_SECRET)) cfg.clientSecret = str(b.PINGCODE_CLIENT_SECRET);
  if (str(b.PINGCODE_REST_ROOT)) cfg.restRoot = str(b.PINGCODE_REST_ROOT).replace(/\/$/, '');
  if (str(b.PINGCODE_AUTH_ROOT)) cfg.authRoot = str(b.PINGCODE_AUTH_ROOT).replace(/\/$/, '');
  if (str(b.PINGCODE_SCOPE)) cfg.scope = str(b.PINGCODE_SCOPE);
  return cfg;
}

/**
 * Decode the header value into a config bag. Returns {} for anything malformed
 * (never throws) — a broken header degrades to the process-env fallback rather
 * than 500ing the request.
 */
export function decodeConfigHeader(value) {
  if (!value || typeof value !== 'string') return {};
  try {
    const obj = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out = {};
    for (const k of REQUEST_CONFIG_KEYS) {
      if (typeof obj[k] === 'string' && obj[k].trim()) out[k] = obj[k];
    }
    return out;
  } catch {
    return {};
  }
}

/** The process-env fallback config (operator configured the box, not an agent). */
export function envAppConfig() {
  return appConfigFrom(process.env);
}

/**
 * Run `fn` with `cfg` as the ambient app config. An empty/absent cfg runs `fn`
 * untouched, so the env fallback still applies — same guard shape as gbrain's
 * `withEmbedding`.
 */
export function withAppConfig(cfg, fn) {
  if (!cfg || Object.keys(cfg).length === 0) return fn();
  return _appCtx.run(cfg, fn);
}

/** The ambient per-request config, or null outside a wrapped flow. */
export function currentAppConfig() {
  return _appCtx.getStore() || null;
}

/**
 * The EFFECTIVE config for right now: the injected per-request config, with the
 * process env filling any field it did not set. Per-FIELD merge (not
 * all-or-nothing) so an agent that only overrides, say, the scope still gets the
 * operator's roots.
 */
export function effectiveAppConfig() {
  return { ...envAppConfig(), ...(currentAppConfig() || {}) };
}

/**
 * The APP IDENTITY a token slot is bound to: a stable, non-reversible hash of
 * the OAuth client_id.
 *
 * WHY hash and not store the raw id: the id itself is not a secret (it rides in
 * every authorize URL), but a slot row should carry the minimum that answers
 * "was this token minted under this app?" — an opaque, fixed-width tag does that
 * and keeps the store free of anything an operator must think about.
 *
 * The identity is the CLIENT_ID alone, deliberately: an OAuth token IS an
 * artifact of a specific client registration, and PingCode will refuse to
 * refresh it under a different client. Keying the slot the same way makes the
 * store agree with the upstream instead of merely hoping it does.
 */
export function appIdFor(clientId) {
  const id = str(clientId);
  if (!id) return null;
  return createHash('sha256').update(id).digest('hex').slice(0, 16);
}

/**
 * Express middleware: decode the header, drop it from the request (nothing
 * downstream should read it again), and run the rest of the request inside the
 * config context.
 */
export function appConfigMiddleware(req, res, next) {
  const raw = req.headers ? req.headers[SIDECAR_CONFIG_HEADER] : '';
  const cfg = appConfigFrom(decodeConfigHeader(Array.isArray(raw) ? raw[0] : raw));
  if (req.headers) delete req.headers[SIDECAR_CONFIG_HEADER];
  withAppConfig(cfg, () => next());
}
