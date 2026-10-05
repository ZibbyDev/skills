/**
 * chat_notify serves EVERY chat provider the run may use, and decides nothing
 * else: no provider is preferred, and where a message goes is the agent's
 * instructions.
 *
 * Before: one provider was picked by a fixed order of env vars (explicit Slack
 * channel, explicit Lark chat, Slack token) and mounted under that provider's
 * server name. With both connected Slack always won; Lark was reachable only
 * when a fixed chat id sat in the env; and the prompt fragment was injected
 * whether or not anything was connected.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { chatNotifySkill, availableChatProviders } from '../chat-notify.js';
import { slackSkill } from '../slack.js';
import { larkSkill } from '../lark.js';

const KEYS = ['WORKFLOW_CONNECTED_INTEGRATIONS', 'WORKFLOW_ENABLED_INTEGRATIONS', 'SLACK_CHANNEL', 'SLACK_BOT_TOKEN', 'LARK_RECEIVE_ID', 'LARK_APP_ID'];
const saved = { ...process.env };
/** The run's facts, and nothing left over from the host. */
function run(env: Record<string, string>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
}
afterEach(() => { process.env = { ...saved }; });

const names = () => chatNotifySkill.tools.map((t: any) => t.name);
const slackTools = (slackSkill.tools || []).map((t: any) => t.name);
const larkTools = (larkSkill.tools || []).map((t: any) => t.name);

describe('which providers a run has', () => {
  it('names the integrations that make it real — the same two its members require', () => {
    expect(chatNotifySkill.requiresIntegration).toEqual([slackSkill.requiresIntegration, larkSkill.requiresIntegration]);
  });

  it('nothing connected: nothing mounted, nothing listed, nothing said', () => {
    run({});
    expect(availableChatProviders()).toEqual([]);
    expect(chatNotifySkill.resolve({})).toBeNull();
    expect(chatNotifySkill.allowedTools).toEqual([]);
    expect(names()).toEqual([]);
    expect(chatNotifySkill.promptFragment()).toBe('');
    // Never `undefined`: a server keyed `undefined` denied every call.
    expect(chatNotifySkill.serverName).toBe('chat_notify');
  });

  it('Lark connected, no chat id in the env: Lark is served — the destination is the agent\'s instructions', () => {
    run({ WORKFLOW_CONNECTED_INTEGRATIONS: 'github,lark' });
    expect(availableChatProviders().map((p) => p.label)).toEqual(['Lark']);
    expect(names()).toEqual(larkTools);
    expect(chatNotifySkill.resolve({})?.command).toBe('node');
    const said = chatNotifySkill.promptFragment();
    expect(said).toContain('lark_send_message');
    expect(said).not.toContain('slack_post_message');
    expect(said).toContain('comes from your instructions');
  });

  it('both connected: both are served by one server — neither is preferred', () => {
    run({ WORKFLOW_CONNECTED_INTEGRATIONS: 'slack,lark' });
    expect(availableChatProviders().map((p) => p.label)).toEqual(['Slack', 'Lark']);
    expect(names()).toEqual([...slackTools, ...larkTools]);
    expect(chatNotifySkill.allowedTools).toEqual(['mcp__chat_notify__*']);
    const said = chatNotifySkill.promptFragment();
    expect(said).toContain('slack_post_message');
    expect(said).toContain('lark_send_message');
  });

  it('an explicit Slack channel no longer hides a connected Lark', () => {
    run({ WORKFLOW_CONNECTED_INTEGRATIONS: 'slack,lark', SLACK_CHANNEL: '#alerts' });
    expect(availableChatProviders().map((p) => p.label)).toEqual(['Slack', 'Lark']);
    expect(chatNotifySkill.promptFragment()).toContain('Default channel: #alerts.');
  });

  it('the agent\'s own allowlist narrows what it gets', () => {
    run({ WORKFLOW_CONNECTED_INTEGRATIONS: 'slack,lark', WORKFLOW_ENABLED_INTEGRATIONS: 'github,lark' });
    expect(availableChatProviders().map((p) => p.label)).toEqual(['Lark']);
    run({ WORKFLOW_CONNECTED_INTEGRATIONS: 'slack,lark', WORKFLOW_ENABLED_INTEGRATIONS: 'github' });
    expect(availableChatProviders()).toEqual([]);
    expect(chatNotifySkill.resolve({})).toBeNull();
  });

  it('a run the platform did not describe is read from what it was handed (existing deploys)', () => {
    run({ SLACK_BOT_TOKEN: 'xoxb-test-not-real' });
    expect(availableChatProviders().map((p) => p.label)).toEqual(['Slack']);
    run({ LARK_RECEIVE_ID: 'oc_test' });
    expect(availableChatProviders().map((p) => p.label)).toEqual(['Lark']);
    expect(chatNotifySkill.promptFragment()).toContain('Default chat: oc_test.');
    run({ LARK_APP_ID: 'cli_test' });
    expect(availableChatProviders().map((p) => p.label)).toEqual(['Lark']);
  });
});

describe('the one server it mounts', () => {
  it('is the generic skill server over this module, with what the child needs to decide the same way', () => {
    run({ WORKFLOW_CONNECTED_INTEGRATIONS: 'slack,lark', SLACK_BOT_TOKEN: 'xoxb-test-not-real', PROJECT_API_TOKEN: 'run-token' });
    const spec = chatNotifySkill.resolve({});
    expect(spec.args.slice(1)).toEqual(['../dist/chat-notify.js', 'chatNotifySkill']);
    expect(existsSync(spec.args[0])).toBe(true);
    expect(spec.env.WORKFLOW_CONNECTED_INTEGRATIONS).toBe('slack,lark');
    expect(spec.env.SLACK_BOT_TOKEN).toBe('xoxb-test-not-real');
    expect(spec.env.PROJECT_API_TOKEN).toBe('run-token');
    // A per-call worker is given PATH/HOME + envKeys and nothing else: the
    // facts it decides by must be among them, or it would list no tools.
    for (const k of ['WORKFLOW_CONNECTED_INTEGRATIONS', 'WORKFLOW_ENABLED_INTEGRATIONS']) expect(chatNotifySkill.envKeys).toContain(k);
    for (const k of [...(slackSkill.envKeys || []), ...(larkSkill.envKeys || [])]) expect(chatNotifySkill.envKeys).toContain(k);
  });

  it('routes a call to its provider by name, whatever this skill reads about the run', async () => {
    run({});
    const out = JSON.parse(await chatNotifySkill.handleToolCall('teams_post', {}, {}));
    expect(out.error).toContain('unknown tool "teams_post"');
  });
});
