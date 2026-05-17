/**
 * Skill Installer Skill
 *
 * Meta-skill that provides the catalog of installable skills for chat sessions.
 * Exposes proper tool definitions so any LLM provider (OpenAI, Anthropic, etc.)
 * can call install/uninstall/list via native function calling.
 *
 * The strategy's tool-loop routes calls to handleToolCall(), which mutates
 * the activeSkills array passed in context.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';

const catalog = {
  jira: {
    description: 'Jira issue search, details, comments, transitions',
    integrationProvider: 'jira',
    envKeys: [],
    setupInstructions: `To connect Jira:\n1. Go to Settings → Integrations (https://studio.zibby.dev/integrations)\n2. Click "Connect Jira" and authorize via Atlassian OAuth\n3. After OAuth completes, ask me to install Jira again`,
  },
  github: {
    description: 'GitHub issues, PRs, repository management',
    integrationProvider: 'github',
    envKeys: [],
    setupInstructions: `To connect GitHub:\n1. Go to Settings → Integrations (https://studio.zibby.dev/integrations)\n2. Click "Connect GitHub" and authorize\n3. After OAuth completes, ask me to install GitHub again`,
  },
  slack: {
    description: 'Slack messages, channels, reactions',
    integrationProvider: 'slack',
    envKeys: [],
    setupInstructions: `To connect Slack:\n1. Go to Settings → Integrations (https://studio.zibby.dev/integrations)\n2. Click "Connect Slack" and authorize\n3. After OAuth completes, ask me to install Slack again`,
  },
  sentry: {
    description: 'Sentry error tracking — projects, issues, events',
    integrationProvider: 'sentry',
    envKeys: [],
    setupInstructions: `To connect Sentry:\n1. Go to Settings → Integrations (https://studio.zibby.dev/integrations)\n2. Click "Connect Sentry" and authorize\n3. After OAuth completes, ask me to install Sentry again`,
  },
  runner: {
    description: 'Run zibby test workflows from chat (parallel supported)',
    envKeys: [],
    setupInstructions: 'Ready to use. Runs zibby test workflows as background processes — each with its own browser and session.',
  },
  browser: {
    description: 'Playwright browser automation (navigate, click, fill, screenshot)',
    envKeys: [],
    setupInstructions: 'Ready to use. Starts a Playwright browser for web automation.',
  },
  memory: {
    description: 'Test memory database (Dolt) — history, selectors, insights',
    envKeys: [],
    setupInstructions: 'Ready to use. Requires Dolt (https://docs.dolthub.com/introduction/installation) and a memory DB via `zibby init --mem`.',
  },
  'chat-memory': {
    description: 'Persistent chat memory — remembers facts, decisions, and task history across sessions (Dolt-backed)',
    envKeys: [],
    setupInstructions: 'Ready to use. Requires Dolt installed. Tables auto-create on first use. Install with: "add chat memory" or "install chat-memory".',
  },
  git: {
    description: 'Clone and explore git repositories locally for codebase analysis',
    envKeys: [],
    setupInstructions: 'Ready to use. Clone repos with git_checkout, explore with git_explore. Auto-authenticates with GitHub/GitLab tokens.',
  },
};

function buildPromptFragment() {
  const lines = ['## Available Skills'];
  for (const [id, meta] of Object.entries(catalog)) {
    const tag = meta.integrationProvider ? `integration: ${meta.integrationProvider}` : 'ready';
    lines.push(`- ${id}: ${meta.description} [${tag}]`);
  }
  lines.push('');
  lines.push('Use the install_skill / uninstall_skill / list_available_skills tools to manage skills.');
  lines.push(`Zibby third party Integration settings page: ${getIntegrationsUrl()}`);
  lines.push('');
  lines.push('## Tool-First Policy (mandatory)');
  lines.push('CRITICAL RULES — follow these strictly:');
  lines.push('1. When user asks to do something and a matching skill is available but not installed, IMMEDIATELY call install_skill. Never ask for credentials or confirmation first.');
  lines.push('2. If install_skill succeeds, the skill\'s tools are now available. Use them RIGHT AWAY in the same turn — don\'t just say "it\'s connected", actually call the tools.');
  lines.push('3. If install_skill reports needsIntegration, tell the user to connect via the integration URL and try again after.');
  lines.push('4. When the relevant skill is already installed, use its tools directly — don\'t ask for IDs or keys. Each skill\'s own instructions explain the workflow.');
  lines.push('5. If a task needs multiple skills (e.g. data from one + execution from another), install all of them, then follow each skill\'s workflow instructions.');
  return lines.join('\n');
}

function getSessionToken() {
  if (process.env.ZIBBY_USER_TOKEN) return process.env.ZIBBY_USER_TOKEN;
  try {
    const configPath = join(homedir(), '.zibby', 'config.json');
    if (!existsSync(configPath)) return null;
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return config.sessionToken || null;
  } catch {
    return null;
  }
}

function getApiUrl() {
  const base = process.env.ZIBBY_API_URL || process.env.ZIBBY_PROD_API_URL || 'https://api-prod.zibby.app';
  return base.replace(/\/$/, '');
}

function getIntegrationsUrl() {
  const frontend = process.env.ZIBBY_FRONTEND_URL || process.env.ZIBBY_PROD_FRONTEND_URL || 'https://studio.zibby.dev';
  return `${frontend.replace(/\/$/, '')}/integrations`;
}

function openBrowser(url) {
  try {
    const platform = process.platform;
    const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}

async function getAllIntegrationStatuses() {
  const token = getSessionToken();
  if (!token) return { checked: false, statuses: null, reason: 'no-session-token' };

  try {
    const res = await fetch(`${getApiUrl()}/integrations/status`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { checked: false, statuses: null, reason: `status-${res.status}` };
    const data = await res.json();
    return { checked: true, statuses: data || {}, reason: null };
  } catch {
    return { checked: false, statuses: null, reason: 'network-error' };
  }
}

function getProviderIntegrationStatus(statuses, provider) {
  if (!provider || !statuses) return { connected: null };
  const info = statuses[provider];
  if (!info || typeof info.connected !== 'boolean') return { connected: null, details: info || null };
  return { connected: info.connected, details: info };
}

export const skillInstallerSkill = {
  id: 'skill-installer',
  description: 'Live skill installation for chat sessions',
  envKeys: [],

  catalog,

  promptFragment: buildPromptFragment,

  tools: [
    {
      name: 'install_skill',
      description: 'Install a skill into the current chat session so its tools become available',
      input_schema: {
        type: 'object',
        properties: {
          skillId: {
            type: 'string',
            description: 'Skill identifier to install (e.g. "jira", "github", "browser", "memory")',
          },
        },
        required: ['skillId'],
      },
    },
    {
      name: 'uninstall_skill',
      description: 'Remove a skill from the current chat session',
      input_schema: {
        type: 'object',
        properties: {
          skillId: {
            type: 'string',
            description: 'Skill identifier to remove',
          },
        },
        required: ['skillId'],
      },
    },
    {
      name: 'list_available_skills',
      description: 'List all skills that can be installed, with their env-var readiness status',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
  ],

  async handleToolCall(name, args, context) {
    const { activeSkills } = context;
    const allStatuses = await getAllIntegrationStatuses();

    if (name === 'list_available_skills') {
      const entries = Object.entries(catalog).map(([id, meta]) => {
        const installed = activeSkills.includes(id);
        const integration = getProviderIntegrationStatus(allStatuses.statuses, meta.integrationProvider);
        return {
          id, description: meta.description, installed,
          integrationProvider: meta.integrationProvider || undefined,
          integrationConnected: integration.connected,
          setupInstructions: integration.connected === false ? meta.setupInstructions : undefined,
        };
      });
      return JSON.stringify({ skills: entries });
    }

    if (name === 'install_skill') {
      const { skillId } = args;
      if (!skillId) return JSON.stringify({ ok: false, error: 'skillId is required' });
      if (activeSkills.includes(skillId)) {
        const meta = catalog[skillId];
        const { getSkill } = await import('@zibby/agent-workflow');
        const skill = getSkill(skillId);
        const toolNames = (skill?.tools || []).map(t => t.name);
        return JSON.stringify({
          ok: true,
          alreadyInstalled: true,
          skillId,
          description: meta?.description,
          availableTools: toolNames,
          integrationUrl: meta?.integrationProvider ? getIntegrationsUrl() : undefined,
          hint: `${skillId} is already active. Tools available: ${toolNames.join(', ')}. Use them directly.`,
        });
      }
      if (!catalog[skillId]) {
        return JSON.stringify({ ok: false, error: `Unknown skill "${skillId}". Available: ${Object.keys(catalog).join(', ')}` });
      }
      const meta = catalog[skillId];
      if (meta.integrationProvider) {
        const integration = getProviderIntegrationStatus(allStatuses.statuses, meta.integrationProvider);
        const integrationUrl = getIntegrationsUrl();
        if (allStatuses.checked && integration.connected === false) {
          const opened = openBrowser(integrationUrl);
          return JSON.stringify({
            ok: false,
            error: `${meta.integrationProvider} is not connected for this Zibby account yet`,
            needsIntegration: true,
            integrationUrl,
            openedBrowser: opened,
            setupInstructions: `Please connect ${meta.integrationProvider} first at ${integrationUrl}. After you finish OAuth, ask me to install ${skillId} again.`,
          });
        }
      }
      activeSkills.push(skillId);
      const { getSkill } = await import('@zibby/agent-workflow');
      const skill = getSkill(skillId);
      const toolNames = (skill?.tools || []).map(t => t.name);
      return JSON.stringify({
        ok: true,
        installed: skillId,
        description: meta.description,
        availableTools: toolNames,
        hint: `${skillId} is now active. You now have these tools: ${toolNames.join(', ')}. Use them immediately to help the user — don't just confirm installation.`,
      });
    }

    if (name === 'uninstall_skill') {
      const { skillId } = args;
      if (!skillId) return JSON.stringify({ ok: false, error: 'skillId is required' });
      if (skillId === 'skill-installer') {
        return JSON.stringify({ ok: false, error: 'Cannot uninstall the skill installer' });
      }
      const idx = activeSkills.indexOf(skillId);
      if (idx === -1) {
        return JSON.stringify({ ok: false, error: `${skillId} is not installed` });
      }
      activeSkills.splice(idx, 1);
      return JSON.stringify({ ok: true, uninstalled: skillId });
    }

    return JSON.stringify({ error: `Unknown tool: ${name}` });
  },

  resolve() {
    return null;
  },
};
