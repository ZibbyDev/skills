/**
 * Lark / Feishu Docs skill — read / create / append Lark Docx documents.
 *
 * The document-world twin of googleDocs.js + notion.js, but for Lark/Feishu.
 * It runs on the DEDICATED Lark Docs app (integration `lark_docs`) — the app
 * carrying the docx (+ wiki/drive) scopes — and falls back to the chat app
 * (`lark`) so a single-app setup keeps working. Auth:
 *   resolveLarkApp() (shared, larkApp.ts) → { appId, appSecret, host } →
 *   tenant_access_token (cached ~2h) → Bearer on every Docx call.
 *
 * Design rules (mirrors notion.js / googleDocs.js):
 *   - resolveLarkApp() is the SINGLE auth chokepoint (via the
 *     larkDocsApi() helper). Don't re-resolve at call sites. It lives in
 *     larkApp.ts because the docs app is also what other tenant-wide Lark
 *     readers (lark-attendance) must use — one decider, not one per skill.
 *   - handleToolCall() dispatches the tools and NEVER throws — any HTTP or
 *     parse failure is returned as { ok:false, error } so a missing/broken
 *     Lark connection can't crash the run.
 *   - Region-aware host: whatever resolveLarkApp() returns as
 *     `host` (open.feishu.cn vs open.larksuite.com) is used verbatim, so the
 *     skill always matches the connected app's region. No baked host, no CLI,
 *     no heavy deps — pure `fetch`.
 *
 * Docx v1 API (host-relative):
 *   GET  /open-apis/docx/v1/documents/{id}                     → { document:{title,...} }
 *   GET  /open-apis/docx/v1/documents/{id}/raw_content?lang=0  → { content } (plain text)
 *   POST /open-apis/docx/v1/documents                          → { document:{document_id,title} }
 *   POST /open-apis/docx/v1/documents/{id}/blocks/{block}/children
 *        (block == document_id == the doc root) → append blocks at the end
 *   GET  /open-apis/wiki/v2/spaces/get_node?token={t}          → { node:{obj_token,obj_type} }
 *
 * Bitable v1 API (Base / 多维表格 — requires bitable:app:readonly):
 *   GET  /open-apis/bitable/v1/apps/{app}                       → { app:{name,...} }
 *   GET  /open-apis/bitable/v1/apps/{app}/tables?page_size=100  → { items:[{table_id,name}] }
 *   GET  /open-apis/bitable/v1/apps/{app}/tables/{t}/fields     → { items:[{field_name,type}] }
 *   POST /open-apis/bitable/v1/apps/{app}/tables/{t}/records/search?page_size=500
 *        body { view_id?, field_names? } → { items:[{record_id,fields}], has_more, page_token, total }
 *   A Base is NOT a docx: a /wiki/ node fronting one resolves to obj_type
 *   'bitable', which the docx path rejects by design (see resolveDocumentId).
 *
 * Wiki v2 API (write support — requires wiki:node:create / wiki:space:read):
 *   GET  /open-apis/wiki/v2/spaces?page_size=50[&page_token]   → { items:[{space_id,name}], has_more, page_token }
 *   POST /open-apis/wiki/v2/spaces/{space_id}/nodes            → { node:{node_token,obj_token,obj_type} }
 *        (obj_type='docx', node_type='origin', optional parent_node_token)
 */

import { existsSync, statSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { basename, dirname, resolve as resolvePath } from 'path';
import { INTEGRATIONS } from './integrations.js';
import { LARK_APP_ENV_KEYS, resolveLarkApp } from './larkApp.js';
import { fetchWithDeadline } from './lib/http-deadline.js';

/**
 * Resolve the generic skill MCP server binary (bin/mcp-skill.mjs), derived
 * from import.meta.url so it works in src/, dist/, and a published install.
 * Same rationale as notion.js / googleDocs.js.
 */
function resolveSkillBin() {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

// Cap on flattened text so a large doc can't blow the prompt budget.
const MAX_TEXT_CHARS = 20000;
// Lark's blocks/children create endpoint accepts at most 50 children/request.
const MAX_BLOCK_CHILDREN = 50;
// Wiki space listing: 50/page (Lark's max) — cap pages so a pathological
// tenant can't loop forever. 20 pages = up to 1000 spaces, plenty.
const WIKI_SPACES_PAGE_SIZE = 50;
const MAX_WIKI_SPACE_PAGES = 20;
// Base (bitable) reads. Lark's records/search caps page_size at 500; we ask for
// the max so a normal table is one round-trip. maxRecords defaults small enough
// to be safe in a prompt and is capped so a 100k-row table can't be pulled whole.
const BITABLE_PAGE_SIZE = 500;
const DEFAULT_BITABLE_RECORDS = 200;
const MAX_BITABLE_RECORDS = 1000;
const BITABLE_TABLES_PAGE_SIZE = 100;
const MAX_BITABLE_PAGES = 20;
// Independent of MAX_TEXT_CHARS: a table is wide as well as long, so the row
// budget is measured in serialized characters, not rows.
const MAX_BITABLE_CHARS = 30000;
// Field types whose value is an epoch-ms number: DateTime, Created time,
// Modified time. Rendered as ISO so the model never sees a bare 1756944000000.
const BITABLE_DATE_FIELD_TYPES = new Set([5, 1001, 1002]);

// Cap on uploaded image size. Lark's drive upload_all hard cap is 20MB
// (validation max 20971520 bytes); we stay at 10MB so a report chart can
// never bump the platform limit.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// Lark's tenant_access_token TTL is ~2h. Cache slightly under that. This is a
// SEPARATE cache from lark.js (each module gets its own) — same pattern as
// bin/mcp-lark.mjs duplicating the mint locally.
const TOKEN_TTL_MS = 100 * 60 * 1000;
let tokenCache = null; // { token, expiresAt, appId }

/**
 * Every env name the SHARED app-credential resolution can read (→ envKeys).
 * Re-exported under its historical name; the list is DERIVED from larkApp.ts's
 * precedence order, never a second hand-kept copy.
 */
export const LARK_DOCS_APP_ENV_KEYS = LARK_APP_ENV_KEYS;

async function getTenantAccessToken() {
  // Auth chokepoint: the app credential comes from the SHARED resolver
  // (larkApp.ts) — docs app first, chat app fallback, backend last.
  const { appId, appSecret, host } = await resolveLarkApp();
  if (tokenCache && tokenCache.appId === appId && tokenCache.expiresAt > Date.now()) {
    return { token: tokenCache.token, host };
  }
  const res = await fetchWithDeadline(`${host}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  }, { kind: 'api', what: 'Lark tenant_access_token' });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`Lark tenant_access_token failed: ${data.msg || data.code}`);
  }
  tokenCache = { token: data.tenant_access_token, expiresAt: Date.now() + TOKEN_TTL_MS, appId };
  return { token: data.tenant_access_token, host };
}

/**
 * Low-level Lark REST helper. Resolves the tenant_access_token (single auth
 * chokepoint), calls the host-relative path, and returns the `data` payload.
 * Throws on a non-zero Lark `code` — handleToolCall catches + fail-softs.
 * Returns { data, host } so callers can build region-aware web URLs.
 */
async function larkDocsApi(method, path, body?: any) {
  const { token, host } = await getTenantAccessToken();
  const init: any = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
  };
  if (method !== 'GET' && body !== undefined) init.body = JSON.stringify(body);
  const res = await fetchWithDeadline(`${host}${path}`, init, { kind: 'api', what: `Lark Docx ${method} ${path}` });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`Lark Docx API ${path} error: ${data.msg || data.code}`);
  }
  return { data: data.data || {}, host };
}

/**
 * Derive the human-facing doc web URL from the open-api host + document id.
 * The open-api host (open.feishu.cn / open.larksuite.com) is region-specific;
 * the web doc lives on the corresponding product domain. This is a best-effort
 * canonical URL — a tenant with a vanity subdomain may render its own host, but
 * the product-domain URL still resolves for the user.
 */
export function docWebUrl(host, id) {
  const h = String(host || '');
  if (h.includes('feishu')) return `https://feishu.cn/docx/${id}`;
  return `https://www.larksuite.com/docx/${id}`;
}

/**
 * Derive the human-facing wiki node web URL (same region logic as docWebUrl).
 * A wiki-resident doc is best shared by its /wiki/<node_token> link — opening
 * it shows the doc in its wiki-space context.
 */
export function wikiWebUrl(host, nodeToken) {
  const h = String(host || '');
  if (h.includes('feishu')) return `https://feishu.cn/wiki/${nodeToken}`;
  return `https://www.larksuite.com/wiki/${nodeToken}`;
}

/**
 * Pull the Base coordinates out of a Lark URL's query string. A Base link
 * carries its table and view THERE (…/base/<app>?table=tbl…&view=vew…), so a
 * link without them names the whole Base rather than one table. Only the id
 * shapes Lark actually mints are accepted, so an unrelated `table=` param can
 * never be mistaken for a table id. Returns {} when absent — callers SPREAD
 * this, so the keys are missing rather than present-and-undefined.
 */
function parseBitableQuery(input) {
  const q = input.indexOf('?');
  if (q < 0) return {};
  const query = input.slice(q + 1).split('#')[0];
  const params = new URLSearchParams(query);
  const out: any = {};
  const table = params.get('table');
  const view = params.get('view');
  if (table && /^tbl[A-Za-z0-9]+$/.test(table)) out.tableId = table;
  if (view && /^vew[A-Za-z0-9]+$/.test(view)) out.viewId = view;
  return out;
}

/**
 * Parse a Lark/Feishu doc reference (raw token OR URL) into { type, token }.
 *   - .../docx/<token>  → { type:'docx', token }
 *   - .../wiki/<token>  → { type:'wiki', token } (resolved to its backing object)
 *   - .../base/<token>  → { type:'base', token } (a Base / 多维表格)
 *   - bare token        → { type:'docx', token }
 * A /base/ or /wiki/ URL additionally carries { tableId?, viewId? } when its
 * query names them. Returns null when nothing usable can be extracted.
 * Pure + side-effect-free.
 */
export function parseLarkDocRef(ref) {
  if (!ref || typeof ref !== 'string') return null;
  const input = ref.trim();
  if (!input) return null;

  // URL form: the segment right after /docx/, /wiki/ or /base/, plus the Base
  // table/view coordinates when the query carries them.
  const m = input.match(/\/(docx|wiki|base)\/([A-Za-z0-9]+)/);
  if (m) return { type: m[1], token: m[2], ...parseBitableQuery(input) };

  // Bare token — Lark doc/obj tokens are alphanumeric, typically ~24-27 chars.
  if (/^[A-Za-z0-9]{10,}$/.test(input)) return { type: 'docx', token: input };

  return null;
}

/**
 * Resolve a parsed ref to a concrete docx document id. A wiki node is resolved
 * to its backing object via wiki/v2/spaces/get_node; only docx-backed nodes are
 * supported (a wiki node fronting a sheet/bitable isn't a document). Returns the
 * document id string or throws a clear error (caught + fail-softed upstream).
 */
async function resolveDocumentId(refOrParsed) {
  const parsed = typeof refOrParsed === 'string' ? parseLarkDocRef(refOrParsed) : refOrParsed;
  if (!parsed) throw new Error('A valid Lark doc id or URL is required');
  if (parsed.type === 'docx') return parsed.token;

  // Wiki node → resolve to the underlying object token.
  const { data } = await larkDocsApi(
    'GET',
    `/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(parsed.token)}`,
  );
  const node = data?.node || {};
  if (node.obj_type !== 'docx' || !node.obj_token) {
    const objType = node.obj_type || 'unknown';
    // A Base behind a wiki node is READABLE — just not here. Point at the tool
    // that can read it rather than leaving the caller with a bare type name.
    if (objType === 'bitable') {
      throw new Error(
        'This Lark wiki link is a Base / 多维表格 (obj_type=bitable), not a document — '
        + 'read it with larkbitable_read_records (larkbitable_list_tables lists its tables)',
      );
    }
    throw new Error(`Wiki node is not a docx document (obj_type=${objType})`);
  }
  return node.obj_token;
}

/**
 * Map a small, common subset of markdown into Lark Docx block objects.
 * Each block is a single line: headings (#/##/### → heading1/2/3), bullets
 * (- / *), ordered (1.), everything else a text paragraph. Inline marks are
 * kept as literal text (content is preserved; we don't emit Lark text-element
 * styles — honest + robust). Empty lines are skipped (Lark rejects empty text
 * blocks). Bounded by the caller's chunking to MAX_BLOCK_CHILDREN per request.
 */
export function markdownToLarkBlocks(markdown) {
  const source = String(markdown ?? '').replace(/\r\n/g, '\n');
  const blocks = [];
  for (const rawLine of source.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;

    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);

    let key;
    let blockType;
    let content;
    if (h) {
      const level = h[1].length; // 1..3
      key = `heading${level}`;
      blockType = 2 + level; // heading1=3, heading2=4, heading3=5
      content = h[2];
    } else if (ul) {
      key = 'bullet';
      blockType = 12;
      content = ul[1];
    } else if (ol) {
      key = 'ordered';
      blockType = 13;
      content = ol[1];
    } else {
      key = 'text';
      blockType = 2;
      content = line;
    }

    blocks.push({
      block_type: blockType,
      [key]: { elements: [{ text_run: { content } }], style: {} },
    });
  }
  return blocks;
}

/** The markdown OR text content arg — markdown wins when both are present. */
function contentArg(args) {
  const md = typeof args?.markdown === 'string' ? args.markdown : null;
  const txt = typeof args?.text === 'string' ? args.text : null;
  return md ?? txt;
}

/**
 * Append blocks to a doc root in ≤50-child chunks (Lark's per-request cap).
 * Returns the region host (from the API call) so the caller can build the doc
 * web URL without an extra request.
 */
async function appendBlocks(documentId, blocks) {
  let host;
  for (let i = 0; i < blocks.length; i += MAX_BLOCK_CHILDREN) {
    const chunk = blocks.slice(i, i + MAX_BLOCK_CHILDREN);
    // block == document_id == the document root; omitting `index` appends at
    // the end. document_revision_id=-1 targets the latest revision.
    const res = await larkDocsApi(
      'POST',
      `/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children?document_revision_id=-1`,
      { children: chunk },
    );
    host = res.host;
  }
  return host;
}

// ── Images (docx image block + drive media upload) ──────────────────────────
// Inserting a LOCAL image into a docx is a 3-step dance (verified against
// Lark's open docs: docx-v1 document-block/create + patch, drive-v1
// media/upload_all):
//   1. create an EMPTY image block as a child of the doc root:
//        POST /open-apis/docx/v1/documents/{id}/blocks/{id}/children
//        { children: [{ block_type: 27, image: {} }] }
//      → data.children[0].block_id (block_type 27 == image)
//   2. upload the file bytes to drive, parented on that block:
//        POST /open-apis/drive/v1/medias/upload_all  (multipart/form-data:
//        file_name, parent_type='docx_image', parent_node=<block_id>,
//        size=<bytes>, file=<binary>; ≤20MB) → data.file_token
//   3. bind the token to the block:
//        PATCH /open-apis/docx/v1/documents/{id}/blocks/{block_id}
//              ?document_revision_id=-1
//        { replace_image: { token, width?, height? } }  (width/height in px)

/**
 * Validate + read a local image file for upload. Throws a clear error
 * (caught + fail-softed by handleToolCall) on a missing path, a non-file,
 * an unsupported extension, or an oversize file.
 */
function readImageBytes(imagePath) {
  const p = typeof imagePath === 'string' ? imagePath.trim() : '';
  if (!p) throw new Error('imagePath is required');
  if (!existsSync(p) || !statSync(p).isFile()) {
    throw new Error(`imagePath not found (or not a file): ${p}`);
  }
  if (!/\.(png|jpe?g)$/i.test(p)) {
    throw new Error('imagePath must be a .png or .jpg/.jpeg file');
  }
  const bytes = readFileSync(p);
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`image is ${(bytes.length / (1024 * 1024)).toFixed(1)}MB — max 10MB`);
  }
  return bytes;
}

/**
 * Upload image bytes to Lark drive as a docx image (multipart/form-data).
 * A SEPARATE helper from larkDocsApi (which is JSON-only), but auth still
 * routes through getTenantAccessToken — the single chokepoint. Uses the
 * global FormData + Blob (Node 18+); fetch sets the multipart boundary.
 * Returns the drive file_token.
 */
async function larkUploadDocxImage({ fileName, parentNode, bytes }: any) {
  const { token, host } = await getTenantAccessToken();
  const form = new FormData();
  form.set('file_name', fileName);
  form.set('parent_type', 'docx_image');
  form.set('parent_node', parentNode);
  form.set('size', String(bytes.length));
  form.set('file', new Blob([bytes]), fileName);
  const res = await fetchWithDeadline(`${host}/open-apis/drive/v1/medias/upload_all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  }, { kind: 'transfer', what: 'Lark Docx image upload' });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`Lark media upload_all error: ${data.msg || data.code}`);
  }
  const fileToken = data.data?.file_token;
  if (!fileToken) throw new Error('Lark media upload_all returned no file_token');
  return fileToken;
}

// ── Comments (drive v1) ──────────────────────────────────────────────────────
// Lark's file-comment API is SEPARATE from the docx block API and is keyed on
// the drive `file_token` (for a docx the file_token == the document_id) plus a
// `file_type` query param. A docx document's file_type is 'docx'.
//   Create a NEW comment on a file:
//     POST /open-apis/drive/v1/files/{file_token}/comments?file_type=docx
//       { reply_list: { replies: [{ content: { elements: [text_run…] } }] } }
//   Reply to an EXISTING comment (thread):
//     POST /open-apis/drive/v1/files/{file_token}/comments/{comment_id}/replies?file_type=docx
//       { content: { elements: [text_run…] } }
//   List comments:
//     GET  /open-apis/drive/v1/files/{file_token}/comments?file_type=docx&page_size=50
const DEFAULT_FILE_TYPE = 'docx';
const MAX_COMMENTS = 50;

/** Build a Lark comment content element array from plain text. */
function larkCommentElements(text) {
  return [{ type: 'text_run', text_run: { text: String(text ?? '') } }];
}

/** Flatten a Lark comment content.elements array → plain text. */
function larkElementsToText(elements) {
  if (!Array.isArray(elements)) return '';
  return elements
    .map((e) => e?.text_run?.text ?? e?.docs_link?.url ?? (e?.person ? `@${e.person.user_id || ''}` : ''))
    .join('');
}

/** Summarize a Lark file comment (with its replies) for agent thread context. */
function larkCommentSummary(c) {
  const replies = Array.isArray(c?.reply_list?.replies) ? c.reply_list.replies : [];
  return {
    commentId: c?.comment_id || '',
    resolved: Boolean(c?.is_solved),
    replies: replies.map((r) => ({
      replyId: r?.reply_id || '',
      author: r?.user_id || '',
      text: larkElementsToText(r?.content?.elements),
      createTime: r?.create_time || '',
    })),
  };
}

/** The file_type query value — defaults to docx (our doc surface). */
function fileTypeArg(args) {
  const t = typeof args?.fileType === 'string' && args.fileType.trim() ? args.fileType.trim() : DEFAULT_FILE_TYPE;
  return t;
}

// ── Base / 多维表格 (bitable) ───────────────────────────────────────────────
// A Base is a SEPARATE object type from a docx — its own API family, its own
// scope (bitable:app:readonly), and its own coordinates (app token → table →
// view). The docx path deliberately refuses it; everything below is that
// second path, read-only.

/**
 * Derive the human-facing Base web URL (same region logic as docWebUrl).
 */
export function baseWebUrl(host, appToken, tableId?, viewId?) {
  const h = String(host || '');
  const root = h.includes('feishu') ? 'https://feishu.cn' : 'https://www.larksuite.com';
  const qs = new URLSearchParams();
  if (tableId) qs.set('table', tableId);
  if (viewId) qs.set('view', viewId);
  const query = qs.toString();
  return `${root}/base/${appToken}${query ? `?${query}` : ''}`;
}

/**
 * Resolve a parsed ref to Base coordinates { appToken, tableId, viewId }.
 * A /base/ link (and a bare token, which parseLarkDocRef types as 'docx'
 * because it cannot know better) already names the Base app. A /wiki/ link
 * names a NODE FRONTING the Base, so it is resolved through get_node — the
 * mirror of resolveDocumentId, which resolves the same node shape to a docx.
 * tableId/viewId are null rather than absent so one field keeps one type.
 */
async function resolveBitableRef(refOrParsed) {
  const parsed = typeof refOrParsed === 'string' ? parseLarkDocRef(refOrParsed) : refOrParsed;
  if (!parsed) throw new Error('A valid Lark Base id or URL is required');
  const coords = { tableId: parsed.tableId || null, viewId: parsed.viewId || null };

  if (parsed.type !== 'wiki') return { appToken: parsed.token, ...coords };

  const { data } = await larkDocsApi(
    'GET',
    `/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(parsed.token)}`,
  );
  const node = data?.node || {};
  if (node.obj_type !== 'bitable' || !node.obj_token) {
    // The symmetric counterpart of resolveDocumentId's bitable branch.
    if (node.obj_type === 'docx') {
      throw new Error(
        'This Lark wiki link is a document (obj_type=docx), not a Base / 多维表格 — read it with larkdoc_get',
      );
    }
    throw new Error(`Wiki node is not a Base / 多维表格 (obj_type=${node.obj_type || 'unknown'})`);
  }
  return { appToken: node.obj_token, ...coords };
}

/**
 * Flatten ONE Base cell to plain text. Bitable values are richly shaped —
 * text runs [{type,text}], people [{id,name,en_name,email}], links
 * {text,link}, attachments [{name,url}], locations {full_address}, formula
 * {value} — and a model reading a table wants the words, not the envelope.
 * ALWAYS returns a string: one field, one type, so a consumer never has to
 * branch on whether a cell came back as a number, an array, or an object.
 */
function bitableCellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(bitableCellText).filter((part) => part !== '').join(', ');
  }
  if (typeof value === 'object') {
    const o: any = value;
    // Most specific first — a person carries `name`, a link carries both
    // `text` and `link` (the text is what a reader wants).
    if (typeof o.text === 'string' && o.text) return o.text;
    if (typeof o.name === 'string' && o.name) return o.name;
    if (typeof o.en_name === 'string' && o.en_name) return o.en_name;
    if (typeof o.full_address === 'string' && o.full_address) return o.full_address;
    if (typeof o.link === 'string' && o.link) return o.link;
    if (o.value !== undefined) return bitableCellText(o.value);
    return JSON.stringify(o);
  }
  return String(value);
}

/**
 * Cell text with the field's declared type applied. Only date-shaped fields
 * need it: Lark returns them as epoch milliseconds, which is unreadable (and
 * un-reasonable-about) as a bare number. Everything else flattens generically.
 */
function bitableFieldText(value, fieldType) {
  if (BITABLE_DATE_FIELD_TYPES.has(Number(fieldType))) {
    const ms = Number(Array.isArray(value) ? value[0] : value);
    if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  }
  return bitableCellText(value);
}

/** List every table in a Base (paginated). Returns [{ tableId, name }]. */
async function listBitableTables(appToken) {
  const tables = [];
  let pageToken = null;
  for (let page = 0; page < MAX_BITABLE_PAGES; page++) {
    const qs = new URLSearchParams({ page_size: String(BITABLE_TABLES_PAGE_SIZE) });
    if (pageToken) qs.set('page_token', pageToken);
    const { data } = await larkDocsApi(
      'GET',
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables?${qs.toString()}`,
    );
    for (const t of (Array.isArray(data?.items) ? data.items : [])) {
      tables.push({ tableId: String(t?.table_id || ''), name: String(t?.name || '') });
    }
    if (!data?.has_more || !data?.page_token) break;
    pageToken = data.page_token;
  }
  return tables;
}

/** List a table's columns (paginated). Returns [{ name, type }]. */
async function listBitableFields(appToken, tableId) {
  const fields = [];
  let pageToken = null;
  for (let page = 0; page < MAX_BITABLE_PAGES; page++) {
    const qs = new URLSearchParams({ page_size: String(BITABLE_TABLES_PAGE_SIZE) });
    if (pageToken) qs.set('page_token', pageToken);
    const { data } = await larkDocsApi(
      'GET',
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields?${qs.toString()}`,
    );
    for (const f of (Array.isArray(data?.items) ? data.items : [])) {
      fields.push({ name: String(f?.field_name || ''), type: Number(f?.type) || 0 });
    }
    if (!data?.has_more || !data?.page_token) break;
    pageToken = data.page_token;
  }
  return fields;
}

/**
 * Settle which table to read. The table id is taken, in order, from the
 * caller's argument, then the Base URL's `table=` query, then — only when the
 * Base holds exactly ONE table — that table. An ambiguous Base is an ERROR
 * that NAMES the candidates, never a silent pick of the first one.
 */
async function pickBitableTable({ appToken, tableId }) {
  if (tableId) return tableId;
  const tables = await listBitableTables(appToken);
  if (tables.length === 1) return tables[0].tableId;
  if (!tables.length) throw new Error('This Lark Base has no tables');
  const listed = tables.map((t) => `${t.name} (${t.tableId})`).join('; ');
  throw new Error(`tableId is required — this Base has ${tables.length} tables: ${listed}`);
}

/**
 * Read records via bitable records/search, paging until maxRecords, the
 * character budget, or the end of the table. Returns the rows already
 * flattened, plus whether the read stopped early and where to resume.
 */
async function readBitableRecords({ appToken, tableId, viewId, fieldNames, maxRecords, pageToken }) {
  const columns = await listBitableFields(appToken, tableId);
  const typeByName = new Map(columns.map((c) => [c.name, c.type]));

  const records = [];
  let chars = 0;
  let cursor = pageToken || null;
  let hasMore = false;
  let total = 0;
  let truncated = false;

  for (let page = 0; page < MAX_BITABLE_PAGES; page++) {
    const qs = new URLSearchParams({ page_size: String(Math.min(BITABLE_PAGE_SIZE, maxRecords)) });
    if (cursor) qs.set('page_token', cursor);
    const { data } = await larkDocsApi(
      'POST',
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/search?${qs.toString()}`,
      {
        ...(viewId ? { view_id: viewId } : {}),
        ...(fieldNames?.length ? { field_names: fieldNames } : {}),
      },
    );
    total = Number(data?.total) || total;
    hasMore = Boolean(data?.has_more);
    cursor = data?.page_token || null;

    for (const item of (Array.isArray(data?.items) ? data.items : [])) {
      const fields = {};
      for (const [name, value] of Object.entries(item?.fields || {})) {
        fields[name] = bitableFieldText(value, typeByName.get(name));
      }
      const row = { recordId: String(item?.record_id || ''), fields };
      // Budget in serialized characters — a table is wide as well as long, so
      // a row count alone can't keep the payload inside the prompt.
      const size = JSON.stringify(row).length;
      if (records.length && chars + size > MAX_BITABLE_CHARS) {
        truncated = true;
        break;
      }
      chars += size;
      records.push(row);
      if (records.length >= maxRecords) break;
    }

    if (truncated || records.length >= maxRecords || !hasMore || !cursor) break;
  }

  // `hasMore` describes the TABLE (Lark's own flag); `truncated` describes OUR
  // read stopping on the character budget. Deliberately NOT `records.length <
  // total`: `total` counts the whole table while a filtered VIEW returns fewer
  // rows, so that comparison would claim more pages exist with no cursor to
  // fetch them — a caller that trusts it loops forever.
  return {
    columns,
    records,
    total,
    hasMore: (hasMore || truncated) && Boolean(cursor),
    nextPageToken: cursor || '',
    truncated,
  };
}

export const larkDocsSkill: any = {
  id: 'lark-docs',
  // Backend-calling: the MCP child talks to Zibby's own backend — the
  // session-env contract is guaranteed by backendSession.ts at registration
  // (declare ONCE here; see backend-session-env-contract.test.ts).
  callsBackend: true,
  serverName: 'larkdocs',
  allowedTools: ['mcp__larkdocs__*'],
  // The DOCS app is the declared requirement (matches backend
  // skill-integrations.js `'lark-docs' → lark_docs`); the CHAT app is accepted
  // as the single-app fallback because resolveLarkApp() really does fall
  // back to it. An ARRAY means "any ONE of these" to both availability gates
  // (agent-workflow strategy-registry + core strategies), so an account with
  // only the docs app connected keeps the prompt fragment it used to lose.
  requiresIntegration: [INTEGRATIONS.LARK_DOCS, INTEGRATIONS.LARK],
  description: 'Lark / Feishu Docs — read, create, append, and insert images into Lark documents (docx), and read Lark Bases (多维表格 / bitable).',
  // resolveLarkApp() reads the injected LARK_DOCS_*/LARK_* app creds and,
  // failing that, calls OUR OWN backend for them (Lark mints a tenant token
  // from app_id+secret — no single-bearer self-host fast path exists). envKeys
  // IS the spawned MCP child's ENTIRE environment, so BOTH halves must be
  // listed: the app-credential env (or the child never sees what the executor
  // injected and always pays the backend round-trip) AND the session
  // credential that round-trip authenticates with (or the child dies with the
  // misleading CLI-era "No session token. Run `zibby login` first." — 3rd
  // occurrence of that trap; github/gitlab hit it the same way). The app-cred
  // half is DERIVED from the resolution order itself, never a second hand-kept
  // list. Deliberately an ALLOWLIST: no ANTHROPIC_API_KEY / AWS creds reach it.
  envKeys: ['PROJECT_API_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_ENV', ...LARK_DOCS_APP_ENV_KEYS],

  promptFragment: `## Lark Docs
You can read, create, and append Lark/Feishu documents (docx), read/post/reply to their comments, and READ Lark Bases (多维表格 / bitable). This runs on the connected Lark Docs app (the chat app is used when no separate docs app is connected). Each \`larkdoc_*\` / \`larkwiki_*\` / \`larkbitable_*\` tool documents its own params and return shape in its tool description — they are not restated here.
A Lark link is not always a document: a \`/base/…\` link, or a \`/wiki/…\` link carrying \`?table=tbl…\`, is a Base — read it with \`larkbitable_read_records\`, NOT \`larkdoc_get\` (which refuses it, since a Base has no document body). Base reads need the \`bitable:app:readonly\` scope on the connected app.
These tools return { ok:false, error } on failure — treat an unavailable Lark connection as "cannot read/deliver to Lark Docs" and continue rather than blocking the task.`,

  /**
   * Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs) pointing at this
   * module's larkDocsSkill export, so the AGENT gets real mcp__larkdocs__*
   * tools. The child does NOT inherit the run env — the env returned here is
   * its ENTIRE environment, so the backend-session allowlist (envKeys) MUST be
   * forwarded or resolveLarkApp() dies inside the child with a
   * misleading session error. (The 0.2.7 fix declared envKeys but this
   * resolve() still returned env:{} — the drift the
   * backend-session-env-contract test now pins.) When unconnected,
   * handleToolCall returns { ok:false, error }.
   */
  resolve() {
    const bin = resolveSkillBin();
    if (!bin) return null;
    const env: any = {};
    for (const key of this.envKeys) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/larkDocs.js', 'larkDocsSkill'],
      env,
      description: this.description,
      // NO `alwaysLoad`: the SDK defers MCP tools behind ToolSearch by design and
      // ToolSearch reaches them — measured, see MCP_TOOL_LOADING.md.
    };
  },

  async handleToolCall(name, args) {
    try {
      switch (name) {
        case 'larkdoc_get': {
          const ref = args?.documentId || args?.url || args?.id;
          const parsed = parseLarkDocRef(ref);
          if (!parsed) return JSON.stringify({ ok: false, error: 'A valid Lark doc id or URL is required' });

          const documentId = await resolveDocumentId(parsed);

          // Title (best-effort — a raw_content read is the primary payload).
          let title = '';
          try {
            const meta = await larkDocsApi('GET', `/open-apis/docx/v1/documents/${documentId}`);
            title = meta.data?.document?.title || '';
          } catch {
            // Non-fatal — continue with the content.
          }

          const { data, host } = await larkDocsApi(
            'GET',
            `/open-apis/docx/v1/documents/${documentId}/raw_content?lang=0`,
          );
          let text = String(data?.content || '');
          let truncated = false;
          if (text.length > MAX_TEXT_CHARS) {
            text = text.slice(0, MAX_TEXT_CHARS);
            truncated = true;
          }
          return JSON.stringify({
            ok: true,
            documentId,
            title,
            url: docWebUrl(host, documentId),
            text,
            ...(truncated ? { truncated: true } : {}),
          });
        }

        case 'larkdoc_create': {
          const title = typeof args?.title === 'string' && args.title.trim()
            ? args.title.trim()
            : null;
          if (!title) return JSON.stringify({ ok: false, error: 'title is required' });

          // Wiki path: create the docx AS a wiki node (space / optional parent),
          // then write the content into its backing docx exactly like the
          // standalone path. Absent wikiSpaceId → the standalone path below,
          // byte-identical to the previous behavior.
          const wikiSpaceId = typeof args?.wikiSpaceId === 'string' && args.wikiSpaceId.trim()
            ? args.wikiSpaceId.trim()
            : null;
          if (wikiSpaceId) {
            const parentNodeToken = typeof args?.parentNodeToken === 'string' && args.parentNodeToken.trim()
              ? args.parentNodeToken.trim()
              : null;
            const { data, host } = await larkDocsApi(
              'POST',
              `/open-apis/wiki/v2/spaces/${encodeURIComponent(wikiSpaceId)}/nodes`,
              {
                obj_type: 'docx',
                node_type: 'origin',
                title,
                ...(parentNodeToken ? { parent_node_token: parentNodeToken } : {}),
              },
            );
            const node = data?.node || {};
            const documentId = node.obj_token;
            if (!documentId) {
              return JSON.stringify({ ok: false, error: 'Lark wiki node create returned no obj_token' });
            }

            const content = contentArg(args);
            if (content && content.trim()) {
              const blocks = markdownToLarkBlocks(content);
              if (blocks.length) await appendBlocks(documentId, blocks);
            }
            return JSON.stringify({
              ok: true,
              documentId,
              title,
              wikiSpaceId,
              wikiNodeToken: node.node_token || '',
              // Share the wiki-node URL (opens the doc in its wiki context);
              // fall back to the raw docx URL if Lark returned no node_token.
              url: node.node_token ? wikiWebUrl(host, node.node_token) : docWebUrl(host, documentId),
            });
          }

          const { data, host } = await larkDocsApi('POST', '/open-apis/docx/v1/documents', {
            title,
            ...(args?.folderToken ? { folder_token: String(args.folderToken) } : {}),
          });
          const documentId = data?.document?.document_id;
          if (!documentId) {
            return JSON.stringify({ ok: false, error: 'Lark Docs create returned no document_id' });
          }

          const content = contentArg(args);
          if (content && content.trim()) {
            const blocks = markdownToLarkBlocks(content);
            if (blocks.length) await appendBlocks(documentId, blocks);
          }
          return JSON.stringify({ ok: true, documentId, title, url: docWebUrl(host, documentId) });
        }

        case 'larkdoc_append': {
          const ref = args?.documentId || args?.url || args?.id;
          const parsed = parseLarkDocRef(ref);
          if (!parsed) return JSON.stringify({ ok: false, error: 'A valid Lark doc id or URL is required' });
          const content = contentArg(args);
          if (!content || !content.trim()) {
            return JSON.stringify({ ok: false, error: 'markdown or text content is required' });
          }

          const documentId = await resolveDocumentId(parsed);
          const blocks = markdownToLarkBlocks(content);
          if (!blocks.length) {
            return JSON.stringify({ ok: false, error: 'no non-empty content to append' });
          }
          const host = await appendBlocks(documentId, blocks);
          return JSON.stringify({ ok: true, documentId, url: docWebUrl(host, documentId) });
        }

        case 'larkdoc_insert_image': {
          const ref = args?.documentId || args?.url || args?.id;
          const parsed = parseLarkDocRef(ref);
          if (!parsed) return JSON.stringify({ ok: false, error: 'A valid Lark doc id or URL is required' });
          if (!args?.imagePath || typeof args.imagePath !== 'string' || !args.imagePath.trim()) {
            return JSON.stringify({ ok: false, error: 'imagePath is required' });
          }

          const documentId = await resolveDocumentId(parsed);
          const imagePath = args.imagePath.trim();
          const bytes = readImageBytes(imagePath);
          const fileName = basename(imagePath);

          // 1. Empty image block appended at the end of the doc root.
          const created = await larkDocsApi(
            'POST',
            `/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children?document_revision_id=-1`,
            { children: [{ block_type: 27, image: {} }] },
          );
          const blockId = created.data?.children?.[0]?.block_id;
          if (!blockId) {
            return JSON.stringify({ ok: false, error: 'Lark image block create returned no block_id' });
          }

          // 2. Upload the bytes, parented on the new block.
          const fileToken = await larkUploadDocxImage({ fileName, parentNode: blockId, bytes });

          // 3. Bind the uploaded file to the block (optional px dimensions).
          const replaceImage: any = { token: fileToken };
          const width = Number(args?.width);
          const height = Number(args?.height);
          if (Number.isFinite(width) && width > 0) replaceImage.width = Math.round(width);
          if (Number.isFinite(height) && height > 0) replaceImage.height = Math.round(height);
          const { host } = await larkDocsApi(
            'PATCH',
            `/open-apis/docx/v1/documents/${documentId}/blocks/${blockId}?document_revision_id=-1`,
            { replace_image: replaceImage },
          );

          return JSON.stringify({
            ok: true, documentId, blockId, fileToken, url: docWebUrl(host, documentId),
          });
        }

        case 'larkwiki_list_spaces': {
          const spaces = [];
          let pageToken = null;
          for (let page = 0; page < MAX_WIKI_SPACE_PAGES; page++) {
            const qs = new URLSearchParams({ page_size: String(WIKI_SPACES_PAGE_SIZE) });
            if (pageToken) qs.set('page_token', pageToken);
            const { data } = await larkDocsApi('GET', `/open-apis/wiki/v2/spaces?${qs.toString()}`);
            const items = Array.isArray(data?.items) ? data.items : [];
            for (const s of items) {
              spaces.push({ spaceId: String(s?.space_id || ''), name: String(s?.name || '') });
            }
            if (!data?.has_more || !data?.page_token) break;
            pageToken = data.page_token;
          }
          return JSON.stringify({ ok: true, count: spaces.length, spaces });
        }

        case 'larkbitable_list_tables': {
          const ref = args?.baseId || args?.url || args?.documentId || args?.id;
          const parsed = parseLarkDocRef(ref);
          if (!parsed) return JSON.stringify({ ok: false, error: 'A valid Lark Base id or URL is required' });

          const { appToken, tableId, viewId } = await resolveBitableRef(parsed);
          const tables = await listBitableTables(appToken);

          // Base name is best-effort — the table list is the payload.
          let name = '';
          let host = '';
          try {
            const meta = await larkDocsApi('GET', `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}`);
            name = meta.data?.app?.name || '';
            host = meta.host;
          } catch {
            // Non-fatal — continue without the Base title.
          }

          return JSON.stringify({
            ok: true,
            appToken,
            name,
            ...(host ? { url: baseWebUrl(host, appToken, tableId, viewId) } : {}),
            // Echo back what the LINK already pinned, so the caller can pass it
            // straight to larkbitable_read_records instead of guessing.
            ...(tableId ? { linkedTableId: tableId } : {}),
            ...(viewId ? { linkedViewId: viewId } : {}),
            count: tables.length,
            tables,
          });
        }

        case 'larkbitable_read_records': {
          const ref = args?.baseId || args?.url || args?.documentId || args?.id;
          const parsed = parseLarkDocRef(ref);
          if (!parsed) return JSON.stringify({ ok: false, error: 'A valid Lark Base id or URL is required' });

          const resolved = await resolveBitableRef(parsed);
          const appToken = resolved.appToken;
          // Explicit arg wins over the link's own coordinates.
          const tableId = await pickBitableTable({
            appToken,
            tableId: (typeof args?.tableId === 'string' && args.tableId.trim())
              ? args.tableId.trim()
              : resolved.tableId,
          });
          const viewId = (typeof args?.viewId === 'string' && args.viewId.trim())
            ? args.viewId.trim()
            : resolved.viewId;
          const fieldNames = Array.isArray(args?.fieldNames)
            ? args.fieldNames.map((f) => String(f)).filter(Boolean)
            : null;
          const requested = Number(args?.maxRecords);
          const maxRecords = Number.isFinite(requested) && requested > 0
            ? Math.min(Math.round(requested), MAX_BITABLE_RECORDS)
            : DEFAULT_BITABLE_RECORDS;
          const pageToken = (typeof args?.pageToken === 'string' && args.pageToken.trim())
            ? args.pageToken.trim()
            : null;

          const read = await readBitableRecords({
            appToken, tableId, viewId, fieldNames, maxRecords, pageToken,
          });
          const { host } = await getTenantAccessToken();

          // Base name is best-effort — the rows are the payload. Same shape as
          // larkdoc_get's title read: a caller that wants to LABEL what it read
          // shouldn't need a second tool call to get a name.
          let name = '';
          try {
            const meta = await larkDocsApi('GET', `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}`);
            name = meta.data?.app?.name || '';
          } catch {
            // Non-fatal — continue without the Base title.
          }

          return JSON.stringify({
            ok: true,
            appToken,
            name,
            tableId,
            ...(viewId ? { viewId } : {}),
            url: baseWebUrl(host, appToken, tableId, viewId),
            total: read.total,
            count: read.records.length,
            columns: read.columns,
            records: read.records,
            hasMore: read.hasMore,
            ...(read.nextPageToken ? { nextPageToken: read.nextPageToken } : {}),
            ...(read.truncated ? { truncated: true } : {}),
          });
        }

        case 'larkdoc_list_comments': {
          const ref = args?.documentId || args?.url || args?.id || args?.fileToken;
          const parsed = parseLarkDocRef(ref);
          if (!parsed) return JSON.stringify({ ok: false, error: 'A valid Lark doc id or URL is required' });
          const documentId = await resolveDocumentId(parsed);
          const fileType = fileTypeArg(args);

          const qs = new URLSearchParams({ file_type: fileType, page_size: String(MAX_COMMENTS) });
          const { data } = await larkDocsApi(
            'GET',
            `/open-apis/drive/v1/files/${documentId}/comments?${qs.toString()}`,
          );
          const items = Array.isArray(data?.items) ? data.items : [];
          const comments = items.map(larkCommentSummary);
          return JSON.stringify({ ok: true, documentId, count: comments.length, comments });
        }

        case 'larkdoc_add_comment': {
          const ref = args?.documentId || args?.url || args?.id || args?.fileToken;
          const parsed = parseLarkDocRef(ref);
          if (!parsed) return JSON.stringify({ ok: false, error: 'A valid Lark doc id or URL is required' });
          const text = contentArg({ text: args?.text ?? args?.body });
          if (!text || !text.trim()) return JSON.stringify({ ok: false, error: 'text is required' });

          const documentId = await resolveDocumentId(parsed);
          const fileType = fileTypeArg(args);
          const { data } = await larkDocsApi(
            'POST',
            `/open-apis/drive/v1/files/${documentId}/comments?file_type=${encodeURIComponent(fileType)}`,
            { reply_list: { replies: [{ content: { elements: larkCommentElements(text) } }] } },
          );
          return JSON.stringify({ ok: true, documentId, commentId: data?.comment_id || '' });
        }

        case 'larkdoc_reply_comment': {
          const ref = args?.documentId || args?.url || args?.id || args?.fileToken;
          const parsed = parseLarkDocRef(ref);
          if (!parsed) return JSON.stringify({ ok: false, error: 'A valid Lark doc id or URL is required' });
          const commentId = args?.commentId || args?.comment_id;
          if (!commentId) return JSON.stringify({ ok: false, error: 'commentId is required' });
          const text = contentArg({ text: args?.text ?? args?.body });
          if (!text || !text.trim()) return JSON.stringify({ ok: false, error: 'text is required' });

          const documentId = await resolveDocumentId(parsed);
          const fileType = fileTypeArg(args);
          const { data } = await larkDocsApi(
            'POST',
            `/open-apis/drive/v1/files/${documentId}/comments/${encodeURIComponent(commentId)}/replies?file_type=${encodeURIComponent(fileType)}`,
            { content: { elements: larkCommentElements(text) } },
          );
          return JSON.stringify({ ok: true, documentId, commentId: String(commentId), replyId: data?.reply_id || '' });
        }

        default:
          return JSON.stringify({ ok: false, error: `Unknown tool: ${name}` });
      }
    } catch (e) {
      // NEVER throw — a broken/missing Lark connection must not crash the caller.
      return JSON.stringify({ ok: false, error: e.message });
    }
  },

  tools: [
    {
      name: 'larkdoc_get',
      description: 'Read a Lark/Feishu document (docx) as plain text, for use as reference context. Accepts a raw doc id OR a full Lark doc URL (a /docx/ or /wiki/ link — wiki links are resolved to their backing docx). Returns { ok, documentId, title, url, text }. Text is truncated to ~20k chars.',
      input_schema: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'Lark doc id (docx token) OR a full Lark/Feishu doc URL (/docx/… or /wiki/…).' },
        },
        required: ['documentId'],
      },
    },
    {
      name: 'larkdoc_create',
      description: 'Create a new Lark/Feishu document (docx) with a title and optional content (markdown: #/##/### headings, - bullets, 1. ordered; or plain text). Pass wikiSpaceId (from larkwiki_list_spaces) to create the doc INSIDE a wiki space instead of as a standalone doc — optionally nested under parentNodeToken. Returns { ok, documentId, url } (plus wikiNodeToken when created in a wiki) — share the url with the user.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Document title.' },
          markdown: { type: 'string', description: 'Document body as markdown (preferred).' },
          text: { type: 'string', description: 'Document body as plain text (used when markdown is absent).' },
          folderToken: { type: 'string', description: 'Optional Lark drive folder token to create the doc in. Absent = the app root. Ignored when wikiSpaceId is set.' },
          wikiSpaceId: { type: 'string', description: 'Optional wiki space id (from larkwiki_list_spaces) — create the doc as a node inside this wiki space.' },
          parentNodeToken: { type: 'string', description: 'Optional wiki node token to nest the new doc under (only with wikiSpaceId). Absent = the space root.' },
        },
        required: ['title'],
      },
    },
    {
      name: 'larkwiki_list_spaces',
      description: 'List the Lark/Feishu wiki spaces visible to the connected app. Returns { ok, count, spaces:[{ spaceId, name }] }. Use to discover the wikiSpaceId for larkdoc_create.',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'larkdoc_append',
      description: 'Append markdown/text content to the END of an existing Lark/Feishu document (docx). Accepts a documentId or a full Lark doc URL. Returns { ok, documentId, url }.',
      input_schema: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'Lark doc id (docx token) OR a full Lark/Feishu doc URL.' },
          markdown: { type: 'string', description: 'Content to append, as markdown (preferred).' },
          text: { type: 'string', description: 'Content to append, as plain text (used when markdown is absent).' },
        },
        required: ['documentId'],
      },
    },
    {
      name: 'larkdoc_insert_image',
      description: 'Append a LOCAL image file (png/jpg, max 10MB) to the END of an existing Lark/Feishu document (docx). Accepts a documentId or full doc URL plus a local file path. Optional width/height in pixels. Returns { ok, documentId, blockId, fileToken, url }.',
      input_schema: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'Lark doc id (docx token) OR a full Lark/Feishu doc URL.' },
          imagePath: { type: 'string', description: 'Local filesystem path to a .png or .jpg/.jpeg image (max 10MB).' },
          width: { type: 'number', description: 'Optional display width in pixels.' },
          height: { type: 'number', description: 'Optional display height in pixels.' },
        },
        required: ['documentId', 'imagePath'],
      },
    },
    {
      name: 'larkbitable_list_tables',
      description: "List the tables in a Lark/Feishu Base (多维表格 / bitable). Accepts a Base URL (a /base/… link, or a /wiki/… link whose node IS a Base) or a raw app token. Returns { ok, appToken, name, tables:[{ tableId, name }] } plus linkedTableId/linkedViewId when the URL pinned them. A Base is NOT a document — larkdoc_get cannot read one; use this and larkbitable_read_records instead.",
      input_schema: {
        type: 'object',
        properties: {
          baseId: { type: 'string', description: 'Lark Base app token OR a full Base/wiki URL (/base/… or /wiki/…).' },
        },
        required: ['baseId'],
      },
    },
    {
      name: 'larkbitable_read_records',
      description: "Read the rows of one table in a Lark/Feishu Base (多维表格 / bitable) as flat text. Accepts a Base URL (/base/… or a /wiki/… link fronting a Base) or app token; the table and view are taken from the URL's table=/view= when present, and tableId may be omitted when the Base has exactly one table. Optionally restrict to viewId or fieldNames. Returns { ok, appToken, name, tableId, total, count, columns:[{name,type}], records:[{ recordId, fields:{ <column>: <text> } }], hasMore, nextPageToken }. Every cell is a STRING (dates as ISO). Defaults to 200 records; pass maxRecords (max 1000) and pageToken to page through a bigger table.",
      input_schema: {
        type: 'object',
        properties: {
          baseId: { type: 'string', description: 'Lark Base app token OR a full Base/wiki URL (/base/… or /wiki/…).' },
          tableId: { type: 'string', description: 'Table id (tbl…). Optional when the URL carries table= or the Base has exactly one table; larkbitable_list_tables lists them.' },
          viewId: { type: 'string', description: 'Optional view id (vew…) — restricts the read to that view\'s rows and order.' },
          fieldNames: { type: 'array', items: { type: 'string' }, description: 'Optional column names to return. Absent = every column.' },
          maxRecords: { type: 'number', description: 'Max records to return (default 200, hard cap 1000).' },
          pageToken: { type: 'string', description: 'Resume token from a previous call\'s nextPageToken.' },
        },
        required: ['baseId'],
      },
    },
    {
      name: 'larkdoc_list_comments',
      description: 'List the comment threads on a Lark/Feishu document. Accepts a documentId or full doc URL. Returns { ok, comments:[{ commentId, replies:[{ replyId, author, text }] }] }. Use to read the thread you are replying to.',
      input_schema: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'Lark doc id (docx token) OR a full Lark/Feishu doc URL.' },
          fileType: { type: 'string', description: "Drive file type — defaults to 'docx'. Only change for non-docx files (doc/sheet/bitable/file/slides)." },
        },
        required: ['documentId'],
      },
    },
    {
      name: 'larkdoc_add_comment',
      description: 'Post a NEW top-level comment on a Lark/Feishu document. Accepts a documentId or full doc URL plus text. Returns { ok, documentId, commentId }.',
      input_schema: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'Lark doc id (docx token) OR a full Lark/Feishu doc URL.' },
          text: { type: 'string', description: 'The comment body (plain text).' },
          fileType: { type: 'string', description: "Drive file type — defaults to 'docx'." },
        },
        required: ['documentId', 'text'],
      },
    },
    {
      name: 'larkdoc_reply_comment',
      description: 'Reply INSIDE an existing comment thread on a Lark/Feishu document. Pass { documentId, commentId, text }. Use to answer a user who @mentioned Zibby in a doc comment (reply in the same commentId). Returns { ok, documentId, commentId, replyId }.',
      input_schema: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'Lark doc id (docx token) OR a full Lark/Feishu doc URL.' },
          commentId: { type: 'string', description: 'The comment_id of the thread to reply into (from larkdoc_list_comments or the webhook event).' },
          text: { type: 'string', description: 'The reply body (plain text).' },
          fileType: { type: 'string', description: "Drive file type — defaults to 'docx'." },
        },
        required: ['documentId', 'commentId', 'text'],
      },
    },
  ],
};

// Test-only: lets vitest reset the token cache between cases.
export function _resetLarkDocsTokenCache() {
  tokenCache = null;
}
