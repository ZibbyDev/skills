/**
 * @zibby/skills — Built-in skill catalog
 *
 * Importing this module registers all built-in skills with the core
 * skill registry.  Users and community packages can register additional
 * skills via registerSkill().
 */

import { registerSkill } from '@zibby/agent-workflow';
import { withBackendSessionEnv } from './backendSession.js';
import { browserSkill } from './browser.js';
import { jiraSkill } from './jira.js';
import { githubSkill } from './github.js';
import { gitlabSkill } from './gitlab.js';
import { figmaSkill } from './figma.js';
import { hubspotSkill } from './hubspot.js';
import { linearSkill } from './linear.js';
import { vikunjaSkill } from './vikunja.js';
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
import { artifactSkill } from './artifact.js';
import { chartRenderSkill } from './chartRender.js';
import { codeStatsSkill } from './codeStats.js';
import { chatProgressSkill } from './chatProgress.js';
import { socialCardSkill } from './socialCard.js';
import { codeScanSkill } from './code-scan.js';
import { triggerAgentSkill } from './triggerAgent.js';
import { codebaseMemorySkill } from './codebaseMemory.js';
import { gbrainSkill } from './gbrain.js';
import { workflowBuilderSkill } from './workflow-builder.js';
import {
  openaiBillingSkill,
  anthropicBillingSkill,
  cursorAdminSkill,
} from './llm-billing.js';

// Registration choke point: a skill that declares `callsBackend: true` gets
// the backend-session env contract enforced here (child env always carries
// PROJECT_API_TOKEN + ZIBBY_ACCOUNT_API_URL + ZIBBY_ENV) — authors declare
// ONCE on the skill object instead of hand-maintaining envKeys + resolve()
// allowlists in lockstep. See src/backendSession.ts.
const reg = (skill: any) => registerSkill(withBackendSessionEnv(skill));

reg(browserSkill);
reg(jiraSkill);
reg(githubSkill);
reg(gitlabSkill);
reg(figmaSkill);
reg(hubspotSkill);
reg(linearSkill);
reg(vikunjaSkill);
reg(planeSkill);
reg(opendesignSkill);
reg(slackSkill);
reg(larkSkill);
reg(discordSkill);
reg(notionSkill);
reg(linkedinSkill);
reg(googleDocsSkill);
reg(larkDocsSkill);
reg(chatNotifySkill);
reg(sentrySkill);
reg(memorySkill);
reg(testRunnerSkill);
reg(gitSkill);
reg(gitWriteSkill);
reg(skillInstallerSkill);
reg(coreToolsSkill);
reg(chatMemorySkill);
reg(kvMemorySkill);
reg(datasetStoreSkill);
reg(artifactSkill);
reg(chartRenderSkill);
reg(codeStatsSkill);
reg(chatProgressSkill);
reg(socialCardSkill);
reg(codeScanSkill);
reg(triggerAgentSkill);
reg(codebaseMemorySkill);
reg(gbrainSkill);
reg(workflowBuilderSkill);
reg(openaiBillingSkill);
reg(anthropicBillingSkill);
reg(cursorAdminSkill);

// Backward-compat alias: MCP_SERVER_REGISTRY used 'slack_notify' as the key
reg({ ...slackSkill, id: 'slack_notify' });

// The single authoritative skill-id map now lives in the zero-dep leaf
// @zibby/skill-ids (see strategy/skills-platform-architecture.md). Re-exported
// here as SKILLS so this file's registerSkill() calls, every SKILLS.X reference,
// and every downstream `import { SKILLS } from '@zibby/skills'` keep working —
// identical shape, now the complete superset (drift gone).
export { SKILL_IDS as SKILLS } from '@zibby/skill-ids';

export { browserSkill, jiraSkill, githubSkill, gitlabSkill, figmaSkill, hubspotSkill, linearSkill, vikunjaSkill, planeSkill, opendesignSkill, gitSkill, gitWriteSkill, slackSkill, larkSkill, discordSkill, notionSkill, linkedinSkill, googleDocsSkill, larkDocsSkill, chatNotifySkill, sentrySkill, memorySkill, chatMemorySkill, kvMemorySkill, datasetStoreSkill, artifactSkill, chartRenderSkill, codeStatsSkill, chatProgressSkill, socialCardSkill, codeScanSkill, codebaseMemorySkill, gbrainSkill, testRunnerSkill, testRunnerSkill as runnerSkill, skillInstallerSkill, coreToolsSkill, workflowBuilderSkill };
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
