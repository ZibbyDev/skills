/**
 * trigger-agent — a GENERIC, agent-callable skill for firing another Zibby
 * agent run from inside a running agent.
 *
 * The agent gets ONE real MCP tool, `trigger_agent`, and DECIDES for itself
 * when (and how many times) to call it — so a triage agent can trigger a fix for
 * every issue it judges worth fixing, an orchestrator can fan out to N children,
 * etc. This is the agent-driven counterpart to the engine's deterministic
 * `dispatchSubgraph` — the primitive lives in the model's hands, not in node code.
 *
 * Portable across CLOUD and SELF-HOSTED (the same reason @zibby/skills/datasetStore
 * works in both): it POSTs to `${apiBase}/projects/{PROJECT_ID}/workflows/{type}/trigger`
 * with the run's `PROJECT_API_TOKEN`, resolving `apiBase` from the env the runtime
 * injects — cloud sets `PROGRESS_API_URL` (`<base>/executions`), self-hosted's
 * docker/k8s dispatcher sets `ZIBBY_ACCOUNT_API_URL` ("reachable FROM the run") —
 * so neither environment needs a special case.
 *
 * Fire-and-forget: it triggers the run and returns its executionId; it does NOT
 * wait for the child to finish. `handleToolCall` NEVER throws — any failure comes
 * back as `{ ok:false, error }` so a bad trigger can't crash the calling agent.
 *
 * Shape mirrors the other hand-written multi-tool skills (github.js / datasetStore.js):
 * `serverName`, `allowedTools`, `tools[]`, `handleToolCall`, and a `resolve()` that
 * spawns the generic bin/mcp-skill.mjs.
 */

import { dirname, resolve as resolvePath } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

/** Generic skill MCP-server binary — derived from import.meta.url so it works in
 *  src/ (dev), dist/ (bundled), and node_modules/@zibby/skills/ (published). */
function resolveSkillBin() {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

/** The run's backend credential (Fargate-injected PROJECT_API_TOKEN first). */
function getSessionToken() {
  return process.env.PROJECT_API_TOKEN || process.env.ZIBBY_USER_TOKEN || null;
}

/**
 * Backend base URL, PORTABLE across cloud AND self-hosted:
 *  - cloud (Fargate): PROGRESS_API_URL is set (`<base>/executions`) — strip it.
 *  - self-hosted (docker/k8s): the dispatcher injects ZIBBY_ACCOUNT_API_URL
 *    ("the control-plane as reachable FROM the run"), NOT PROGRESS_API_URL — so we
 *    fall back to it (the same base @zibby/skills/datasetStore uses, which is why
 *    datasets work self-hosted). api-prod is the final default (matches datasetStore).
 */
function getApiBase() {
  const fromProgress = (process.env.PROGRESS_API_URL || '').replace(/\/executions\/?$/, '');
  const raw = fromProgress
    || process.env.ZIBBY_ACCOUNT_API_URL
    || process.env.ZIBBY_PROD_ACCOUNT_API_URL
    || (process.env.ZIBBY_ENV === 'local' ? 'http://localhost:3001' : 'https://api-prod.zibby.app');
  return raw.replace(/\/+$/, '');
}

const TRIGGER_TOOL = {
  name: 'trigger_agent',
  description:
    'Trigger another Zibby workflow/agent run in THIS project (fire-and-forget). ' +
    'Call it once per run you want to start — the agent decides which and how many. ' +
    'Omit workflowType to re-run THIS same agent (self-dispatch, e.g. with a different ' +
    'trigger input). Returns the started run\'s executionId; does NOT wait for it to finish.',
  input_schema: {
    type: 'object',
    properties: {
      workflowType: {
        type: 'string',
        description:
          'Which workflow to trigger (its type/slug in this project). Omit to trigger THIS same agent (self-dispatch).',
      },
      input: {
        type: 'object',
        description: 'The trigger payload passed to the target workflow (validated against its state schema).',
      },
    },
    required: [],
  },
};

export const triggerAgentSkill = {
  id: 'trigger-agent',
  serverName: 'trigger',
  allowedTools: ['mcp__trigger__*'],
  envKeys: [],
  description:
    'Trigger another Zibby workflow/agent run in this project (agent-driven, fire-and-forget; cloud + self-hosted).',

  promptFragment: `## Trigger another agent (agent-driven)
You can start another Zibby agent run yourself with the \`trigger_agent\`
tool — and YOU decide when and how many times to call it. Each call starts ONE
independent run (fire-and-forget) and returns its executionId; it does NOT wait for
that run to finish.
- To re-run THIS same agent (self-dispatch) — e.g. to hand an item to another of
  this agent's scenarios — OMIT \`workflowType\` and pass the \`input\` for that run.
- To trigger a DIFFERENT agent in the project, pass its \`workflowType\` + \`input\`.
Call it once per run you want to start (loop over your items and call it for each).
It never throws — a failure comes back as { ok:false, error }; log it and move on.`,

  resolve() {
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env: {}, description: this.description };
    // Forward the auth + routing env the spawned MCP process needs to reach the
    // backend and self-address. resolve() runs in the agent process where the
    // workflow-executor has set these.
    const env = {};
    for (const key of [
      'PROJECT_API_TOKEN', 'PROJECT_ID', 'WORKFLOW_TYPE',
      'PROGRESS_API_URL', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_PROD_ACCOUNT_API_URL', 'ZIBBY_ENV', 'ZIBBY_USER_TOKEN',
    ]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/triggerAgent.js', 'triggerAgentSkill'],
      env,
      description: this.description,
      alwaysLoad: false,
    };
  },

  async handleToolCall(name, args = {}) {
    if (name !== 'trigger_agent') {
      return JSON.stringify({ ok: false, error: `unknown tool: ${name}` });
    }
    try {
      const projectId = process.env.PROJECT_ID;
      const token = getSessionToken();
      const workflowType =
        (typeof args.workflowType === 'string' && args.workflowType.trim())
          ? args.workflowType.trim()
          : (process.env.WORKFLOW_TYPE || '').trim();
      if (!projectId) return JSON.stringify({ ok: false, error: 'PROJECT_ID not set — cannot resolve the target project.' });
      if (!token)     return JSON.stringify({ ok: false, error: 'PROJECT_API_TOKEN not set — cannot authenticate the trigger.' });
      if (!workflowType) return JSON.stringify({ ok: false, error: 'No workflowType given and WORKFLOW_TYPE is unset — nothing to trigger.' });

      const url = `${getApiBase()}/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowType)}/trigger`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      let resp;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ input: (args.input && typeof args.input === 'object') ? args.input : {} }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const text = await resp.text().catch(() => '');
      let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
      if (!resp.ok) {
        return JSON.stringify({ ok: false, error: `trigger failed (HTTP ${resp.status})`, detail: (body && (body.error || body.message)) || text.slice(0, 300) });
      }
      const executionId = body.executionId || body.execution?.id || body.id || null;
      return JSON.stringify({ ok: true, workflowType, executionId, note: 'run started (fire-and-forget)' });
    } catch (e) {
      return JSON.stringify({ ok: false, error: `trigger_agent failed: ${e?.message || String(e)}` });
    }
  },

  tools: [TRIGGER_TOOL],
};
