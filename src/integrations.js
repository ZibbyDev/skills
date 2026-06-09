/**
 * Integration registry — the closed set of OAuth/credentialed external
 * services a Zibby skill can declare a dependency on.
 *
 * Why this exists:
 *   Skills hand-off authentication to the backend's resolveIntegrationToken()
 *   (see packages/skills/src/jira.js, sentry.js, etc.). At deploy time we
 *   want to know "does THIS workflow need Slack connected before it can
 *   run?" without re-grepping handler source. Skills declare it explicitly
 *   via `requiresIntegration: INTEGRATIONS.<NAME>` and the backend
 *   workflow-bundler derives `workflow.requiredIntegrations` from the
 *   union of every node's skill list. Same pattern as npm peer-deps,
 *   Helm `requires`, Terraform `required_providers`.
 *
 * Source of truth for IDs lives here (Object.freeze) — both backend
 * (`backend/src/services/skill-integrations.js`) and frontend (settings
 * UI) reference these string constants. Backend mirrors the skill→
 * integration mapping locally because @zibby/skills is NOT bundled into
 * the Lambda layer (per CLAUDE.md: lambda-layer/nodejs/package.json must
 * stay under 262MB and only carries production runtime deps).
 */

export const INTEGRATIONS = Object.freeze({
  SENTRY: 'sentry',
  JIRA:   'jira',
  GITHUB: 'github',
  GITLAB: 'gitlab',
  SLACK:  'slack',
  LARK:   'lark',
  // LLM-provider admin/billing keys. Distinct from a hypothetical
  // `OPENAI` (request-time chat API key) — these are org-admin scoped,
  // read-only for cost+usage reporting, and gated separately at the UI
  // because the consent surface is different (only an org-admin can
  // mint them). Cursor's Team/Enterprise Admin API follows the same
  // shape (single paste-able admin token, no OAuth).
  OPENAI_BILLING:    'openai_billing',
  ANTHROPIC_BILLING: 'anthropic_billing',
  CURSOR_ADMIN:      'cursor_admin',
  // Notion OAuth — multi-workspace integration. See handlers/notion.js.
  NOTION:            'notion',
  // Plane — api-key style (static API key + workspace slug + base URL),
  // NOT OAuth. Same paste-token shape as github/sentry. Backed by the
  // official Plane MCP server (see plane.js). baseUrl is user-overridable
  // so one integration covers Plane Cloud, self-hosted, and Zibby-hosted.
  PLANE:             'plane',
  // Linear — api-key style (static personal API key), NOT OAuth. Same
  // paste-token shape as github/sentry/plane but a SINGLE value (no
  // workspace slug / base URL). The linearSkill talks to the Linear
  // GraphQL API directly (no MCP server). See linear.js + handlers/linear.js.
  LINEAR:            'linear',
});

/**
 * Display metadata. Surface this to humans (modal copy, missing-list
 * rendering) — backend joins this with the user's connected list and
 * returns it from GET /workflows/{uuid}/integrations/status.
 *
 * `connectPath` points to the existing frontend Integrations page —
 * verified against frontend/src/App.js (route `/integrations`) and
 * frontend/src/pages/IntegrationsPage/IntegrationsPage.js (single page
 * handles all six providers). We pass the provider name as a query
 * param so the UI can highlight / scroll the relevant card; the page
 * gracefully ignores the param if not handled yet. NO per-provider
 * sub-routes exist (`/integrations/jira` etc. would 404 today).
 */
export const INTEGRATION_REGISTRY = Object.freeze({
  sentry: { id: 'sentry', name: 'Sentry', connectPath: '/integrations?provider=sentry' },
  jira:   { id: 'jira',   name: 'Jira',   connectPath: '/integrations?provider=jira'   },
  github: { id: 'github', name: 'GitHub', connectPath: '/integrations?provider=github' },
  gitlab: { id: 'gitlab', name: 'GitLab', connectPath: '/integrations?provider=gitlab' },
  slack:  { id: 'slack',  name: 'Slack',  connectPath: '/integrations?provider=slack'  },
  lark:   { id: 'lark',   name: 'Lark',   connectPath: '/integrations?provider=lark'   },
  openai_billing: {
    id: 'openai_billing',
    name: 'OpenAI Admin',
    connectPath: '/integrations?provider=openai_billing',
  },
  anthropic_billing: {
    id: 'anthropic_billing',
    name: 'Anthropic Admin',
    connectPath: '/integrations?provider=anthropic_billing',
  },
  cursor_admin: {
    id: 'cursor_admin',
    name: 'Cursor Admin',
    connectPath: '/integrations?provider=cursor_admin',
  },
  notion: { id: 'notion', name: 'Notion', connectPath: '/integrations?provider=notion' },
  plane:  { id: 'plane',  name: 'Plane',  connectPath: '/integrations?provider=plane'  },
  linear: { id: 'linear', name: 'Linear', connectPath: '/integrations?provider=linear' },
});
