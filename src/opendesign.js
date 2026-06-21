/**
 * OpenDesign skill — design/deck authoring + export over the OpenDesign REST
 * API (the Zibby-managed `open-design` app, catalog appType === 'open-design').
 *
 * Mirrors figma.js / linear.js: a hand-written `tools[]` array + a
 * `handleToolCall` switch, served over MCP by bin/mcp-skill.mjs (the generic
 * skill server). There is NO upstream MCP server — we talk to the OpenDesign
 * REST API directly.
 *
 * Auth: OpenDesign is a PASTE-TOKEN + base URL integration (same {token,
 * baseUrl} shape as plane). The credential is resolved per-call via
 * resolveIntegrationToken('open_design') — the backend returns
 *   { token: string, baseUrl: string }
 * where baseUrl is "https://<host>" (no trailing slash). Every API path is
 * under `${baseUrl}/api`. All calls send `Authorization: Bearer <token>`
 * EXCEPT GET /api/health, which is an open connectivity probe (no auth).
 *
 * IMPORTANT: this skill is OPTIONAL. requiresIntegration is intentionally
 * NOT set, so declaring SKILLS.OPEN_DESIGN on a node must NEVER gate deploy
 * on a connected integration (it is not added to any required-integration
 * map). A workflow can list it and still deploy without OpenDesign connected;
 * the tools simply error at call time if the credential is missing.
 */

import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve as resolvePath } from 'path';
import { resolveIntegrationToken } from '@zibby/core/backend-client.js';
import { INTEGRATIONS } from './integrations.js';

/**
 * Resolve the path to the generic skill MCP server binary. Derived from
 * `import.meta.url` (NOT a package self-reference) so it works in src/ during
 * dev, dist/ after bundling, and node_modules/@zibby/skills/ in a published
 * install — bin/ is always a sibling of this module's dir. See figma.js /
 * linear.js for the full rationale.
 */
function resolveSkillBin() {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

/**
 * Resolve the OpenDesign credential ({ token, baseUrl }). baseUrl is
 * normalized to drop any trailing slash so callers can safely append
 * `/api/...`. Throws a clear error if the integration response is malformed.
 */
async function resolveOpenDesign() {
  const data = await resolveIntegrationToken(INTEGRATIONS.OPEN_DESIGN);
  const token = data?.token;
  const rawBase = data?.baseUrl;
  if (!token || typeof token !== 'string') {
    throw new Error('OpenDesign is not connected: missing token. Connect it in Integrations.');
  }
  if (!rawBase || typeof rawBase !== 'string') {
    throw new Error('OpenDesign is not connected: missing baseUrl. Connect it in Integrations.');
  }
  const baseUrl = rawBase.replace(/\/+$/, '');
  return { token, baseUrl };
}

/**
 * Single chokepoint for every authenticated OpenDesign REST call. Resolves
 * the credential, builds the URL under `${baseUrl}/api`, sets the Bearer
 * header, issues the request, and throws a trimmed error on non-2xx —
 * surfacing the OpenDesign error `code` when the body carries one — so
 * handleToolCall can return it as JSON.
 *
 * @param {string} apiPath path under /api, e.g. '/projects' or '/runs/abc'
 * @param {object} [opts] { method, body, query, raw }
 *   - query: object of querystring params (skips null/undefined values)
 *   - raw:   when true, return the parsed JSON without any caller wrapping
 */
async function odFetch(apiPath, opts = {}) {
  const { token, baseUrl } = await resolveOpenDesign();
  let url = `${baseUrl}/api${apiPath}`;
  if (opts.query && typeof opts.query === 'object') {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
  };
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return parseOdResponse(res, 'OpenDesign');
}

/**
 * Shared response parser. On non-2xx, surfaces the OpenDesign error code
 * (body.code / body.error.code) plus message when present; otherwise the
 * trimmed raw text. On success returns parsed JSON (or {} for empty bodies).
 */
async function parseOdResponse(res, label) {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      const code = j?.code || j?.error?.code;
      const message = j?.message || j?.error?.message || j?.error;
      if (code || message) {
        detail = [code ? `[${code}]` : null, message].filter(Boolean).join(' ') || detail;
      }
    } catch {
      // non-JSON body — keep the trimmed text
    }
    throw new Error(`${label} API ${res.status}: ${detail}`);
  }
  const text = await res.text().catch(() => '');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    // Some endpoints (e.g. inline HTML export) may return non-JSON; hand the
    // raw text back so the caller can decide what to do with it.
    return { raw: text };
  }
}

export const opendesignSkill = {
  id: 'open-design',
  serverName: 'opendesign',
  allowedTools: ['mcp__opendesign__*'],
  // OPTIONAL integration — deliberately NO `requiresIntegration`. Declaring
  // SKILLS.OPEN_DESIGN on a node must NOT gate deploy on a connected
  // integration; the tools resolve the credential lazily and error at call
  // time if it is missing. (Do not add OPEN_DESIGN to any required map.)
  envKeys: [],
  description: 'OpenDesign — list projects/designs, run the design agent, and export decks to PDF/HTML',

  promptFragment: `## OpenDesign (optional)
You may have access to the user's OpenDesign workspace (the Zibby-managed design/deck app) via its REST API. These tools are OPTIONAL — if OpenDesign is not connected they will return a "not connected" error; reach for them only when the task involves OpenDesign projects, designs, or exports. Tools (mcp__opendesign__*):

### Connectivity
- opendesign_health: Probe the OpenDesign instance (GET /api/health, no auth). Use to confirm the instance is reachable before other calls.

### Projects & designs
- opendesign_list_projects: List the projects in the workspace.
- opendesign_get_project: Get one project by id.
- opendesign_list_designs: List the live design artifacts in a project (pass projectId).
- opendesign_get_design: Get one live design artifact by id (pass projectId).

### Authoring agent
- opendesign_cli_run: Start an OpenDesign agent run (agentId + message; optional projectId / conversationId / model). Returns a runId.
- opendesign_cli_status: Poll a run's status by runId.

### Export
- opendesign_export_pdf: Export a project's deck to PDF (projectId + fileName; optional title / deck).
- opendesign_export_html: Fetch a project's HTML export by path (projectId + path; inline=1).

### Notes
- A design artifact lookup ALWAYS needs its projectId (it scopes the query).
- After opendesign_cli_run, poll opendesign_cli_status with the returned runId until the run is no longer running.`,

  resolve() {
    // Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs), pointing it at
    // this module's opendesignSkill export. It registers every entry in
    // tools[] as an MCP tool and dispatches each call through handleToolCall —
    // so the model gets real mcp__opendesign__* tools. The module arg is
    // resolved RELATIVE TO bin/ at runtime → node_modules/@zibby/skills/dist/
    // opendesign.js in a published install (mirrors figma.js / linear.js). No
    // env to forward: odFetch resolves the credential via the backend.
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env: {}, description: this.description };
    const env = {};
    for (const key of this.envKeys) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/opendesign.js', 'opendesignSkill'],
      env,
      description: this.description,
      // Force tools into the system prompt (see figma.js / linear.js resolve()).
      alwaysLoad: true,
    };
  },

  async handleToolCall(name, args) {
    try {
      switch (name) {
        case 'opendesign_health': {
          // Open probe — GET /api/health, NO auth. We still resolve the base
          // URL from the credential (so we know which instance to hit) but do
          // NOT send the Bearer header, per the OpenDesign contract.
          const { baseUrl } = await resolveOpenDesign();
          const res = await fetch(`${baseUrl}/api/health`, {
            method: 'GET',
            headers: { Accept: 'application/json' },
          });
          const data = await parseOdResponse(res, 'OpenDesign');
          return JSON.stringify({ ok: true, health: data });
        }

        case 'opendesign_list_projects': {
          const data = await odFetch('/projects');
          return JSON.stringify(data);
        }

        case 'opendesign_get_project': {
          const id = args?.id || args?.projectId;
          if (!id) return JSON.stringify({ error: 'id is required' });
          const data = await odFetch(`/projects/${encodeURIComponent(id)}`);
          return JSON.stringify(data);
        }

        case 'opendesign_list_designs': {
          const projectId = args?.projectId;
          if (!projectId) return JSON.stringify({ error: 'projectId is required' });
          const data = await odFetch('/live-artifacts', { query: { projectId } });
          return JSON.stringify(data);
        }

        case 'opendesign_get_design': {
          const id = args?.id;
          const projectId = args?.projectId;
          if (!id) return JSON.stringify({ error: 'id is required' });
          if (!projectId) return JSON.stringify({ error: 'projectId is required' });
          const data = await odFetch(`/live-artifacts/${encodeURIComponent(id)}`, { query: { projectId } });
          return JSON.stringify(data);
        }

        case 'opendesign_export_pdf': {
          const projectId = args?.projectId || args?.id;
          const { fileName, title, deck } = args || {};
          if (!projectId) return JSON.stringify({ error: 'projectId is required' });
          if (!fileName) return JSON.stringify({ error: 'fileName is required' });
          const body = { fileName };
          if (title !== undefined) body.title = title;
          if (deck !== undefined) body.deck = deck;
          const data = await odFetch(`/projects/${encodeURIComponent(projectId)}/export/pdf`, {
            method: 'POST',
            body,
          });
          return JSON.stringify(data);
        }

        case 'opendesign_export_html': {
          const projectId = args?.projectId || args?.id;
          const path = args?.path;
          if (!projectId) return JSON.stringify({ error: 'projectId is required' });
          if (!path) return JSON.stringify({ error: 'path is required (the export sub-path)' });
          // Strip any leading slash on the export sub-path so it nests cleanly
          // under /projects/:id/export/. The path segments are encoded but '/'
          // separators are preserved.
          const cleanPath = String(path).replace(/^\/+/, '');
          const encodedPath = cleanPath.split('/').map((s) => encodeURIComponent(s)).join('/');
          const data = await odFetch(`/projects/${encodeURIComponent(projectId)}/export/${encodedPath}`, {
            query: { inline: 1 },
          });
          return JSON.stringify(data);
        }

        case 'opendesign_cli_run': {
          const { agentId, message, projectId, conversationId, model } = args || {};
          if (!agentId) return JSON.stringify({ error: 'agentId is required' });
          if (!message) return JSON.stringify({ error: 'message is required' });
          const body = { agentId, message };
          if (projectId !== undefined) body.projectId = projectId;
          if (conversationId !== undefined) body.conversationId = conversationId;
          if (model !== undefined) body.model = model;
          const data = await odFetch('/runs', { method: 'POST', body });
          return JSON.stringify(data);
        }

        case 'opendesign_cli_status': {
          const id = args?.id || args?.runId;
          if (!id) return JSON.stringify({ error: 'id (runId) is required' });
          const data = await odFetch(`/runs/${encodeURIComponent(id)}`);
          return JSON.stringify(data);
        }

        default:
          return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  },

  tools: [
    {
      name: 'opendesign_health',
      description: 'Probe the OpenDesign instance (GET /api/health, no auth). Use to confirm connectivity before other calls.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'opendesign_list_projects',
      description: 'List the projects in the OpenDesign workspace.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'opendesign_get_project',
      description: 'Get a single OpenDesign project by id.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The project id.' },
        },
        required: ['id'],
      },
    },
    {
      name: 'opendesign_list_designs',
      description: 'List the live design artifacts in an OpenDesign project. Requires the projectId, which scopes the query.',
      input_schema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'The project id whose designs to list.' },
        },
        required: ['projectId'],
      },
    },
    {
      name: 'opendesign_get_design',
      description: 'Get a single live design artifact by id. Requires both the design id and its projectId.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The live-artifact (design) id.' },
          projectId: { type: 'string', description: 'The project id the design belongs to (scopes the lookup).' },
        },
        required: ['id', 'projectId'],
      },
    },
    {
      name: 'opendesign_export_pdf',
      description: 'Export an OpenDesign project deck to PDF. Returns the export result (e.g. a download URL/path).',
      input_schema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'The project id to export.' },
          fileName: { type: 'string', description: 'The output PDF file name.' },
          title: { type: 'string', description: 'Optional deck title for the PDF.' },
          deck: { description: 'Optional deck payload/override to render instead of the project\'s current deck.' },
        },
        required: ['projectId', 'fileName'],
      },
    },
    {
      name: 'opendesign_export_html',
      description: "Fetch an OpenDesign project's HTML export by sub-path (requested inline). Requires projectId and the export path.",
      input_schema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'The project id to export.' },
          path: { type: 'string', description: 'The export sub-path under /projects/:id/export/ (e.g. "index.html" or a slide path).' },
        },
        required: ['projectId', 'path'],
      },
    },
    {
      name: 'opendesign_cli_run',
      description: 'Start an OpenDesign agent run. Returns a runId; poll opendesign_cli_status with it until the run finishes.',
      input_schema: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'The OpenDesign agent id to run.' },
          message: { type: 'string', description: 'The instruction/message to send to the agent.' },
          projectId: { type: 'string', description: 'Optional project id to scope the run to.' },
          conversationId: { type: 'string', description: 'Optional conversation id to continue an existing thread.' },
          model: { type: 'string', description: 'Optional model id override for the run.' },
        },
        required: ['agentId', 'message'],
      },
    },
    {
      name: 'opendesign_cli_status',
      description: 'Poll the status of an OpenDesign agent run by its runId.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The runId returned by opendesign_cli_run.' },
        },
        required: ['id'],
      },
    },
  ],
};
