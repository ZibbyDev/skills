// Entrypoint: read env → build the real dependencies → listen.
// All request handling lives in src/app.js (injectable, so the OAuth flow is
// testable without a live PingCode or a bound port).

import { createApp, normalizeBasePath } from './app.js';
import { getPingCodeOAuth } from './pingcode.js';

const PORT = Number(process.env.PORT || 8090);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const BASE_PATH = normalizeBasePath(
  process.env.PUBLIC_BASE_PATH ?? new URL(PUBLIC_BASE_URL).pathname,
);

// Per-attempt nonce in the redirect_uri PATH (`/oauth/callback/<nonce>`).
// OFF by default: PingCode validates redirect_uri against the app's registered
// list, so a per-attempt path only works where a wildcard/extra path can be
// registered. The nonce cookie (always on) already binds the callback; this is
// the extra belt for consoles that allow it. See README → "Callback nonce".
const CALLBACK_PATH_NONCE = /^(1|true|yes|on)$/i.test(
  process.env.OAUTH_CALLBACK_PATH_NONCE || '',
);

const pc = getPingCodeOAuth();

const app = createApp({
  pc,
  publicBaseUrl: PUBLIC_BASE_URL,
  basePath: BASE_PATH,
  callbackPathNonce: CALLBACK_PATH_NONCE,
});

app.listen(PORT, () => {
  console.log(`pingcode-mcp listening on :${PORT}`);
  console.log(`  Public URL:          ${PUBLIC_BASE_URL}`);
  console.log(`  MCP endpoint:        POST ${PUBLIC_BASE_URL}/mcp`);
  console.log(`  OAuth callback URL:  ${PUBLIC_BASE_URL}/oauth/callback${CALLBACK_PATH_NONCE ? '/<nonce>  (per-attempt path — register the wildcard/extra path)' : ''}`);
  console.log(`  Self-serve onboard:  ${PUBLIC_BASE_URL}/oauth/start`);
  console.log(`  (register the callback URL above in your PingCode app)`);
  // ── multi-tenant note ──────────────────────────────────────────────────
  // The PingCode app (client id/secret, API roots, scope) is NOT boot state: it
  // is resolved PER REQUEST from the declaring agent's encrypted Env bag
  // (app-config.js), so this ONE container serves N agents pointing at N
  // different PingCode apps. Container env is only the fallback for an operator
  // who configures the box directly — report which mode this box is in.
  const envConfigured = !!(process.env.PINGCODE_CLIENT_ID && process.env.PINGCODE_CLIENT_SECRET);
  console.log(
    `  App config:          per-request (from the declaring agent's Env bag)`
    + `${envConfigured ? ' + container-env fallback present' : ' — no container-env fallback set'}`,
  );
  // SCOPE is OPTIONAL. Sending none means "ask for the app's default
  // permissions", which on a normally-configured PingCode app is enough to call
  // GET /v1/myself — verified against a live app with a real user token. The
  // previous version of this line claimed a missing scope GUARANTEED a 403 and
  // therefore a refused renew; that was wrong, and a scary-but-false boot
  // warning is worse than none. Only set PINGCODE_SCOPE if YOUR PingCode app
  // requires an explicit scope value (its consent page then shows 请求权限).
  console.log(
    `  OAuth scope:         ${process.env.PINGCODE_SCOPE
      ? process.env.PINGCODE_SCOPE
      : 'none requested — the app\'s default permissions apply (set PINGCODE_SCOPE only if your PingCode app requires an explicit scope)'}`,
  );
});
