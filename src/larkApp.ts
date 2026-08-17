/**
 * larkApp — the ONE decider for "which Lark/Feishu APP credential do I mint a
 * tenant_access_token from, and in what order do I look for it".
 *
 * Zibby has TWO Lark app credentials, and which one a consumer should use is a
 * single decision, not one per skill:
 *   - the CHAT app       (integration `lark`,      env LARK_*)      — PER-PROJECT
 *   - the DOCS/data app  (integration `lark_docs`, env LARK_DOCS_*) — ACCOUNT-LEVEL
 * `workflow-executor.js` resolves the chat row with resolveChatIntegration
 * (project override → account fallback) and the docs row with
 * getAccountProviderIntegration(accountId, 'lark_docs'), then injects each as
 * its own env trio. TENANT-WIDE readers (docs/wiki, attendance) therefore lead
 * with the ACCOUNT-LEVEL app: a project that never bound Lark chat has no
 * project-scoped chat row at all, and an account-only lookup for `lark` lands
 * on a credential-less LARK_TENANT# mapping row that silently yields nothing
 * (observed live — see the comment at workflow-executor.js's `usesLark` block).
 *
 * PRECEDENCE (docs/account app first, chat app as the single-app fallback):
 *   1. LARK_DOCS_* env — the account-level app the executor injected
 *   2. LARK_* env      — the chat app (one Lark app carrying every scope)
 *   3. resolveIntegrationToken('lark_docs') → the backend resolver, which
 *      applies the SAME docs-row-then-chat-row order server-side for callers
 *      with no injected env (the Copilot: in-process/Lambda turns get no
 *      executor env, only the per-turn JWT).
 *
 * WHY IT LIVES IN ITS OWN MODULE (the bug this shape closes)
 * ──────────────────────────────────────────────────────────
 * The platform grew the dedicated `lark_docs` account integration (its own
 * connect/disconnect in handlers/lark.js, its own "Lark App" card, its own
 * LARK_DOCS_* injection) and the DECLARATION moved with it —
 * skill-integrations.js maps `'lark-docs' → lark_docs`. The RUNTIME did not:
 * the skill still asked for `lark`, and the backend token endpoint had no
 * `lark_docs` case at all. So an account with the docs app connected and the
 * chat app not passed every gate (green card, green toggle, deploy allowed)
 * and then failed at call time with "lark is not connected" — a TWO-PLACES
 * drift with nothing screaming, reproduced on two boxes 2026-08-12. Keeping the
 * resolution in ONE module means the next Lark consumer inherits the fixed
 * order instead of re-deriving (and re-breaking) it.
 */

import { resolveIntegrationToken } from '@zibby/core/backend-client.js';
import { INTEGRATIONS } from './integrations.js';

const DEFAULT_LARK_HOST = 'https://open.larksuite.com';

/**
 * The two env trios that can carry a Lark app credential, in PRECEDENCE order.
 * These names are the pre-existing platform contract — `workflow-executor.js`
 * injects LARK_DOCS_* from the `lark_docs` integration row and LARK_* from the
 * `lark` one, and lark-kb-sync's fetch-node reads them in this same order.
 * A backend twin pins the pair: backend/src/services/__tests__/
 * lark-docs-env-trio-tripwire.test.js.
 */
export const LARK_APP_ENV_TRIOS = Object.freeze([
  Object.freeze({ appId: 'LARK_DOCS_APP_ID', appSecret: 'LARK_DOCS_APP_SECRET', host: 'LARK_DOCS_HOST' }),
  Object.freeze({ appId: 'LARK_APP_ID', appSecret: 'LARK_APP_SECRET', host: 'LARK_HOST' }),
]);

/** Every env name the resolution below can read (→ a consumer's envKeys). */
export const LARK_APP_ENV_KEYS = Object.freeze(
  LARK_APP_ENV_TRIOS.flatMap((t) => [t.appId, t.appSecret, t.host]),
);

/** Lark hosts are used as `${host}/open-apis/...` — force an absolute origin. */
export function normalizeLarkHost(raw: any) {
  const h = String(raw || '').trim().replace(/\/+$/, '');
  if (!h) return DEFAULT_LARK_HOST;
  return /^https?:\/\//i.test(h) ? h : `https://${h}`;
}

function appFromEnvTrio(trio: any) {
  const appId = String(process.env[trio.appId] || '').trim();
  const appSecret = String(process.env[trio.appSecret] || '').trim();
  if (!appId || !appSecret) return null;
  return { appId, appSecret, host: normalizeLarkHost(process.env[trio.host]) };
}

/**
 * Resolve the Lark APP CREDENTIAL to mint a tenant_access_token from, per the
 * precedence documented above. Throws whatever the backend resolver throws when
 * nothing is connected — callers fail-soft that into { ok:false, error }.
 */
export async function resolveLarkApp() {
  for (const trio of LARK_APP_ENV_TRIOS) {
    const app = appFromEnvTrio(trio);
    if (app) return app;
  }
  try {
    const t: any = await resolveIntegrationToken(INTEGRATIONS.LARK_DOCS);
    return { appId: t?.appId, appSecret: t?.appSecret, host: normalizeLarkHost(t?.host) };
  } catch (err: any) {
    // COMPAT, narrowly scoped: a box whose CONTROL-PLANE predates the
    // `lark_docs` token resolver answers 400 "Unknown provider: lark_docs".
    // A run container installs @zibby/skills fresh at [setup] npm install, so a
    // NEW skill genuinely meets an OLD backend there. Retry the chat provider
    // ONLY for that one signature — every other failure (404 not connected,
    // 401, network) propagates so a real problem is never masked. Remove once
    // no supported self-host release predates the resolver.
    if (!/unknown provider/i.test(String(err?.message || ''))) throw err;
    const t: any = await resolveIntegrationToken(INTEGRATIONS.LARK);
    return { appId: t?.appId, appSecret: t?.appSecret, host: normalizeLarkHost(t?.host) };
  }
}
