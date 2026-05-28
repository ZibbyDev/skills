import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock backend-client BEFORE importing the skill so resolveIntegrationToken
// is replaced at load time.
vi.mock('@zibby/core/backend-client.js', () => ({
  resolveIntegrationToken: vi.fn(async () => ({ token: 'xoxb-test', team: 'T01' })),
}));

const { slackSkill } = await import('../src/slack.js');

// Helper — build a `fetch` response. Slack APIs always wrap success
// in { ok: true, ... } and errors in { ok: false, error: '<reason>' }.
function fetchOk(payload = {}) {
  return { json: async () => ({ ok: true, ...payload }) };
}
function fetchErr(reason) {
  return { json: async () => ({ ok: false, error: reason }) };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('slackSkill structure', () => {
  it('has correct id', () => {
    expect(slackSkill.id).toBe('slack');
  });

  it('exposes the expected tools (incl. routing helpers)', () => {
    const names = slackSkill.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'slack_add_reaction',
      'slack_get_channel_history',
      'slack_get_thread_replies',
      'slack_get_user_profile',
      'slack_get_usergroup_members',
      'slack_get_users',
      'slack_list_channels',
      'slack_list_usergroups',
      'slack_lookup_user_by_email',
      'slack_post_message',
      'slack_reply_to_thread',
      'slack_search_users',
    ]);
  });

  it('slack_post_message requires channel + text', () => {
    const tool = slackSkill.tools.find((t) => t.name === 'slack_post_message');
    expect(tool.input_schema.required).toEqual(['channel', 'text']);
  });

  it('slack_lookup_user_by_email requires email', () => {
    const tool = slackSkill.tools.find((t) => t.name === 'slack_lookup_user_by_email');
    expect(tool.input_schema.required).toEqual(['email']);
  });

  it('slack_search_users requires query', () => {
    const tool = slackSkill.tools.find((t) => t.name === 'slack_search_users');
    expect(tool.input_schema.required).toEqual(['query']);
  });

  it('slack_get_usergroup_members requires usergroup id', () => {
    const tool = slackSkill.tools.find((t) => t.name === 'slack_get_usergroup_members');
    expect(tool.input_schema.required).toEqual(['usergroup']);
  });
});

describe('slack_lookup_user_by_email', () => {
  it('returns ok:true + user record on hit', async () => {
    globalThis.fetch = vi.fn(async () => fetchOk({
      user: { id: 'U012ABC', real_name: 'Sam Tan', name: 'sam', profile: { email: 'sam@acme.com' } },
    }));
    const result = JSON.parse(await slackSkill.handleToolCall('slack_lookup_user_by_email', { email: 'sam@acme.com' }));
    expect(result).toMatchObject({
      ok: true,
      user: { id: 'U012ABC', name: 'Sam Tan', email: 'sam@acme.com' },
    });
  });

  it('returns ok:false (no exception) when Slack says users_not_found', async () => {
    globalThis.fetch = vi.fn(async () => fetchErr('users_not_found'));
    const result = JSON.parse(await slackSkill.handleToolCall('slack_lookup_user_by_email', { email: 'ghost@nowhere.io' }));
    expect(result).toEqual({ ok: false, reason: 'users_not_found' });
  });

  it('surfaces other API errors as { error }', async () => {
    globalThis.fetch = vi.fn(async () => fetchErr('not_authed'));
    const result = JSON.parse(await slackSkill.handleToolCall('slack_lookup_user_by_email', { email: 'x@y.z' }));
    expect(result.error).toMatch(/not_authed/);
  });

  it('rejects missing email', async () => {
    const result = JSON.parse(await slackSkill.handleToolCall('slack_lookup_user_by_email', {}));
    expect(result.error).toMatch(/email is required/);
  });
});

describe('slack_list_usergroups', () => {
  it('maps the Slack response into { id, handle, name, description, user_count }', async () => {
    globalThis.fetch = vi.fn(async () => fetchOk({
      usergroups: [
        { id: 'S01ONCALL', handle: 'oncall',   name: 'On-Call',     description: 'Weekly rotation', user_count: '4' },
        { id: 'S01PLATFM', handle: 'platform', name: 'Platform',    user_count: 9 },
      ],
    }));
    const result = JSON.parse(await slackSkill.handleToolCall('slack_list_usergroups', {}));
    expect(result.usergroups).toHaveLength(2);
    expect(result.usergroups[0]).toEqual({
      id: 'S01ONCALL', handle: 'oncall', name: 'On-Call', description: 'Weekly rotation', user_count: 4,
    });
    expect(result.usergroups[1].description).toBe('');
  });
});

describe('slack_get_usergroup_members', () => {
  it('returns the user list verbatim from Slack', async () => {
    globalThis.fetch = vi.fn(async () => fetchOk({ users: ['U01', 'U02', 'U03'] }));
    const result = JSON.parse(await slackSkill.handleToolCall('slack_get_usergroup_members', { usergroup: 'S01ONCALL' }));
    expect(result.users).toEqual(['U01', 'U02', 'U03']);
  });

  it('rejects missing usergroup', async () => {
    const result = JSON.parse(await slackSkill.handleToolCall('slack_get_usergroup_members', {}));
    expect(result.error).toMatch(/usergroup id is required/);
  });
});

describe('slack_search_users', () => {
  it('matches users by real_name substring and returns ranked results', async () => {
    globalThis.fetch = vi.fn(async () => fetchOk({
      members: [
        { id: 'U01', real_name: 'Sam Tan',   name: 'sam',  profile: { display_name: 'sam.t', email: 'sam@acme.com' } },
        { id: 'U02', real_name: 'Samantha',  name: 'sami', profile: { display_name: 'sami',  email: 'samantha@acme.com' } },
        { id: 'U03', real_name: 'Alex Wong', name: 'alex', profile: { display_name: 'alex',  email: 'alex@acme.com' } },
        { id: 'BOT', real_name: 'Zibby Bot', name: 'zbb',  is_bot: true },
        { id: 'DEL', real_name: 'Old User',  name: 'old',  deleted: true },
      ],
      response_metadata: { next_cursor: '' },
    }));
    const result = JSON.parse(await slackSkill.handleToolCall('slack_search_users', { query: 'sam', limit: 5 }));
    expect(result.ok).toBe(true);
    // Sam Tan should beat Samantha (closer length to query "sam").
    expect(result.matches[0].id).toBe('U01');
    expect(result.matches[1].id).toBe('U02');
    // Alex shouldn't appear; bots and deleted users excluded.
    expect(result.matches.find((m) => m.id === 'U03')).toBeUndefined();
    expect(result.matches.find((m) => m.id === 'BOT')).toBeUndefined();
    expect(result.matches.find((m) => m.id === 'DEL')).toBeUndefined();
  });

  it('returns empty matches when query yields nothing', async () => {
    globalThis.fetch = vi.fn(async () => fetchOk({
      members: [{ id: 'U01', real_name: 'Alex', name: 'a' }],
      response_metadata: { next_cursor: '' },
    }));
    const result = JSON.parse(await slackSkill.handleToolCall('slack_search_users', { query: 'nobody' }));
    expect(result.ok).toBe(true);
    expect(result.matches).toEqual([]);
  });

  it('rejects missing query', async () => {
    const result = JSON.parse(await slackSkill.handleToolCall('slack_search_users', {}));
    expect(result.error).toMatch(/query is required/);
  });

  it('caps `limit` at 25 even if the caller asks for more', async () => {
    // Generate 30 users named "sam-N"
    const members = Array.from({ length: 30 }, (_, i) => ({
      id: `U${i}`,
      real_name: `Sam ${i}`,
      name: `sam${i}`,
    }));
    globalThis.fetch = vi.fn(async () => fetchOk({ members, response_metadata: { next_cursor: '' } }));
    const result = JSON.parse(await slackSkill.handleToolCall('slack_search_users', { query: 'sam', limit: 999 }));
    expect(result.matches.length).toBeLessThanOrEqual(25);
  });
});
