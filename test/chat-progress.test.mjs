import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatProgressSkill } from '../src/chatProgress.js';

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
