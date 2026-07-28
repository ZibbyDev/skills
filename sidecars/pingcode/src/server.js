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
  // Renews FAIL CLOSED when the consenting PingCode user cannot be resolved via
  // GET /v1/myself. An empty scope is the configuration in which that call 403s,
  // so say it once at boot rather than at day 90 when a user clicks renew.
  if (envConfigured && !process.env.PINGCODE_SCOPE) {
    console.warn(
      '  ⚠️  The container-env fallback sets no PINGCODE_SCOPE. Renews require ' +
      'GET /v1/myself to succeed; with no scope PingCode grants the user token no ' +
      'API permissions and that call 403s, so a renew under the fallback config ' +
      'will be REFUSED (fail-closed). Set PINGCODE_SCOPE on the agent Env bag ' +
      '(preferred) or on the box.',
    );
  }
});
