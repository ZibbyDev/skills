/**
 * The five scenarios this file has always pinned, under the rule that replaced
 * the provider ORDER (explicit Slack channel → explicit Lark chat → Slack
 * token): chat_notify serves every provider the run has, under its own server
 * name, and prefers none. The full contract — the platform's connected list,
 * the agent's allowlist, the spawned server — is in
 * src/__tests__/chatNotify-availability.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { chatNotifySkill, availableChatProviders } from '../src/chat-notify.js';

const ENV = ['SLACK_CHANNEL', 'LARK_RECEIVE_ID', 'SLACK_BOT_TOKEN', 'LARK_APP_ID', 'WORKFLOW_CONNECTED_INTEGRATIONS', 'WORKFLOW_ENABLED_INTEGRATIONS'];
const saved = { ...process.env };
const run = (env) => { ENV.forEach((k) => delete process.env[k]); Object.assign(process.env, env); };
afterEach(() => { process.env = { ...saved }; });
const served = () => availableChatProviders().map((p) => p.label);

describe('chat_notify serves what the run has', () => {
  it('SLACK_CHANNEL set → Slack, on the chat_notify server', () => {
    run({ SLACK_CHANNEL: '#x' });
    expect(served()).toEqual(['Slack']);
    expect(chatNotifySkill.serverName).toBe('chat_notify');
    expect(chatNotifySkill.allowedTools).toEqual(['mcp__chat_notify__*']);
    expect(chatNotifySkill.resolve()).toMatchObject({ command: 'node' });
  });
  it('LARK_RECEIVE_ID set → Lark', () => {
    run({ LARK_RECEIVE_ID: 'oc_x' });
    expect(served()).toEqual(['Lark']);
  });
  it('SLACK_BOT_TOKEN present but NO SLACK_CHANNEL → Slack (the channel comes from the agent\'s instructions)', () => {
    run({ SLACK_BOT_TOKEN: 'xoxb-test' });
    expect(served()).toEqual(['Slack']);
    expect(chatNotifySkill.resolve()).toMatchObject({ command: 'node' });
  });
  it('nothing configured → no server, and never a server named undefined', () => {
    run({});
    expect(chatNotifySkill.serverName).toBe('chat_notify');
    expect(chatNotifySkill.allowedTools).toEqual([]);
    expect(chatNotifySkill.resolve()).toBeNull();
  });
  it('a Lark chat and a Slack token together → BOTH (this used to be Lark only: an explicit variable hid the other provider)', () => {
    run({ LARK_RECEIVE_ID: 'oc_x', SLACK_BOT_TOKEN: 'xoxb-test' });
    expect(served()).toEqual(['Slack', 'Lark']);
  });
});
