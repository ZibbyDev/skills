/**
 * chat_notify is an OR-group over Slack + Lark. Its prompt fragment tells an
 * agent "you can post chat messages", so the engine must be able to withhold it
 * when neither provider is connected — which it decides from
 * `requiresIntegration` (core strategies/index.js: a list means "any one of").
 * Without the declaration the fragment was injected on every node that declares
 * the skill, connected or not.
 */
import { describe, it, expect } from 'vitest';
import { chatNotifySkill } from '../chat-notify.js';
import { slackSkill } from '../slack.js';
import { larkSkill } from '../lark.js';

describe('chat_notify names the integrations that make it real', () => {
  it('requires Slack or Lark — the same two its members require', () => {
    expect(chatNotifySkill.requiresIntegration).toEqual([slackSkill.requiresIntegration, larkSkill.requiresIntegration]);
  });

  it('mounts nothing and offers no tools when neither provider is configured', () => {
    const saved = { ...process.env };
    try {
      for (const k of ['SLACK_CHANNEL', 'LARK_RECEIVE_ID', 'SLACK_BOT_TOKEN']) delete process.env[k];
      expect(chatNotifySkill.resolve({})).toBeNull();
      expect(chatNotifySkill.serverName).toBeUndefined();
      expect(chatNotifySkill.allowedTools).toEqual([]);
    } finally { process.env = saved; }
  });
});
