/**
 * lark-attendance — the declaration, the guard rails, and the wire shape.
 *
 * What is pinned here, and WHY each one is worth a test:
 *   - AUTH: it mints from the ACCOUNT-LEVEL app (LARK_DOCS_* → LARK_* → backend
 *     `lark_docs`). Attendance is tenant-wide while Lark CHAT connects PER
 *     PROJECT, so riding `lark` would silently return nothing for a project
 *     with no chat binding (workflow-executor.js says as much in prose; this
 *     asserts it in code).
 *   - envKeys: the child's env IS this list. The trap has now bitten github,
 *     gitlab, lark and lark-docs — so the six app-cred names AND the three
 *     session keys are asserted, and the deny-list (ANTHROPIC_API_KEY / AWS)
 *     is asserted too.
 *   - PRIVACY: every data tool refuses without an explicit userIds scope, and
 *     refuses (rather than silently truncating) an over-cap batch — a truncated
 *     batch would quietly drop people out of an HR report.
 *   - PURE HELPERS: date normalization + span math, which is where an opaque
 *     Lark 1220001 would otherwise come from.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGINAL = { ...process.env };
const AUTH_PATH = '/open-apis/auth/v3/tenant_access_token/internal';

const resolveIntegrationToken = vi.fn();
vi.mock('@zibby/core/backend-client.js', () => ({
  resolveIntegrationToken: (...args: any[]) => resolveIntegrationToken(...args),
}));

type Call = { url: string; init: any };

/**
 * Drive ONE tool call against a stubbed Lark, returning the parsed tool result
 * plus every HTTP call made. A fresh module instance each time so the
 * module-level token cache can never leak an earlier case's app.
 */
async function drive(
  tool: string,
  args: any,
  respond: (url: string, init: any) => any = () => ({ code: 0, data: {} }),
): Promise<{ result: any; calls: Call[]; minted: any }> {
  vi.resetModules();
  const calls: Call[] = [];
  let minted: any = null;
  vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes(AUTH_PATH)) {
      const body = JSON.parse(init.body);
      minted = { url: u, appId: body.app_id, appSecret: body.app_secret };
      return { json: async () => ({ code: 0, tenant_access_token: 't-abc' }) };
    }
    return { json: async () => respond(u, init) };
  }));
  const { larkAttendanceSkill } = await import('../larkAttendance.js');
  const raw = await larkAttendanceSkill.handleToolCall(tool, args);
  return { result: JSON.parse(raw), calls, minted };
}

/** The one call that is not the token mint. */
function apiCall(calls: Call[]): Call {
  const hit = calls.find((c) => !c.url.includes(AUTH_PATH));
  if (!hit) throw new Error('no Lark API call was made');
  return hit;
}

beforeEach(() => {
  resolveIntegrationToken.mockReset();
  for (const k of Object.keys(process.env)) if (k.startsWith('LARK')) delete process.env[k];
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL };
});

describe('lark-attendance declaration', () => {
  test('requires the ACCOUNT-LEVEL app first, chat app as the single-app fallback', async () => {
    vi.resetModules();
    const { larkAttendanceSkill } = await import('../larkAttendance.js');
    // Provider IDS, never display labels — the card's name is free to change.
    expect(larkAttendanceSkill.requiresIntegration).toEqual(['lark_docs', 'lark']);
    expect(larkAttendanceSkill.id).toBe('lark-attendance');
    expect(larkAttendanceSkill.serverName).toBe('larkattendance');
    expect(larkAttendanceSkill.allowedTools).toEqual(['mcp__larkattendance__*']);
    expect(larkAttendanceSkill.callsBackend).toBe(true);
  });

  test('the id is the one @zibby/skill-ids publishes', async () => {
    const { SKILL_IDS } = await import('@zibby/skill-ids');
    const { larkAttendanceSkill } = await import('../larkAttendance.js');
    expect(SKILL_IDS.LARK_ATTENDANCE).toBe(larkAttendanceSkill.id);
  });

  test('TRIPWIRE: envKeys carries BOTH app trios and the session keys', async () => {
    vi.resetModules();
    const { larkAttendanceSkill } = await import('../larkAttendance.js');
    // envKeys IS the spawned MCP child's ENTIRE environment. A name the
    // resolution reads but the list omits is simply absent there, and the
    // failure surfaces as a confusing auth error rather than a missing-env one.
    // The reader side is the SHARED resolver, so scan THAT file for the names.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'larkApp.ts'), 'utf8',
    );
    const read = new Set(Array.from(src.matchAll(/\bLARK[A-Z0-9_]*\b/g), (m) => m[0])
      .filter((n) => /^LARK(_DOCS)?_(APP_ID|APP_SECRET|HOST)$/.test(n)));
    expect(read.size).toBe(6);
    for (const key of read) expect(larkAttendanceSkill.envKeys).toContain(key);
    for (const key of ['PROJECT_API_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_ENV']) {
      expect(larkAttendanceSkill.envKeys).toContain(key);
    }
  });

  test('the child env is an ALLOWLIST — no model or cloud credentials reach it', async () => {
    vi.resetModules();
    const { larkAttendanceSkill } = await import('../larkAttendance.js');
    const set: Record<string, string> = {
      LARK_APP_ID: 'cli_x',
      ANTHROPIC_API_KEY: 'must-not-reach-the-child',
      AWS_SECRET_ACCESS_KEY: 'must-not-reach-the-child',
    };
    Object.assign(process.env, set);
    try {
      const resolved = larkAttendanceSkill.resolve();
      expect(resolved?.command).toBeTruthy();
      expect(resolved.env.LARK_APP_ID).toBe('cli_x');
      expect(resolved.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(resolved.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    } finally {
      for (const k of Object.keys(set)) delete process.env[k];
    }
  });

  test('every declared tool is dispatchable and read-only by name', async () => {
    vi.resetModules();
    const { larkAttendanceSkill } = await import('../larkAttendance.js');
    const names = larkAttendanceSkill.tools.map((t: any) => t.name).sort();
    expect(names).toEqual([
      'larkattendance_get_group',
      'larkattendance_list_groups',
      'larkattendance_list_stats_fields',
      'larkattendance_query_records',
      'larkattendance_query_stats',
      'larkattendance_resolve_users',
    ]);
    for (const t of larkAttendanceSkill.tools) {
      expect(t.description.length, `${t.name} needs a self-sufficient description`).toBeGreaterThan(80);
      const { result } = await drive(t.name, {});
      // Unknown-tool is the ONLY thing dispatch must never answer for a
      // declared tool (a name typo in the switch would show up exactly here).
      expect(String(result.error || '')).not.toMatch(/Unknown tool/);
    }
  });
});

describe('lark-attendance auth', () => {
  test('LARK_DOCS_* env wins — the account-level app the executor injected', async () => {
    process.env.LARK_DOCS_APP_ID = 'cli_account';
    process.env.LARK_DOCS_APP_SECRET = 'account-secret';
    process.env.LARK_DOCS_HOST = 'https://open.feishu.cn';
    process.env.LARK_APP_ID = 'cli_chat';
    process.env.LARK_APP_SECRET = 'chat-secret';

    const { minted } = await drive('larkattendance_list_groups', {});
    expect(minted?.appId).toBe('cli_account');
    expect(minted?.url.startsWith('https://open.feishu.cn')).toBe(true);
    expect(resolveIntegrationToken).not.toHaveBeenCalled();
  });

  test('LARK_* env is the single-app fallback', async () => {
    process.env.LARK_APP_ID = 'cli_chat';
    process.env.LARK_APP_SECRET = 'chat-secret';
    const { minted } = await drive('larkattendance_list_groups', {});
    expect(minted?.appId).toBe('cli_chat');
    expect(minted?.url.startsWith('https://open.larksuite.com')).toBe(true);
  });

  test('with no env it asks the backend for lark_docs — never bare lark', async () => {
    resolveIntegrationToken.mockResolvedValue({
      appId: 'cli_from_backend', appSecret: 's', host: 'open.feishu.cn',
    });
    const { minted } = await drive('larkattendance_list_groups', {});
    const asked = resolveIntegrationToken.mock.calls.map((c) => c[0]);
    expect(asked).toContain('lark_docs');
    expect(asked).not.toContain('lark');
    expect(minted?.appId).toBe('cli_from_backend');
  });

  test('a Lark error never crashes the run and names the missing scope', async () => {
    process.env.LARK_APP_ID = 'cli_chat';
    process.env.LARK_APP_SECRET = 'chat-secret';
    const { result } = await drive(
      'larkattendance_list_groups', {},
      () => ({ code: 99991672, msg: 'no permission' }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/attendance:rule:readonly/);
    expect(result.error).toMatch(/RE-PUBLISH/);
  });
});

describe('lark-attendance guard rails', () => {
  beforeEach(() => {
    process.env.LARK_APP_ID = 'cli_chat';
    process.env.LARK_APP_SECRET = 'chat-secret';
  });

  test('no whole-tenant read: the data tools refuse without an explicit userIds scope', async () => {
    for (const tool of ['larkattendance_query_stats', 'larkattendance_query_records']) {
      const { result, calls } = await drive(tool, { startDate: '2026-04-01', endDate: '2026-04-30' });
      expect(result.ok, tool).toBe(false);
      expect(result.error, tool).toMatch(/userIds is required/);
      // And nothing was sent to Lark at all.
      expect(calls.filter((c) => !c.url.includes(AUTH_PATH)), tool).toHaveLength(0);
    }
  });

  test('an over-cap batch is REFUSED, never silently truncated', async () => {
    const many = Array.from({ length: 201 }, (_, i) => `u${i}`);
    const { result } = await drive('larkattendance_query_stats', {
      userIds: many, startDate: 20260401, endDate: 20260430,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/at most 200 user ids/i);

    const { result: r2 } = await drive('larkattendance_query_records', {
      userIds: Array.from({ length: 51 }, (_, i) => `u${i}`),
      startDate: 20260401, endDate: 20260430,
    });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/at most 50 user ids/i);
  });

  test('an over-long range is refused with the documented cap, before the call', async () => {
    const { result, calls } = await drive('larkattendance_query_stats', {
      userIds: ['u1'], startDate: 20260401, endDate: 20260531,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/caps this query at 31 days/);
    expect(result.error).toMatch(/61 days/);
    expect(calls.filter((c) => !c.url.includes(AUTH_PATH))).toHaveLength(0);
    // The FIELDS discovery call has a wider (40-day) documented cap — a shared
    // constant here would have silently over-restricted it.
    const { result: fields } = await drive('larkattendance_list_stats_fields', {
      startDate: 20260401, endDate: 20260505,
    }, () => ({ code: 0, data: { user_stats_field: { fields: [] } } }));
    expect(fields.ok).toBe(true);
  });

  test('a non-existent calendar date is rejected rather than sent as garbage', async () => {
    const { result } = await drive('larkattendance_query_stats', {
      userIds: ['u1'], startDate: '2026-02-30', endDate: '2026-03-01',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/yyyyMMdd/);
  });
});

describe('lark-attendance wire shape', () => {
  beforeEach(() => {
    process.env.LARK_APP_ID = 'cli_chat';
    process.env.LARK_APP_SECRET = 'chat-secret';
  });

  test('list_groups clamps the page size and returns the cursor for continuation', async () => {
    const { result, calls } = await drive('larkattendance_list_groups', { pageSize: 999 }, () => ({
      code: 0,
      data: {
        group_list: [{ group_id: 'g1', group_name: 'A' }],
        has_more: true,
        page_token: 'next-cursor',
      },
    }));
    expect(apiCall(calls).url).toContain('page_size=50');
    expect(result).toMatchObject({
      ok: true, count: 1, hasMore: true, pageToken: 'next-cursor',
    });
    expect(result.groups).toEqual([{ groupId: 'g1', groupName: 'A' }]);
  });

  test('get_group surfaces the member ids that scope every later data call', async () => {
    const { result, calls } = await drive('larkattendance_get_group', { groupId: 'g1' }, () => ({
      code: 0,
      data: {
        group_id: 'g1',
        group_name: '技术',
        bind_user_ids: ['u1', 'u2'],
        bind_dept_ids: ['od_x'],
        group_leader_ids: ['u9'],
      },
    }));
    expect(apiCall(calls).url).toContain('employee_type=employee_id');
    expect(apiCall(calls).url).toContain('dept_type=open_id');
    expect(result.memberUserIds).toEqual(['u1', 'u2']);
    expect(result.memberDeptIds).toEqual(['od_x']);
    expect(result.leaderUserIds).toEqual(['u9']);
  });

  test('list_stats_fields flattens the per-tenant field groups (incl. 自定义字段)', async () => {
    const { result } = await drive('larkattendance_list_stats_fields', {
      startDate: 20260401, endDate: 20260430,
    }, () => ({
      code: 0,
      data: {
        user_stats_field: {
          fields: [
            { code: '1007', title: '自定义字段', child_fields: [{ code: 'c1', title: '项目工时', time_unit: 'hour' }] },
          ],
        },
      },
    }));
    expect(result.fieldGroups).toEqual([{
      code: '1007',
      title: '自定义字段',
      fields: [{ code: 'c1', title: '项目工时', timeUnit: 'hour' }],
    }]);
  });

  test('query_stats sends the scope Lark expects and can filter to the picked codes', async () => {
    const { result, calls } = await drive('larkattendance_query_stats', {
      userIds: ['u1'],
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      fieldCodes: ['c1'],
      operatorUserId: 'admin1',
    }, () => ({
      code: 0,
      data: {
        user_datas: [{
          name: 'Ann',
          user_id: 'u1',
          datas: [
            { code: 'c1', title: '项目工时', value: '160' },
            { code: 'c2', title: '迟到次数', value: '3' },
          ],
        }],
        invalid_user_list: ['u404'],
      },
    }));
    const body = JSON.parse(apiCall(calls).init.body);
    expect(body).toMatchObject({
      stats_type: 'month', start_date: 20260401, end_date: 20260430, user_ids: ['u1'], user_id: 'admin1',
    });
    // fieldCodes trims the columns, it does not change what was requested.
    expect(result.users[0].fields).toEqual([{ code: 'c1', title: '项目工时', value: '160' }]);
    expect(result.invalidUserIds).toEqual(['u404']);
  });

  test('query_records tolerates unknown ids instead of failing the whole batch', async () => {
    const { result, calls } = await drive('larkattendance_query_records', {
      userIds: ['u1'], startDate: 20260401, endDate: 20260407,
    }, () => ({
      code: 0,
      data: {
        user_task_results: [{
          user_id: 'u1',
          employee_name: 'Ann',
          day: 20260401,
          records: [{
            check_in_record: { check_time: '1000' },
            check_in_result: 'Normal',
            check_out_record: { check_time: '1900' },
            check_out_result: 'Late',
          }],
        }],
        invalid_user_ids: ['u404'],
        unauthorized_user_ids: [],
      },
    }));
    expect(apiCall(calls).url).toContain('ignore_invalid_users=true');
    expect(result.results[0].records[0]).toMatchObject({
      checkInTime: '1000', checkInResult: 'Normal', checkOutTime: '1900', checkOutResult: 'Late',
    });
    expect(result.invalidUserIds).toEqual(['u404']);
  });

  test('resolve_users asks for user_id — the id form the attendance API accepts', async () => {
    // The `lark` skill's lark_lookup_user_by_email asks for open_id (for DMs);
    // the attendance endpoints reject open_ids, which is the whole reason this
    // tool exists rather than reusing that one.
    const { result, calls } = await drive('larkattendance_resolve_users', {
      emails: ['a@example.test', 'ghost@example.test'],
    }, () => ({
      code: 0,
      data: { user_list: [{ email: 'a@example.test', user_id: 'u1' }, { email: 'ghost@example.test' }] },
    }));
    expect(apiCall(calls).url).toContain('user_id_type=user_id');
    expect(result.users).toEqual([{ email: 'a@example.test', userId: 'u1' }]);
    expect(result.notFound).toEqual(['ghost@example.test']);
  });
});

describe('lark-attendance pure helpers', () => {
  test('toLarkDate accepts the forms an agent actually writes', async () => {
    const { toLarkDate } = await import('../larkAttendance.js');
    expect(toLarkDate(20260401)).toBe(20260401);
    expect(toLarkDate('20260401')).toBe(20260401);
    expect(toLarkDate('2026-04-01')).toBe(20260401);
    expect(toLarkDate('2026/04/01')).toBe(20260401);
    expect(toLarkDate('2026-02-30')).toBeNull();
    expect(toLarkDate('April 1')).toBeNull();
    expect(toLarkDate('')).toBeNull();
    expect(toLarkDate(undefined)).toBeNull();
  });

  test('daySpan is inclusive and crosses months', async () => {
    const { daySpan } = await import('../larkAttendance.js');
    expect(daySpan(20260401, 20260401)).toBe(1);
    expect(daySpan(20260401, 20260430)).toBe(30);
    expect(daySpan(20260401, 20260501)).toBe(31);
  });
});
