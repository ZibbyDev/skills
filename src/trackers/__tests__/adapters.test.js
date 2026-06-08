/**
 * Neutral tracker adapter tests.
 * ============================================================================
 * Focus: the toNeutral / stateCategory MAPPING for every provider (where bugs
 * hide), the registry/getAdapter selection, and the 6-method surface. No real
 * network — we mock each provider's fetch chokepoint (global.fetch for the
 * REST/GraphQL providers; env keys for the static-key ones).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// GitHub + Jira resolve a token via the backend client; stub it so the skills
// load and ghFetch/jiraFetch get a token without a network call.
vi.mock('@zibby/core/backend-client.js', () => ({
  resolveIntegrationToken: vi.fn(async () => ({ token: 'tok-test', cloudId: 'cloud-1' })),
  clearTokenCache: vi.fn(),
}));

// Static-key providers read the key from env at call time.
process.env.LINEAR_API_KEY = 'lin_test';
process.env.PLANE_API_KEY = 'plane_test';
process.env.PLANE_WORKSPACE_SLUG = 'acme';
process.env.PLANE_PROJECT_ID = 'proj-uuid';

const { jiraAdapter } = await import('../jira-adapter.js');
const { linearAdapter } = await import('../linear-adapter.js');
const { githubAdapter } = await import('../github-adapter.js');
const { planeAdapter } = await import('../plane-adapter.js');
const {
  getAdapter,
  TRACKER_ADAPTERS,
  DEFAULT_TRACKER_PROVIDER,
  TRACKER_STATE_CATEGORIES,
} = await import('../index.js');

const SIX_METHODS = ['listCandidates', 'getTicket', 'getComments', 'addComment', 'transition', 'linkPullRequest'];

/**
 * Install a fake global.fetch that resolves to JSON `payload`. Returns the spy.
 * `payloadFor(url, opts)` may be a function to vary by request.
 */
function mockFetch(payloadFor) {
  const fn = typeof payloadFor === 'function' ? payloadFor : () => payloadFor;
  const spy = vi.fn(async (url, opts = {}) => {
    const body = fn(String(url), opts);
    const json = body === undefined ? {} : body;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(json),
      json: async () => json,
    };
  });
  global.fetch = spy;
  return spy;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────
describe('registry / getAdapter', () => {
  it('registers exactly the four providers', () => {
    expect(Object.keys(TRACKER_ADAPTERS).sort()).toEqual(['github', 'jira', 'linear', 'plane']);
  });

  it('getAdapter picks by explicit provider id', () => {
    expect(getAdapter('linear')).toBe(linearAdapter);
    expect(getAdapter('github')).toBe(githubAdapter);
    expect(getAdapter('plane')).toBe(planeAdapter);
    expect(getAdapter('jira')).toBe(jiraAdapter);
  });

  it('getAdapter is case-insensitive and trims', () => {
    expect(getAdapter('  LINEAR ')).toBe(linearAdapter);
  });

  it('getAdapter falls back to TRACKER_PROVIDER env, then default', () => {
    const prev = process.env.TRACKER_PROVIDER;
    process.env.TRACKER_PROVIDER = 'github';
    expect(getAdapter()).toBe(githubAdapter);
    delete process.env.TRACKER_PROVIDER;
    expect(getAdapter()).toBe(TRACKER_ADAPTERS[DEFAULT_TRACKER_PROVIDER]);
    if (prev !== undefined) process.env.TRACKER_PROVIDER = prev;
  });

  it('getAdapter throws on an unknown provider', () => {
    expect(() => getAdapter('asana')).toThrow(/Unknown tracker provider/);
  });

  it('default provider is jira', () => {
    expect(DEFAULT_TRACKER_PROVIDER).toBe('jira');
  });
});

describe('every adapter exposes the 6-method contract + id', () => {
  for (const adapter of [jiraAdapter, linearAdapter, githubAdapter, planeAdapter]) {
    it(`${adapter.id} has id + all 6 methods`, () => {
      expect(typeof adapter.id).toBe('string');
      for (const m of SIX_METHODS) {
        expect(typeof adapter[m]).toBe('function');
      }
    });
  }
});

describe('shared bucket vocabulary', () => {
  it('TRACKER_STATE_CATEGORIES is the canonical 5-bucket list', () => {
    expect(TRACKER_STATE_CATEGORIES).toEqual(['todo', 'in_progress', 'done', 'blocked', 'unknown']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('jira: statusCategory.key → bucket', () => {
  const cases = [
    [{ name: 'To Do', statusCategory: { key: 'new' } }, 'todo'],
    [{ name: 'In Progress', statusCategory: { key: 'indeterminate' } }, 'in_progress'],
    [{ name: 'Done', statusCategory: { key: 'done' } }, 'done'],
    [{ name: 'Blocked', statusCategory: { key: 'indeterminate' } }, 'blocked'], // name beats category
    [{ name: 'On Hold', statusCategory: { key: 'new' } }, 'blocked'],
    [{ name: 'Weird', statusCategory: { key: 'mystery' } }, 'unknown'],
    [null, 'unknown'],
  ];
  for (const [status, want] of cases) {
    it(`${status?.name || 'null'} (${status?.statusCategory?.key}) → ${want}`, () => {
      expect(jiraAdapter.toStateCategory(status)).toBe(want);
    });
  }
});

describe('jira: toNeutral + reads', () => {
  const ISSUE = {
    id: '10001',
    key: 'PROJ-7',
    self: 'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/10001',
    fields: {
      summary: 'Fix the thing',
      description: { content: [{ type: 'paragraph', content: [{ type: 'text', text: 'details here' }] }] },
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      assignee: { displayName: 'Ada Lovelace' },
      labels: ['zibby'],
    },
  };

  it('maps a full issue to a NeutralTicket', () => {
    const t = jiraAdapter.toNeutral(ISSUE);
    expect(t).toMatchObject({
      id: '10001',
      key: 'PROJ-7',
      title: 'Fix the thing',
      state: 'In Progress',
      stateCategory: 'in_progress',
      assignee: 'Ada Lovelace',
    });
    expect(t.body).toContain('details here');
    expect(t.url).toBe('https://api.atlassian.com/browse/PROJ-7');
    expect(t._raw).toBe(ISSUE);
  });

  it('getTicket returns a neutral ticket', async () => {
    mockFetch(ISSUE);
    const t = await jiraAdapter.getTicket('PROJ-7');
    expect(t.key).toBe('PROJ-7');
    expect(t.stateCategory).toBe('in_progress');
  });

  it('listCandidates maps issues from the search payload', async () => {
    mockFetch({ issues: [ISSUE] });
    const list = await jiraAdapter.listCandidates({ query: 'project = PROJ' });
    expect(list).toHaveLength(1);
    expect(list[0].key).toBe('PROJ-7');
  });

  it('listCandidates builds a bounded default JQL when none given', async () => {
    const spy = mockFetch({ issues: [] });
    await jiraAdapter.listCandidates({ labels: 'zibby', updatedAfter: '2026-01-01' });
    const url = String(spy.mock.calls[0][0]);
    expect(decodeURIComponent(url)).toContain('labels = "zibby"');
    expect(decodeURIComponent(url)).toContain('ORDER BY updated DESC');
  });

  it('linkPullRequest uses remotelink when it succeeds', async () => {
    const spy = mockFetch({});
    const res = await jiraAdapter.linkPullRequest('PROJ-7', 'https://gh/pr/1', 'PR #1');
    expect(res).toEqual({ ok: true, via: 'remotelink' });
    expect(String(spy.mock.calls[0][0])).toContain('/remotelink');
  });

  it('linkPullRequest falls back to a comment when remotelink fails', async () => {
    const spy = vi.fn(async (url) => {
      if (String(url).includes('/remotelink')) {
        return { ok: false, status: 403, text: async () => 'forbidden' };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({}) };
    });
    global.fetch = spy;
    const res = await jiraAdapter.linkPullRequest('PROJ-7', 'https://gh/pr/1');
    expect(res.via).toBe('comment');
    expect(res.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('linear: state.type → bucket', () => {
  const cases = [
    [{ type: 'triage' }, 'todo'],
    [{ type: 'backlog' }, 'todo'],
    [{ type: 'unstarted' }, 'todo'],
    [{ type: 'started' }, 'in_progress'],
    [{ type: 'completed' }, 'done'],
    [{ type: 'canceled' }, 'done'],
    [{ name: 'Blocked', type: 'started' }, 'blocked'], // name beats type
    [{ type: 'nonsense' }, 'unknown'],
    [null, 'unknown'],
  ];
  for (const [state, want] of cases) {
    it(`${state?.name || ''}(${state?.type}) → ${want}`, () => {
      expect(linearAdapter.toStateCategory(state)).toBe(want);
    });
  }
});

describe('linear: toNeutral + reads', () => {
  const ISSUE = {
    id: 'uuid-1',
    identifier: 'ENG-12',
    title: 'Login bug',
    description: 'desc',
    url: 'https://linear.app/eng/issue/ENG-12',
    state: 'In Progress',
    stateType: 'started',
    assignee: 'Grace H',
  };

  it('maps a linear issue projection to a NeutralTicket', () => {
    const t = linearAdapter.toNeutral(ISSUE);
    expect(t).toMatchObject({
      id: 'uuid-1',
      key: 'ENG-12',
      title: 'Login bug',
      state: 'In Progress',
      stateCategory: 'in_progress',
      assignee: 'Grace H',
      url: 'https://linear.app/eng/issue/ENG-12',
    });
  });

  it('getTicket returns a neutral ticket', async () => {
    // linear_get_issue resolves via a filtered issues query, then projects.
    // linearFetch returns json.data, so the GraphQL envelope is { data: {...} }.
    mockFetch({
      data: {
        issues: { nodes: [{
          id: 'uuid-1', identifier: 'ENG-12', number: 12, title: 'Login bug',
          description: 'desc', url: 'https://linear.app/eng/issue/ENG-12',
          state: { id: 's1', name: 'In Progress', type: 'started' },
          assignee: { displayName: 'Grace H' }, labels: { nodes: [] },
          team: { id: 't1', key: 'ENG', name: 'Eng' },
        }] },
      },
    });
    const t = await linearAdapter.getTicket('ENG-12');
    expect(t.key).toBe('ENG-12');
    expect(t.stateCategory).toBe('in_progress');
  });

  it('transition reports the post-state bucket', async () => {
    mockFetch((_url, opts) => {
      const q = JSON.parse(opts.body).query;
      if (q.includes('MoveIssue')) {
        return { data: { issueUpdate: { success: true, issue: { id: 'uuid-1', identifier: 'ENG-12', state: { id: 's2', name: 'Done', type: 'completed' } } } } };
      }
      // getIssueByIdOrIdentifier for the team's states
      return { data: { issues: { nodes: [{ id: 'uuid-1', identifier: 'ENG-12', state: { id: 's1', name: 'In Progress', type: 'started' }, team: { id: 't1', key: 'ENG', states: { nodes: [{ id: 's2', name: 'Done', type: 'completed', position: 2 }] } } }] } } };
    });
    const res = await linearAdapter.transition('ENG-12', 'Done');
    expect(res.ok).toBe(true);
    expect(res.stateAfter).toBe('Done');
    expect(res.stateCategoryAfter).toBe('done');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('github: open/closed + labels → bucket', () => {
  const cases = [
    ['closed', [], 'done'],
    ['closed', ['in progress'], 'done'], // closed always wins
    ['open', [], 'todo'],
    ['open', ['bug'], 'todo'], // unrelated label
    ['open', ['in progress'], 'in_progress'],
    ['open', ['in-progress'], 'in_progress'],
    ['open', ['wip'], 'in_progress'],
    ['open', ['blocked'], 'blocked'],
    ['open', ['on hold'], 'blocked'],
    ['open', ['blocked', 'in progress'], 'blocked'], // blocked beats in-progress
    ['weird', [], 'unknown'],
  ];
  for (const [state, labels, want] of cases) {
    it(`${state} ${JSON.stringify(labels)} → ${want}`, () => {
      expect(githubAdapter.toStateCategory(state, labels)).toBe(want);
    });
  }
});

describe('github: toNeutral + transition mapping (the real seam)', () => {
  const ISSUE = {
    number: 42, title: 'Crash on save', body: 'stack trace', state: 'open',
    labels: ['blocked'], assignee: 'octocat', url: 'https://github.com/o/r/issues/42',
  };

  it('maps a github issue to a NeutralTicket with owner/repo key', () => {
    const t = githubAdapter.toNeutral(ISSUE, { owner: 'o', repo: 'r' });
    expect(t).toMatchObject({
      id: '42', key: 'o/r#42', title: 'Crash on save', state: 'open',
      stateCategory: 'blocked', assignee: 'octocat',
    });
  });

  it('getTicket reads via env scope', async () => {
    process.env.GITHUB_OWNER = 'o';
    process.env.GITHUB_REPO = 'r';
    mockFetch(ISSUE);
    const t = await githubAdapter.getTicket('o/r#42');
    expect(t.key).toBe('o/r#42');
    expect(t.stateCategory).toBe('blocked');
    delete process.env.GITHUB_OWNER;
    delete process.env.GITHUB_REPO;
  });

  it('transition: "done" closes the issue', async () => {
    const spy = mockFetch({ number: 42, state: 'closed', state_reason: 'completed' });
    const res = await githubAdapter.transition('o/r#42', 'Done', { owner: 'o', repo: 'r' });
    expect(res.ok).toBe(true);
    expect(res.stateCategoryAfter).toBe('done');
    expect(spy.mock.calls.some(([, o]) => (o?.method || 'GET') === 'PATCH')).toBe(true);
  });

  it('transition: "in progress" labels the open issue', async () => {
    mockFetch((_url, opts) => {
      const method = opts.method || 'GET';
      if (method === 'PATCH') return { number: 42, state: 'open' }; // reopen
      if (method === 'POST') return [{ name: 'in progress' }]; // add label
      return { number: 42, state: 'open', labels: [] };
    });
    const res = await githubAdapter.transition('o/r#42', 'In Progress', { owner: 'o', repo: 'r' });
    expect(res.ok).toBe(true);
    expect(res.stateCategoryAfter).toBe('in_progress');
    expect(res.via).toBe('label');
  });

  it('transition: an unrepresentable target returns ok:false (genuine seam)', async () => {
    mockFetch({});
    const res = await githubAdapter.transition('o/r#42', 'AI 验收', { owner: 'o', repo: 'r' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no "AI 验收" state/);
  });

  it('scope errors when owner/repo missing', async () => {
    await expect(githubAdapter.getTicket('#1', {})).rejects.toThrow(/GitHub scope missing/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('plane: group → bucket', () => {
  const cases = [
    [{ group: 'backlog' }, 'todo'],
    [{ group: 'unstarted' }, 'todo'],
    [{ group: 'started' }, 'in_progress'],
    [{ group: 'completed' }, 'done'],
    [{ group: 'cancelled' }, 'done'],
    [{ name: 'Blocked', group: 'started' }, 'blocked'], // name beats group
    [{ group: 'mystery' }, 'unknown'],
    [null, 'unknown'],
  ];
  for (const [state, want] of cases) {
    it(`${state?.name || ''}(${state?.group}) → ${want}`, () => {
      expect(planeAdapter.toStateCategory(state)).toBe(want);
    });
  }
});

describe('plane: toNeutral + transition (state uuid resolution)', () => {
  const STATES = {
    results: [
      { id: 'st-todo', name: 'Todo', group: 'unstarted' },
      { id: 'st-prog', name: 'In Progress', group: 'started' },
      { id: 'st-done', name: 'Done', group: 'completed' },
    ],
  };
  const WORKITEM = {
    id: 'wi-1', name: 'API 500s', sequence_id: 42, state: 'st-prog',
    description_html: '<p>boom</p>', assignees: ['member-uuid'],
    created_at: '2026-06-01', updated_at: '2026-06-02',
  };

  it('getTicket resolves state uuid → name + bucket', async () => {
    mockFetch((url) => {
      if (url.includes('/states/')) return STATES;
      return WORKITEM;
    });
    const t = await planeAdapter.getTicket('wi-1', { workspaceSlug: 'acme', projectId: 'proj-uuid', projectIdentifier: 'API' });
    expect(t).toMatchObject({
      id: 'wi-1', key: 'API-42', title: 'API 500s',
      state: 'In Progress', stateCategory: 'in_progress', assignee: 'member-uuid',
    });
    expect(t.body).toBe('<p>boom</p>');
  });

  it('listCandidates returns mapped tickets + honors per_page cap', async () => {
    const spy = mockFetch((url) => {
      if (url.includes('/states/')) return STATES;
      return { results: [WORKITEM], next_cursor: 'c2' };
    });
    const list = await planeAdapter.listCandidates({ limit: 500, ctx: { projectIdentifier: 'API' } });
    expect(list).toHaveLength(1);
    expect(list[0].key).toBe('API-42');
    const wiCall = spy.mock.calls.map(([u]) => String(u)).find((u) => u.includes('/work-items/'));
    expect(wiCall).toContain('per_page=100'); // capped from 500
  });

  it('transition resolves a target name to a state uuid and PATCHes', async () => {
    const spy = mockFetch((url) => {
      if (url.includes('/states/')) return STATES;
      return { id: 'wi-1' };
    });
    const res = await planeAdapter.transition('wi-1', 'Done', { workspaceSlug: 'acme', projectId: 'p2' });
    expect(res.ok).toBe(true);
    expect(res.stateAfter).toBe('Done');
    expect(res.stateCategoryAfter).toBe('done');
    const patch = spy.mock.calls.find(([, o]) => o?.method === 'PATCH');
    expect(JSON.parse(patch[1].body)).toEqual({ state: 'st-done' });
  });

  it('transition returns ok:false when no state matches', async () => {
    mockFetch((url) => (url.includes('/states/') ? STATES : {}));
    const res = await planeAdapter.transition('wi-1', 'Nonexistent ZZZ', { workspaceSlug: 'acme', projectId: 'p3' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/No Plane state matches/);
  });

  it('addComment wraps plaintext in <p> (Plane comments are HTML)', async () => {
    const spy = mockFetch({ id: 'cmt-1' });
    const res = await planeAdapter.addComment('wi-1', 'looks good', { workspaceSlug: 'acme', projectId: 'p4' });
    expect(res.ok).toBe(true);
    const post = spy.mock.calls.find(([, o]) => o?.method === 'POST');
    expect(JSON.parse(post[1].body)).toEqual({ comment_html: '<p>looks good</p>' });
  });
});
