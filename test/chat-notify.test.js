import { describe, it, expect, afterEach, vi } from 'vitest';
// Stub the underlying skills so we test chat_notify's PROVIDER PICK only.
vi.mock('../src/slack.js', () => ({ slackSkill: { serverName: 'slack', allowedTools: ['mcp__slack__*'], envKeys: ['SLACK_BOT_TOKEN','SLACK_TEAM_ID'], resolve: () => ({ type:'stdio', command:'node', args:['slack'] }) } }));
vi.mock('../src/lark.js',  () => ({ larkSkill:  { serverName: 'lark',  allowedTools: ['mcp__lark__*'],  envKeys: [], resolve: () => ({ type:'stdio', command:'node', args:['lark'] }) } }));
const { chatNotifySkill } = await import('../src/chat-notify.js');

const ENV = ['SLACK_CHANNEL','LARK_RECEIVE_ID','SLACK_BOT_TOKEN'];
afterEach(() => ENV.forEach(k => delete process.env[k]));

describe('chat_notify provider pick', () => {
  it('SLACK_CHANNEL set → slack', () => {
    process.env.SLACK_CHANNEL = '#x';
    expect(chatNotifySkill.serverName).toBe('slack');
    expect(chatNotifySkill.allowedTools).toEqual(['mcp__slack__*']);
    expect(chatNotifySkill.resolve()).toMatchObject({ args: ['slack'] });
  });
  it('LARK_RECEIVE_ID set → lark', () => {
    process.env.LARK_RECEIVE_ID = 'oc_x';
    expect(chatNotifySkill.serverName).toBe('lark');
  });
  it('NEW: SLACK_BOT_TOKEN present but NO SLACK_CHANNEL → slack still exposed (channel comes from the agent/custom prompt)', () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    expect(chatNotifySkill.serverName).toBe('slack');
    expect(chatNotifySkill.allowedTools).toEqual(['mcp__slack__*']);
    expect(chatNotifySkill.resolve()).toMatchObject({ args: ['slack'] });
  });
  it('nothing configured → no server (undefined / null)', () => {
    expect(chatNotifySkill.serverName).toBeUndefined();
    expect(chatNotifySkill.allowedTools).toEqual([]);
    expect(chatNotifySkill.resolve()).toBeNull();
  });
  it('explicit channel vars win over token (SLACK_CHANNEL first, LARK_RECEIVE_ID before token fallback)', () => {
    process.env.LARK_RECEIVE_ID = 'oc_x';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    expect(chatNotifySkill.serverName).toBe('lark'); // explicit lark beats slack-token fallback
  });
});
