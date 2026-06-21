import { describe, it, expect, vi } from 'vitest';

// resolveIntegrationToken is imported at module load by sentry/jira/github/
// slack/lark — stub it so the skill modules don't try to reach a real
// backend during import. (Same approach as test/lark.test.js.)
vi.mock('@zibby/core/backend-client.js', () => ({
  resolveIntegrationToken: vi.fn(async () => ({})),
  clearTokenCache: vi.fn(),
}));

const { INTEGRATIONS, INTEGRATION_REGISTRY } = await import('../src/integrations.js');
const { sentrySkill } = await import('../src/sentry.js');
const { jiraSkill } = await import('../src/jira.js');
const { githubSkill } = await import('../src/github.js');
const { planeSkill } = await import('../src/plane.js');
const { linearSkill } = await import('../src/linear.js');
const { slackSkill } = await import('../src/slack.js');
const { larkSkill } = await import('../src/lark.js');
const { memorySkill } = await import('../src/memory.js');
const { chatMemorySkill } = await import('../src/chat-memory.js');
const { coreToolsSkill } = await import('../src/core-tools.js');
const { browserSkill } = await import('../src/browser.js');
const {
  openaiBillingSkill,
  anthropicBillingSkill,
  cursorAdminSkill,
} = await import('../src/llm-billing.js');

describe('INTEGRATIONS constant', () => {
  it('is frozen (single source of truth)', () => {
    expect(Object.isFrozen(INTEGRATIONS)).toBe(true);
    // Sanity: attempting to mutate throws or silently no-ops; the freeze
    // guarantees no late additions slip in via a typo somewhere.
    expect(() => { INTEGRATIONS.NEW = 'new'; }).toThrow();
  });

  it('exposes the closed set of providers backend handlers support', () => {
    // If you add a provider handler under backend/src/handlers/*.js with
    // OAuth/credentials, add it here too. Order doesn't matter; the set
    // is what we verify. Adding to this set is intentional and must be
    // mirrored in backend/src/services/skill-integrations.js — the
    // backend keeps its own copy because @zibby/skills isn't bundled
    // into the Lambda layer.
    expect(new Set(Object.values(INTEGRATIONS))).toEqual(
      new Set([
        'sentry', 'jira', 'github', 'gitlab', 'slack', 'lark',
        // LLM-provider admin/billing keys (paste-token, no OAuth — see
        // INTEGRATIONS comment above)
        'openai_billing', 'anthropic_billing', 'cursor_admin',
        // Notion OAuth — multi-workspace integration. See
        // backend/src/handlers/notion.js. Surfaced for notify-notion +
        // any future report-producing template that targets Notion as
        // a destination.
        'notion',
        // Plane — api-key style (static API key + workspace slug +
        // overridable base URL), backed by the official Plane MCP server.
        // See plane.js. Supports Plane Cloud, self-hosted, and Zibby-hosted
        // via the configurable PLANE_BASE_URL.
        'plane',
        // Linear — api-key style (single static personal API key, no
        // workspace slug / base URL). See linear.js + handlers/linear.js.
        // The skill talks to the Linear GraphQL API directly (no MCP server).
        'linear',
        // Figma — first-class OAuth integration (NOT a paste-token). See
        // figma.js + handlers/figma.js. The skill reads files/nodes/
        // comments and renders frames via the Figma REST API with a Bearer
        // token (auto-refreshed server-side); no MCP server.
        'figma',
        // OpenDesign — paste-token + base URL integration (same { token,
        // baseUrl } shape as plane). OPTIONAL skill — opendesignSkill sets
        // NO requiresIntegration, so this id is not in any gating map.
        // See opendesign.js.
        'open_design',
      ])
    );
  });
});

describe('INTEGRATION_REGISTRY', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(INTEGRATION_REGISTRY)).toBe(true);
  });

  it('has one entry per INTEGRATIONS value, with matching id', () => {
    const integrationIds = Object.values(INTEGRATIONS).sort();
    const registryKeys = Object.keys(INTEGRATION_REGISTRY).sort();
    expect(registryKeys).toEqual(integrationIds);
    for (const id of integrationIds) {
      const entry = INTEGRATION_REGISTRY[id];
      expect(entry.id).toBe(id);
      expect(typeof entry.name).toBe('string');
      expect(entry.name.length).toBeGreaterThan(0);
      // connectPath must point at the existing /integrations frontend route
      // (App.js:112). Per-provider sub-routes don't exist — query param
      // tells the page which card to highlight.
      expect(entry.connectPath).toMatch(/^\/integrations(\?|$)/);
    }
  });
});

describe('skill.requiresIntegration declarations', () => {
  it('sentrySkill declares sentry', () => {
    expect(sentrySkill.requiresIntegration).toBe(INTEGRATIONS.SENTRY);
  });
  it('jiraSkill declares jira', () => {
    expect(jiraSkill.requiresIntegration).toBe(INTEGRATIONS.JIRA);
  });
  it('githubSkill declares github', () => {
    expect(githubSkill.requiresIntegration).toBe(INTEGRATIONS.GITHUB);
  });
  it('planeSkill declares plane', () => {
    expect(planeSkill.requiresIntegration).toBe(INTEGRATIONS.PLANE);
  });
  it('linearSkill declares linear', () => {
    expect(linearSkill.requiresIntegration).toBe(INTEGRATIONS.LINEAR);
  });
  it('slackSkill declares slack', () => {
    expect(slackSkill.requiresIntegration).toBe(INTEGRATIONS.SLACK);
  });
  it('larkSkill declares lark', () => {
    expect(larkSkill.requiresIntegration).toBe(INTEGRATIONS.LARK);
  });

  // Skills that run entirely against local state / process env / a
  // self-contained MCP server must NOT declare an integration. Adding
  // one would force users to "connect" something that isn't actually a
  // prerequisite. Re-verify each time someone touches these files.
  it('memory/chat-memory/core-tools/browser do NOT declare an integration', () => {
    expect(memorySkill.requiresIntegration).toBeUndefined();
    expect(chatMemorySkill.requiresIntegration).toBeUndefined();
    expect(coreToolsSkill.requiresIntegration).toBeUndefined();
    expect(browserSkill.requiresIntegration).toBeUndefined();
  });

  it('openaiBillingSkill declares openai_billing', () => {
    expect(openaiBillingSkill.requiresIntegration).toBe(INTEGRATIONS.OPENAI_BILLING);
  });
  it('anthropicBillingSkill declares anthropic_billing', () => {
    expect(anthropicBillingSkill.requiresIntegration).toBe(INTEGRATIONS.ANTHROPIC_BILLING);
  });
  it('cursorAdminSkill declares cursor_admin', () => {
    expect(cursorAdminSkill.requiresIntegration).toBe(INTEGRATIONS.CURSOR_ADMIN);
  });
});
