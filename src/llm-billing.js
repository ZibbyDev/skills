/**
 * llm-billing — read-only fetch + normalize for LLM-provider cost/usage
 * admin APIs (OpenAI / Anthropic / Cursor).
 *
 * Design notes:
 *
 *  - This file exports BOTH the minimal skill declarations (id +
 *    requiresIntegration only — these gate marketplace deploys via the
 *    backend's deriveRequiredIntegrations) AND a plain-function
 *    fetch SDK (fetchOpenAICosts / fetchAnthropicCosts / fetchCursorSpend
 *    + fetchAllProviders). Skill objects are registered in index.js;
 *    fetch functions are imported directly by template nodes.
 *
 *  - We deliberately do NOT expose this as an MCP server. The fetch
 *    surface is small (3 endpoints) and deterministic — workflow code
 *    knows exactly what to ask for. MCP would add a JSON-RPC hop and
 *    LLM-driven tool selection for no gain. See README discussion
 *    re: REST vs MCP for the broader rationale.
 *
 *  - Output shape is normalized across providers so downstream
 *    analysis (baseline diff, anomaly detection) doesn't need
 *    per-provider branches. See NormalizedSpendRecord JSDoc below.
 *
 *  - Failure mode is partial: `fetchAllProviders` uses Promise.allSettled
 *    so one provider being down (or not connected) doesn't kill the
 *    whole digest. Each leg returns either { items, ok: true } or
 *    { error, ok: false } so the analyze node can render a degraded
 *    digest.
 */

import { resolveIntegrationToken } from '@zibby/core/backend-client.js';
import { INTEGRATIONS } from './integrations.js';

/**
 * Normalized record shape — one entry per (provider × day × dimension)
 * after each provider's response is unpacked. Optional fields are
 * provider-specific and may be undefined.
 *
 * @typedef {Object} NormalizedSpendRecord
 * @property {'openai'|'anthropic'|'cursor'} provider
 * @property {string} day                 ISO date (YYYY-MM-DD)
 * @property {number} costUsd             USD, positive
 * @property {string} [projectId]         OpenAI project_id
 * @property {string} [projectName]       OpenAI project metadata (joined on lookup)
 * @property {string} [workspaceId]       Anthropic workspace_id
 * @property {string} [workspaceName]     Anthropic workspace metadata
 * @property {string} [apiKeyId]          OpenAI / Anthropic api_key_id
 * @property {string} [userEmail]         Cursor team-member email
 * @property {string} [model]             Model id (when grouped by model)
 * @property {number} [tokensIn]
 * @property {number} [tokensOut]
 * @property {number} [cachedTokens]
 * @property {number} [requestCount]      Cursor
 * @property {number} [acceptanceRate]    Cursor: 0..1
 */

/**
 * Marketplace-gating skill declarations. The id matches the
 * REQUIRED_INTEGRATION_MAP entry on the backend; the template's node
 * just declares `skills: [SKILLS.OPENAI_BILLING, ...]` and the bundler
 * derives required integrations automatically.
 *
 * These are intentionally minimal — no MCP tools, no resolve(), no
 * prompt fragments. The skill object exists ONLY to register the
 * integration dependency. Runtime behavior lives in the fetch fns below.
 */
export const openaiBillingSkill = Object.freeze({
  id: 'openai_billing',
  requiresIntegration: INTEGRATIONS.OPENAI_BILLING,
  description: 'OpenAI organization billing/usage admin API (paste sk-admin-... key)',
});

export const anthropicBillingSkill = Object.freeze({
  id: 'anthropic_billing',
  requiresIntegration: INTEGRATIONS.ANTHROPIC_BILLING,
  description: 'Anthropic organization cost/usage admin API (paste sk-ant-admin-... key)',
});

export const cursorAdminSkill = Object.freeze({
  id: 'cursor_admin',
  requiresIntegration: INTEGRATIONS.CURSOR_ADMIN,
  description: 'Cursor Team/Enterprise admin API (paste admin key)',
});

// ─────────────────────── helpers ───────────────────────

function toUnixSec(ms) {
  return Math.floor(ms / 1000);
}

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

async function getProviderToken(provider) {
  const data = await resolveIntegrationToken(provider);
  if (!data?.token) throw new Error(`${provider} token resolver returned no token`);
  return data.token;
}

// ─────────────────────── OpenAI ───────────────────────

/**
 * Fetch OpenAI org costs + usage for the window. Iterates pagination
 * (page_token) until exhausted.
 *
 * Reference: GET /v1/organization/costs
 *   query: start_time (unix sec), end_time (unix sec), bucket_width=1d,
 *          group_by[]=project_id&group_by[]=line_item, page
 *   response shape:
 *     {
 *       object: 'page',
 *       data: [
 *         { object: 'bucket', start_time, end_time,
 *           results: [{ amount: { value, currency }, project_id, line_item, ... }] }
 *       ],
 *       has_more: boolean,
 *       next_page: '...'
 *     }
 *
 * We normalize each result row into a NormalizedSpendRecord.
 *
 * @param {{ startMs: number, endMs: number, groupBy?: string[] }} opts
 * @returns {Promise<{ ok: true, items: NormalizedSpendRecord[], rawBuckets: number }>}
 */
export async function fetchOpenAICosts({ startMs, endMs, groupBy = ['project_id', 'line_item'] }) {
  const token = await getProviderToken('openai_billing');
  const items = [];
  let rawBuckets = 0;

  const groupByParam = groupBy.map((g) => `group_by[]=${encodeURIComponent(g)}`).join('&');
  let nextPage = null;
  // Defensive bound — if upstream pagination loops on us we bail.
  for (let safety = 0; safety < 50; safety++) {
    const params = [
      `start_time=${toUnixSec(startMs)}`,
      `end_time=${toUnixSec(endMs)}`,
      `bucket_width=1d`,
      `limit=180`,
      groupByParam,
      nextPage ? `page=${encodeURIComponent(nextPage)}` : '',
    ].filter(Boolean).join('&');
    const url = `https://api.openai.com/v1/organization/costs?${params}`;

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI costs API ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();

    for (const bucket of data.data || []) {
      rawBuckets += 1;
      const day = isoDay((bucket.start_time || 0) * 1000);
      for (const r of bucket.results || []) {
        items.push({
          provider: 'openai',
          day,
          costUsd: Number(r.amount?.value ?? 0),
          projectId: r.project_id || undefined,
          apiKeyId: r.api_key_id || undefined,
          model: r.line_item || undefined,
        });
      }
    }

    if (!data.has_more || !data.next_page) break;
    nextPage = data.next_page;
  }

  return { ok: true, items, rawBuckets };
}

/**
 * Fetch the OpenAI project catalog (id → name). Useful for the digest
 * to display "acme-prod" instead of "proj_abc123". Cheap — usually
 * <50 projects. Returns Map<projectId, projectName>.
 */
export async function fetchOpenAIProjects() {
  const token = await getProviderToken('openai_billing');
  const url = 'https://api.openai.com/v1/organization/projects?limit=100';
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI projects API ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const map = new Map();
  for (const p of data.data || []) map.set(p.id, p.name);
  return map;
}

// ─────────────────────── Anthropic ───────────────────────

/**
 * Fetch Anthropic cost report.
 *
 * Reference: GET /v1/organizations/cost_report
 *   query: starting_at (ISO), ending_at (ISO), bucket=1d,
 *          group_by[]=workspace_id&group_by[]=model
 *   headers: x-api-key, anthropic-version: 2023-06-01
 *   response shape (beta):
 *     {
 *       data: [
 *         { starting_at, ending_at, currency: 'USD',
 *           results: [{ amount: '0.42', workspace_id, model, ... }] }
 *       ],
 *       has_more, next_page
 *     }
 *
 * Anthropic returns cost amounts as decimal strings (cents-precision).
 * Multiply-by-100 then parse-int → exact-cents arithmetic OK; for the
 * digest we just parseFloat (drift over 28 days is negligible).
 */
export async function fetchAnthropicCosts({ startMs, endMs, groupBy = ['workspace_id'] }) {
  const token = await getProviderToken('anthropic_billing');
  const items = [];
  let rawBuckets = 0;

  const groupByParam = groupBy.map((g) => `group_by[]=${encodeURIComponent(g)}`).join('&');
  let nextPage = null;
  for (let safety = 0; safety < 50; safety++) {
    const params = [
      `starting_at=${encodeURIComponent(toIso(startMs))}`,
      `ending_at=${encodeURIComponent(toIso(endMs))}`,
      `bucket=1d`,
      `limit=100`,
      groupByParam,
      nextPage ? `page=${encodeURIComponent(nextPage)}` : '',
    ].filter(Boolean).join('&');
    const url = `https://api.anthropic.com/v1/organizations/cost_report?${params}`;

    const res = await fetch(url, {
      headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic cost_report ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();

    for (const bucket of data.data || []) {
      rawBuckets += 1;
      const day = (bucket.starting_at || '').slice(0, 10);
      for (const r of bucket.results || []) {
        items.push({
          provider: 'anthropic',
          day,
          costUsd: Number(r.amount ?? r.cost ?? 0),
          workspaceId: r.workspace_id || undefined,
          apiKeyId: r.api_key_id || undefined,
          model: r.model || undefined,
          tokensIn: r.uncached_input_tokens != null ? Number(r.uncached_input_tokens) : undefined,
          tokensOut: r.output_tokens != null ? Number(r.output_tokens) : undefined,
          cachedTokens: r.cached_input_tokens != null ? Number(r.cached_input_tokens) : undefined,
        });
      }
    }

    if (!data.has_more || !data.next_page) break;
    nextPage = data.next_page;
  }

  return { ok: true, items, rawBuckets };
}

/**
 * Fetch Anthropic workspace catalog (id → name).
 */
export async function fetchAnthropicWorkspaces() {
  const token = await getProviderToken('anthropic_billing');
  const url = 'https://api.anthropic.com/v1/organizations/workspaces?limit=100';
  const res = await fetch(url, {
    headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic workspaces ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const map = new Map();
  for (const w of data.data || []) map.set(w.id, w.name);
  return map;
}

// ─────────────────────── Cursor ───────────────────────

/**
 * Fetch Cursor team daily-usage data. The endpoint returns per-day,
 * per-user, per-model rolls — we flatten to NormalizedSpendRecord.
 *
 * Reference: GET /teams/daily-usage-data
 *   query: startDate (YYYY-MM-DD), endDate (YYYY-MM-DD)
 *   header: Authorization: Bearer <admin-key>
 *   response shape (Cursor Admin API, 2026):
 *     {
 *       data: [
 *         { date, totalCents, userMetrics: [
 *             { email, totalCents, modelUsage: [
 *                 { model, requestCount, acceptedLines, suggestedLines } ] } ]
 *         }
 *       ]
 *     }
 *
 * acceptanceRate = acceptedLines / suggestedLines (per model per user
 * per day). The digest aggregates across users for the team-level rate.
 */
export async function fetchCursorSpend({ startMs, endMs }) {
  const token = await getProviderToken('cursor_admin');
  const startDate = isoDay(startMs);
  const endDate = isoDay(endMs);
  const url = `https://api.cursor.com/teams/daily-usage-data?startDate=${startDate}&endDate=${endDate}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Cursor daily-usage ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const items = [];
  let rawBuckets = 0;
  for (const bucket of data.data || []) {
    rawBuckets += 1;
    const day = bucket.date;
    for (const userRow of bucket.userMetrics || []) {
      for (const mu of userRow.modelUsage || []) {
        const accepted = Number(mu.acceptedLines ?? 0);
        const suggested = Number(mu.suggestedLines ?? 0);
        items.push({
          provider: 'cursor',
          day,
          costUsd: Number((mu.totalCents ?? 0)) / 100,
          userEmail: userRow.email,
          model: mu.model,
          requestCount: Number(mu.requestCount ?? 0),
          acceptanceRate: suggested > 0 ? accepted / suggested : undefined,
        });
      }
      // If no modelUsage breakdown, still emit a user-aggregate so we
      // don't lose the cost. Common during low-usage days.
      if (!userRow.modelUsage || userRow.modelUsage.length === 0) {
        items.push({
          provider: 'cursor',
          day,
          costUsd: Number(userRow.totalCents ?? 0) / 100,
          userEmail: userRow.email,
        });
      }
    }
  }

  return { ok: true, items, rawBuckets };
}

// ─────────────────────── Aggregator ───────────────────────

/**
 * Pull all three providers in parallel. Returns a per-provider result
 * map so the analyze node can degrade gracefully when one provider
 * fails (not connected, key revoked, upstream 500, etc.).
 *
 * @param {{ startMs: number, endMs: number }} opts
 * @returns {Promise<{
 *   openai:    { ok: true, items: NormalizedSpendRecord[] } | { ok: false, error: string },
 *   anthropic: { ok: true, items: NormalizedSpendRecord[] } | { ok: false, error: string },
 *   cursor:    { ok: true, items: NormalizedSpendRecord[] } | { ok: false, error: string },
 *   totals:    { provider: string, totalUsd: number }[],
 * }>}
 */
export async function fetchAllProviders({ startMs, endMs }) {
  const [openai, anthropic, cursor] = await Promise.allSettled([
    fetchOpenAICosts({ startMs, endMs }),
    fetchAnthropicCosts({ startMs, endMs }),
    fetchCursorSpend({ startMs, endMs }),
  ]);

  const settle = (result) =>
    result.status === 'fulfilled'
      ? result.value
      : { ok: false, error: result.reason?.message || String(result.reason), items: [] };

  const oai = settle(openai);
  const ant = settle(anthropic);
  const cur = settle(cursor);

  const totals = [
    { provider: 'openai',    totalUsd: oai.items.reduce((s, it) => s + (it.costUsd || 0), 0) },
    { provider: 'anthropic', totalUsd: ant.items.reduce((s, it) => s + (it.costUsd || 0), 0) },
    { provider: 'cursor',    totalUsd: cur.items.reduce((s, it) => s + (it.costUsd || 0), 0) },
  ];

  return { openai: oai, anthropic: ant, cursor: cur, totals };
}

/**
 * Group an array of normalized records by a key + sum costUsd.
 * Convenience for analyze nodes — saves writing the same reduce 5x.
 *
 * @param {NormalizedSpendRecord[]} items
 * @param {(item: NormalizedSpendRecord) => string} keyFn
 * @returns {{ key: string, totalUsd: number, count: number }[]}  sorted desc by totalUsd
 */
export function groupByKey(items, keyFn) {
  const acc = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!k) continue;
    const cur = acc.get(k) || { key: k, totalUsd: 0, count: 0 };
    cur.totalUsd += it.costUsd || 0;
    cur.count += 1;
    acc.set(k, cur);
  }
  return [...acc.values()].sort((a, b) => b.totalUsd - a.totalUsd);
}

/**
 * Compute mean + stddev over a numeric window. Used by analyze nodes
 * to flag this-week-vs-baseline anomalies (>2σ).
 *
 * @param {number[]} xs
 * @returns {{ mean: number, stddev: number }}
 */
export function meanStddev(xs) {
  if (!xs.length) return { mean: 0, stddev: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length;
  return { mean, stddev: Math.sqrt(variance) };
}
