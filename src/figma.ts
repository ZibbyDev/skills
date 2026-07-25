import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve as resolvePath } from 'path';
import { resolveIntegrationToken } from '@zibby/core/backend-client.js';
import { INTEGRATIONS } from './integrations.js';

/**
 * Figma skill — design context + dev-handoff over the Figma REST API.
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
async function figmaFetch(path, opts: any = {}) {
  const { token } = await resolveIntegrationToken('figma');
  const url = path.startsWith('https://') ? path : `https://api.figma.com${path}`;
  const headers: any = {
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

// ── Figma URL / key / node-id helpers ────────────────────────────────────────
// A Figma "file key" is the opaque id segment in a figma.com URL. These helpers
// let every tool accept EITHER a raw key OR a full figma.com URL, and accept
// node ids in URL form (`1-23`) or API form (`1:23`) interchangeably.

/** Accept a raw file key OR a figma.com URL (/file/, /design/, /board/, /proto/) → the key. */
export function fileKeyFrom(fileKeyOrUrl) {
  const s = String(fileKeyOrUrl || '').trim();
  const m = s.match(/figma\.com\/(?:file|design|board|proto)\/([A-Za-z0-9]+)/i);
  return m ? m[1] : s;
}

/** Accept a comma-string OR array of node ids; map URL form `1-23` → API `1:23`; join with commas. */
export function normalizeNodeIds(ids) {
  if (ids == null) return undefined;
  const arr = Array.isArray(ids) ? ids : String(ids).split(',');
  return arr.map((x) => String(x).trim().replace(/-/g, ':')).filter(Boolean).join(',');
}

/** Extract the `node-id` query param from a Figma URL, dash→colon. */
export function nodeIdFromUrl(url) {
  const m = String(url || '').match(/[?&]node-id=([^&]+)/i);
  return m ? decodeURIComponent(m[1]).replace(/-/g, ':') : undefined;
}

// ── Dev-handoff spec extraction (computed from the REST node tree) ────────────
const round = (n) => (typeof n === 'number' ? Math.round(n * 100) / 100 : n);

function rgbaToHex(c) {
  if (!c) return null;
  const to = (x) => Math.round((x ?? 0) * 255).toString(16).padStart(2, '0');
  const out: any = { hex: `#${to(c.r)}${to(c.g)}${to(c.b)}`.toUpperCase() };
  if (c.a != null && c.a < 1) out.opacity = round(c.a);
  return out;
}

function paintSpec(p) {
  if (!p || p.visible === false) return null;
  if (p.type === 'SOLID') return { type: 'SOLID', ...rgbaToHex(p.color), ...(p.opacity != null ? { opacity: p.opacity } : {}) };
  return {
    type: p.type,
    ...(p.opacity != null ? { opacity: p.opacity } : {}),
    ...(p.gradientStops ? { stops: p.gradientStops.map((s) => ({ position: round(s.position), ...rgbaToHex(s.color) })) } : {}),
  };
}

/**
 * Dev-Mode-style spec for a REST node: size, position, opacity, cornerRadius,
 * fills (hex), strokes, effects, auto-layout, and text style — recursing
 * `depth` levels into children. Used by figma_get_node_specs.
 */
export function nodeSpec(n, depth) {
  const bb = n.absoluteBoundingBox;
  const s: any = { id: n.id, name: n.name, type: n.type };
  if (bb) { s.size = { w: round(bb.width), h: round(bb.height) }; s.position = { x: round(bb.x), y: round(bb.y) }; }
  if (n.opacity != null && n.opacity !== 1) s.opacity = n.opacity;
  if (n.cornerRadius != null) s.cornerRadius = n.cornerRadius;
  if (Array.isArray(n.rectangleCornerRadii)) s.cornerRadii = n.rectangleCornerRadii;
  const fills = (n.fills || []).map(paintSpec).filter(Boolean);
  if (fills.length) s.fills = fills;
  const strokes = (n.strokes || []).map(paintSpec).filter(Boolean);
  if (strokes.length) { s.strokes = strokes; if (n.strokeWeight != null) s.strokeWeight = n.strokeWeight; }
  const effects = (n.effects || []).filter((e) => e.visible !== false)
    .map((e) => ({ type: e.type, ...(e.radius != null ? { radius: e.radius } : {}), ...(e.offset ? { offset: { x: round(e.offset.x), y: round(e.offset.y) } } : {}), ...(e.spread ? { spread: e.spread } : {}), ...(e.color ? rgbaToHex(e.color) : {}) }));
  if (effects.length) s.effects = effects;
  if (n.layoutMode && n.layoutMode !== 'NONE') {
    s.autoLayout = {
      direction: n.layoutMode,
      padding: { l: n.paddingLeft ?? 0, r: n.paddingRight ?? 0, t: n.paddingTop ?? 0, b: n.paddingBottom ?? 0 },
      gap: n.itemSpacing ?? 0,
      align: { primary: n.primaryAxisAlignItems, counter: n.counterAxisAlignItems },
    };
  }
  if (n.type === 'TEXT') {
    const st = n.style || {};
    s.text = n.characters;
    s.textStyle = {
      fontFamily: st.fontFamily, fontWeight: st.fontWeight, fontSize: st.fontSize,
      lineHeightPx: st.lineHeightPx != null ? round(st.lineHeightPx) : undefined,
      letterSpacing: st.letterSpacing != null ? round(st.letterSpacing) : undefined,
      align: st.textAlignHorizontal, case: st.textCase,
    };
  }
  if (depth > 0 && Array.isArray(n.children) && n.children.length) {
    s.children = n.children.map((c) => nodeSpec(c, depth - 1));
  }
  return s;
}

export const figmaSkill: any = {
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
  description: 'Figma — read files, nodes and comments; extract dev-handoff specs (sizes/colors/fonts/auto-layout); list versions and image fills; render frames to PNG/JPG/SVG/PDF; browse team projects/files; and post comments',

  promptFragment: `## Figma (connected)
You have access to the user's Figma files via the Figma REST API. Every tool that takes a file accepts EITHER the raw file key OR a full figma.com URL (figma.com/file|design/<key>/...). Node ids accept URL form \`1-23\` or API form \`1:23\` interchangeably. Tools:

### Identity
- figma_get_me: Get the authenticated Figma user (handle, email, id) — confirms the token works.

### Files & nodes
- figma_get_file: Get a file's document tree by key or URL. Optional depth (1-2) limits how deep the tree is returned — usually enough to find pages/frames.
- figma_get_nodes: Get specific nodes by id (comma-separated or array). Use after figma_get_file to drill into a frame/component without re-fetching the whole file.

### Dev handoff (build UI from a design)
- figma_get_node_specs: THE dev-mode tool. For the given node ids returns a compact spec computed from the REST tree — size, position, colors (hex), fonts/text-style, spacing/auto-layout, corner radius, strokes and effects — recursing depth levels (default 2). Prefer this over raw figma_get_nodes when your job is to reproduce a design in code.
- figma_get_image_fills: Map of imageRef → download URL for every image fill in a file.

### Rendering
- figma_render_png: Render nodes to PNG/JPG/SVG/PDF and return image URLs (a map of nodeId → URL). Optional format (default png), scale 0.01–4 (raster only), svg_include_id, version. Despite the name it renders any of the four formats.

### Comments
- figma_get_comments: Read the comments on a file.
- figma_post_comment: Post a comment (WRITE — needs a PAT with comment-write scope). Optionally reply (comment_id) or pin to a node (node_id[+x/y]) or a canvas point (x/y).

### Browse
- figma_get_file_versions: List a file's saved version history; a version id can be passed to render a past version.
- figma_get_team_projects: List the projects in a team (team_id from a team URL …/files/team/<TEAM_ID>/…).
- figma_get_project_files: List the files in a project (from figma_get_team_projects).

### Local helper
- figma_parse_url: Extract { file_key, node_id } from a figma.com URL — no API call.

### Notes
- The file key is NOT the file name — it's the opaque id segment in the URL (or just paste the URL).
- Node ids look like "1:23" and come from figma_get_file / figma_get_nodes / figma_parse_url output.`,

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
    const env: any = {};
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
          const key = fileKeyFrom((args || {}).fileKey);
          const { depth } = args || {};
          if (!key) return JSON.stringify({ error: 'fileKey is required (a file key or a figma.com URL)' });
          let path = `/v1/files/${encodeURIComponent(key)}`;
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
          const key = fileKeyFrom((args || {}).fileKey);
          const { ids, depth } = args || {};
          if (!key) return JSON.stringify({ error: 'fileKey is required (a file key or a figma.com URL)' });
          const normIds = normalizeNodeIds(ids);
          if (!normIds) return JSON.stringify({ error: 'ids is required (comma-separated or array of node ids; `1-23` or `1:23`)' });
          const params = new URLSearchParams();
          params.set('ids', normIds);
          if (depth != null) {
            const d = Number(depth);
            if (!Number.isNaN(d) && d > 0) params.set('depth', String(d));
          }
          const data = await figmaFetch(`/v1/files/${encodeURIComponent(key)}/nodes?${params.toString()}`);
          // Figma returns { nodes: { "<id>": { document, components, ... } } }.
          const nodes: any = {};
          for (const [id, entry] of Object.entries((data.nodes || {}) as any) as [string, any][]) {
            nodes[id] = entry?.document
              ? { id: entry.document.id, name: entry.document.name, type: entry.document.type, document: entry.document }
              : entry;
          }
          return JSON.stringify({ name: data.name, nodes });
        }

        case 'figma_get_node_specs': {
          const key = fileKeyFrom((args || {}).file);
          const { ids, depth } = args || {};
          if (!key) return JSON.stringify({ error: 'file is required (a file key or a figma.com URL)' });
          const normIds = normalizeNodeIds(ids);
          if (!normIds) return JSON.stringify({ error: 'ids is required (comma-separated or array of node ids; `1-23` or `1:23`)' });
          let d = Number(depth);
          if (Number.isNaN(d)) d = 2;
          d = Math.min(6, Math.max(0, Math.trunc(d)));
          const params = new URLSearchParams();
          params.set('ids', normIds);
          params.set('depth', String(d));
          const data = await figmaFetch(`/v1/files/${encodeURIComponent(key)}/nodes?${params.toString()}`);
          const out: any = {};
          for (const [id, entry] of (Object.entries(data.nodes || {}) as [string, any][])) {
            out[id] = entry && entry.document ? nodeSpec(entry.document, d) : null;
          }
          return JSON.stringify(out);
        }

        case 'figma_render_png': {
          const key = fileKeyFrom((args || {}).fileKey ?? (args || {}).file);
          const { ids, scale, format, svg_include_id, version } = args || {};
          if (!key) return JSON.stringify({ error: 'fileKey is required (a file key or a figma.com URL)' });
          const normIds = normalizeNodeIds(ids);
          if (!normIds) return JSON.stringify({ error: 'ids is required (comma-separated or array of node ids; `1-23` or `1:23`)' });
          const fmt = ['png', 'jpg', 'svg', 'pdf'].includes(String(format || '').toLowerCase())
            ? String(format).toLowerCase()
            : 'png';
          const params = new URLSearchParams();
          params.set('ids', normIds);
          params.set('format', fmt);
          let s;
          if (fmt === 'png' || fmt === 'jpg') {
            // Figma accepts scale 0.01–4 for raster formats; clamp and default to 1.
            s = Number(scale);
            if (Number.isNaN(s) || s <= 0) s = 1;
            s = Math.min(4, Math.max(0.01, s));
            params.set('scale', String(s));
          }
          if (fmt === 'svg' && svg_include_id != null) params.set('svg_include_id', String(!!svg_include_id));
          if (version) params.set('version', String(version));
          const data = await figmaFetch(`/v1/images/${encodeURIComponent(key)}?${params.toString()}`);
          if (data.err) return JSON.stringify({ error: `Figma render error: ${data.err}` });
          // data.images = { "<nodeId>": "<url>" | null }
          return JSON.stringify({ format: fmt, ...(s != null ? { scale: s } : {}), images: data.images || {} });
        }

        case 'figma_get_image_fills': {
          const key = fileKeyFrom((args || {}).file);
          if (!key) return JSON.stringify({ error: 'file is required (a file key or a figma.com URL)' });
          const data = await figmaFetch(`/v1/files/${encodeURIComponent(key)}/images`);
          // Figma returns { error, status, meta: { images: { <imageRef>: <url> } } }.
          return JSON.stringify({ images: data.meta?.images ?? data.images ?? {} });
        }

        case 'figma_get_file_versions': {
          const key = fileKeyFrom((args || {}).file);
          if (!key) return JSON.stringify({ error: 'file is required (a file key or a figma.com URL)' });
          const data = await figmaFetch(`/v1/files/${encodeURIComponent(key)}/versions`);
          const versions = (data.versions || []).map((v) => ({
            id: v.id,
            label: v.label,
            description: v.description,
            createdAt: v.created_at,
            user: v.user?.handle,
          }));
          return JSON.stringify({ count: versions.length, versions });
        }

        case 'figma_get_comments': {
          const key = fileKeyFrom((args || {}).fileKey);
          if (!key) return JSON.stringify({ error: 'fileKey is required (a file key or a figma.com URL)' });
          const data = await figmaFetch(`/v1/files/${encodeURIComponent(key)}/comments`);
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

        case 'figma_post_comment': {
          const key = fileKeyFrom((args || {}).file);
          const { message, comment_id, node_id, x, y } = args || {};
          if (!key) return JSON.stringify({ error: 'file is required (a file key or a figma.com URL)' });
          if (!message) return JSON.stringify({ error: 'message is required' });
          const body: any = { message };
          if (comment_id) body.comment_id = comment_id;
          if (node_id) body.client_meta = { node_id: normalizeNodeIds(node_id), node_offset: { x: x ?? 0, y: y ?? 0 } };
          else if (x != null || y != null) body.client_meta = { x: x ?? 0, y: y ?? 0 };
          const data = await figmaFetch(`/v1/files/${encodeURIComponent(key)}/comments`, { method: 'POST', body });
          return JSON.stringify({
            id: data.id,
            message: data.message,
            fileKey: key,
            createdAt: data.created_at,
            parentId: data.parent_id || null,
          });
        }

        case 'figma_get_team_projects': {
          const { team_id } = args || {};
          if (!team_id) return JSON.stringify({ error: 'team_id is required' });
          const data = await figmaFetch(`/v1/teams/${encodeURIComponent(team_id)}/projects`);
          return JSON.stringify({ name: data.name, projects: data.projects || [] });
        }

        case 'figma_get_project_files': {
          const { project_id, branch_data } = args || {};
          if (!project_id) return JSON.stringify({ error: 'project_id is required' });
          const params = new URLSearchParams();
          if (branch_data) params.set('branch_data', 'true');
          const qs = params.toString();
          const data = await figmaFetch(`/v1/projects/${encodeURIComponent(project_id)}/files${qs ? `?${qs}` : ''}`);
          return JSON.stringify({ name: data.name, files: data.files || [] });
        }

        case 'figma_parse_url': {
          const { url } = args || {};
          return JSON.stringify({ file_key: fileKeyFrom(url), node_id: nodeIdFromUrl(url) ?? null });
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
      description: 'Get a Figma file\'s document tree. Accepts a file key OR a figma.com URL (figma.com/file|design/<key>/... — NOT the file name). Returns a summarized map of pages and their top-level frames/nodes. Use figma_get_nodes or figma_get_node_specs to drill into a specific node.',
      input_schema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'A file key OR a figma.com URL (e.g. "aBcD1234" or figma.com/design/aBcD1234/My-File)' },
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
          fileKey: { type: 'string', description: 'A file key OR a figma.com URL' },
          ids: { type: 'array', items: { type: 'string' }, description: 'Node ids to fetch. Accepts URL form ["1-23"] or API form ["1:23"]. A comma-separated string is also accepted.' },
          depth: { type: 'number', description: 'Optional: limit traversal depth within each node.' },
        },
        required: ['fileKey', 'ids'],
      },
    },
    {
      name: 'figma_get_node_specs',
      description: 'Dev-Mode-style inspection computed from the REST tree: for the given nodes and their children returns size, position, colors (hex), fonts/text-style, spacing/auto-layout, corner radius, strokes and effects — a compact spec for reproducing a design in code. Prefer this over figma_get_nodes when your job is to build UI from a Figma file.',
      input_schema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'A file key OR a figma.com URL' },
          ids: { type: 'array', items: { type: 'string' }, description: 'Node ids to inspect (URL form "1-23" or API form "1:23"). A comma-separated string is also accepted.' },
          depth: { type: 'number', description: 'How many levels of children to walk (0-6, default 2).' },
        },
        required: ['file', 'ids'],
      },
    },
    {
      name: 'figma_render_png',
      description: 'Render one or more Figma nodes to an image and return the URLs (a map of nodeId → URL). Despite the name it renders PNG/JPG/SVG/PDF (default png). Use to show or download a visual of a frame/component.',
      input_schema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'A file key OR a figma.com URL' },
          ids: { type: 'array', items: { type: 'string' }, description: 'Node ids to render (URL form "1-23" or API form "1:23"). A comma-separated string is also accepted.' },
          format: { type: 'string', enum: ['png', 'jpg', 'svg', 'pdf'], description: 'Output format (default png).' },
          scale: { type: 'number', description: 'Render scale, 0.01–4 (raster formats only; default 1). 2 for retina/hi-dpi.' },
          svg_include_id: { type: 'boolean', description: 'For SVG: include element ids as attributes.' },
          version: { type: 'string', description: 'Render a specific file version id (from figma_get_file_versions).' },
        },
        required: ['fileKey', 'ids'],
      },
    },
    {
      name: 'figma_get_image_fills',
      description: 'Get a map of imageRef → download URL for every image fill used in a Figma file.',
      input_schema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'A file key OR a figma.com URL' },
        },
        required: ['file'],
      },
    },
    {
      name: 'figma_get_file_versions',
      description: 'List a Figma file\'s saved version history (version id, label, created_at, user). A version id can be passed to figma_render_png to render a past version.',
      input_schema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'A file key OR a figma.com URL' },
        },
        required: ['file'],
      },
    },
    {
      name: 'figma_get_comments',
      description: 'Read the comments on a Figma file',
      input_schema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'A file key OR a figma.com URL' },
        },
        required: ['fileKey'],
      },
    },
    {
      name: 'figma_post_comment',
      description: 'Post a comment on a Figma file (WRITE — needs a PAT with comment-write scope). Optionally reply to a comment (comment_id), pin it to a node (node_id, with optional x/y offset), or pin to a canvas point (x/y).',
      input_schema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'A file key OR a figma.com URL' },
          message: { type: 'string', description: 'The comment text.' },
          comment_id: { type: 'string', description: 'Optional: reply to this parent comment id.' },
          node_id: { type: 'string', description: 'Optional: pin the comment to this node ("1-23" or "1:23").' },
          x: { type: 'number', description: 'Optional: x position (node offset if node_id given, else canvas point).' },
          y: { type: 'number', description: 'Optional: y position (node offset if node_id given, else canvas point).' },
        },
        required: ['file', 'message'],
      },
    },
    {
      name: 'figma_get_team_projects',
      description: 'List the projects in a Figma team. Get team_id from a Figma team URL (…/files/team/<TEAM_ID>/…).',
      input_schema: {
        type: 'object',
        properties: {
          team_id: { type: 'string', description: 'The Figma team id.' },
        },
        required: ['team_id'],
      },
    },
    {
      name: 'figma_get_project_files',
      description: 'List the files in a Figma project (from figma_get_team_projects). Returns file key, name, thumbnail, last_modified.',
      input_schema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'The Figma project id.' },
          branch_data: { type: 'boolean', description: 'Optional: include branch metadata for each file.' },
        },
        required: ['project_id'],
      },
    },
    {
      name: 'figma_parse_url',
      description: 'Local helper (no API call): extract the file key and node id (colon form) from a figma.com file/design URL. Returns { file_key, node_id }.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'A full figma.com file/design URL.' },
        },
        required: ['url'],
      },
    },
  ],
};
