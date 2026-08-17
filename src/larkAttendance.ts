/**
 * Lark / Feishu Attendance (考勤) skill — READ-ONLY, AGENT-DRIVEN.
 *
 * WHY THIS IS A SKILL AND NOT NODE CODE
 * ─────────────────────────────────────
 * Every tenant's attendance setup is different: different 考勤组 names, a
 * different notion of "工时", and a per-tenant `自定义字段` group whose field
 * codes exist nowhere in our source. So the fetch CANNOT be hard-coded — the
 * model must DISCOVER what this tenant has (groups → members → available stat
 * fields) and pick columns from a natural-language ask ("拿工时和出勤天数").
 * That is why the surface leads with discovery tools and why every tool
 * description is written to be self-sufficient (the agent has no docs).
 * Deterministic aggregation/math over the returned rows is a DIFFERENT layer
 * and deliberately not here — these tools return Lark's rows faithfully.
 *
 * Auth: the SHARED Lark app resolver (larkApp.ts) — LARK_DOCS_* env, then
 * LARK_* env, then the backend `lark_docs` resolver — → tenant_access_token
 * (cached ~100min) → Bearer. It leads with the ACCOUNT-LEVEL app on purpose:
 * attendance is TENANT-WIDE (考勤组 are company-level, not per-project), while
 * `lark` chat connects PER PROJECT — `workflow-executor.js` resolves the chat
 * row with resolveChatIntegration(project override → account) and warns that an
 * account-only lookup for `lark` lands on a credential-less LARK_TENANT#
 * mapping row that silently yields nothing. Riding the project-scoped chat
 * credential would therefore give a project with no Lark chat binding NO
 * attendance data at all.
 *
 * KNOWN WRINKLE (deliberate, documented rather than hidden): the declared
 * integration is the existing account-level `lark_docs` card, so the Settings
 * UI does NOT tell an operator that the app behind that card also needs the
 * attendance scopes (attendance:rule:readonly + attendance:task:readonly, plus
 * contact:user.id:readonly for the email→user_id bridge). The additive upgrade
 * path is a dedicated `lark_attendance` provider + card inserted at the FRONT
 * of the fallback chain — zero migration for single-app setups, which keep
 * resolving through the existing trios.
 *
 * PRIVACY: attendance is HR data. There is no "dump the tenant" tool — every
 * data call takes an explicit, caller-supplied `userIds` scope, which is also
 * what Lark's own API requires. Group/field listings are metadata only.
 *
 * PROVENANCE: shapes below marked [WIRE-VERIFIED] were confirmed against a real
 * tenant on 2026-08-17; everything else comes from Lark's published docs. The
 * probe corrected the docs twice (the group endpoint's member field names, and
 * `user_id` being required on the stats query), so prefer the marked claims and
 * treat an unmarked one as "documented, not observed".
 *
 * Attendance v1 API (host-relative), all read paths:
 *   GET  /open-apis/attendance/v1/groups?page_size&page_token
 *          → { group_list:[{group_id,group_name}], page_token, has_more }
 *          scope: attendance:rule:readonly
 *   GET  /open-apis/attendance/v1/groups/{id}?employee_type&dept_type=open_id
 *          → { group_id, group_name, bind_user_ids, bind_dept_ids,
 *              except_user_ids, except_dept_ids, bind_default_user_ids,
 *              bind_default_dept_ids, need_punch_members,
 *              no_need_punch_members, ... }   [WIRE-VERIFIED]
 *          NB there is NO `member_ids` / `member_user_ids`; `bind_user_ids`
 *          IS the member list. `group_leader_ids` is documented but was not
 *          returned by the live tenant.
 *          scope: attendance:rule:readonly
 *   POST /open-apis/attendance/v1/user_stats_fields/query?employee_type
 *          body { locale, stats_type, start_date, end_date }  (≤40-day span)
 *          → { user_stats_field:{ fields:[{code,title,child_fields:[…]}] } }
 *          scope: attendance:task:readonly
 *   POST /open-apis/attendance/v1/user_stats_datas/query?employee_type
 *          body { locale, stats_type, start_date, end_date, user_ids(≤200),
 *                 user_id (REQUIRED — the OPERATOR; omitting it returns
 *                 1220001 "Need user_id" [WIRE-VERIFIED]),
 *                 need_history, current_group_only }  (≤31-day span)
 *          → { user_datas:[{name,user_id,datas:[{title,…}]}],
 *              invalid_user_list }   [WIRE-VERIFIED: ~43 cells per user for a
 *          one-month range — period totals + identity columns + one per DAY]
 *          scope: attendance:task:readonly
 *   POST /open-apis/attendance/v1/user_tasks/query?employee_type&ignore_invalid_users
 *          body { user_ids(≤50), check_date_from, check_date_to,
 *                 need_overtime_result }
 *          → { user_task_results:[…], invalid_user_ids, unauthorized_user_ids }
 *          scope: attendance:task:readonly
 *   POST /open-apis/contact/v3/users/batch_get_id?user_id_type=user_id
 *          body { emails } → { user_list:[{email,user_id}] }
 *          scope: contact:user.id:readonly
 */

import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve as resolvePath } from 'path';
import { INTEGRATIONS } from './integrations.js';
import { LARK_APP_ENV_KEYS, resolveLarkApp } from './larkApp.js';

/**
 * Resolve the generic skill MCP server binary (bin/mcp-skill.mjs), derived
 * from import.meta.url so it works in src/, dist/, and a published install.
 * Same rationale as larkDocs.ts / notion.ts.
 */
function resolveSkillBin() {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

// Lark's tenant_access_token TTL is ~2h. Cache slightly under that. A SEPARATE
// cache per module (lark.ts / larkDocs.ts each have their own) — the apps can
// differ, and the cache is keyed by appId so it can never serve the wrong one.
const TOKEN_TTL_MS = 100 * 60 * 1000;
let tokenCache: any = null; // { token, expiresAt, appId }

// ── Lark-documented limits. Enforced BEFORE the call so the agent gets a
// sentence it can act on instead of an opaque 1220001 "invalid parameters".
const GROUPS_PAGE_MAX = 50;          // groups?page_size ∈ [1,50], default 10
const GROUPS_PAGE_DEFAULT = 50;
const STATS_FIELDS_MAX_SPAN_DAYS = 40;
const STATS_DATA_MAX_SPAN_DAYS = 31;
const STATS_DATA_MAX_USERS = 200;
const TASKS_MAX_SPAN_DAYS = 31;
const TASKS_MAX_USERS = 50;
const BATCH_GET_ID_MAX_EMAILS = 50;  // contact v3 batch_get_id caps at 50

const STATS_TYPES = Object.freeze(['daily', 'month']);
const LOCALES = Object.freeze(['zh', 'en', 'ja']);
const EMPLOYEE_TYPES = Object.freeze(['employee_id', 'employee_no']);

/**
 * Every env name the SHARED app-credential resolution can read (→ envKeys).
 * DERIVED from larkApp.ts's precedence order — never a second hand-kept list.
 */
export const LARK_ATTENDANCE_APP_ENV_KEYS = LARK_APP_ENV_KEYS;

async function getTenantAccessToken() {
  // Auth chokepoint: the app credential comes from the SHARED resolver
  // (larkApp.ts) — docs/account app first, chat app fallback, backend last.
  const { appId, appSecret, host } = await resolveLarkApp();
  if (tokenCache && tokenCache.appId === appId && tokenCache.expiresAt > Date.now()) {
    return { token: tokenCache.token, host };
  }
  const res = await fetch(`${host}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // NEVER log this body — it carries the app secret.
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data: any = await res.json();
  if (data.code !== 0) {
    // data.msg is Lark's own message and never echoes the secret back.
    throw new Error(`Lark tenant_access_token failed: ${data.msg || data.code}`);
  }
  tokenCache = { token: data.tenant_access_token, expiresAt: Date.now() + TOKEN_TTL_MS, appId };
  return { token: data.tenant_access_token, host };
}

/**
 * Turn a Lark non-zero `code` into a sentence the AGENT can act on. The raw
 * codes are opaque (99991672 reads as nothing); the actionable part is always
 * "which scope is missing, on which app, and where to add it".
 */
function larkErrorMessage(path: string, code: any, msg: any) {
  const base = `Lark attendance API ${path} error ${code}: ${msg || '(no message)'}`;
  const scope = path.includes('/attendance/v1/groups')
    ? 'attendance:rule:readonly (打卡规则/考勤组 读取)'
    : path.includes('/contact/v3/users')
      ? 'contact:user.id:readonly (邮箱 → 用户 ID)'
      : 'attendance:task:readonly (打卡结果/统计数据 读取)';
  if (String(code) === '99991672' || /permission|scope|权限/i.test(String(msg || ''))) {
    return `${base}. The connected Lark app is missing the ${scope} permission — add it in the Lark/Feishu developer console (开发者后台 > 权限管理), then RE-PUBLISH a new app version so the scope takes effect.`;
  }
  if (String(code) === '1220002') {
    return `${base}. The tenant token was rejected — the Lark integration's app credentials look wrong; reconnect Lark in Integrations.`;
  }
  if (String(code) === '1220001') {
    return `${base}. Lark rejected the parameters — check the date range (yyyyMMdd, and within the documented span), stats_type, and that every user id matches the employeeType you passed.`;
  }
  return base;
}

/**
 * Low-level Lark REST helper. Resolves the tenant_access_token (the single
 * auth chokepoint), calls the host-relative path, returns the `data` payload.
 * Throws on a non-zero Lark `code` — handleToolCall catches + fail-softs.
 */
async function larkApi(method: string, path: string, body?: any) {
  const { token, host } = await getTenantAccessToken();
  const init: any = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
  };
  if (method !== 'GET' && body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${host}${path}`, init);
  const data: any = await res.json();
  if (data.code !== 0) throw new Error(larkErrorMessage(path, data.code, data.msg));
  return data.data || {};
}

// ── Argument normalization (pure, exported for tests) ───────────────────────

/**
 * Normalize a date argument to Lark's yyyyMMdd INTEGER form. Accepts
 * 20260401 (number), '20260401', '2026-04-01', '2026/04/01'. Returns null when
 * the value cannot be read as a real calendar date — callers turn that into an
 * explicit { ok:false } rather than sending garbage Lark answers 1220001 to.
 */
export function toLarkDate(value: any): number | null {
  if (value === null || value === undefined || value === '') return null;
  const digits = String(value).trim().replace(/[-/.]/g, '');
  if (!/^\d{8}$/.test(digits)) return null;
  const y = Number(digits.slice(0, 4));
  const m = Number(digits.slice(4, 6));
  const d = Number(digits.slice(6, 8));
  if (y < 1970 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Reject a date the calendar does not have (2026-02-30 → Mar 2 otherwise).
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return Number(digits);
}

/** Inclusive day span between two yyyyMMdd ints (20260401→20260401 = 1). */
export function daySpan(startInt: number, endInt: number): number {
  const asUtc = (n: number) => Date.UTC(
    Math.floor(n / 10000),
    Math.floor((n % 10000) / 100) - 1,
    n % 100,
  );
  return Math.floor((asUtc(endInt) - asUtc(startInt)) / 86400000) + 1;
}

/**
 * Validate + normalize the (startDate, endDate, span-cap) triple shared by the
 * three period-scoped tools. Returns { error } or { startDate, endDate }.
 */
function normalizePeriod(args: any, maxSpanDays: number) {
  const startDate = toLarkDate(args?.startDate ?? args?.start_date);
  const endDate = toLarkDate(args?.endDate ?? args?.end_date);
  if (!startDate || !endDate) {
    return { error: 'startDate and endDate are required, as yyyyMMdd (e.g. 20260401) or YYYY-MM-DD' };
  }
  if (endDate < startDate) return { error: 'endDate must not be earlier than startDate' };
  const span = daySpan(startDate, endDate);
  if (span > maxSpanDays) {
    return {
      error: `Lark caps this query at ${maxSpanDays} days; the requested range is ${span} days. `
        + 'Split it into consecutive windows and merge the results.',
    };
  }
  return { startDate, endDate };
}

/** The `user_ids` scope argument — REQUIRED, never implicitly "everyone". */
function normalizeUserIds(args: any, maxUsers: number) {
  const raw = args?.userIds ?? args?.user_ids;
  const ids = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [])
    .map((v: any) => String(v || '').trim())
    .filter(Boolean);
  if (!ids.length) {
    return {
      error: 'userIds is required — attendance data is personal, so this tool never returns a whole tenant. '
        + 'Get the ids from larkattendance_get_group (bind_user_ids) or larkattendance_resolve_users.',
    };
  }
  if (ids.length > maxUsers) {
    // Truncating would silently drop people from a report — refuse instead.
    return { error: `Lark accepts at most ${maxUsers} user ids per call; ${ids.length} were passed. Split into batches.` };
  }
  return { ids };
}

function pickEnum(value: any, allowed: readonly string[], fallback: string) {
  const v = String(value || '').trim().toLowerCase();
  return allowed.includes(v) ? v : fallback;
}

function employeeTypeArg(args: any) {
  return pickEnum(args?.employeeType ?? args?.employee_type, EMPLOYEE_TYPES, 'employee_id');
}

// ── Response shaping ────────────────────────────────────────────────────────

/** A stat field group as returned by user_stats_fields/query. */
function shapeFieldGroup(g: any) {
  return {
    code: String(g?.code || ''),
    title: String(g?.title || ''),
    fields: (Array.isArray(g?.child_fields) ? g.child_fields : []).map((f: any) => ({
      code: String(f?.code || ''),
      title: String(f?.title || ''),
      ...(f?.time_unit ? { timeUnit: String(f.time_unit) } : {}),
    })),
  };
}

/** One person's stat row from user_stats_datas/query. */
function shapeUserStats(u: any, wanted: Set<string> | null) {
  const datas = Array.isArray(u?.datas) ? u.datas : [];
  const fields = datas
    .filter((d: any) => !wanted || wanted.has(String(d?.code || '')) || wanted.has(String(d?.title || '')))
    .map((d: any) => ({
      code: String(d?.code || ''),
      title: String(d?.title || ''),
      value: d?.value === undefined || d?.value === null ? '' : String(d.value),
      ...(d?.duration_num ? { durationNum: d.duration_num } : {}),
      ...(Array.isArray(d?.features) && d.features.length ? { features: d.features } : {}),
    }));
  return { userId: String(u?.user_id || ''), name: String(u?.name || ''), fields };
}

/** One person-day of clock-in/out results from user_tasks/query. */
function shapeUserTask(t: any) {
  return {
    userId: String(t?.user_id || ''),
    name: String(t?.employee_name || ''),
    day: t?.day ?? null,
    groupId: String(t?.group_id || ''),
    shiftId: String(t?.shift_id || ''),
    records: (Array.isArray(t?.records) ? t.records : []).map((r: any) => ({
      checkInTime: r?.check_in_record?.check_time ?? null,
      checkInResult: String(r?.check_in_result || ''),
      checkInResultSupplement: String(r?.check_in_result_supplement || ''),
      checkInShiftTime: r?.check_in_shift_time ?? null,
      checkOutTime: r?.check_out_record?.check_time ?? null,
      checkOutResult: String(r?.check_out_result || ''),
      checkOutResultSupplement: String(r?.check_out_result_supplement || ''),
      checkOutShiftTime: r?.check_out_shift_time ?? null,
      ...(r?.task_shift_type === undefined ? {} : { taskShiftType: r.task_shift_type }),
    })),
  };
}

export const larkAttendanceSkill: any = {
  id: 'lark-attendance',
  // Backend-calling: with no injected LARK_* env (every Copilot turn) the MCP
  // child asks Zibby's own backend for the app credential — the session-env
  // contract is guaranteed by backendSession.ts at registration (declare ONCE
  // here; see backend-session-env-contract.test.ts).
  callsBackend: true,
  serverName: 'larkattendance',            // tools appear as mcp__larkattendance__<tool>
  allowedTools: ['mcp__larkattendance__*'],
  // The ACCOUNT-LEVEL Lark app (integration `lark_docs`) is the declared
  // requirement — matches the backend REQUIRED_INTEGRATION_MAP entry
  // `lark-attendance` → INTEGRATIONS.LARK_DOCS, and matches the resolution
  // order above (attendance is tenant-wide; `lark` chat is project-scoped).
  // The CHAT app is accepted as the single-app fallback because resolveLarkApp()
  // really does fall back to it. An ARRAY means "any ONE of these" to both
  // availability gates (agent-workflow strategy-registry + core strategies).
  requiresIntegration: [INTEGRATIONS.LARK_DOCS, INTEGRATIONS.LARK],
  description: 'Lark / Feishu attendance (考勤) — discover attendance groups and statistic fields, then read per-user work-hour / attendance statistics and clock-in records. Read-only.',
  // envKeys IS the spawned MCP child's ENTIRE environment — not an addition to
  // it (CLAUDE.md; this trap bit github, gitlab, lark and lark-docs). BOTH
  // halves must be listed:
  //   - BOTH app-credential trios the executor injects (LARK_DOCS_* and LARK_*)
  //     — else the child never sees what was injected and always pays the
  //     backend round-trip. DERIVED from larkApp.ts's precedence order, so
  //     there is no second hand-kept list;
  //   - the backend-session keys that round-trip authenticates with (else the
  //     child dies with the misleading "No session token. Run `zibby login`").
  // Deliberately an ALLOWLIST: no ANTHROPIC_API_KEY / AWS creds reach it.
  envKeys: ['PROJECT_API_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_ENV', ...LARK_ATTENDANCE_APP_ENV_KEYS],

  promptFragment: `## Lark Attendance (考勤)
Read-only access to this tenant's Lark/Feishu attendance data. NOTHING about the tenant's setup is known in advance — group names, what counts as "工时", and the per-tenant 自定义字段 all differ — so DISCOVER before you fetch:
1. \`larkattendance_list_groups\` → the 考勤组 that exist.
2. \`larkattendance_get_group\` → that group's member user ids (the scope for every data call).
3. \`larkattendance_list_stats_fields\` → every statistic column available for the period, INCLUDING this tenant's 自定义字段. Match the user's words ("工时", "出勤天数", …) against the returned \`title\`s and pass the matching \`code\`s onward.
4. \`larkattendance_query_stats\` (aggregated numbers) and/or \`larkattendance_query_records\` (raw clock-in/out).
\`larkattendance_query_stats\` also needs an \`operatorUserId\` — the attendance admin the query runs AS. Lark rejects the call without one, and it selects the saved statistics view that decides which columns come back, so this skill refuses to invent it: if the prompt did not supply one, ASK for it rather than substituting a member id.
Identity mapping: attendance ids are the tenant \`user_id\` (employee_id), NOT the \`open_id\` the \`lark\` skill's \`lark_lookup_user_by_email\` returns — use \`larkattendance_resolve_users\` to turn emails into attendance ids. For chat/DM routing keep using the \`lark\` skill's tools.
Attendance is personal HR data: every data tool requires an explicit \`userIds\` list, and there is no whole-tenant dump. Report the numbers as returned; do not invent a column the tenant does not have.
These tools return { ok:false, error } on failure — read the error, it names the missing permission or the range limit.`,

  /**
   * Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs) pointing at this
   * module's larkAttendanceSkill export, so the AGENT gets real
   * mcp__larkattendance__* tools. The child does NOT inherit the run env — the
   * env returned here IS its entire environment, so envKeys is forwarded
   * verbatim (backendSession.ts additionally guarantees the session keys).
   */
  resolve() {
    const bin = resolveSkillBin();
    if (!bin) return null;
    const env: any = {};
    for (const key of this.envKeys) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/larkAttendance.js', 'larkAttendanceSkill'],
      env,
      description: this.description,
      // Force tools into the system prompt instead of deferring behind the
      // SDK's ToolSearch (see larkDocs.ts / notion.ts resolve()).
      alwaysLoad: true,
    };
  },

  async handleToolCall(name: string, args: any) {
    try {
      switch (name) {
        case 'larkattendance_list_groups': {
          const requested = Number(args?.pageSize ?? args?.page_size);
          const pageSize = Number.isFinite(requested) && requested > 0
            ? Math.min(Math.floor(requested), GROUPS_PAGE_MAX)
            : GROUPS_PAGE_DEFAULT;
          const qs = new URLSearchParams({ page_size: String(pageSize) });
          const pageToken = String(args?.pageToken ?? args?.page_token ?? '').trim();
          if (pageToken) qs.set('page_token', pageToken);
          const data = await larkApi('GET', `/open-apis/attendance/v1/groups?${qs.toString()}`);
          const groups = (Array.isArray(data?.group_list) ? data.group_list : []).map((g: any) => ({
            groupId: String(g?.group_id || ''),
            groupName: String(g?.group_name || ''),
          }));
          return JSON.stringify({
            ok: true,
            count: groups.length,
            groups,
            hasMore: Boolean(data?.has_more),
            ...(data?.has_more && data?.page_token ? { pageToken: String(data.page_token) } : {}),
          });
        }

        case 'larkattendance_get_group': {
          const groupId = String(args?.groupId ?? args?.group_id ?? '').trim();
          if (!groupId) return JSON.stringify({ ok: false, error: 'groupId is required (from larkattendance_list_groups)' });
          const employeeType = employeeTypeArg(args);
          const qs = new URLSearchParams({ employee_type: employeeType, dept_type: 'open_id' });
          const data = await larkApi(
            'GET',
            `/open-apis/attendance/v1/groups/${encodeURIComponent(groupId)}?${qs.toString()}`,
          );
          const arr = (v: any) => (Array.isArray(v) ? v.map((x: any) => String(x)) : []);
          // WIRE-VERIFIED (live tenant, 2026-08-17): the id-bearing keys this
          // endpoint really returns are bind_user_ids (the member list — 217
          // ids there), bind_dept_ids, except_user_ids, except_dept_ids,
          // bind_default_user_ids, bind_default_dept_ids, plus the
          // need_punch_members / no_need_punch_members object arrays.
          // `member_ids` and `member_user_ids` DO NOT EXIST — do not reach for
          // the obvious-sounding name. Three distinct exclusion concepts are
          // kept distinct here rather than collapsed into one "exempt" bag:
          //   except_*        — removed from the group entirely
          //   bind_default_*  — in the group but not required to punch
          // The scoped-rule arrays (need_punch_members / no_need_punch_members)
          // are deliberately NOT mapped: their element shape is not
          // wire-verified, and inventing field names is exactly the bug this
          // comment exists to prevent.
          return JSON.stringify({
            ok: true,
            groupId: String(data?.group_id || groupId),
            groupName: String(data?.group_name || ''),
            employeeType,
            memberUserIds: arr(data?.bind_user_ids),
            memberDeptIds: arr(data?.bind_dept_ids),
            excludedUserIds: arr(data?.except_user_ids),
            excludedDeptIds: arr(data?.except_dept_ids),
            noPunchUserIds: arr(data?.bind_default_user_ids),
            noPunchDeptIds: arr(data?.bind_default_dept_ids),
            // Documented by Lark but ABSENT from the live response, so it is
            // omitted rather than reported as an empty array — "[]" would read
            // as "this group has no leaders", which is a different claim from
            // "Lark did not tell us". Nothing may source the stats operator id
            // from here (see larkattendance_query_stats).
            ...(Array.isArray(data?.group_leader_ids)
              ? { leaderUserIds: arr(data.group_leader_ids) }
              : {}),
          });
        }

        case 'larkattendance_list_stats_fields': {
          const period: any = normalizePeriod(args, STATS_FIELDS_MAX_SPAN_DAYS);
          if (period.error) return JSON.stringify({ ok: false, error: period.error });
          const statsType = pickEnum(args?.statsType ?? args?.stats_type, STATS_TYPES, 'month');
          const locale = pickEnum(args?.locale, LOCALES, 'zh');
          const employeeType = employeeTypeArg(args);
          const data = await larkApi(
            'POST',
            `/open-apis/attendance/v1/user_stats_fields/query?employee_type=${encodeURIComponent(employeeType)}`,
            { locale, stats_type: statsType, start_date: period.startDate, end_date: period.endDate },
          );
          const field = data?.user_stats_field || {};
          const groups = (Array.isArray(field?.fields) ? field.fields : []).map(shapeFieldGroup);
          return JSON.stringify({
            ok: true,
            statsType,
            locale,
            startDate: period.startDate,
            endDate: period.endDate,
            fieldGroupCount: groups.length,
            fieldGroups: groups,
          });
        }

        case 'larkattendance_query_stats': {
          const period: any = normalizePeriod(args, STATS_DATA_MAX_SPAN_DAYS);
          if (period.error) return JSON.stringify({ ok: false, error: period.error });
          const scope: any = normalizeUserIds(args, STATS_DATA_MAX_USERS);
          if (scope.error) return JSON.stringify({ ok: false, error: scope.error });
          const statsType = pickEnum(args?.statsType ?? args?.stats_type, STATS_TYPES, 'month');
          const locale = pickEnum(args?.locale, LOCALES, 'zh');
          const employeeType = employeeTypeArg(args);
          // REQUIRED, and we refuse rather than guess. WIRE-VERIFIED (live
          // tenant, 2026-08-17): the identical body WITHOUT a top-level
          // `user_id` returns code 1220001 "Need user_id" and empty data; WITH
          // one it returns code 0 and real rows. This is a THIRD identity,
          // distinct from the `user_ids` array (whose data you want) and from
          // `employee_type` (the id FORM) — it is the querying OPERATOR.
          //
          // WHY NO DEFAULT: the operator selects which saved statistics VIEW
          // applies, and the view decides WHICH COLUMNS come back. Substituting
          // some id we happened to have (the first member, the group's
          // bind_default_user_ids, …) would return a full, plausible,
          // successfully-parsed table built from the WRONG column set — a
          // silently-wrong answer, the one failure mode worth refusing a call
          // over. So an absent operator is a loud local error, never a guess.
          const operatorUserId = String(args?.operatorUserId ?? args?.user_id ?? '').trim();
          if (!operatorUserId) {
            return JSON.stringify({
              ok: false,
              error: 'operatorUserId is required by Lark (the API rejects this call with 1220001 "Need user_id"). '
                + 'It is the OPERATOR performing the query — a third id, not one of `userIds` and not `employeeType`. '
                + 'It must be a user whose saved attendance statistics view contains the columns you want (normally an '
                + 'attendance admin), because that view decides which columns Lark returns. This skill will NOT pick one '
                + 'for you: substituting an arbitrary member would silently return the wrong column set instead of failing. '
                + 'Ask the caller/prompt for the attendance admin\'s user id, or resolve their email with '
                + 'larkattendance_resolve_users.',
            });
          }
          const body: any = {
            locale,
            stats_type: statsType,
            start_date: period.startDate,
            end_date: period.endDate,
            user_ids: scope.ids,
            user_id: operatorUserId,
            need_history: args?.needHistory === true,
            current_group_only: args?.currentGroupOnly === true,
          };

          const rawCodes = Array.isArray(args?.fieldCodes) ? args.fieldCodes : null;
          const wantedCodes: string[] = rawCodes
            ? rawCodes.map((c: any) => String(c || '').trim()).filter(Boolean)
            : [];
          const wanted = wantedCodes.length ? new Set<string>(wantedCodes) : null;

          const data = await larkApi(
            'POST',
            `/open-apis/attendance/v1/user_stats_datas/query?employee_type=${encodeURIComponent(employeeType)}`,
            body,
          );
          const users = (Array.isArray(data?.user_datas) ? data.user_datas : [])
            .map((u: any) => shapeUserStats(u, wanted));
          return JSON.stringify({
            ok: true,
            statsType,
            startDate: period.startDate,
            endDate: period.endDate,
            employeeType,
            userCount: users.length,
            users,
            invalidUserIds: Array.isArray(data?.invalid_user_list)
              ? data.invalid_user_list.map((x: any) => String(x))
              : [],
          });
        }

        case 'larkattendance_query_records': {
          const period: any = normalizePeriod(
            {
              startDate: args?.startDate ?? args?.checkDateFrom ?? args?.check_date_from,
              endDate: args?.endDate ?? args?.checkDateTo ?? args?.check_date_to,
            },
            TASKS_MAX_SPAN_DAYS,
          );
          if (period.error) return JSON.stringify({ ok: false, error: period.error });
          const scope: any = normalizeUserIds(args, TASKS_MAX_USERS);
          if (scope.error) return JSON.stringify({ ok: false, error: scope.error });
          const employeeType = employeeTypeArg(args);
          const qs = new URLSearchParams({
            employee_type: employeeType,
            // Report unknown ids in `invalidUserIds` instead of failing the
            // whole batch — a departed employee must not kill a month's report.
            ignore_invalid_users: 'true',
          });
          if (args?.includeTerminatedUser === true) qs.set('include_terminated_user', 'true');
          const data = await larkApi(
            'POST',
            `/open-apis/attendance/v1/user_tasks/query?${qs.toString()}`,
            {
              user_ids: scope.ids,
              check_date_from: period.startDate,
              check_date_to: period.endDate,
              need_overtime_result: args?.needOvertimeResult === true,
            },
          );
          const results = (Array.isArray(data?.user_task_results) ? data.user_task_results : [])
            .map(shapeUserTask);
          return JSON.stringify({
            ok: true,
            startDate: period.startDate,
            endDate: period.endDate,
            employeeType,
            count: results.length,
            results,
            invalidUserIds: Array.isArray(data?.invalid_user_ids) ? data.invalid_user_ids.map((x: any) => String(x)) : [],
            unauthorizedUserIds: Array.isArray(data?.unauthorized_user_ids) ? data.unauthorized_user_ids.map((x: any) => String(x)) : [],
          });
        }

        case 'larkattendance_resolve_users': {
          const raw = args?.emails;
          const emails = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [])
            .map((v: any) => String(v || '').trim())
            .filter(Boolean);
          if (!emails.length) return JSON.stringify({ ok: false, error: 'emails is required (a non-empty array of work email addresses)' });
          if (emails.length > BATCH_GET_ID_MAX_EMAILS) {
            return JSON.stringify({ ok: false, error: `At most ${BATCH_GET_ID_MAX_EMAILS} emails per call; ${emails.length} were passed. Split into batches.` });
          }
          // user_id_type=user_id → the tenant user_id, which is exactly what the
          // attendance API calls `employee_id`. (The `lark` skill's
          // lark_lookup_user_by_email asks for open_id, which these endpoints
          // reject — that is why this tool exists rather than reusing it.)
          const data = await larkApi(
            'POST',
            '/open-apis/contact/v3/users/batch_get_id?user_id_type=user_id',
            { emails },
          );
          const list = Array.isArray(data?.user_list) ? data.user_list : [];
          const users = list
            .filter((u: any) => u?.user_id)
            .map((u: any) => ({ email: String(u?.email || ''), userId: String(u.user_id) }));
          const found = new Set(users.map((u: any) => u.email));
          return JSON.stringify({
            ok: true,
            employeeType: 'employee_id',
            users,
            notFound: emails.filter((e) => !found.has(e)),
          });
        }

        default:
          return JSON.stringify({ ok: false, error: `Unknown tool: ${name}` });
      }
    } catch (e: any) {
      // NEVER throw — a broken/missing Lark connection must not crash the run.
      return JSON.stringify({ ok: false, error: e?.message || String(e) });
    }
  },

  tools: [
    {
      name: 'larkattendance_list_groups',
      description: 'DISCOVERY (start here). List this tenant\'s Lark/Feishu attendance groups (考勤组) — their names are tenant-specific, so never assume one. Returns { ok, count, groups:[{ groupId, groupName }], hasMore, pageToken }. When hasMore is true, call again with pageToken to continue. Needs the attendance:rule:readonly permission on the connected Lark app.',
      input_schema: {
        type: 'object',
        properties: {
          pageSize: { type: 'number', description: 'Groups per page, 1-50 (default 50).' },
          pageToken: { type: 'string', description: 'Cursor from a previous call\'s pageToken — omit for the first page.' },
        },
      },
    },
    {
      name: 'larkattendance_get_group',
      description: 'DISCOVERY. Read one attendance group and, crucially, ITS MEMBERS — memberUserIds is the scope you pass as userIds to larkattendance_query_stats / larkattendance_query_records (a real group can hold hundreds, so expect to batch). Returns { ok, groupId, groupName, employeeType, memberUserIds, memberDeptIds, excludedUserIds, excludedDeptIds, noPunchUserIds, noPunchDeptIds }. THREE different exclusion lists, do not conflate them: excludedUserIds are removed from the group; noPunchUserIds are in the group but not required to clock in (they still have statistics). Members bound by DEPARTMENT appear in memberDeptIds, not memberUserIds — resolve those people another way (e.g. larkattendance_resolve_users from emails you already have). Lark does not reliably return the group leaders here, so leaderUserIds may be absent — never source the query operator id from this tool.',
      input_schema: {
        type: 'object',
        properties: {
          groupId: { type: 'string', description: 'Attendance group id from larkattendance_list_groups.' },
          employeeType: { type: 'string', description: "Which id form to return members in: 'employee_id' (tenant user_id, the default and what every other tool here expects) or 'employee_no' (工号)." },
        },
        required: ['groupId'],
      },
    },
    {
      name: 'larkattendance_list_stats_fields',
      description: 'DISCOVERY — call this BEFORE larkattendance_query_stats. Lists every statistic column this tenant has for the period, grouped (e.g. 基本信息 / 出勤统计 / 异常统计 / 每日统计 / 自定义字段). The 自定义字段 group is tenant-defined and exists nowhere else, so this is the only way to learn its codes. Match the user\'s wording ("工时", "出勤天数", "迟到次数") against the returned `title`s and pass the matching `code`s as fieldCodes to larkattendance_query_stats. Returns { ok, statsType, locale, startDate, endDate, fieldGroups:[{ code, title, fields:[{ code, title, timeUnit }] }] }. Range is capped at 40 days.',
      input_schema: {
        type: 'object',
        properties: {
          startDate: { type: 'string', description: 'Period start as yyyyMMdd (20260401) or YYYY-MM-DD.' },
          endDate: { type: 'string', description: 'Period end, same format. At most 40 days after startDate.' },
          statsType: { type: 'string', description: "'month' (default) for period totals, or 'daily' for per-day columns." },
          locale: { type: 'string', description: "Field-title language: 'zh' (default), 'en', or 'ja'." },
          employeeType: { type: 'string', description: "'employee_id' (default) or 'employee_no'." },
        },
        required: ['startDate', 'endDate'],
      },
    },
    {
      name: 'larkattendance_query_stats',
      description: 'The numbers: per-user attendance statistics (work hours, attendance days, exceptions, custom fields) for a period. Needs THREE separate things: userIds (whose data you want, max 200), operatorUserId (WHO IS ASKING — required by Lark, see below), and the date range (max 31 days). Attendance is personal data and there is no whole-tenant read; get ids from larkattendance_get_group or larkattendance_resolve_users. Returns { ok, statsType, startDate, endDate, users:[{ userId, name, fields:[{ code, title, value, durationNum? }] }], invalidUserIds }. Values are STRINGS exactly as Lark returns them — report them as-is, do not re-derive. EXPECT MANY COLUMNS: a one-month query returns roughly 40+ cells per person, because Lark mixes period totals (e.g. an "actual attendance hours" column, late/early counts) with identity columns (department, employee number) AND one column PER DAY of the range — so match on `title` rather than assuming a short list, and pass fieldCodes to trim. The exact set of columns follows the SAVED STATISTICS VIEW of the operatorUserId (考勤 > 统计设置), so if a field that larkattendance_list_stats_fields advertises is missing from the result, it is switched off in that operator\'s view and an admin must enable it — or you are querying as the wrong operator.',
      input_schema: {
        type: 'object',
        properties: {
          userIds: { type: 'array', items: { type: 'string' }, description: 'The people to report on, in the employeeType id form. Max 200. Required.' },
          startDate: { type: 'string', description: 'Period start as yyyyMMdd (20260401) or YYYY-MM-DD.' },
          endDate: { type: 'string', description: 'Period end, same format. At most 31 days after startDate.' },
          statsType: { type: 'string', description: "'month' (default) for period totals, or 'daily' for per-day rows." },
          fieldCodes: { type: 'array', items: { type: 'string' }, description: 'Optional filter — only these field codes/titles are returned. Omit to get every column.' },
          locale: { type: 'string', description: "Field-title language: 'zh' (default), 'en', or 'ja'." },
          employeeType: { type: 'string', description: "'employee_id' (default) or 'employee_no' — must match the form of userIds." },
          operatorUserId: { type: 'string', description: 'REQUIRED. The user id of the OPERATOR performing the query — a third id, distinct from `userIds` (whose data you want) and from `employeeType` (the id form). Lark rejects the call without it (1220001 "Need user_id"). It should be an attendance admin whose saved statistics view contains the columns you need, because that view decides which columns come back. This skill will not pick one for you — get it from the caller/prompt, or from an email via larkattendance_resolve_users.' },
          needHistory: { type: 'boolean', description: 'Include transferred/departed staff (default false).' },
          currentGroupOnly: { type: 'boolean', description: 'Restrict to the user\'s current attendance group (default false).' },
        },
        required: ['userIds', 'operatorUserId', 'startDate', 'endDate'],
      },
    },
    {
      name: 'larkattendance_query_records',
      description: 'The raw clock-in/out results (打卡结果) per person per day — use when the aggregated statistics are not enough (e.g. to show which days were late, or the actual punch times). REQUIRES an explicit userIds list (max 50); range capped at 31 days. Returns { ok, results:[{ userId, name, day, groupId, shiftId, records:[{ checkInTime, checkInResult, checkOutTime, checkOutResult, checkInShiftTime, checkOutShiftTime }] }], invalidUserIds, unauthorizedUserIds }. Unknown ids are reported in invalidUserIds rather than failing the batch. Result values are Lark\'s own enums (Normal / Early / Late / Lack / …).',
      input_schema: {
        type: 'object',
        properties: {
          userIds: { type: 'array', items: { type: 'string' }, description: 'The people to read, in the employeeType id form. Max 50. Required.' },
          startDate: { type: 'string', description: 'First day as yyyyMMdd (20260401) or YYYY-MM-DD.' },
          endDate: { type: 'string', description: 'Last day, same format. At most 31 days after startDate.' },
          employeeType: { type: 'string', description: "'employee_id' (default) or 'employee_no' — must match the form of userIds." },
          needOvertimeResult: { type: 'boolean', description: 'Also return overtime shift records (default false).' },
          includeTerminatedUser: { type: 'boolean', description: 'Include departed employees (default false).' },
        },
        required: ['userIds', 'startDate', 'endDate'],
      },
    },
    {
      name: 'larkattendance_resolve_users',
      description: 'Map work EMAIL addresses to the attendance user ids (tenant user_id = the attendance API\'s employee_id). Use this to line a report\'s people up with attendance rows. NOTE this is deliberately different from the `lark` skill\'s lark_lookup_user_by_email, which returns an open_id for chat/DM — the attendance endpoints reject open_ids. Max 50 emails per call. Returns { ok, employeeType:"employee_id", users:[{ email, userId }], notFound:[email] }. Needs the contact:user.id:readonly permission.',
      input_schema: {
        type: 'object',
        properties: {
          emails: { type: 'array', items: { type: 'string' }, description: 'Work email addresses to resolve. Max 50.' },
        },
        required: ['emails'],
      },
    },
  ],
};

// Test-only: lets vitest reset the token cache between cases.
export function _resetLarkAttendanceTokenCache() {
  tokenCache = null;
}
