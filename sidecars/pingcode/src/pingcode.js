import { fetch } from 'undici';
import { TokenStore } from './token-store.js';

const TOKEN_REFRESH_SKEW_MS = 60_000;

export class PingCodeOAuth {
  constructor({ clientId, clientSecret, restRoot, authRoot, tokenStorePath, redirectUri, scope }) {
    if (!clientId || !clientSecret) {
      throw new Error('PINGCODE_CLIENT_ID and PINGCODE_CLIENT_SECRET are required');
    }
    // No hardcoded deployment default: every install points at its OWN
    // PingCode instance, so both roots are required env.
    if (!restRoot || !authRoot) {
      throw new Error(
        'PINGCODE_REST_ROOT and PINGCODE_AUTH_ROOT are required, e.g. ' +
        'PINGCODE_REST_ROOT=https://pingcode.example.com/open ' +
        'PINGCODE_AUTH_ROOT=https://pingcode.example.com',
      );
    }
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.restRoot = restRoot.replace(/\/$/, '');
    this.authRoot = authRoot.replace(/\/$/, '');
    // Sent explicitly on BOTH authorize and token-exchange. PingCode validates
    // it against the app's registered redirect URI list, so each deployment
    // (server IP / ngrok) can send its own and they coexist in one app. Must be
    // registered in the PingCode app or authorize fails with redirect_uri 不匹配.
    this.redirectUri = redirectUri || null;
    // OAuth scope requested on authorize. PingCode shows it on the consent page
    // as 请求权限; if absent the consent shows 请求权限:无 and the user token
    // gets NO API permissions (every business call 403s even when the user
    // themselves has access). Set PINGCODE_SCOPE once the app's permitted scope
    // value is known; left null it preserves the previous (no-scope) behaviour.
    this.scope = scope || null;
    this.store = new TokenStore(tokenStorePath);
    this.refreshInflight = new Map();
  }

  authorizeUrl(state) {
    const qs = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      state,
    });
    if (this.redirectUri) qs.set('redirect_uri', this.redirectUri);
    if (this.scope) qs.set('scope', this.scope);
    return `${this.authRoot}/oauth2/authorize?${qs.toString()}`;
  }

  async exchangeCode(code) {
    const qs = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
    });
    // RFC 6749 §4.1.3: when redirect_uri was in the authorize request it must
    // be repeated identically here, or PingCode rejects the exchange.
    if (this.redirectUri) qs.set('redirect_uri', this.redirectUri);
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
  // PingCode user as the slot it renews (PingCode does not echo `state` on the
  // OAuth callback, so identity — not state — is what makes renews safe).
  // Returns the PingCode user id as a string, or null when it can't be
  // determined (e.g. the app's scope doesn't cover GET /v1/myself).
  async fetchUserId(accessToken) {
    try {
      const res = await fetch(`${this.restRoot}/v1/myself`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return null;
      const data = await res.json();
      const id = data?.id ?? data?.user_id ?? data?.value?.id ?? null;
      return id ? String(id) : null;
    } catch {
      return null;
    }
  }

  async refresh(refreshToken) {
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

  async saveTokens(mcpToken, tokens) {
    await this.store.set(mcpToken, tokens);
  }

  async getStatus(mcpToken) {
    const t = await this.store.get(mcpToken);
    if (!t) return { authorized: false };
    return { authorized: true, expires_at: t.expires_at, granted_at: t.granted_at };
  }

  async getValidAccessToken(mcpToken) {
    const t = await this.store.get(mcpToken);
    if (!t) return null;
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

  async hasSlot(mcpToken) {
    const t = await this.store.get(mcpToken);
    return !!t;
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
export function getPingCodeOAuth() {
  if (!singleton) {
    const publicBaseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    singleton = new PingCodeOAuth({
      clientId: process.env.PINGCODE_CLIENT_ID,
      clientSecret: process.env.PINGCODE_CLIENT_SECRET,
      restRoot: process.env.PINGCODE_REST_ROOT,
      authRoot: process.env.PINGCODE_AUTH_ROOT,
      // SQLite (encrypted) store. A legacy `.../users.json` value still works:
      // the store maps it to a sibling users.db and migrates the JSON once.
      tokenStorePath: process.env.TOKEN_STORE_PATH || '/data/users.db',
      // Derive the redirect URI from this deployment's public base URL so the
      // server sends its IP callback and local dev sends its ngrok callback.
      redirectUri: publicBaseUrl ? `${publicBaseUrl}/oauth/callback` : null,
      // Optional: OAuth scope to request on authorize (see PingCode app config).
      scope: process.env.PINGCODE_SCOPE || null,
    });
  }
  return singleton;
}
