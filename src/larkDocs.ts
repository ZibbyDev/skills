/**
 * Lark / Feishu Docs skill — read / create / append Lark Docx documents.
 *
 * The document-world twin of googleDocs.js + notion.js, but for Lark/Feishu.
 * It REUSES the already-connected Lark app (integration `lark`) — the SAME
 * app that powers lark.js messaging — so there is nothing new to connect: the
 * app just needs the docx (+ optional wiki/drive) scopes added in the Lark
 * developer console. Auth is minted EXACTLY like lark.js:
 *   resolveIntegrationToken('lark') → { appId, appSecret, host } →
 *   tenant_access_token (cached ~2h) → Bearer on every Docx call.
 *
 * Design rules (mirrors notion.js / googleDocs.js):
 *   - resolveIntegrationToken('lark') is the SINGLE auth chokepoint (via the
 *     larkDocsApi() helper). Don't re-resolve at call sites.
 *   - handleToolCall() dispatches the tools and NEVER throws — any HTTP or
 *     parse failure is returned as { ok:false, error } so a missing/broken
 *     Lark connection can't crash the run.
 *   - Region-aware host: whatever resolveIntegrationToken('lark') returns as
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
 * Wiki v2 API (write support — requires wiki:node:create / wiki:space:read):
 *   GET  /open-apis/wiki/v2/spaces?page_size=50[&page_token]   → { items:[{space_id,name}], has_more, page_token }
 *   POST /open-apis/wiki/v2/spaces/{space_id}/nodes            → { node:{node_token,obj_token,obj_type} }
 *        (obj_type='docx', node_type='origin', optional parent_node_token)
 */

import { existsSync, statSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { basename, dirname, resolve as resolvePath } from 'path';
import { resolveIntegrationToken } from '@zibby/core/backend-client.js';
import { INTEGRATIONS } from './integrations.js';

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
// Cap on uploaded image size. Lark's drive upload_all hard cap is 20MB
// (validation max 20971520 bytes); we stay at 10MB so a report chart can
// never bump the platform limit.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// Lark's tenant_access_token TTL is ~2h. Cache slightly under that. This is a
// SEPARATE cache from lark.js (each module gets its own) — same pattern as
// bin/mcp-lark.mjs duplicating the mint locally.
const TOKEN_TTL_MS = 100 * 60 * 1000;
let tokenCache = null; // { token, expiresAt, appId }

async function getTenantAccessToken() {
  const { appId, appSecret, host } = await resolveIntegrationToken('lark');
  if (tokenCache && tokenCache.appId === appId && tokenCache.expiresAt > Date.now()) {
    return { token: tokenCache.token, host };
  }
  const res = await fetch(`${host}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
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
  const res = await fetch(`${host}${path}`, init);
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
 * Parse a Lark/Feishu doc reference (raw token OR URL) into { type, token }.
 *   - .../docx/<token>  → { type:'docx', token }
 *   - .../wiki/<token>  → { type:'wiki', token } (resolved to its docx obj_token)
 *   - bare token        → { type:'docx', token }
 * Returns null when nothing usable can be extracted. Pure + side-effect-free.
 */
export function parseLarkDocRef(ref) {
  if (!ref || typeof ref !== 'string') return null;
  const input = ref.trim();
  if (!input) return null;

  // URL form: pull the segment right after /docx/ or /wiki/ (strip query/hash).
  const m = input.match(/\/(docx|wiki)\/([A-Za-z0-9]+)/);
  if (m) return { type: m[1], token: m[2] };

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
    throw new Error(`Wiki node is not a docx document (obj_type=${node.obj_type || 'unknown'})`);
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
  const res = await fetch(`${host}/open-apis/drive/v1/medias/upload_all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
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

export const larkDocsSkill: any = {
  id: 'lark-docs',
  serverName: 'larkdocs',
  allowedTools: ['mcp__larkdocs__*'],
  requiresIntegration: INTEGRATIONS.LARK, // reuses the connected Lark app (docx scopes)
  description: 'Lark / Feishu Docs — read, create, append, and insert images into Lark documents (docx).',
  // resolveIntegrationToken('lark') calls OUR OWN backend for the app creds
  // (Lark mints a tenant token from app_id+secret — no single-bearer self-host
  // fast path exists). envKeys IS the spawned MCP child's ENTIRE environment,
  // so the session credential that call authenticates with MUST be listed or
  // the child dies with the misleading CLI-era "No session token. Run `zibby
  // login` first." (3rd occurrence of this trap — github/gitlab hit it the
  // same way; same allowlist artifactSkill uses). Deliberately an ALLOWLIST:
  // no ANTHROPIC_API_KEY / AWS creds reach the child.
  envKeys: ['PROJECT_API_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_ENV'],

  promptFragment: `## Lark Docs
You can read, create, and append Lark/Feishu documents (docx). This reuses the same connected Lark app as messaging.
- larkdoc_get: pass a Lark doc id OR a full doc URL (a /docx/ or /wiki/ link); returns { ok, documentId, title, url, text } where text is the doc as plain text (truncated to ~20k chars). Use it as reference context.
- larkdoc_create: create a new doc from a title + markdown/text (#/##/### headings, - bullets, 1. ordered supported); returns { ok, documentId, url }. Share the url. To create the doc INSIDE a wiki space, first call larkwiki_list_spaces to find the space id, then pass wikiSpaceId (+ optional parentNodeToken to nest under a wiki node) — the doc is created as a wiki node and the returned url is the wiki link.
- larkwiki_list_spaces: list the wiki spaces the connected Lark app can see; returns { ok, spaces:[{ spaceId, name }] }. Use it to discover the wikiSpaceId before larkdoc_create.
- larkdoc_append: append markdown/text to the end of an existing doc (pass the documentId or doc URL).
- larkdoc_insert_image: append a LOCAL image file (png/jpg, ≤10MB) to the end of a doc — pass { documentId, imagePath, width?, height? } (width/height in px, optional). Returns { ok, documentId, blockId, url }. Use this to deliver a rendered chart/report image into the doc.
- larkdoc_list_comments: list the comment threads on a doc (pass the documentId or doc URL); returns { ok, comments:[{ commentId, replies:[{ replyId, author, text }] }] }. Use to read the thread you are replying to.
- larkdoc_reply_comment: reply INSIDE an existing comment thread — pass { documentId, commentId, text }. Use this to answer a user who @mentioned Zibby in a doc comment (reply in the SAME commentId).
- larkdoc_add_comment: post a NEW top-level comment on a doc — pass { documentId, text }.
These tools return { ok:false, error } on failure — treat an unavailable Lark connection as "cannot read/deliver to Lark Docs" and continue rather than blocking the task.`,

  /**
   * Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs) pointing at this
   * module's larkDocsSkill export, so the AGENT gets real mcp__larkdocs__*
   * tools. The child does NOT inherit the run env — the env returned here is
   * its ENTIRE environment, so the backend-session allowlist (envKeys) MUST be
   * forwarded or resolveIntegrationToken('lark') dies inside the child with a
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
      // Force tools into the system prompt instead of deferring behind the
      // SDK's ToolSearch (see notion.js / googleDocs.js resolve()).
      alwaysLoad: true,
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
