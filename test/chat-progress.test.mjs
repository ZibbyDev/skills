import { test } from 'vitest'; // was node:test — broken since the TS migration (../src/*.js no longer exists); vitest transforms the .ts import
import assert from 'node:assert/strict';
import { chatProgressSkill } from '../src/chatProgress';

function clearEnv() {
  for (const k of ['ZIBBY_PROGRESS_PROVIDER', 'ZIBBY_PROGRESS_CHAT_ID', 'ZIBBY_PROGRESS_MENTION', 'SLACK_CHANNEL', 'LARK_RECEIVE_ID', 'SLACK_BOT_TOKEN']) delete process.env[k];
}

test('skill shape — one tool, ids, forwards slack/lark + progress env', () => {
  assert.equal(chatProgressSkill.id, 'chat-progress');
  assert.equal(chatProgressSkill.serverName, 'chat_progress');
  assert.equal(chatProgressSkill.tools.length, 1);
  assert.equal(chatProgressSkill.tools[0].name, 'report_progress');
  assert.ok(chatProgressSkill.envKeys.includes('ZIBBY_PROGRESS_CHAT_ID'));
  assert.ok(chatProgressSkill.envKeys.includes('SLACK_BOT_TOKEN')); // from slackSkill.envKeys
});

test('unknown tool → error', async () => {
  const r = JSON.parse(await chatProgressSkill.handleToolCall('nope', {}));
  assert.ok(r.error);
});

test('empty message → soft skip (never throws)', async () => {
  clearEnv();
  const r = JSON.parse(await chatProgressSkill.handleToolCall('report_progress', { message: '  ' }));
  assert.equal(r.ok, false);
  assert.match(r.skipped, /empty/);
});

test('no chat target → soft no-op, not an error', async () => {
  clearEnv();
  const r = JSON.parse(await chatProgressSkill.handleToolCall('report_progress', { message: 'working…' }));
  assert.equal(r.ok, false);
  assert.match(r.skipped, /no chat target/);
});

test('resolve() is pure-ish — returns a command, forwards target env when set', () => {
  process.env.ZIBBY_PROGRESS_PROVIDER = 'lark';
  process.env.ZIBBY_PROGRESS_CHAT_ID = 'oc_abc';
  const r = chatProgressSkill.resolve();
  // Either a real bin (dev) or the null-command fallback — both are objects.
  assert.equal(typeof r, 'object');
  if (r.command) {
    assert.equal(r.env.ZIBBY_PROGRESS_PROVIDER, 'lark');
    assert.equal(r.env.ZIBBY_PROGRESS_CHAT_ID, 'oc_abc');
  }
  clearEnv();
});

test('target resolves from args over env; delegates to the right provider (mocked)', async () => {
  clearEnv();
  // Monkeypatch the underlying skills to capture the delegation without network.
  const mod = await import('../src/chatProgress.js');
  // We can't easily swap the imported slack/lark inside the module, so instead
  // assert the target-resolution branch via env: set slack env, expect a post
  // ATTEMPT (which will soft-fail on the fake token, but prove routing).
  process.env.SLACK_BOT_TOKEN = 'xoxb-fake';
  process.env.SLACK_CHANNEL = 'C123';
  const r = JSON.parse(await mod.chatProgressSkill.handleToolCall('report_progress', { message: 'hi' }));
  // Fake token → the slack post fails → soft-skip with a post-failed reason
  // (NOT a throw, NOT "no chat target" — proving it resolved slack + attempted).
  assert.equal(r.ok, false);
  assert.ok(/post failed|error/.test(r.skipped), `expected an attempted-post soft failure, got ${JSON.stringify(r)}`);
  clearEnv();
});

// ── the run's own line (founder 2026-10-07: one "tell the people watching" tool) ──
import { vi, afterEach } from 'vitest';
const DOOR = { PROGRESS_API_URL: 'http://cp:3001/executions/', EXECUTION_ID: 'exec-1', PROJECT_API_TOKEN: 'run-token' };
const setDoor = () => Object.assign(process.env, DOOR);
const clearDoor = () => { for (const k of Object.keys(DOOR)) delete process.env[k]; };
afterEach(() => { vi.unstubAllGlobals(); clearDoor(); clearEnv(); });
function stubFetch(calls) {
  vi.stubGlobal('fetch', async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const body = String(url).includes('slack.com') ? { ok: true, channel: 'C123', ts: '1.2' } : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

test('records the line as the run\'s own, with the run\'s token, even with no chat — and says so instead of "skipped"', async () => {
  clearEnv(); setDoor();
  const calls = []; stubFetch(calls);
  const r = JSON.parse(await chatProgressSkill.handleToolCall('report_progress', { message: 'Ticket 42: fixing the login\nform focus' }));
  assert.deepEqual(r, { ok: true, recorded: true, posted: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://cp:3001/executions/exec-1/progress');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer run-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), { statusLine: 'Ticket 42: fixing the login form focus' });
});

test('a successful reply acknowledges only the message IDs the agent explicitly supplied', async () => {
  clearEnv(); setDoor(); stubFetch([]);
  const r = JSON.parse(await chatProgressSkill.handleToolCall('report_progress', {
    message: 'Yes, I have included your requirement.', answeredMessageIds: ['message-a'],
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.answeredMessageIds, ['message-a']);
  assert.equal(chatProgressSkill.tools[0].input_schema.properties.answeredMessageIds.items.type, 'string');
});

test('a failed reply cannot acknowledge a message', async () => {
  clearEnv(); clearDoor();
  const r = JSON.parse(await chatProgressSkill.handleToolCall('report_progress', {
    message: 'Reply that cannot be posted.', answeredMessageIds: ['message-a'],
  }));
  assert.equal(r.ok, false);
  assert.equal(r.answeredMessageIds, undefined);
});

test('records the line AND still posts to the chat when a target resolves', async () => {
  clearEnv(); setDoor();
  process.env.SLACK_BOT_TOKEN = 'xoxb-fake'; process.env.SLACK_CHANNEL = 'C123';
  const calls = []; stubFetch(calls);
  const r = JSON.parse(await chatProgressSkill.handleToolCall('report_progress', { message: 'Scored 60 of 188 commits, continuing' }));
  assert.equal(r.recorded, true); assert.equal(r.posted, true); assert.equal(r.provider, 'slack');
  assert.ok(calls.some((c) => c.url.endsWith('/executions/exec-1/progress')));
  assert.ok(calls.some((c) => c.url.includes('slack.com')), 'the chat post still happens');
});

test('a line over the cap is handed back to be rewritten — nothing is recorded or posted', async () => {
  clearEnv(); setDoor();
  const calls = []; stubFetch(calls);
  const r = JSON.parse(await chatProgressSkill.handleToolCall('report_progress', { message: 'x'.repeat(281) }));
  assert.equal(r.ok, false); assert.match(r.error, /at most 280/);
  assert.equal(calls.length, 0);
});

test('the run\'s door and identity reach the spawned server', () => {
  setDoor();
  const r = chatProgressSkill.resolve();
  if (r.command) for (const k of Object.keys(DOOR)) assert.equal(r.env[k], DOOR[k]);
  assert.ok(chatProgressSkill.envKeys.includes('PROGRESS_API_URL') && chatProgressSkill.envKeys.includes('EXECUTION_ID'));
});

test('the tool is pinned in front of the model (alwaysLoad), not left behind a toolbox search', () => {
  const r = chatProgressSkill.resolve();
  if (r.command) assert.equal(r.alwaysLoad, true);
});

// ── a reply that names what it answered marks it read in the run's own mailbox ──
// (run_log/product-owner/2026-10-25-handled-mail-stays-unread: the product owner
// answered "hey (latency check)" with answeredMessageIds, and the mail stayed unread.)
const MAILBOX = { PROJECT_ID: 'proj-1', WORKFLOW_TYPE: 'product-owner' };
function stubDoors(calls, ackBody = { ok: true, found: true }) {
  vi.stubGlobal('fetch', async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const body = String(url).includes('/inbox/') ? ackBody : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

test('[A/B] a successful reply acknowledges each named message in the run\'s OWN mailbox, with the run\'s token', async () => {
  clearEnv(); setDoor(); Object.assign(process.env, MAILBOX);
  const calls = []; stubDoors(calls);
  try {
    const r = JSON.parse(await chatProgressSkill.handleToolCall('report_progress', {
      message: 'Hi — I am reviewing #40 and #47 now.', answeredMessageIds: ['1792892876844-d71311d3'],
    }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.answeredMessageIds, ['1792892876844-d71311d3']); // the ledger receipt is unchanged
    assert.deepEqual(r.acknowledged, ['1792892876844-d71311d3']);
    const ack = calls.find((c) => c.url.includes('/inbox/'));
    assert.ok(ack, 'before the fix no acknowledgement was ever sent');
    assert.equal(ack.url, 'http://cp:3001/projects/proj-1/workflows/product-owner/inbox/1792892876844-d71311d3/ack');
    assert.equal(ack.init.method, 'POST');
    assert.equal(new Headers(ack.init.headers).get('authorization'), 'Bearer run-token');
  } finally { for (const k of Object.keys(MAILBOX)) delete process.env[k]; }
});

test('a reply that names nothing, or fails, acknowledges nothing', async () => {
  clearEnv(); setDoor(); Object.assign(process.env, MAILBOX);
  const calls = []; stubDoors(calls);
  try {
    const plain = JSON.parse(await chatProgressSkill.handleToolCall('report_progress', { message: 'Still working on #40.' }));
    assert.equal(plain.ok, true); assert.equal(plain.acknowledged, undefined);
    const tooLong = JSON.parse(await chatProgressSkill.handleToolCall('report_progress', { message: 'x'.repeat(281), answeredMessageIds: ['m-1'] }));
    assert.equal(tooLong.ok, false);
    assert.equal(calls.filter((c) => c.url.includes('/inbox/')).length, 0);
  } finally { for (const k of Object.keys(MAILBOX)) delete process.env[k]; }
});

test('an id that is not in the mailbox is reported, never fails the reply', async () => {
  clearEnv(); setDoor(); Object.assign(process.env, MAILBOX);
  stubDoors([], { ok: true, found: false });
  try {
    const r = JSON.parse(await chatProgressSkill.handleToolCall('report_progress', { message: 'Answered.', answeredMessageIds: ['m-x'] }));
    assert.equal(r.ok, true);
    assert.equal(r.acknowledged, undefined);
    assert.deepEqual(r.notAcknowledged, [{ id: 'm-x', reason: 'no such message in your mailbox' }]);
  } finally { for (const k of Object.keys(MAILBOX)) delete process.env[k]; }
});

test('served from the platform, the run\'s identity comes from the verified call context', async () => {
  clearEnv(); setDoor();
  const calls = []; stubDoors(calls);
  const r = JSON.parse(await chatProgressSkill.handleToolCall('report_progress', { message: 'Answered.', answeredMessageIds: ['m-2'] },
    { executionId: 'exec-1', projectId: 'proj-9', workflowType: 'designer', apiBase: 'http://127.0.0.1:3001' }));
  assert.deepEqual(r.acknowledged, ['m-2']);
  assert.equal(calls.find((c) => c.url.includes('/inbox/')).url, 'http://127.0.0.1:3001/projects/proj-9/workflows/designer/inbox/m-2/ack');
});

test('the run\'s mailbox identity reaches the spawned server', () => {
  setDoor(); Object.assign(process.env, MAILBOX);
  try {
    const r = chatProgressSkill.resolve();
    if (r.command) for (const k of Object.keys(MAILBOX)) assert.equal(r.env[k], MAILBOX[k]);
  } finally { for (const k of Object.keys(MAILBOX)) delete process.env[k]; }
});
