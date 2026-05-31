/**
 * chatNotifySkill — OR-group meta-skill over slack + lark.
 *
 * Mirrors the `git` meta-skill pattern: lets a workflow declare
 * `skills: [SKILLS.CHAT_NOTIFY]` and have the marketplace card
 * render "Slack OR Lark" instead of demanding both. Backend's
 * REQUIRED_INTEGRATION_MAP entry (`chat_notify: { any: [...] }`)
 * does the OR-group routing for the integration gate.
 *
 * Runtime — single funnel, no parallel paths:
 *
 *   - For in-process callers (custom-execute nodes): use
 *     handleToolCall(toolName, args). It routes to slack or lark
 *     by tool-name prefix.
 *
 *   - For MCP-backed agents (Claude Code SDK / Cursor): resolve()
 *     returns ONE MCP server config — slack's when SLACK_CHANNEL is
 *     set, lark's when LARK_RECEIVE_ID is set. The OR-group at
 *     marketplace integration-gate time is satisfied by EITHER
 *     connection; at runtime we commit to one. The LLM only sees
 *     the matching provider's tools, so there's no chance of it
 *     calling the wrong skill.
 *
 * Skill declaration on a workflow node:
 *
 *   skills: [SKILLS.CHAT_NOTIFY]
 *
 * No need to also declare slack/lark — chat_notify subsumes them.
 */

import { slackSkill } from './slack.js';
import { larkSkill } from './lark.js';

export const chatNotifySkill = {
  id: 'chat_notify',
  description: 'Chat notification meta-skill — routes to whichever messaging integration (Slack OR Lark) the user has configured for this project.',
  // Pull in both providers' env keys so the agent strategy passes
  // them through to whichever MCP server resolve() selects.
  envKeys: [...(slackSkill.envKeys || []), ...(larkSkill.envKeys || [])],

  // ── serverName + allowedTools: dynamic, must match resolve()'s pick ──
  //
  // The MCP agent strategy (claude-strategy._resolveSkills) does:
  //     if (skill.allowedTools) allowedTools.push(...skill.allowedTools);
  //     mcpServers[skill.serverName] = skill.resolve(...);
  //
  // Without a `serverName`, `mcpServers[undefined]` registers the server
  // under the literal key `undefined`, so its tools surface to the model
  // as `mcp__undefined__slack_post_message`. The permission allowlist is
  // built from `allowedTools` (`mcp__slack__*`), which never matches the
  // `mcp__undefined__*` names — so EVERY tool call is silently denied at
  // the Agent SDK permission gate. That's a hard break: any workflow
  // using SKILLS.CHAT_NOTIFY (e.g. sentry-triage dispatch) could fetch +
  // classify but never actually post to Slack/Lark.
  //
  // Both are getters because the active provider is only known at runtime
  // (which env var is set). They evaluate during _resolveSkills, after
  // the workflow's env is loaded, and stay in lockstep with resolve():
  //   SLACK_CHANNEL set  → 'slack' + slack's allowedTools
  //   LARK_RECEIVE_ID set → 'lark' + lark's allowedTools
  // The agent only ever sees ONE provider's server, so its serverName +
  // allowedTools + resolve() all agree.
  get serverName() {
    if (process.env.SLACK_CHANNEL) return slackSkill.serverName;
    if (process.env.LARK_RECEIVE_ID) return larkSkill.serverName;
    // Neither configured → resolve() returns null too, so no server is
    // registered; the undefined here is never used as a map key.
    return undefined;
  },
  get allowedTools() {
    if (process.env.SLACK_CHANNEL) return slackSkill.allowedTools || [];
    if (process.env.LARK_RECEIVE_ID) return larkSkill.allowedTools || [];
    return [];
  },

  promptFragment: `## Chat notifications (Slack OR Lark — at least one connected)
You can post chat messages via either:
- slack_post_message (channel, text)      — Slack, when SLACK_CHANNEL is set
- lark_send_message  (receive_id, text)   — Lark, when LARK_RECEIVE_ID is set
Use whichever the user has configured.`,

  /**
   * Runtime MCP server selection. Picks the provider whose env var
   * the user actually set. Falls back to null when neither is
   * configured (workflow code should already have errored on env
   * validation before reaching this point).
   */
  resolve(ctx) {
    if (process.env.SLACK_CHANNEL && typeof slackSkill.resolve === 'function') {
      return slackSkill.resolve(ctx);
    }
    if (process.env.LARK_RECEIVE_ID && typeof larkSkill.resolve === 'function') {
      return larkSkill.resolve(ctx);
    }
    return null;
  },

  // In-process tool dispatch — delegates to the underlying skill by
  // tool-name prefix. Used by custom-execute dispatchers that aren't
  // going through MCP.
  async handleToolCall(name, args, context) {
    if (typeof name === 'string' && name.startsWith('slack_')) {
      return slackSkill.handleToolCall(name, args, context);
    }
    if (typeof name === 'string' && name.startsWith('lark_')) {
      return larkSkill.handleToolCall(name, args, context);
    }
    return JSON.stringify({ error: `chat_notify: unknown tool "${name}". Expected slack_* or lark_*.` });
  },

  // Surface every slack + lark tool so the assistant-agent strategy
  // (which reads `.tools`) can advertise them all. The LLM picks the
  // right one at runtime based on env / prompt context.
  get tools() {
    return [...(slackSkill.tools || []), ...(larkSkill.tools || [])];
  },
};
