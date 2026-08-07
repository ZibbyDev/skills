import { z } from 'zod';
import { figmaRequest } from './figma.js';

const json = (data) => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }],
});

const errorContent = (label, error) => {
  let hint = '';
  if (error.code === 'NO_TOKEN') {
    hint = '\n\n没有收到 Figma token。安装命令里要带 --header "X-Figma-Token: <你的PAT>"。';
  } else if (error.status === 403 || error.status === 401) {
    hint =
      '\n\n可能原因：PAT 无效/已过期，或这个文件没分享给你的 Figma 账号（私有草稿、或不在你所在的团队/组织）。' +
      '确认：① PAT 还有效且勾了正确 scope（读文件要 file_content:read）；② 这个文件对你可见（org 可见或已分享到你邮箱）。';
  }
  return {
    isError: true,
    content: [{
      type: 'text',
      text: `${label} failed: status=${error.status ?? 'n/a'} ${error.message}` +
        (error.body ? `\nbody=${JSON.stringify(error.body)}` : '') + hint,
    }],
  };
};

function wrap(label, handler) {
  return async (args) => {
    try { return json(await handler(args)); }
    catch (e) { return errorContent(label, e); }
  };
}

// ── Figma URL / key / node-id helpers ────────────────────────────────────────
function fileKeyFrom(fileKeyOrUrl) {
  const s = String(fileKeyOrUrl || '').trim();
  const m = s.match(/figma\.com\/(?:file|design|board|proto)\/([A-Za-z0-9]+)/i);
  return m ? m[1] : s;
}
function normalizeNodeIds(ids) {
  if (ids == null) return undefined;
  const arr = Array.isArray(ids) ? ids : String(ids).split(',');
  return arr.map((x) => String(x).trim().replace(/-/g, ':')).filter(Boolean).join(',');
}
function nodeIdFromUrl(url) {
  const m = String(url || '').match(/[?&]node-id=([^&]+)/i);
  return m ? decodeURIComponent(m[1]).replace(/-/g, ':') : undefined;
}

// ── Dev-handoff spec extraction (computed from the REST node tree) ────────────
const round = (n) => (typeof n === 'number' ? Math.round(n * 100) / 100 : n);
function rgbaToHex(c) {
  if (!c) return null;
  const to = (x) => Math.round((x ?? 0) * 255).toString(16).padStart(2, '0');
  const out = { hex: `#${to(c.r)}${to(c.g)}${to(c.b)}`.toUpperCase() };
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
function nodeSpec(n, depth) {
  const bb = n.absoluteBoundingBox;
  const s = { id: n.id, name: n.name, type: n.type };
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

export function registerTools(server, ctx) {
  const call = (method, path, opts) => figmaRequest(ctx.pat, method, path, opts);
  const reg = (name, def, handler) => server.registerTool(name, def, wrap(name, handler));

  reg('figma_whoami', {
    title: 'Get the authenticated Figma user',
    description: 'Returns the current Figma user (id, handle, email, img_url) — a quick way to confirm the token works.',
    inputSchema: {},
  }, async () => call('GET', '/v1/me'));

  reg('figma_get_file', {
    title: 'Get a Figma file (document tree)',
    description: 'Fetch a Figma file by key or URL. Returns the document node tree, components and styles. Large files are big — prefer `depth` (1-2) or figma_get_file_nodes for a subtree.',
    inputSchema: {
      file: z.string().describe('Figma file key OR a full figma.com file/design URL'),
      version: z.string().optional().describe('Specific version id (from figma_get_file_versions)'),
      ids: z.string().optional().describe('Comma-separated node ids to limit the tree (URL `1-23` or API `1:23`)'),
      depth: z.number().int().min(1).optional().describe('How many levels of the node tree to return'),
      geometry: z.enum(['paths']).optional(),
      branch_data: z.boolean().optional(),
    },
  }, async ({ file, ids, ...rest }) =>
    call('GET', `/v1/files/${encodeURIComponent(fileKeyFrom(file))}`, { query: { ...rest, ids: normalizeNodeIds(ids) } }));

  reg('figma_get_file_nodes', {
    title: 'Get specific nodes from a Figma file',
    description: 'Fetch only the given nodes (and subtrees) — much smaller than figma_get_file. Node ids accept URL form `1-23` or API form `1:23`.',
    inputSchema: {
      file: z.string().describe('Figma file key OR URL'),
      ids: z.string().describe('Comma-separated node ids (required)'),
      depth: z.number().int().min(1).optional(),
      geometry: z.enum(['paths']).optional(),
      version: z.string().optional(),
    },
  }, async ({ file, ids, ...rest }) =>
    call('GET', `/v1/files/${encodeURIComponent(fileKeyFrom(file))}/nodes`, { query: { ...rest, ids: normalizeNodeIds(ids) } }));

  reg('figma_get_node_specs', {
    title: 'Get dev-handoff specs for Figma nodes',
    description: 'Dev-Mode-style inspection computed from the REST tree: for the given nodes and their children, returns size, position, colors (hex), fonts, spacing/auto-layout, radius, strokes and effects — a compact spec for building UI. Node ids accept `1-23` or `1:23`.',
    inputSchema: {
      file: z.string().describe('Figma file key OR URL'),
      ids: z.string().describe('Comma-separated node ids to inspect'),
      depth: z.number().int().min(0).max(6).optional().default(2).describe('How deep to walk children (default 2)'),
    },
  }, async ({ file, ids, depth = 2 }) => {
    const data = await call('GET', `/v1/files/${encodeURIComponent(fileKeyFrom(file))}/nodes`, {
      query: { ids: normalizeNodeIds(ids), depth },
    });
    const out = {};
    for (const [id, entry] of Object.entries(data.nodes || {})) {
      out[id] = entry && entry.document ? nodeSpec(entry.document, depth) : null;
    }
    return out;
  });

  reg('figma_get_images', {
    title: 'Render Figma nodes to images',
    description: 'Render the given nodes to PNG/JPG/SVG/PDF and return temporary URLs (valid ~14 days). Use for previews/exports.',
    inputSchema: {
      file: z.string().describe('Figma file key OR URL'),
      ids: z.string().describe('Comma-separated node ids to render (URL `1-23` or API `1:23`)'),
      format: z.enum(['png', 'jpg', 'svg', 'pdf']).optional().default('png'),
      scale: z.number().min(0.01).max(4).optional().describe('Image scale 0.01–4 (raster only)'),
      svg_include_id: z.boolean().optional(),
      version: z.string().optional(),
    },
  }, async ({ file, ids, ...rest }) =>
    call('GET', `/v1/images/${encodeURIComponent(fileKeyFrom(file))}`, { query: { ...rest, ids: normalizeNodeIds(ids) } }));

  reg('figma_get_image_fills', {
    title: 'Get image fill URLs for a file',
    description: 'Return a map of imageRef → download URL for every image fill used in the file.',
    inputSchema: { file: z.string().describe('Figma file key OR URL') },
  }, async ({ file }) => call('GET', `/v1/files/${encodeURIComponent(fileKeyFrom(file))}/images`));

  reg('figma_get_file_versions', {
    title: 'List a Figma file’s version history',
    description: 'Return the saved version history (version id, label, created_at, user). Use a version id with figma_get_file.',
    inputSchema: { file: z.string().describe('Figma file key OR URL') },
  }, async ({ file }) => call('GET', `/v1/files/${encodeURIComponent(fileKeyFrom(file))}/versions`));

  reg('figma_get_comments', {
    title: 'Get comments on a Figma file',
    description: 'List all comments on a file (id, message, author, resolved status, position).',
    inputSchema: {
      file: z.string().describe('Figma file key OR URL'),
      as_md: z.boolean().optional().describe('Return comment bodies as Markdown'),
    },
  }, async ({ file, as_md }) =>
    call('GET', `/v1/files/${encodeURIComponent(fileKeyFrom(file))}/comments`, { query: as_md ? { as_md: true } : undefined }));

  reg('figma_post_comment', {
    title: 'Post a comment on a Figma file',
    description: 'Add a comment to a file. Optionally reply to a comment (comment_id) or pin it to a node. Needs a PAT with comment-write scope.',
    inputSchema: {
      file: z.string().describe('Figma file key OR URL'),
      message: z.string().describe('Comment text'),
      comment_id: z.string().optional().describe('Reply to this parent comment id'),
      node_id: z.string().optional().describe('Pin the comment to this node (`1-23` or `1:23`)'),
      x: z.number().optional(),
      y: z.number().optional(),
    },
  }, async ({ file, message, comment_id, node_id, x, y }) => {
    const body = { message };
    if (comment_id) body.comment_id = comment_id;
    if (node_id) body.client_meta = { node_id: normalizeNodeIds(node_id), node_offset: { x: x ?? 0, y: y ?? 0 } };
    else if (x != null || y != null) body.client_meta = { x: x ?? 0, y: y ?? 0 };
    return call('POST', `/v1/files/${encodeURIComponent(fileKeyFrom(file))}/comments`, { body });
  });

  reg('figma_get_team_projects', {
    title: 'List projects in a Figma team',
    description: 'List the projects in a team. Get team_id from a Figma team URL (…/files/team/<TEAM_ID>/…).',
    inputSchema: { team_id: z.string().describe('Figma team id') },
  }, async ({ team_id }) => call('GET', `/v1/teams/${encodeURIComponent(team_id)}/projects`));

  reg('figma_get_project_files', {
    title: 'List files in a Figma project',
    description: 'List the files in a project (from figma_get_team_projects). Returns file key, name, thumbnail, last_modified.',
    inputSchema: {
      project_id: z.string().describe('Figma project id'),
      branch_data: z.boolean().optional(),
    },
  }, async ({ project_id, branch_data }) =>
    call('GET', `/v1/projects/${encodeURIComponent(project_id)}/files`, { query: branch_data ? { branch_data: true } : undefined }));

  reg('figma_parse_url', {
    title: 'Parse a Figma URL into file key + node id',
    description: 'Local helper (no API call): extract the file key and node id (colon form) from a Figma file/design URL.',
    inputSchema: { url: z.string().describe('A full figma.com file/design URL') },
  }, async ({ url }) => ({ file_key: fileKeyFrom(url), node_id: nodeIdFromUrl(url) ?? null }));

  console.log('registered 12 curated Figma tools');
}
