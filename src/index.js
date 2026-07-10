/**
 * @zibby/skills — Built-in skill catalog
 *
 * Importing this module registers all built-in skills with the core
 * skill registry.  Users and community packages can register additional
 * skills via registerSkill().
 */

import { registerSkill } from '@zibby/agent-workflow';
import { browserSkill } from './browser.js';
import { jiraSkill } from './jira.js';
import { githubSkill } from './github.js';
import { gitlabSkill } from './gitlab.js';
import { figmaSkill } from './figma.js';
import { linearSkill } from './linear.js';
import { planeSkill } from './plane.js';
import { opendesignSkill } from './opendesign.js';
import { slackSkill } from './slack.js';
import { larkSkill } from './lark.js';
import { discordSkill } from './discord.js';
import { notionSkill } from './notion.js';
import { linkedinSkill } from './linkedin.js';
import { googleDocsSkill } from './googleDocs.js';
import { larkDocsSkill } from './larkDocs.js';
import { chatNotifySkill } from './chat-notify.js';
import { memorySkill } from './memory.js';
import { skillInstallerSkill } from './skill-installer.js';
import { coreToolsSkill } from './core-tools.js';
import { sentrySkill } from './sentry.js';
import { testRunnerSkill } from './test-runner.js';
import { gitSkill } from './git.js';
import { gitWriteSkill } from './git-write.js';
import { chatMemorySkill } from './chat-memory.js';
import { kvMemorySkill } from './kvMemory.js';
import { datasetStoreSkill } from './datasetStore.js';
import { chartRenderSkill } from './chartRender.js';
import { socialCardSkill } from './socialCard.js';
import { codeScanSkill } from './code-scan.js';
import { triggerAgentSkill } from './triggerAgent.js';
import { codebaseMemorySkill } from './codebaseMemory.js';
import { workflowBuilderSkill } from './workflow-builder.js';
import {
  openaiBillingSkill,
  anthropicBillingSkill,
  cursorAdminSkill,
} from './llm-billing.js';

registerSkill(browserSkill);
registerSkill(jiraSkill);
registerSkill(githubSkill);
registerSkill(gitlabSkill);
registerSkill(figmaSkill);
registerSkill(linearSkill);
registerSkill(planeSkill);
registerSkill(opendesignSkill);
registerSkill(slackSkill);
registerSkill(larkSkill);
registerSkill(discordSkill);
registerSkill(notionSkill);
registerSkill(linkedinSkill);
registerSkill(googleDocsSkill);
registerSkill(larkDocsSkill);
registerSkill(chatNotifySkill);
registerSkill(sentrySkill);
registerSkill(memorySkill);
registerSkill(testRunnerSkill);
registerSkill(gitSkill);
registerSkill(gitWriteSkill);
registerSkill(skillInstallerSkill);
registerSkill(coreToolsSkill);
registerSkill(chatMemorySkill);
registerSkill(kvMemorySkill);
registerSkill(datasetStoreSkill);
registerSkill(chartRenderSkill);
registerSkill(socialCardSkill);
registerSkill(codeScanSkill);
registerSkill(triggerAgentSkill);
registerSkill(codebaseMemorySkill);
registerSkill(workflowBuilderSkill);
registerSkill(openaiBillingSkill);
registerSkill(anthropicBillingSkill);
registerSkill(cursorAdminSkill);

// Backward-compat alias: MCP_SERVER_REGISTRY used 'slack_notify' as the key
registerSkill({ ...slackSkill, id: 'slack_notify' });

export const SKILLS = {
  BROWSER: 'browser',
  JIRA: 'jira',
  GITHUB: 'github',
  GITLAB: 'gitlab',
  FIGMA: 'figma',
  LINEAR: 'linear',
  PLANE: 'plane',
  OPEN_DESIGN: 'open-design',
  GIT: 'git',
  // `git-write` — REQUIRED extension of `git`: the same
  // git_checkout/list_repos/explore READ tools PLUS one provider-agnostic
  // mutation tool, git_open_pr (opens a real PR/MR, delegating to the
  // github/gitlab provider APIs). Repo-MUTATING agents (push/PR/MR) declare
  // this so deploy is gated on "GitHub OR GitLab" connected; backend maps it
  // into REQUIRED_INTEGRATION_MAP as {any:[github,gitlab]} — the OR-group is
  // unchanged by adding git_open_pr (it's exposed THROUGH git-write precisely
  // to avoid declaring github+gitlab separately, which would AND-gate them).
  // Backed by gitWriteSkill. Read-only clone agents keep GIT.
  GIT_WRITE: 'git-write',
  SLACK: 'slack',
  LARK: 'lark',
  // `discord` — post messages / list channels in the user's Discord server as
  // their bot (paste-token integration, provider 'discord'). Backed by
  // discordSkill (served over bin/mcp-skill.mjs as mcp__discord__* tools).
  // Mirrored in @zibby/agent-workflow's SKILLS map.
  DISCORD: 'discord',
  NOTION: 'notion',
  // `google-docs` — create/append/read Google Docs (googleDocsSkill, served
  // over MCP via bin/mcp-skill.mjs as mcp__gdocs__* tools). Backed by the
  // drive.file-scoped 'google' OAuth integration; backend
  // REQUIRED_INTEGRATION_MAP maps 'google-docs' → INTEGRATIONS.GOOGLE.
  // Mirrored in @zibby/agent-workflow's SKILLS map.
  GOOGLE_DOCS: 'google-docs',
  // `lark-docs` — read/create/append Lark/Feishu documents (larkDocsSkill,
  // served over MCP via bin/mcp-skill.mjs as mcp__larkdocs__* tools). REUSES
  // the connected Lark app (integration 'lark' — same app as messaging), so
  // backend REQUIRED_INTEGRATION_MAP maps 'lark-docs' → INTEGRATIONS.LARK.
  // Mirrored in @zibby/agent-workflow's SKILLS map.
  LARK_DOCS: 'lark-docs',
  // `doc_source` — INTEGRATION-GATE MARKER (like `circleci`), not a runtime MCP
  // skill: no skill object registers under this id (the runtime tool-resolver
  // warns + skips it). Declaring it on a node's `skills` makes the backend gate
  // deploy on a document source being connected via the OR-group
  // {any:[google, notion, lark]} (google-docs / notion / lark-docs all read a
  // PRD). Used by the prd-review template. Mirrored in @zibby/agent-workflow.
  DOC_SOURCE: 'doc_source',
  LINKEDIN: 'linkedin',
  CHAT_NOTIFY: 'chat_notify',
  SENTRY: 'sentry',
  MEMORY: 'memory',
  RUNNER: 'runner',
  SKILL_INSTALLER: 'skill-installer',
  CORE_TOOLS: 'core-tools',
  CHAT_MEMORY: 'chat-memory',
  KV_MEMORY: 'kv-memory',
  // `dataset-store` — durable, queryable structured-record store (append rows,
  // run SQL-style aggregations later for reports). Auths with the run's OWN
  // project token (getSessionToken Bearer) → UNGATED, like kv-memory
  // (intentionally absent from backend skill-integrations maps). Opt-in: it is
  // NOT alwaysLoad — activates ONLY when a node declares it via skills:[...],
  // so existing agents are unaffected. The id MUST match the skill's registered
  // id ('dataset-store'). Backed by datasetStoreSkill.
  DATASET_STORE: 'dataset-store',
  // `chart-render` — LOCAL server-side chart rendering (Apache ECharts pure-SVG
  // SSR + @resvg/resvg-js PNG rasterization; bundled OFL Noto Sans so text
  // renders in font-less containers). Tier ① (API-only/local): no browser, no
  // external service — the data never leaves the box → UNGATED (no integration
  // token; intentionally absent from backend skill-integrations maps). Opt-in:
  // NOT auto-loaded — activates ONLY when a node declares it via skills:[...].
  // The id MUST match the skill's registered id ('chart-render'). Backed by
  // chartRenderSkill.
  CHART_RENDER: 'chart-render',
  // `social-card` — LOCAL server-side branded "concept card" renderer (hand-
  // authored SVG → @resvg/resvg-js PNG; bundled OFL Noto Sans so text renders
  // in font-less containers). Tier ① (API-only/local): no browser, no external
  // service — the data never leaves the box → UNGATED (no integration token;
  // intentionally absent from backend skill-integrations maps). Opt-in: NOT
  // auto-loaded — activates ONLY when a node declares it via skills:[...]. The
  // id MUST match the skill's registered id ('social-card'). Backed by
  // socialCardSkill. Pairs with the linkedin skill (returns a PNG `path` to
  // pass as a post's imagePath).
  SOCIAL_CARD: 'social-card',
  // `code-scan` — AGENT-DRIVEN, stack-smart deterministic linter over a
  // checked-out repo (auto-detects the stack: JS/TS→oxlint, more coming; runs
  // every matching scanner from a NO-HARDCODING registry). Tier ① (fully local):
  // no API/OAuth/browser — the code never leaves the box → UNGATED (no
  // integration token; intentionally absent from backend skill-integrations
  // maps). Opt-in: NOT auto-loaded — activates ONLY when a node declares it via
  // skills:[...]. The id MUST match the skill's registered id ('code-scan').
  // Backed by codeScanSkill. Used by the code-review templates (the passes that
  // hold the on-disk clone) to get ground-truth linter candidates.
  CODE_SCAN: 'code-scan',
  // `codebase-memory` — code-graph + semantic index over the checked-out repo,
  // backed by the DeusData/codebase-memory-mcp binary BAKED INTO the agent
  // image. Fully local → UNGATED (no integration token; intentionally absent
  // from backend skill-integrations maps). Activates ONLY when a node declares
  // it (the registry never auto-loads it), so existing agents are unaffected.
  // The id MUST match the skill's registered id ('codebase-memory'). Backed by
  // codebaseMemorySkill.
  CODEBASE_MEMORY: 'codebase-memory',
  WORKFLOW_BUILDER: 'workflow-builder',
  OPENAI_BILLING: 'openai_billing',
  ANTHROPIC_BILLING: 'anthropic_billing',
  CURSOR_ADMIN: 'cursor_admin',
  // `circleci` — INTEGRATION-GATE MARKER, not a runtime MCP skill: no skill
  // object registers under this id (the runtime tool-resolver warns + skips it).
  // Declaring it on a node's `skills` makes the backend's
  // REQUIRED_INTEGRATION_MAP gate deploy on a connected CircleCI (the
  // flaky-test-fixer pattern — the node resolves the CircleCI token
  // deterministically, no LLM tools involved). Mirrored in
  // @zibby/agent-workflow's SKILLS map.
  CIRCLECI: 'circleci',
  // `trigger-agent` — the agent-callable `trigger_agent` MCP tool
  // (triggerAgentSkill): fire another Zibby workflow/agent run in this project
  // (fire-and-forget, returns the executionId). Declares no
  // requiresIntegration → never gates deploy. The id MUST match the skill's
  // registered id ('trigger-agent'). Mirrored in @zibby/agent-workflow's map.
  TRIGGER_AGENT: 'trigger-agent',
};

export { browserSkill, jiraSkill, githubSkill, gitlabSkill, figmaSkill, linearSkill, planeSkill, opendesignSkill, gitSkill, gitWriteSkill, slackSkill, larkSkill, discordSkill, notionSkill, linkedinSkill, googleDocsSkill, larkDocsSkill, chatNotifySkill, sentrySkill, memorySkill, chatMemorySkill, kvMemorySkill, datasetStoreSkill, chartRenderSkill, socialCardSkill, codeScanSkill, codebaseMemorySkill, testRunnerSkill, testRunnerSkill as runnerSkill, skillInstallerSkill, coreToolsSkill, workflowBuilderSkill };
export {
  openaiBillingSkill,
  anthropicBillingSkill,
  cursorAdminSkill,
  fetchOpenAICosts,
  fetchOpenAIProjects,
  fetchAnthropicCosts,
  fetchAnthropicWorkspaces,
  fetchCursorSpend,
  fetchAllProviders,
  groupByKey,
  meanStddev,
} from './llm-billing.js';
export {
  reportObjectSchema,
  reportToBlockKit,
  reportToLarkCard,
  reportToNotionBlocks,
  reportToMarkdown,
  SEVERITIES as REPORT_SEVERITIES,
} from './report.js';
export { skill, functionSkill } from './function-skill.js';
export { registerSkill, getSkill, hasSkill, getAllSkills, listSkillIds } from '@zibby/agent-workflow';
export { INTEGRATIONS, INTEGRATION_REGISTRY } from './integrations.js';
