/**
 * chatNotifySkill — "post to the team's chat", over every chat provider the
 * run may use (Slack, Lark).
 *
 * A workflow node declares `skills: [SKILLS.CHAT_NOTIFY]` and means "whatever
 * chat this project connected". The marketplace card renders "Slack OR Lark"
 * and the integration gate passes when EITHER is connected (backend
 * REQUIRED_INTEGRATION_MAP `chat_notify: { any: [...] }`).
 *
 * WHICH PROVIDERS, AND WHO DECIDES. The skill never picks a provider and never
 * picks a destination:
 *
 *   - WHICH ONES EXIST for this run is the platform's answer, read by
 *     `availableChatProviders()` below — the one decider for what is mounted,
 *     what is listed and what the prompt says, so the three cannot disagree.
 *   - EVERY available provider is served, by ONE MCP server named
 *     `chat_notify`. A project that connected both gets both.
 *   - WHERE a message goes is the agent's instructions (a per-node prompt:
 *     "post the round summary to #release"). A default destination the operator
 *     set (SLACK_CHANNEL / LARK_RECEIVE_ID) is told to the agent as a default,
 *     nothing more.
 *
 * It used to commit to one provider by a fixed order of env vars (explicit
 * Slack channel, explicit Lark chat, Slack token), mounted under that
 * provider's own server name. Two things followed that no operator chose: with
 * both connected Slack always won, and Lark was only reachable when a fixed
 * chat id had been set in the env — instructions alone could not send there.
 *
 * In-process callers (custom-execute nodes) keep using
 * `handleToolCall(toolName, args)`: it routes by tool-name prefix and the
 * provider's own handler decides whether it can post.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slackSkill } from './slack.js';
import { larkSkill } from './lark.js';
import { INTEGRATIONS } from './integrations.js';

const SERVER_NAME = 'chat_notify';

/**
 * The providers this skill spans. `credential` is the env var the platform
 * injects for a run that has the provider's credentials; `destination` is the
 * operator's optional default place to post. Order is display order only.
 */
const PROVIDERS = Object.freeze([
  { integration: INTEGRATIONS.SLACK, label: 'Slack', skill: slackSkill, prefix: 'slack_', credential: 'SLACK_BOT_TOKEN', destination: 'SLACK_CHANNEL' },
  { integration: INTEGRATIONS.LARK, label: 'Lark', skill: larkSkill, prefix: 'lark_', credential: 'LARK_APP_ID', destination: 'LARK_RECEIVE_ID' },
]);

/** Run facts this skill reads to know which providers exist. None is a secret. */
const AVAILABILITY_ENV_KEYS = Object.freeze([
  'WORKFLOW_CONNECTED_INTEGRATIONS', 'WORKFLOW_ENABLED_INTEGRATIONS',
  ...PROVIDERS.flatMap((p) => [p.credential, p.destination]),
]);

/** A comma-separated run fact as a set; null when the platform did not state it. */
function stated(value: unknown): Set<string> | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean));
}

/**
 * THE ONE DECIDER: the chat providers this run may post through.
 *
 * A provider exists for the run when the platform says so — it is on the
 * account's connected list (WORKFLOW_CONNECTED_INTEGRATIONS), or the platform
 * handed this run its credential or the operator gave it a destination. It is
 * then kept only if the agent's own allowlist admits it
 * (WORKFLOW_ENABLED_INTEGRATIONS; absent = every connected provider is
 * allowed, the platform's own rule for that variable).
 */
export function availableChatProviders(env: Record<string, string | undefined> = process.env) {
  const connected = stated(env.WORKFLOW_CONNECTED_INTEGRATIONS);
  const enabled = stated(env.WORKFLOW_ENABLED_INTEGRATIONS);
  return PROVIDERS.filter((p) => (connected?.has(p.integration) || !!env[p.credential] || !!env[p.destination])
    && (!enabled || enabled.has(p.integration)));
}

/**
 * bin/mcp-skill.mjs — the generic server that serves any skill's `tools` through
 * its `handleToolCall`. Derived from `import.meta.url`, never a package
 * self-reference (see github.ts `resolveSkillBin`).
 */
function resolveSkillBin() {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

export const chatNotifySkill: any = {
  id: 'chat_notify',
  serverName: SERVER_NAME,
  description: 'Post to the team\'s chat — every chat provider (Slack, Lark) this project connected and this agent may use.',
  // EITHER provider makes this skill real (the engine reads a list as "any one
  // of") and withholds the prompt fragment when neither is connected.
  requiresIntegration: PROVIDERS.map((p) => p.integration),
  // What a spawned server (or a per-call worker) needs: each provider's own
  // keys, plus the run facts `availableChatProviders` reads — a child that
  // cannot read them would list no tools and refuse every call.
  envKeys: [...new Set([...PROVIDERS.flatMap((p) => p.skill.envKeys || []), ...AVAILABILITY_ENV_KEYS])],

  /** Pure preflight check; the same provider decision used by tools and resolve(). */
  mcpAvailableForRun() {
    return availableChatProviders().length > 0;
  },

  /** Tool patterns for the permission allowlist — this skill's ONE server. */
  get allowedTools() {
    return availableChatProviders().length ? [`mcp__${SERVER_NAME}__*`] : [];
  },

  /**
   * What the agent is told. Only the providers it actually has, and never where
   * to post: that is its instructions. An operator's default is stated as one.
   */
  promptFragment() {
    const providers = availableChatProviders();
    if (!providers.length) return '';
    const lines = [`## Chat messages (${providers.map((p) => p.label).join(', ')})`, 'You can post to the team\'s chat:'];
    for (const p of providers) {
      const fallback = process.env[p.destination];
      if (p.integration === INTEGRATIONS.SLACK) {
        lines.push(`- slack_post_message (channel, text[, blocks]) — Slack. \`channel\` is a "#name" or a channel id.${fallback ? ` Default channel: ${fallback}.` : ''}`);
      } else {
        lines.push(`- lark_send_message (receive_id, text) — Lark. \`receive_id\` is a chat id (oc_…), a user id or an email.${fallback ? ` Default chat: ${fallback}.` : ''}`);
      }
    }
    lines.push('Where a message goes comes from your instructions. With no destination in your instructions and no default above, do not post — there is nowhere to send it.');
    return lines.join('\n');
  },

  /**
   * ONE server for every available provider: the generic skill server over
   * this module, so the model gets `mcp__chat_notify__slack_*` and
   * `mcp__chat_notify__lark_*` side by side. null when the run has no chat
   * provider — nothing is mounted and nothing is promised.
   */
  resolve(ctx?: unknown) {
    const providers = availableChatProviders();
    if (!providers.length) return null;
    const bin = resolveSkillBin();
    if (!bin) return null;
    // Each provider's own resolve() already allow-lists the env its handler
    // needs; take exactly that, and add the facts the child decides by.
    const env: Record<string, string> = {};
    for (const p of providers) {
      const own = typeof p.skill.resolve === 'function' ? p.skill.resolve(ctx) : null;
      if (own && own.env && typeof own.env === 'object') Object.assign(env, own.env);
    }
    for (const key of this.envKeys) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/chat-notify.js', 'chatNotifySkill'],
      env,
      description: this.description,
    };
  },

  // Routes by tool-name prefix; the provider's own handler is the authority on
  // whether it can post. Deliberately NOT gated on availableChatProviders():
  // a code node that calls a provider directly is told the truth by that
  // provider, not by this skill's reading of the run.
  async handleToolCall(name, args, context) {
    const provider = typeof name === 'string' ? PROVIDERS.find((p) => name.startsWith(p.prefix)) : null;
    if (provider) return provider.skill.handleToolCall(name, args, context);
    return JSON.stringify({ error: `chat_notify: unknown tool "${name}". Expected ${PROVIDERS.map((p) => `${p.prefix}*`).join(' or ')}.` });
  },

  /** The tools of every provider this run has — what is listed is what can be called. */
  get tools() {
    return availableChatProviders().flatMap((p) => p.skill.tools || []);
  },
};
