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
  // Lark DOCS — a SEPARATE Lark app credential from the chat/bot one. Real orgs
  // run distinct Lark apps per concern (a chat bot app with no wiki scopes; a
  // knowledge-base app with wiki/docx read scopes and no bot). Mirrors
  // backend/src/services/skill-integrations.js INTEGRATIONS.LARK_DOCS, which
  // already declares `'lark-docs' → lark_docs` as the REQUIRED provider. Docs
  // consumers PREFER this app and fall back to the chat app, so single-app
  // setups keep working unchanged.
  LARK_DOCS: 'lark_docs',
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
  // Google (Docs/Drive) OAuth — drive.file-scoped (per-file access to docs
  // the app creates or the user picks; NO Google verification needed).
  // Refresh-token flow: the backend auto-refreshes the ~1h access token in
  // resolveIntegrationToken('google'). Powers the google-docs skill. See
  // googleDocs.js + backend handlers/google.js.
  GOOGLE:            'google',
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
  // Vikunja — paste-token, and the connection is an INSTANCE + a token rather
  // than a token alone (a Vikunja is usually one the operator hosts, so there is
  // no fixed base URL to assume). resolveIntegrationToken('vikunja') returns
  // both halves. OPTIONAL in the backend map: board-runner drives Jira,
  // PingCode or Vikunja behind one adapter, so requiring it would gate a
  // Jira-only user on a backend they never selected. See vikunja.ts +
  // handlers/vikunja.js.
  VIKUNJA:           'vikunja',
  // Figma — paste-token (personal access token) integration, same shape as
  // linear/plane (NOT OAuth). The figmaSkill talks to the Figma REST API
  // directly with the `X-Figma-Token` header (no MCP server), resolved via
  // resolveIntegrationToken('figma') (long-lived PAT, no refresh). See
  // figma.js + handlers/figma.js.
  FIGMA:             'figma',
  // HubSpot — OAuth 2.0 integration (authorization-code + refresh, NOT a
  // paste-token). The hubspotSkill talks to the HubSpot REST API directly with
  // an `Authorization: Bearer <token>` header (no MCP server), resolved via
  // resolveIntegrationToken('hubspot') — the backend auto-refreshes the
  // short-lived access token. See hubspot.js + backend handlers/hubspot.js.
  HUBSPOT:           'hubspot',
  // OpenDesign — paste-token + base URL integration (same { token, baseUrl }
  // shape as plane). The opendesignSkill talks to the OpenDesign REST API
  // directly (Authorization: Bearer <token>; all paths under `${baseUrl}/api`),
  // resolved via resolveIntegrationToken('open_design'). NOTE: the skill is
  // OPTIONAL — opendesignSkill deliberately sets NO requiresIntegration, so
  // this id is NOT in any required-gating map. See opendesign.js.
  OPEN_DESIGN:       'open_design',
  // LinkedIn — TWO distinct OAuth providers (the single `linkedin` provider is
  // GONE). The linkedinSkill talks to the LinkedIn versioned REST API directly
  // (Authorization: Bearer <token> + LinkedIn-Version + X-Restli-Protocol-Version
  // headers), resolving a VARIANT-SPECIFIC token per tool:
  //   - linkedin_business → Community Management API (org Pages). The org tools
  //     (list admin Organizations, create DRAFT posts) resolve
  //     resolveIntegrationToken('linkedin_business').
  //   - linkedin_personal → Share on LinkedIn (member profile). The publish tool
  //     resolves resolveIntegrationToken('linkedin_personal') (its token blob
  //     also carries the member id) and PUBLISHES to the member feed.
  // The skill itself sets NO requiresIntegration — the "personal OR business"
  // OR-group gating lives in the backend REQUIRED_INTEGRATION_MAP
  // (linkedin: {any:[linkedin_personal, linkedin_business]}), exactly like
  // git-write. See linkedin.js + handlers/linkedin.js.
  LINKEDIN_PERSONAL: 'linkedin_personal',
  LINKEDIN_BUSINESS: 'linkedin_business',
  // Discord — paste-token (static bot token + guild id) integration, same
  // shape as linear/circleci (NOT OAuth). The discordSkill talks to the
  // Discord REST API directly (Authorization: Bot <token>), resolved via
  // resolveIntegrationToken('discord') with a DISCORD_BOT_TOKEN env fallback
  // for self-host. See discord.js + backend handlers/discord.js.
  DISCORD:           'discord',
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
  // DISPLAY names only — the ids `lark` / `lark_docs` are load-bearing (DDB
  // integration rows key on `provider`, LARK_DOCS_* env, connectPath) and never
  // change with the copy. The names disambiguate the TWO Lark credentials
  // ("Lark" alone reads as one thing): the PROJECT-SCOPED chat/bot app vs the
  // ACCOUNT-LEVEL application. `lark_docs` is named for the APP, not for docs:
  // one app_id + app_secret that already serves docs/wiki and is what every
  // other org-wide read surface rides.
  //
  // These must match backend/src/services/skill-integrations.js entry for entry
  // — `lark` said "Lark" here and "Lark Chat" there until 2026-08-17, i.e. the
  // same provider rendered under two names depending on which surface answered.
  // __tests__/integration-registry-parity.test.ts is the tripwire.
  lark:   { id: 'lark',   name: 'Lark Chat', connectPath: '/integrations?provider=lark' },
  lark_docs: { id: 'lark_docs', name: 'Lark App', connectPath: '/integrations?provider=lark_docs' },
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
  google: { id: 'google', name: 'Google Docs', connectPath: '/integrations?provider=google' },
  plane:  { id: 'plane',  name: 'Plane',  connectPath: '/integrations?provider=plane'  },
  linear: { id: 'linear', name: 'Linear', connectPath: '/integrations?provider=linear' },
  vikunja: { id: 'vikunja', name: 'Vikunja', connectPath: '/integrations?provider=vikunja' },
  figma:  { id: 'figma',  name: 'Figma',  connectPath: '/integrations?provider=figma'  },
  hubspot: { id: 'hubspot', name: 'HubSpot', connectPath: '/integrations?provider=hubspot' },
  open_design: { id: 'open_design', name: 'OpenDesign', connectPath: '/integrations?provider=open_design' },
  linkedin_personal: { id: 'linkedin_personal', name: 'LinkedIn (Personal)', connectPath: '/integrations?provider=linkedin_personal' },
  linkedin_business: { id: 'linkedin_business', name: 'LinkedIn (Business)', connectPath: '/integrations?provider=linkedin_business' },
  discord: { id: 'discord', name: 'Discord', connectPath: '/integrations?provider=discord' },
});
