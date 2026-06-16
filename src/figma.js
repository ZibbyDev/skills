import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve as resolvePath } from 'path';
import { resolveIntegrationToken } from '@zibby/core/backend-client.js';
import { INTEGRATIONS } from './integrations.js';

/**
 * Figma skill — read-only design context over the Figma REST API.
 *
 * Mirrors github.js (the hand-written generic-bin skill: a `tools[]`
 * array + a `handleToolCall` switch, served over MCP by bin/mcp-skill.mjs).
 *
 * Auth: Figma is a PASTE-TOKEN (personal access token) integration. The
 * token is resolved per-call via resolveIntegrationToken('figma') — the
 * backend (handlers/figma.js + integration-tokens.js) decrypts the stored
 * PAT and returns it verbatim (long-lived, no refresh). Personal access
 * tokens authenticate with the `X-Figma-Token: <token>` header (NOT
 * `Authorization: Bearer`, which is the OAuth path). See figmaFetch below.
 * (Legacy OAuth rows are resolved transparently to a bearer token by the
 * backend and would also work here, but X-Figma-Token is the current flow.)
 */

function resolveSkillBin() {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

/**
 * Single chokepoint for every Figma REST call. Resolves the personal access
 * token (long-lived, no refresh) via the backend, issues the request, and
 * throws a trimmed error on non-2xx so handleToolCall can surface it as JSON.
 */
async function figmaFetch(path, opts = {}) {
  const { token } = await resolveIntegrationToken('figma');
  const url = path.startsWith('https://') ? path : `https://api.figma.com${path}`;
  const headers = {
    // Personal access token → X-Figma-Token header (NOT Authorization:
    // Bearer, which is the OAuth path). This is the current paste-token flow.
    'X-Figma-Token': token,
    Accept: 'application/json',
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
  };
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Figma API ${res.status}: ${err.slice(0, 300)}`);
  }
  return res.json();
}

export const figmaSkill = {
  id: 'figma',
  serverName: 'figma',
  allowedTools: ['mcp__figma__*'],
  // Figma is a paste-token (personal access token) integration. The backend
  // connect handler (backend/src/handlers/figma.js connectFigma) stores the
  // PAT and the skill resolves it at runtime via
  // resolveIntegrationToken('figma'). Declaring this gates deploy on a
  // connected Figma integration (mirrored in
  // backend/src/services/skill-integrations.js → INTEGRATIONS.FIGMA).
  requiresIntegration: INTEGRATIONS.FIGMA,
  // Token is resolved per-call via the backend (not injected as env), so
  // there are no env keys to forward to the MCP child.
  envKeys: [],
  description: 'Figma — read files, nodes, comments, and render frames as PNGs',

  promptFragment: `## Figma (connected)
You have read access to the user's Figma files via the Figma REST API. Tools:

### Identity
- figma_get_me: Get the authenticated Figma user (handle, email, id)

### Files & nodes
- figma_get_file: Get a file's document tree by fileKey. The fileKey is the token in a Figma URL: figma.com/file/<fileKey>/<name> (or /design/<fileKey>/). Pass an optional depth to limit how deep the node tree is returned (1-2 is usually enough to find frames/pages).
- figma_get_nodes: Get specific nodes from a file by their node ids (comma-separated or array). Use this after figma_get_file to drill into a particular frame/component without re-fetching the whole tree.

### Rendering
- figma_render_png: Render one or more nodes of a file to PNG and return the image URLs. Pass fileKey + node ids; optional scale (0.01-4, default 1). Returns a map of nodeId → image URL you can show the user or download.

### Comments
- figma_get_comments: Read the comments on a file.

### Notes
- The fileKey is NOT the file name — it's the opaque id segment in the URL.
- Node ids look like "1:23" and come from figma_get_file / figma_get_nodes output.`,

  resolve() {
    // Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs), pointing it
    // at this module's figmaSkill export. It registers every entry in
    // tools[] as an MCP tool and dispatches each call through
    // handleToolCall — so the model gets real mcp__figma__* tools.
    // The module arg is resolved RELATIVE TO bin/ at runtime →
    // node_modules/@zibby/skills/dist/figma.js in a published install
    // (mirrors github.js / mcp-sentry.mjs importing ../dist/<mod>.js).
    // No env to forward: figmaFetch resolves the token via the backend.
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env: {}, description: this.description };
    const env = {};
    for (const key of this.envKeys) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/figma.js', 'figmaSkill'],
      env,
      description: this.description,
      // Force tools into the system prompt (see sentry.js resolve()).
      alwaysLoad: true,
    };
  },

  async handleToolCall(name, args) {
    try {
      switch (name) {
        case 'figma_get_me': {
          const me = await figmaFetch('/v1/me');
          return JSON.stringify({
            id: me.id,
            handle: me.handle,
            email: me.email,
            imgUrl: me.img_url,
          });
        }

        case 'figma_get_file': {
          const { fileKey, depth } = args || {};
          if (!fileKey) return JSON.stringify({ error: 'fileKey is required' });
          let path = `/v1/files/${encodeURIComponent(fileKey)}`;
          if (depth != null) {
            const d = Number(depth);
            if (!Number.isNaN(d) && d > 0) path += `?depth=${d}`;
          }
          const file = await figmaFetch(path);
          // Summarize top-level pages/frames so the model gets an actionable
          // map without the (potentially huge) full node payload. The raw
          // document is still included but trimmed.
          const pages = (file.document?.children || []).map((p) => ({
            id: p.id,
            name: p.name,
            type: p.type,
            childCount: Array.isArray(p.children) ? p.children.length : 0,
            children: (p.children || []).slice(0, 50).map((c) => ({
              id: c.id,
              name: c.name,
              type: c.type,
            })),
          }));
          return JSON.stringify({
            name: file.name,
            lastModified: file.lastModified,
            version: file.version,
            editorType: file.editorType,
            role: file.role,
            pages,
          });
        }

        case 'figma_get_nodes': {
          const { fileKey, ids, depth } = args || {};
          if (!fileKey) return JSON.stringify({ error: 'fileKey is required' });
          const idList = Array.isArray(ids) ? ids : (ids ? String(ids).split(',') : []);
          const cleaned = idList.map((s) => String(s).trim()).filter(Boolean);
          if (cleaned.length === 0) return JSON.stringify({ error: 'ids is required (comma-separated or array of node ids)' });
          const params = new URLSearchParams();
          params.set('ids', cleaned.join(','));
          if (depth != null) {
            const d = Number(depth);
            if (!Number.isNaN(d) && d > 0) params.set('depth', String(d));
          }
          const data = await figmaFetch(`/v1/files/${encodeURIComponent(fileKey)}/nodes?${params.toString()}`);
          // Figma returns { nodes: { "<id>": { document, components, ... } } }.
          const nodes = {};
          for (const [id, entry] of Object.entries(data.nodes || {})) {
            nodes[id] = entry?.document
              ? { id: entry.document.id, name: entry.document.name, type: entry.document.type, document: entry.document }
              : entry;
          }
          return JSON.stringify({ name: data.name, nodes });
        }

        case 'figma_render_png': {
          const { fileKey, ids, scale } = args || {};
          if (!fileKey) return JSON.stringify({ error: 'fileKey is required' });
          const idList = Array.isArray(ids) ? ids : (ids ? String(ids).split(',') : []);
          const cleaned = idList.map((s) => String(s).trim()).filter(Boolean);
          if (cleaned.length === 0) return JSON.stringify({ error: 'ids is required (comma-separated or array of node ids)' });
          const params = new URLSearchParams();
          params.set('ids', cleaned.join(','));
          params.set('format', 'png');
          // Figma accepts scale 0.01–4; clamp and default to 1.
          let s = Number(scale);
          if (Number.isNaN(s) || s <= 0) s = 1;
          s = Math.min(4, Math.max(0.01, s));
          params.set('scale', String(s));
          const data = await figmaFetch(`/v1/images/${encodeURIComponent(fileKey)}?${params.toString()}`);
          if (data.err) return JSON.stringify({ error: `Figma render error: ${data.err}` });
          // data.images = { "<nodeId>": "<png url>" | null }
          return JSON.stringify({ scale: s, format: 'png', images: data.images || {} });
        }

        case 'figma_get_comments': {
          const { fileKey } = args || {};
          if (!fileKey) return JSON.stringify({ error: 'fileKey is required' });
          const data = await figmaFetch(`/v1/files/${encodeURIComponent(fileKey)}/comments`);
          const comments = (data.comments || []).map((c) => ({
            id: c.id,
            message: c.message,
            user: c.user?.handle,
            createdAt: c.created_at,
            resolvedAt: c.resolved_at || null,
            parentId: c.parent_id || null,
          }));
          return JSON.stringify({ count: comments.length, comments });
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
      name: 'figma_get_me',
      description: 'Get the authenticated Figma user profile (handle, email, id)',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'figma_get_file',
      description: 'Get a Figma file\'s document tree by fileKey (the opaque id segment in a figma.com/file/<fileKey>/ or /design/<fileKey>/ URL — NOT the file name). Returns a summarized map of pages and their top-level frames/nodes. Use figma_get_nodes to drill into a specific node.',
      input_schema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'The file key from the Figma URL (e.g. "aBcD1234" in figma.com/design/aBcD1234/My-File)' },
          depth: { type: 'number', description: 'Optional: limit how deep the node tree is traversed (1-2 is usually enough to list pages/frames). Omit for the full tree.' },
        },
        required: ['fileKey'],
      },
    },
    {
      name: 'figma_get_nodes',
      description: 'Get specific nodes from a Figma file by their node ids. Use after figma_get_file to inspect a particular frame/component without re-fetching the whole file.',
      input_schema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'The file key from the Figma URL' },
          ids: { type: 'array', items: { type: 'string' }, description: 'Node ids to fetch (e.g. ["1:23","4:56"]). A comma-separated string is also accepted.' },
          depth: { type: 'number', description: 'Optional: limit traversal depth within each node.' },
        },
        required: ['fileKey', 'ids'],
      },
    },
    {
      name: 'figma_render_png',
      description: 'Render one or more Figma nodes to PNG and return the image URLs (a map of nodeId → URL). Use this to show or download a visual of a frame/component.',
      input_schema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'The file key from the Figma URL' },
          ids: { type: 'array', items: { type: 'string' }, description: 'Node ids to render (e.g. ["1:23"]). A comma-separated string is also accepted.' },
          scale: { type: 'number', description: 'Render scale, 0.01–4 (default 1). 2 for retina/hi-dpi.' },
        },
        required: ['fileKey', 'ids'],
      },
    },
    {
      name: 'figma_get_comments',
      description: 'Read the comments on a Figma file',
      input_schema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'The file key from the Figma URL' },
        },
        required: ['fileKey'],
      },
    },
  ],
};
