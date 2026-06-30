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
import { notionSkill } from './notion.js';
import { linkedinSkill } from './linkedin.js';
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
registerSkill(notionSkill);
registerSkill(linkedinSkill);
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
  NOTION: 'notion',
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
};

export { browserSkill, jiraSkill, githubSkill, gitlabSkill, figmaSkill, linearSkill, planeSkill, opendesignSkill, gitSkill, gitWriteSkill, slackSkill, larkSkill, notionSkill, linkedinSkill, chatNotifySkill, sentrySkill, memorySkill, chatMemorySkill, kvMemorySkill, datasetStoreSkill, codebaseMemorySkill, testRunnerSkill, testRunnerSkill as runnerSkill, skillInstallerSkill, coreToolsSkill, workflowBuilderSkill };
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
  SEVERITIES as REPORT_SEVERITIES,
} from './report.js';
export { skill, functionSkill } from './function-skill.js';
export { registerSkill, getSkill, hasSkill, getAllSkills, listSkillIds } from '@zibby/agent-workflow';
export { INTEGRATIONS, INTEGRATION_REGISTRY } from './integrations.js';
