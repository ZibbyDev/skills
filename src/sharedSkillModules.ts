/**
 * Direct modules for built-in generic stdio skills. A throwaway Worker loads
 * only one skill instead of the entire registry. The contract test compares
 * every entry to the registered skill's resolve() spec, so additions/drift
 * fail before a release.
 *
 * Non-generic or externally registered skills are deliberately absent.
 */
export const SHARED_SKILL_MODULES: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  jira: ['jira.js', 'jiraSkill'],
  github: ['github.js', 'githubSkill'],
  gitlab: ['gitlab.js', 'gitlabSkill'],
  figma: ['figma.js', 'figmaSkill'],
  hubspot: ['hubspot.js', 'hubspotSkill'],
  linear: ['linear.js', 'linearSkill'],
  vikunja: ['vikunja.js', 'vikunjaSkill'],
  'open-design': ['opendesign.js', 'opendesignSkill'],
  discord: ['discord.js', 'discordSkill'],
  notion: ['notion.js', 'notionSkill'],
  linkedin: ['linkedin.js', 'linkedinSkill'],
  'google-docs': ['googleDocs.js', 'googleDocsSkill'],
  'lark-docs': ['larkDocs.js', 'larkDocsSkill'],
  'lark-attendance': ['larkAttendance.js', 'larkAttendanceSkill'],
  'kv-memory': ['kvMemory.js', 'kvMemorySkill'],
  'agent-messaging': ['agentMessaging.js', 'agentMessagingSkill'],
  'person-verification': ['personVerification.js', 'personVerificationSkill'],
  'dataset-store': ['datasetStore.js', 'datasetStoreSkill'],
  artifact: ['artifact.js', 'artifactSkill'],
  'chart-render': ['chartRender.js', 'chartRenderSkill'],
  'report-check': ['reportCheck.js', 'reportCheckSkill'],
  'code-stats': ['codeStats.js', 'codeStatsSkill'],
  'chat-progress': ['chatProgress.js', 'chatProgressSkill'],
  'social-card': ['socialCard.js', 'socialCardSkill'],
  'code-scan': ['code-scan.js', 'codeScanSkill'],
  'trigger-agent': ['triggerAgent.js', 'triggerAgentSkill'],
  'local-workspace': ['localWorkspace.js', 'localWorkspaceSkill'],
  gbrain: ['gbrain.js', 'gbrainSkill'],
  'graph-memory': ['graphMemory.js', 'graphMemorySkill'],
});
