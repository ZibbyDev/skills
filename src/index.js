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
import { slackSkill } from './slack.js';
import { larkSkill } from './lark.js';
import { notionSkill } from './notion.js';
import { chatNotifySkill } from './chat-notify.js';
import { memorySkill } from './memory.js';
import { skillInstallerSkill } from './skill-installer.js';
import { coreToolsSkill } from './core-tools.js';
import { sentrySkill } from './sentry.js';
import { testRunnerSkill } from './test-runner.js';
import { gitSkill } from './git.js';
import { chatMemorySkill } from './chat-memory.js';
import { reviewMemorySkill } from './reviewMemory.js';
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
registerSkill(slackSkill);
registerSkill(larkSkill);
registerSkill(notionSkill);
registerSkill(chatNotifySkill);
registerSkill(sentrySkill);
registerSkill(memorySkill);
registerSkill(testRunnerSkill);
registerSkill(gitSkill);
registerSkill(skillInstallerSkill);
registerSkill(coreToolsSkill);
registerSkill(chatMemorySkill);
registerSkill(reviewMemorySkill);
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
  GIT: 'git',
  SLACK: 'slack',
  LARK: 'lark',
  NOTION: 'notion',
  CHAT_NOTIFY: 'chat_notify',
  SENTRY: 'sentry',
  MEMORY: 'memory',
  RUNNER: 'runner',
  SKILL_INSTALLER: 'skill-installer',
  CORE_TOOLS: 'core-tools',
  CHAT_MEMORY: 'chat-memory',
  REVIEW_MEMORY: 'review-memory',
  WORKFLOW_BUILDER: 'workflow-builder',
  OPENAI_BILLING: 'openai_billing',
  ANTHROPIC_BILLING: 'anthropic_billing',
  CURSOR_ADMIN: 'cursor_admin',
};

export { browserSkill, jiraSkill, githubSkill, gitlabSkill, figmaSkill, linearSkill, planeSkill, gitSkill, slackSkill, larkSkill, notionSkill, chatNotifySkill, sentrySkill, memorySkill, chatMemorySkill, reviewMemorySkill, testRunnerSkill, testRunnerSkill as runnerSkill, skillInstallerSkill, coreToolsSkill, workflowBuilderSkill };
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
