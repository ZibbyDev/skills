/**
 * Plane skill — plugs in the OFFICIAL Plane MCP server.
 *
 * Unlike jira.js / github.js (which hand-write every tool against the
 * provider REST API), this skill is a pure MCP plug-in: it spawns the
 * official `makeplane/plane-mcp-server` over stdio and exposes ALL of
 * its ~100+ tools (projects, work items CRUD + search, cycles, modules,
 * comments, epics, labels, states, pages, workspaces, …) to the agent
 * via the `mcp__plane__*` wildcard allowlist. There is deliberately NO
 * `tools: [...]` array and NO `handleToolCall` — the MCP server is the
 * single source of truth for the tool surface, so it stays current with
 * upstream without us re-implementing anything.
 *
 * Run path (documented stdio entrypoint): `uvx plane-mcp-server stdio`.
 * (A Dockerfile + npx remote also exist upstream; uvx is the canonical
 * stdio path.) `uvx` must be available in the agent runtime — see the
 * "TO GO LIVE" note in the skill's README/handoff.
 *
 * Auth + endpoint (api-key style, mirrors github/sentry credential shape):
 *   - PLANE_API_KEY        (required) static workspace/personal API key
 *   - PLANE_WORKSPACE_SLUG (required for stdio) the workspace to operate on
 *   - PLANE_BASE_URL       (optional) the Plane API base URL
 *
 * Base URL is CONFIGURABLE so a single skill covers all three hosting
 * models with no code change:
 *   - Plane Cloud:        https://api.plane.so   (the default)
 *   - Self-hosted Plane:  https://plane.acme.com/api  (the instance's API base)
 *   - Zibby-app-hosted:   the Zibby-managed instance's API base URL
 * The value flows through the integration credential (baseUrl) or the
 * PLANE_BASE_URL env var; when absent the MCP server falls back to
 * api.plane.so. Never hardcode the host in a tool call.
 *
 * Credential plumbing matches jira/github: the backend resolves the
 * connected-integration credentials and injects them into the Fargate
 * task env (PLANE_API_KEY / PLANE_WORKSPACE_SLUG / PLANE_BASE_URL).
 * resolve() reads them straight from process.env — exactly like
 * jiraSkill.resolve() reads ATLASSIAN_ACCESS_TOKEN. Local dev can set
 * the same env vars directly.
 */

import { INTEGRATIONS } from './integrations.js';

export const planeSkill = {
  id: 'plane',
  serverName: 'plane',                 // MCP server name; tools appear as mcp__plane__<tool>
  allowedTools: ['mcp__plane__*'],     // wildcard: auto-exposes EVERY tool the MCP server serves
  // External credentialed service this skill depends on. The backend
  // workflow-bundler reads this when a node lists this skill and adds
  // 'plane' to workflow.requiredIntegrations, so the status endpoint can
  // tell the user "Plane must be connected before this workflow runs".
  requiresIntegration: INTEGRATIONS.PLANE,
  envKeys: ['PLANE_API_KEY', 'PLANE_WORKSPACE_SLUG', 'PLANE_BASE_URL'],
  description: 'Plane — projects, work items, cycles, modules, epics, comments (official MCP, API key)',
  tools: [],                           // empty: tools come from the spawned MCP server, not declared here

  promptFragment: `## Plane (connected)
You have direct access to the user's Plane workspace via the official Plane MCP server. All Plane tools are available under the mcp__plane__* namespace — use them proactively to read and write projects, work items (issues), cycles, modules, epics, sub-issues, comments, labels, states, pages, and workspace data.

- List/get projects and work items, then create/update/delete or search work items as needed.
- For status changes, read the project's available states first, then set the work item's state.
- Cycles and modules group work items — list them to scope queries before drilling into items.
- Always operate within the connected workspace; the workspace slug and base URL are pre-configured (Plane Cloud, self-hosted, or Zibby-hosted all work transparently).`,

  /**
   * Spawn the official Plane MCP server over stdio. Reads the api-key
   * credentials from the env the backend injected (PLANE_API_KEY /
   * PLANE_WORKSPACE_SLUG / PLANE_BASE_URL). PLANE_BASE_URL is optional —
   * omitted means the MCP server defaults to https://api.plane.so
   * (Plane Cloud); set it for self-hosted / Zibby-hosted instances.
   */
  resolve() {
    const env = {};
    for (const key of this.envKeys) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return {
      type: 'stdio',
      command: 'uvx',
      args: ['plane-mcp-server', 'stdio'],
      env,
      description: this.description,
    };
  },
};
