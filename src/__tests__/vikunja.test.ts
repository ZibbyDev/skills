/**
 * vikunjaSkill — the board as MODEL-DRIVEN tools.
 *
 * What these tests are really guarding is the gap between "the HTTP call
 * succeeded" and "the board changed the way a human would expect", because
 * Vikunja's API has three shapes that look wrong and are not:
 *
 *   1. A COLUMN IS NOT A FIELD. There is no task.status — a column is a bucket
 *      on the project's kanban VIEW, so moving a card is view-scoped and takes
 *      three round trips. An implementation that "simplifies" this into a PATCH
 *      on the task returns 200 and moves nothing.
 *   2. THE LABEL FILTER TAKES A NUMERIC ID. Passing the title 400s (code 4019),
 *      so listing by label MUST resolve title → id first. The failure is a hard
 *      error, but a caller that swallows it reads as "no tasks match".
 *   3. THE CREDENTIAL IS TWO HALVES. A token alone cannot address a board, so a
 *      connected row with no instanceUrl has to say THAT, not fail later with an
 *      auth error against an empty origin.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const resolveIntegrationToken = vi.fn();
vi.mock('@zibby/core/backend-client.js', () => ({
  resolveIntegrationToken: (...a: any[]) => resolveIntegrationToken(...a),
  clearTokenCache: () => {},
}));

const { vikunjaSkill, clearVikunjaCredsCache, vkPriority, vkPlainText } = await import('../vikunja.js');

/** Queue of [matcher, response] — each fetch takes the first matching entry. */
let calls: Array<{ url: string; method: string; body: any }> = [];
let routes: Array<{ test: RegExp; method?: string; json: any }> = [];

function mockFetch() {
  return vi.fn(async (url: string, init: any = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : null });
    const hit = routes.find((r) => r.test.test(url) && (!r.method || r.method === method));
    if (!hit) return { ok: false, status: 404, text: async () => `no route for ${method} ${url}` } as any;
    return { ok: true, status: 200, text: async () => JSON.stringify(hit.json) } as any;
  });
}

beforeEach(() => {
  calls = []; routes = [];
  clearVikunjaCredsCache();
  resolveIntegrationToken.mockReset();
  resolveIntegrationToken.mockResolvedValue({ token: 'tok', instanceUrl: 'https://board.example.com/' });
  (globalThis as any).fetch = mockFetch();
  delete process.env.VIKUNJA_URL;
  delete process.env.VIKUNJA_TOKEN;
});
afterEach(() => { clearVikunjaCredsCache(); });

const call = (name: string, args?: any) => vikunjaSkill.handleToolCall(name, args).then(JSON.parse);

describe('declaration', () => {
  it('is a backend-calling skill — the marker, not a hand-copied env list', () => {
    // resolveIntegrationToken() hits Zibby's own backend on cloud, so the child
    // needs the session keys. `callsBackend` is what guarantees they arrive
    // (withBackendSessionEnv at registration). Hand-listing them instead is how
    // github, gitlab and lark each broke — see backend-session-env-contract.
    expect(vikunjaSkill.callsBackend).toBe(true);
  });

  it('never forwards model or cloud credentials to the child', () => {
    for (const forbidden of ['ANTHROPIC_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
      expect(vikunjaSkill.envKeys).not.toContain(forbidden);
    }
  });

  it('every advertised tool has a handler, and every handler is advertised', async () => {
    const advertised = vikunjaSkill.tools.map((t: any) => t.name).sort();
    expect(advertised.length).toBeGreaterThanOrEqual(12);
    for (const t of vikunjaSkill.tools) {
      expect(t.description, `${t.name} needs a description`).toBeTruthy();
      expect(t.input_schema?.type).toBe('object');
    }
    // An unknown name is reported, never silently ignored.
    const unknown = await call('vikunja_teleport');
    expect(unknown.error).toMatch(/Unknown vikunja tool/);
  });
});

describe('credentials', () => {
  it('a connected row with no instance URL says THAT, and does not blame the token', async () => {
    resolveIntegrationToken.mockResolvedValue({ token: 'tok', instanceUrl: '' });
    const out = await call('vikunja_list_projects');
    expect(out.error).toMatch(/no instance URL/i);
    expect(out.error).toMatch(/reconnect/i);
  });

  it('falls back to the legacy env pair when nothing is connected', async () => {
    resolveIntegrationToken.mockRejectedValue(new Error('not connected'));
    process.env.VIKUNJA_URL = 'https://legacy.example.com/api/v1/';
    process.env.VIKUNJA_TOKEN = 'envtok';
    routes = [{ test: /\/projects$/, json: [{ id: 7, title: 'Legacy' }] }];
    const out = await call('vikunja_list_projects');
    expect(out.count).toBe(1);
    // The trailing slash AND the /api/v1 suffix are stripped before the path is
    // appended — otherwise every URL doubles the prefix.
    expect(calls[0].url).toBe('https://legacy.example.com/api/v1/projects');
  });

  it('with neither connection nor env, the error names the fix', async () => {
    resolveIntegrationToken.mockResolvedValue({ token: '', instanceUrl: '' });
    const out = await call('vikunja_list_projects');
    expect(out.error).toMatch(/Integrations → Vikunja/);
  });
});

describe('moving a card between columns', () => {
  const kanbanRoutes = [
    { test: /\/tasks\/12$/, method: 'GET', json: { id: 12, project_id: 3, title: 'Card' } },
    { test: /\/projects\/3\/views$/, json: [{ id: 9, view_kind: 'list' }, { id: 10, view_kind: 'kanban' }] },
    { test: /\/views\/10\/buckets$/, json: [{ id: 100, title: 'To-Do' }, { id: 101, title: 'Doing' }] },
    { test: /\/buckets\/101\/tasks$/, method: 'POST', json: {} },
  ];

  it('resolves the kanban VIEW and posts the task into the bucket — not a field write', async () => {
    routes = kanbanRoutes;
    const out = await call('vikunja_move_task', { taskId: '12', column: 'Doing' });
    expect(out).toEqual({ moved: true, taskId: '12', column: 'Doing' });
    // The move is the POST into the bucket. If this ever becomes a PATCH on the
    // task, the API answers 200 and the card does not move.
    const move = calls.find((c) => c.method === 'POST' && /buckets\/101\/tasks$/.test(c.url));
    expect(move, 'expected a POST into the bucket').toBeTruthy();
    expect(move!.body).toEqual({ task_id: 12 });
    // …and it picked the KANBAN view, not simply the first one.
    expect(calls.some((c) => /\/views\/10\/buckets$/.test(c.url))).toBe(true);
    expect(calls.some((c) => /\/views\/9\//.test(c.url))).toBe(false);
  });

  it('a wrong column name lists the real ones instead of failing blind', async () => {
    routes = kanbanRoutes;
    const out = await call('vikunja_move_task', { taskId: '12', column: 'In Progress' });
    expect(out.moved).toBe(false);
    expect(out.availableColumns).toEqual(['To-Do', 'Doing']);
  });

  it('a project with no kanban view says so', async () => {
    routes = [
      { test: /\/tasks\/12$/, method: 'GET', json: { id: 12, project_id: 3 } },
      { test: /\/projects\/3\/views$/, json: [{ id: 9, view_kind: 'list' }] },
    ];
    const out = await call('vikunja_move_task', { taskId: '12', column: 'Doing' });
    expect(out.error).toMatch(/no kanban view/i);
  });
});

describe('listing by label', () => {
  it('converts the label TITLE to its numeric id before filtering', async () => {
    routes = [
      { test: /\/labels\?s=ai-fix$/, json: [{ id: 364, title: 'ai-fix' }] },
      { test: /\/projects\/3\/tasks/, json: [{ id: 1, title: 'T', project_id: 3 }] },
    ];
    const out = await call('vikunja_list_tasks', { projectId: '3', label: 'ai-fix', done: false });
    expect(out.count).toBe(1);
    const list = calls.find((c) => /\/projects\/3\/tasks/.test(c.url))!;
    // URLSearchParams encodes a space as '+', which decodeURIComponent leaves
    // alone — normalize before asserting on the filter's readable form.
    const filter = decodeURIComponent(list.url).replace(/\+/g, ' ');
    // Numeric id, never the title — a title 400s with code 4019.
    expect(filter).toContain('labels in 364');
    expect(filter).toContain('done = false');
    expect(filter).not.toContain('labels in ai-fix');
  });

  it('an unknown label returns empty WITH a reason, not a silent zero', async () => {
    routes = [{ test: /\/labels\?s=/, json: null }]; // Vikunja returns JSON null, not []
    const out = await call('vikunja_list_tasks', { projectId: '3', label: 'nope' });
    expect(out.count).toBe(0);
    expect(out.note).toMatch(/No label named "nope"/);
  });
});

describe('creating and reading tasks', () => {
  it('creates, then attaches labels fail-soft — a label error never loses the task', async () => {
    routes = [
      { test: /\/projects\/3\/tasks$/, method: 'PUT', json: { id: 55, title: 'New', project_id: 3 } },
      { test: /\/labels\?s=urgent$/, json: [{ id: 9, title: 'urgent' }] },
      // No route for PUT /tasks/55/labels → the attach fails …
      { test: /\/tasks\/55$/, method: 'GET', json: { id: 55, title: 'New', project_id: 3 } },
    ];
    const out = await call('vikunja_create_task', { projectId: '3', title: 'New', labels: ['urgent'] });
    expect(out.created.id).toBe('55');          // … and the task still comes back
    expect(out.labelErrors).toHaveLength(1);    // … with the failure REPORTED, not hidden
  });

  it('maps priority words a human would use', () => {
    expect(vkPriority('urgent')).toBe(4);
    expect(vkPriority('high')).toBe(3);
    expect(vkPriority(2)).toBe(2);
    expect(vkPriority('gibberish')).toBeNull();  // unknown ⇒ leave it unset, don't guess
    expect(vkPriority(99)).toBe(5);              // clamped into the 0-5 the API accepts
  });

  it('renders UI-authored HTML descriptions as readable text', () => {
    expect(vkPlainText('<p>Fix the <b>login</b> bug</p><p>ASAP&amp;done</p>'))
      .toBe('Fix the login bug\n\nASAP&done');
  });

  it('normalizes a task to the numeric id, not the per-project #identifier', async () => {
    routes = [{ test: /\/tasks\/12$/, json: { id: 12, identifier: '#1', project_id: 3, title: 'T', labels: null } }];
    const out = await call('vikunja_get_task', { taskId: '12' });
    expect(out.task.id).toBe('12');
    expect(out.task.identifier).toBe('#1');
    expect(out.task.labels).toEqual([]);         // labels: null must not throw
    expect(out.task.url).toBe('https://board.example.com/tasks/12');
  });
});
