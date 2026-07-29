import { fetch } from 'undici';
import { TokenStore, loadTokenStoreKey } from './token-store.js';
import { PlatformTokenStore } from './platform-store.js';
import { appIdFor, currentAppConfig, envAppConfig, effectiveAppConfig } from './app-config.js';

const TOKEN_REFRESH_SKEW_MS = 60_000;

/**
 * The OAuth client for ONE PingCode app — resolved PER REQUEST, not at boot.
 *
 * WHAT CHANGED AND WHY (CLAUDE.md north-star #9): the app credentials + API
 * roots used to be constructor-frozen from this container's process env, which
 * made the OAuth app container-global state — two projects wanting two different
 * PingCode apps on one box collided. They are now resolved from the AMBIENT
 * per-request config (app-config.js, threaded with AsyncLocalStorage exactly
 * like gbrain's `withEmbedding`), falling back per FIELD to anything passed to
 * the constructor and then to this process's own env.
 *
 * Precedence, highest first:
 *   1. the PER-REQUEST config injected by the control-plane from the DECLARING
 *      AGENT's encrypted Env bag,
 *   2. explicit constructor values (tests / an embedder),
 *   3. this container's process env (the operator-configured-box fallback).
 *
 * The TOKEN STORE is shared (one encrypted SQLite file for the whole box) — it
 * is the tenant-keyed DATA plane, and every slot records WHICH app minted it
 * (`pingcode_app_id`), so a token from app A can never be used with app B.
 */
/**
 * Pick the storage backend from the environment, once.
 *   ZIBBY_API_BASE + PROJECT_API_TOKEN + ZIBBY_STORE__oauth_tokens  → platform store
 *   otherwise                                                       → local file
 * Injected by the control-plane at launch (the store id comes from the agent's
 * own provisioning), so hosted deployments get the visible store automatically
 * and standalone ones keep working unchanged.
 */
// Per-request store resolution. The store id (and the token the datasets API
// needs) arrive with EACH request, injected from the DECLARING agent's env bag —
// that is what makes two deployed PingCode services use two DIFFERENT stores and
// never share a user's authorization. So the backend is resolved per call, not
// pinned at construction; instances are cached per store id.
const _storeCache = new Map();

function resolveTokenStore(fallbackPath) {
  const cfg = effectiveAppConfig() || {};
  const apiBase = String(cfg.ZIBBY_API_BASE || process.env.ZIBBY_API_BASE || '').trim();
  const apiToken = String(cfg.PROJECT_API_TOKEN || process.env.PROJECT_API_TOKEN || '').trim();
  const storeId = String(cfg.ZIBBY_STORE__oauth_tokens || process.env.ZIBBY_STORE__oauth_tokens || '').trim();
  if (apiBase && apiToken && storeId) {
    const cached = _storeCache.get(storeId);
    if (cached) return cached;
    const built = new PlatformTokenStore({ apiBase, apiToken, storeId, key: loadTokenStoreKey() });
    _storeCache.set(storeId, built);
    return built;
  }
  // Standalone deployment (outside Zibby, or platform wiring absent): the local
  // encrypted file keeps the lego working on its own.
  let local = _storeCache.get('__local__');
  if (!local) { local = new TokenStore(fallbackPath); _storeCache.set('__local__', local); }
  return local;
}

export class PingCodeOAuth {
  constructor({ clientId, clientSecret, restRoot, authRoot, tokenStorePath, redirectUri, scope } = {}) {
    // Constructor values are DEFAULTS, not a frozen configuration. Only the
    // fields actually supplied are recorded, so an absent one falls through to
    // the process env instead of pinning `undefined`.
    this._fixed = {};
    if (clientId) this._fixed.clientId = String(clientId);
    if (clientSecret) this._fixed.clientSecret = String(clientSecret);
    if (restRoot) this._fixed.restRoot = String(restRoot).replace(/\/$/, '');
    if (authRoot) this._fixed.authRoot = String(authRoot).replace(/\/$/, '');
    // OAuth scope requested on authorize — OPTIONAL. When set, PingCode shows it
    // on the consent page as 请求权限; when absent, no `scope` parameter is sent
    // and the app's DEFAULT permissions apply. That default is enough for a
    // normally-configured app: GET /v1/myself was verified to succeed with a real
    // user token minted through a no-scope authorize. (An earlier comment here
    // claimed a missing scope meant "no API permissions, every call 403s" — that
    // is NOT true in general, so do not re-introduce it.) Set PINGCODE_SCOPE only
    // if YOUR PingCode app requires an explicit scope value.
    if (scope) this._fixed.scope = String(scope);
    // Sent explicitly on BOTH authorize and token-exchange. PingCode validates
    // it against the app's registered redirect URI list, so each deployment
    // (server IP / ngrok) can send its own and they coexist in one app. Must be
    // registered in the PingCode app or authorize fails with redirect_uri 不匹配.
    // NOT per-tenant: it is a property of THIS BOX's public URL, not of the app.
    this.redirectUri = redirectUri || null;
    // WHERE the per-user authorizations live. Prefer the PLATFORM store (a
    // first-class Stores-v2 `sqlite` store, visible + manageable on the Storage
    // page, provisioned per AGENT so two deployed services never share
    // authorizations); fall back to the local encrypted file when the platform
    // wiring is absent (a standalone deployment outside Zibby — the lego must
    // keep running on its own). Both backends expose the same get/set/delete
    // and the same ciphertext format, so a slot written by one reads with the
    // other.
    this._tokenStorePath = tokenStorePath;
    this.refreshInflight = new Map();
  }

  /** The token store for THIS request (see resolveTokenStore). */
  get store() { return resolveTokenStore(this._tokenStorePath); }

  /**
   * The EFFECTIVE app config for the current async flow. Merged per FIELD so a
   * partially-populated agent Env bag still inherits the operator's defaults.
   */
  get app() {
    return { ...envAppConfig(), ...this._fixed, ...(currentAppConfig() || {}) };
  }

  get clientId() { return this.app.clientId || null; }

  get clientSecret() { return this.app.clientSecret || null; }

  get restRoot() { return this.app.restRoot || null; }

  get authRoot() { return this.app.authRoot || null; }

  get scope() { return this.app.scope || null; }

  /**
   * The identity of the app this request is running under — the value every
   * token slot is stamped with. null when no client id is configured at all.
   */
  get appId() { return appIdFor(this.clientId); }

  /**
   * Assert a usable app config, or throw the message an operator can ACT on.
   * Called at the top of every leg that talks to PingCode, so a missing config
   * surfaces as a clear error on the request that needed it — instead of
   * crashing the shared container at boot for every OTHER tenant.
   */
  requireApp() {
    const a = this.app;
    const missing = [];
    if (!a.clientId) missing.push('PINGCODE_CLIENT_ID');
    if (!a.clientSecret) missing.push('PINGCODE_CLIENT_SECRET');
    if (!a.restRoot) missing.push('PINGCODE_REST_ROOT');
    if (!a.authRoot) missing.push('PINGCODE_AUTH_ROOT');
    if (missing.length) {
      const err = new Error(
        `PingCode app is not configured: missing ${missing.join(', ')}. ` +
        'Set these on the Env tab of the agent that declares this sidecar ' +
        '(they are read per request from that agent\'s encrypted env), or as ' +
        'container env on the box for a single-app deployment.',
      );
      err.code = 'APP_NOT_CONFIGURED';
      err.missing = missing;
      throw err;
    }
    return a;
  }

  // `redirectUri` may be overridden per attempt (the caller can append a
  // one-time nonce path segment). Whatever is used here MUST be repeated
  // byte-identically in exchangeCode — RFC 6749 §4.1.3.
  authorizeUrl(state, { redirectUri } = {}) {
    this.requireApp();
    const qs = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      state,
    });
    const ru = redirectUri || this.redirectUri;
    if (ru) qs.set('redirect_uri', ru);
    if (this.scope) qs.set('scope', this.scope);
    return `${this.authRoot}/oauth2/authorize?${qs.toString()}`;
  }

  async exchangeCode(code, { redirectUri } = {}) {
    this.requireApp();
    const qs = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
    });
    // RFC 6749 §4.1.3: when redirect_uri was in the authorize request it must
    // be repeated identically here, or PingCode rejects the exchange.
    const ru = redirectUri || this.redirectUri;
    if (ru) qs.set('redirect_uri', ru);
    const res = await fetch(`${this.restRoot}/v1/auth/token?${qs.toString()}`);
    if (!res.ok) {
      throw new Error(`exchangeCode failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    if (!data.access_token) throw new Error(`exchangeCode: no access_token in response`);
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
      granted_at: Date.now(),
    };
  }

  // Who does this access_token act as? Used to BIND a renew to the same
  // PingCode user as the slot it renews. Renews FAIL CLOSED on a null userId,
  // so the caller needs to tell the operator WHY it failed — hence the
  // `{ userId, error }` shape rather than a bare null (a 403 means "the OAuth
  // app's scope doesn't cover GET /v1/myself", a network error means "retry").
  // `error` is a short, secret-free description safe to render and log.
  async fetchIdentity(accessToken) {
    let res;
    try {
      res = await fetch(`${this.restRoot}/v1/myself`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (e) {
      return { userId: null, error: `GET /v1/myself network error: ${e.message}` };
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch { /* body unreadable */ }
      return {
        userId: null,
        error: `GET /v1/myself → HTTP ${res.status}${detail ? ` ${detail}` : ''}`,
      };
    }
    let data;
    try { data = await res.json(); }
    catch (e) { return { userId: null, error: `GET /v1/myself returned non-JSON: ${e.message}` }; }
    const id = data?.id ?? data?.user_id ?? data?.value?.id ?? null;
    if (!id) return { userId: null, error: 'GET /v1/myself returned no user id field' };
    return { userId: String(id), error: null };
  }

  // Back-compat convenience: the id alone, or null.
  async fetchUserId(accessToken) {
    return (await this.fetchIdentity(accessToken)).userId;
  }

  async refresh(refreshToken) {
    this.requireApp();
    const qs = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      // RFC 6749 §6: a confidential client authenticates itself when
      // refreshing. PingCode currently accepts the refresh without it, but
      // sending it is the spec-correct, forward-compatible behaviour.
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    const res = await fetch(`${this.restRoot}/v1/auth/token?${qs.toString()}`);
    if (!res.ok) {
      const err = new Error(`refresh failed: ${res.status} ${await res.text()}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    if (!data.access_token) throw new Error(`refresh: no access_token in response`);
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken,
      expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
      granted_at: Date.now(),
    };
  }

  /**
   * Persist a slot, STAMPING the app identity it was minted under unless the
   * caller supplied one explicitly. Every write goes through here, so a slot
   * without a `pingcode_app_id` can only ever be a pre-migration legacy row.
   */
  async saveTokens(mcpToken, tokens) {
    const stamped = { ...tokens };
    if (stamped.pingcode_app_id === undefined) stamped.pingcode_app_id = this.appId;
    await this.store.set(mcpToken, stamped);
  }

  /**
   * Resolve a slot FOR THE CURRENT APP — the (user, app) key.
   *
   * A slot is a PingCode token minted under ONE OAuth client registration. Under
   * a different client it is meaningless (PingCode will not refresh it) and
   * using it would silently cross tenants, so a mismatch is REFUSED rather than
   * attempted.
   *
   *   'unknown'    → no such mcp_token
   *   'other_app'  → the slot belongs to a different PingCode app
   *
   * MIGRATION: a slot written before app binding existed has no
   * `pingcode_app_id`. Back then the box ran exactly ONE app (container-global
   * env), so the app in force on first use IS the one that minted it — stamp it
   * and carry on. Idempotent, and it happens at most once per slot.
   *
   * @returns {Promise<{ok:true, slot:Object}|{ok:false, reason:'unknown'|'other_app'}>}
   */
  async slotFor(mcpToken) {
    const slot = await this.store.get(mcpToken);
    if (!slot) return { ok: false, reason: 'unknown' };
    const current = this.appId;
    const bound = slot.pingcode_app_id ? String(slot.pingcode_app_id) : null;
    if (bound && current && bound !== current) return { ok: false, reason: 'other_app' };
    if (!bound && current) {
      await this.store.set(mcpToken, { ...slot, pingcode_app_id: current });
      slot.pingcode_app_id = current;
    }
    return { ok: true, slot };
  }

  async getStatus(mcpToken) {
    const r = await this.slotFor(mcpToken);
    if (!r.ok) return { authorized: false, reason: r.reason };
    const t = r.slot;
    return { authorized: true, expires_at: t.expires_at, granted_at: t.granted_at };
  }

  async getValidAccessToken(mcpToken) {
    const r = await this.slotFor(mcpToken);
    if (!r.ok) return null;
    const t = r.slot;
    if (!t.access_token || !t.refresh_token) return null;
    if (t.expires_at - TOKEN_REFRESH_SKEW_MS > Date.now()) return t.access_token;

    if (this.refreshInflight.has(mcpToken)) return this.refreshInflight.get(mcpToken);
    const p = (async () => {
      try {
        const fresh = await this.refresh(t.refresh_token);
        await this.store.set(mcpToken, { ...t, ...fresh });
        return fresh.access_token;
      } catch (e) {
        // Distinguish a dead refresh_token from a transient blip:
        //   • 4xx (invalid_grant: expired ~90d / revoked) → permanent. Null the
        //     PingCode tokens so tool calls return NOT_AUTHORIZED; the MCP_TOKEN
        //     slot survives for the /oauth/start?renew=<token> flow (no reconfig).
        //   • network error / 5xx → transient. Keep the tokens untouched so the
        //     NEXT call retries the refresh, instead of forcing a needless
        //     re-authorization over a momentary hiccup.
        const permanent = typeof e.status === 'number' && e.status >= 400 && e.status < 500;
        if (permanent) {
          await this.store.set(mcpToken, {
            ...t,
            access_token: null,
            refresh_token: null,
            expires_at: 0,
          });
        } else {
          console.warn(`token refresh transient failure for ${mcpToken.slice(0, 12)}…: ${e.message}`);
        }
        return null;
      } finally {
        this.refreshInflight.delete(mcpToken);
      }
    })();
    this.refreshInflight.set(mcpToken, p);
    return p;
  }

  /** Back-compat boolean: does this token exist AND belong to the current app? */
  async hasSlot(mcpToken) {
    return (await this.slotFor(mcpToken)).ok;
  }

  async request(mcpToken, method, p, { query, body } = {}) {
    const accessToken = await this.getValidAccessToken(mcpToken);
    if (!accessToken) {
      const err = new Error('PingCode authorization required');
      err.code = 'NOT_AUTHORIZED';
      throw err;
    }
    let url = `${this.restRoot}${p}`;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) url += `?${s}`;
    }
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!res.ok) {
      const err = new Error(`PingCode ${method} ${p} failed: ${res.status}`);
      err.status = res.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  }
}

let singleton = null;
/**
 * The process-wide client. Deliberately constructed with NO app config: the
 * credentials + API roots + scope are resolved PER REQUEST (the injected agent
 * config, else this container's own env — see the class doc). Only the two
 * genuinely box-level things are passed: where the shared encrypted token store
 * lives, and this box's public callback URL.
 */
export function getPingCodeOAuth() {
  if (!singleton) {
    const publicBaseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    singleton = new PingCodeOAuth({
      // SQLite (encrypted) store. A legacy `.../users.json` value still works:
      // the store maps it to a sibling users.db and migrates the JSON once.
      tokenStorePath: process.env.TOKEN_STORE_PATH || '/data/users.db',
      // Derive the redirect URI from this deployment's public base URL so the
      // server sends its IP callback and local dev sends its ngrok callback.
      redirectUri: publicBaseUrl ? `${publicBaseUrl}/oauth/callback` : null,
    });
  }
  return singleton;
}
