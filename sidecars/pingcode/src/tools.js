import fs from 'node:fs';
import { z } from 'zod';
import { getPingCodeOAuth } from './pingcode.js';

// Generated from PingCode's REST API docs (scripts/parse-api.mjs). Each entry is
// turned into an MCP tool by the data-driven registrar below. Regenerate after
// doc updates; this JSON is the committed source of truth (the HTML is not).
const API_SPEC = JSON.parse(
  fs.readFileSync(new URL('./pingcode-api.json', import.meta.url), 'utf8'),
);

// PingCode "Type" string → a zod validator. Object/array types MUST carry their
// JSON-schema `type`, otherwise z.any() emits an empty schema `{}` with no type
// and the MCP client serializes structured values to a JSON *string* — so e.g.
// `properties` arrives as "{...}" and PingCode rejects it ("必须是一个 object").
// Contents stay permissive (z.any()) since the docs only describe sub-fields.
const zodFor = (type) => {
  const t = String(type || '').toLowerCase();
  if (t.endsWith('[]') || t.startsWith('array')) return z.array(z.any()); // String[], Object[]
  if (t === 'object') return z.record(z.any());                           // nested JSON object
  if (/(number|int|float|timestamp)/.test(t)) return z.number();
  if (t.startsWith('bool')) return z.boolean();
  if (t === 'string') return z.string();
  return z.any(); // File, enums, unknown
};

// Endpoints already hand-registered below — skip their generated twins so the
// curated tools (nicer names/schemas, in active use) remain the canonical ones.
const normKey = (method, path) => `${method} ${path.replace(/\{[^}]+\}/g, '{}')}`;
const HANDWRITTEN_ENDPOINTS = new Set([
  'GET /v1/ship/products',
  'GET /v1/ship/ticket/types',
  'GET /v1/ship/tickets',
  'POST /v1/ship/tickets',
  'PATCH /v1/ship/tickets/{}',
]);

const json = (data) => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }],
});

const notAuthorizedContent = (publicBaseUrl, mcpToken) => {
  // ?renew=<mcp_token> tells the callback to update this slot rather than
  // mint a fresh MCP_TOKEN — so the user's Claude Code config never changes.
  const url = `${publicBaseUrl}/oauth/start?renew=${encodeURIComponent(mcpToken)}`;
  return {
    isError: true,
    content: [{
      type: 'text',
      text:
        `⚠️ PingCode 授权已过期 (refresh_token 90 天有效)。\n` +
        `请用浏览器打开下面这个链接, 登录 PingCode 并点 "同意":\n\n` +
        `${url}\n\n` +
        `授权完成后回到对话, 让我再试一次即可。Claude Code 配置不用改。`,
    }],
  };
};

const errorContent = (label, error) => ({
  isError: true,
  content: [{
    type: 'text',
    text: `${label} failed: status=${error.status ?? 'n/a'} ${error.message}` +
      (error.body ? `\nbody=${JSON.stringify(error.body)}` : ''),
  }],
});

function wrap(label, handler, ctx) {
  return async (args) => {
    try { return json(await handler(args)); }
    catch (e) {
      if (e.code === 'NOT_AUTHORIZED') return notAuthorizedContent(ctx.publicBaseUrl, ctx.mcpToken);
      return errorContent(label, e);
    }
  };
}

export function registerTools(server, ctx) {
  const pc = getPingCodeOAuth();
  const call = (method, path, opts) => pc.request(ctx.mcpToken, method, path, opts);

  server.registerTool('list_products', {
    title: 'List PingCode products',
    description: 'List all Ship products visible to the authenticated user. Returns id, name per product.',
    inputSchema: {},
  }, wrap('list_products', async () => call('GET', '/v1/ship/products'), ctx));

  server.registerTool('list_ticket_types', {
    title: 'List ticket types for a product',
    description: 'List available ticket types for the given product. Required before creating a ticket.',
    inputSchema: {
      product_id: z.string().describe('Product UUID from list_products'),
    },
  }, wrap('list_ticket_types', async ({ product_id }) =>
    call('GET', '/v1/ship/ticket/types', { query: { product_id } }), ctx));

  server.registerTool('list_tickets', {
    title: 'List PingCode Ship tickets',
    description: 'List tickets visible to the authenticated user with optional filters. All filters optional.',
    inputSchema: {
      product_id: z.string().optional(),
      type_id: z.string().optional(),
      state_id: z.string().optional(),
      priority_id: z.string().optional(),
      keywords: z.string().optional().describe('Free-text search'),
      page_size: z.number().int().min(1).max(100).optional().default(20),
      page_index: z.number().int().min(0).optional().default(0),
    },
  }, wrap('list_tickets', async (args) =>
    call('GET', '/v1/ship/tickets', { query: args }), ctx));

  server.registerTool('create_ticket', {
    title: 'Create a PingCode Ship ticket',
    description: 'Create a new ticket (产品工单) as the authenticated user. Call list_products and list_ticket_types first to get the required IDs. Always show the user the html_url from the response.',
    inputSchema: {
      product_id: z.string(),
      title: z.string(),
      type_id: z.string(),
      description: z.string().optional().describe('Strongly recommended; include symptoms / repro / expected behavior'),
      submitter_id: z.string().optional(),
      customer_id: z.string().optional(),
      channel_id: z.string().optional(),
      assignee_id: z.string().optional(),
      priority_id: z.string().optional(),
      properties: z.record(z.any()).optional().describe('Custom/system fields, e.g. {"tag_ids":["<uuid>"]}'),
    },
  }, wrap('create_ticket', async (args) =>
    call('POST', '/v1/ship/tickets', { body: args }), ctx));

  server.registerTool('update_ticket', {
    title: 'Update a PingCode Ship ticket',
    description: 'Patch an existing ticket. Only include fields you want to change.',
    inputSchema: {
      ticket_id: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      type_id: z.string().optional(),
      state_id: z.string().optional(),
      assignee_id: z.string().optional(),
      submitter_id: z.string().optional(),
      solution_id: z.string().optional(),
      priority_id: z.string().optional(),
      customer_id: z.string().optional(),
      properties: z.record(z.any()).optional(),
    },
  }, wrap('update_ticket', async ({ ticket_id, ...patch }) => {
    if (Object.keys(patch).length === 0) {
      throw Object.assign(new Error('Provide at least one field to update'), { status: 400 });
    }
    return call('PATCH', `/v1/ship/tickets/${encodeURIComponent(ticket_id)}`, { body: patch });
  }, ctx));

  server.registerTool('auth_status', {
    title: 'Check PingCode authorization status',
    description: 'Returns whether the current user has a valid PingCode authorization, and when it was granted / expires.',
    inputSchema: {},
  }, wrap('auth_status', async () => pc.getStatus(ctx.mcpToken), ctx));

  // ── data-driven: every other PingCode endpoint from the generated spec ──
  // Optionally restrict to certain doc groups via PINGCODE_TOOL_GROUPS (a
  // comma-separated list of data-group names, e.g. "产品,工单,项目"). Empty =
  // register all of them. Use this to trim the tool list if the agent is
  // overwhelmed by 300+ tools.
  const groupFilter = (process.env.PINGCODE_TOOL_GROUPS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  let registered = 0;
  for (const spec of API_SPEC) {
    if (HANDWRITTEN_ENDPOINTS.has(normKey(spec.method, spec.path))) continue;
    if (groupFilter.length && !groupFilter.includes(spec.group)) continue;

    const shape = {};
    for (const p of spec.params) {
      let v = zodFor(p.type);
      if (p.desc) v = v.describe(p.desc);
      if (!p.required) v = v.optional();
      shape[p.name] = v;
    }
    // Escape hatch for the whole generated fleet: PingCode's docs occasionally
    // omit a top-level field the API still requires/accepts (proven: idea
    // priority_id is undocumented on create yet mandatory). Rather than hand-
    // curate each such tool, every generated tool takes an optional `extra`
    // object whose keys are merged into the outgoing request — so a caller can
    // always supply a doc-omitted field (discovered from an error or a list_*
    // call) without the tool having had to enumerate it.
    shape.extra = z.record(z.any()).optional().describe(
      'Extra top-level API fields not listed above. PingCode docs sometimes omit ' +
      'required ones (e.g. priority_id on create). Keys here are merged into the ' +
      'request body (write) or query (read). Use when a call fails asking for a field absent above.');

    server.registerTool(spec.name, {
      title: spec.cn || spec.name,
      description: spec.description,
      inputSchema: shape,
    }, wrap(spec.name, async (args = {}) => {
      let path = spec.path;
      const query = {};
      const body = {};
      for (const p of spec.params) {
        const val = args[p.name];
        if (val === undefined) continue;
        if (p.in === 'path') path = path.replace(`{${p.name}}`, encodeURIComponent(String(val)));
        else if (p.in === 'query') query[p.name] = val;
        else body[p.name] = val;
      }
      // merge the escape-hatch fields into query (read) or body (write)
      if (args.extra && typeof args.extra === 'object') {
        const sink = (spec.method === 'GET' || spec.method === 'DELETE') ? query : body;
        for (const [k, v] of Object.entries(args.extra)) if (v !== undefined) sink[k] = v;
      }
      const opts = {};
      if (Object.keys(query).length) opts.query = query;
      if (Object.keys(body).length) opts.body = body;
      return call(spec.method, path, opts);
    }, ctx));
    registered++;
  }
  console.log(`registered ${registered} generated PingCode tools (+6 curated)`);
}
