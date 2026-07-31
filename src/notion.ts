/**
 * Notion skill — read context + write pages/blocks/images.
 *
 * Historically read-only (pull a page/database as markdown context for a
 * downstream agent, e.g. a code-review agent reading an
 * engineering-standards page). It now ALSO delivers content: create pages,
 * append blocks, and insert images — the Notion twin of googleDocs.js /
 * larkDocs.js for the report-delivery channels.
 *
 * Modelled on jira.js:
 *   - resolveIntegrationToken('notion') is the SINGLE auth chokepoint
 *     (via the notionApi() helper below). Don't re-resolve at call sites.
 *   - handleToolCall() dispatches the tools and NEVER throws — any HTTP
 *     or parse failure is returned as { ok:false, error } so an optional
 *     context source can't crash the review.
 *
 * Token shape (GET /integrations/token/notion → resolveIntegrationToken):
 *   { provider:'notion', token, workspaceId, workspaceName, botId, expiresInSec }
 * We only need `token` here — it's a long-lived Notion bearer (no refresh).
 *
 * Served over MCP via the generic bin/mcp-skill.mjs (resolve() below) so
 * the agent gets real mcp__notion__* tools; deterministic node code can
 * also call handleToolCall directly, same as jira/slack.
 */

import { existsSync, statSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { basename, dirname, resolve as resolvePath } from 'path';
import { resolveIntegrationToken, clearTokenCache } from '@zibby/core/backend-client.js';
import { INTEGRATIONS } from './integrations.js';

/**
 * Resolve the generic skill MCP server binary (bin/mcp-skill.mjs), derived
 * from import.meta.url so it works in src/, dist/, and a published install.
 * See linear.js / github.js for the full rationale.
 */
function resolveSkillBin() {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

// Current stable Notion API version. Notion requires this header on every
// request; the value pins the response schema (block/property shapes).
// VERIFIED: the File Upload API (POST /v1/file_uploads + .../send) GA'd
// May 2025 under this same version — contemporary examples used
// Notion-Version 2022-06-28 — so image uploads work without bumping it.
const NOTION_VERSION = '2022-06-28';
const NOTION_BASE = 'https://api.notion.com/v1';

// Cap on flattened text so a large page can't blow the prompt budget.
const MAX_TEXT_CHARS = 20000;
// Cap on rows returned by notion_query_database.
const MAX_DB_ROWS = 25;
// Hard ceiling on block-children pagination so a huge page can't loop forever.
const MAX_BLOCK_PAGES = 25;
// Notion caps `children` at 100 blocks per request (pages.create AND
// blocks.children.append) — longer bodies are chunked across requests.
const MAX_CHILDREN_PER_REQUEST = 100;
// Hard bound on the total blocks accepted by one write call.
const MAX_WRITE_BLOCKS = 500;
// Notion's single_part file-upload cap is 20MB.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Extract a 32-char Notion id from a raw id OR a Notion URL.
 *
 * Notion ids are 32 hex chars, usually rendered dashed
 * (8-4-4-4-12) as a UUID. In URLs they appear undashed, often as the
 * trailing segment after a human slug, e.g.
 *   https://www.notion.so/My-Page-Title-1a2b3c...d4e5  (32 hex at end)
 *   https://www.notion.so/workspace/1a2b...d4e5?pvs=4
 * and may also be passed as a bare dashed UUID or undashed 32-char id.
 *
 * Returns the dashed UUID form (which the Notion REST API accepts), or
 * null if no id can be found.
 */
export function parseNotionId(ref) {
  if (!ref || typeof ref !== 'string') return null;
  const input = ref.trim();

  // Strip query/hash so an id-looking ?p= param doesn't get matched first.
  const withoutQuery = input.split(/[?#]/)[0];

  // 1) Dashed UUID anywhere (covers a bare UUID and the dashed form in a path).
  const dashed = withoutQuery.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  if (dashed) return dashed[0].toLowerCase();

  // 2) Undashed 32-hex run. For URLs the id is the LAST such run (after the
  //    slug); for a bare id it's the only one. Take the last match.
  const undashedMatches = withoutQuery.match(/[0-9a-fA-F]{32}/g);
  if (undashedMatches && undashedMatches.length) {
    const raw = undashedMatches[undashedMatches.length - 1].toLowerCase();
    return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
  }

  return null;
}

/**
 * Low-level Notion REST helper. Resolves the bearer via
 * resolveIntegrationToken('notion'), sets the required Notion-Version
 * header, retries once on transient auth errors, and returns parsed JSON.
 *
 * Keep this the single auth chokepoint — don't resolve tokens at call sites.
 * `opts.formData`: a FormData body (the file-upload send endpoint is
 * multipart/form-data, not JSON) — fetch sets the multipart boundary itself,
 * so no Content-Type is set for it.
 */
export async function notionApi(path, opts: any = {}) {
  const makeRequest = async () => {
    const { token } = await resolveIntegrationToken('notion');
    if (typeof token !== 'string' || !token) {
      throw new Error(`Invalid notion token type: ${typeof token}`);
    }
    const res = await fetch(`${NOTION_BASE}${path}`, {
      method: opts.method || 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        Accept: 'application/json',
        ...(opts.body && !opts.formData ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
      body: opts.formData ? opts.formData : (opts.body ? JSON.stringify(opts.body) : undefined),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Notion API ${res.status}: ${err.slice(0, 300)}`);
    }
    const raw = await res.text().catch(() => '');
    if (!raw || !raw.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return { raw };
    }
  };

  try {
    return await makeRequest();
  } catch (error) {
    const msg = String(error?.message || error || '').toLowerCase();
    const shouldRetry = msg.includes('token') || msg.includes('401') || msg.includes('unauthorized');
    if (!shouldRetry) throw error;
    clearTokenCache('notion');
    return makeRequest();
  }
}

/**
 * Flatten Notion rich_text array → plain text with light markdown marks.
 * Notion rich_text items carry annotations (bold/italic/code/strike) and
 * an optional link href on `text.link.url`.
 */
function richTextToString(rich) {
  if (!Array.isArray(rich)) return '';
  let out = '';
  for (const rt of rich) {
    let t = rt?.plain_text ?? rt?.text?.content ?? '';
    if (!t) continue;
    const a = rt.annotations || {};
    if (a.code) t = `\`${t}\``;
    if (a.bold) t = `**${t}**`;
    if (a.italic) t = `_${t}_`;
    if (a.strikethrough) t = `~~${t}~~`;
    const href = rt?.href || rt?.text?.link?.url;
    if (href) t = `[${t}](${href})`;
    out += t;
  }
  return out;
}

/**
 * Render a single Notion block (plus its rendered children) into markdown.
 * `numberStack` tracks ordered-list numbering at the current depth.
 */
function blockToMarkdown(block, depth, childrenText) {
  const type = block?.type;
  const data = block?.[type] || {};
  const indent = '  '.repeat(Math.max(0, depth));
  const rt = (key = 'rich_text') => richTextToString(data[key]);

  let line;
  switch (type) {
    case 'paragraph':
      line = rt();
      break;
    case 'heading_1':
      line = `# ${rt()}`;
      break;
    case 'heading_2':
      line = `## ${rt()}`;
      break;
    case 'heading_3':
      line = `### ${rt()}`;
      break;
    case 'bulleted_list_item':
      line = `${indent}- ${rt()}`;
      break;
    case 'numbered_list_item':
      line = `${indent}1. ${rt()}`;
      break;
    case 'to_do':
      line = `${indent}- [${data.checked ? 'x' : ' '}] ${rt()}`;
      break;
    case 'toggle':
      line = `${indent}- ${rt()}`;
      break;
    case 'quote':
      line = `> ${rt()}`;
      break;
    case 'callout': {
      const icon = data.icon?.emoji ? `${data.icon.emoji} ` : '';
      line = `> ${icon}${rt()}`;
      break;
    }
    case 'code': {
      const lang = data.language || '';
      line = `\`\`\`${lang}\n${rt()}\n\`\`\``;
      break;
    }
    case 'divider':
      line = '---';
      break;
    case 'child_page':
      line = `[child page: ${data.title || ''}]`;
      break;
    case 'child_database':
      line = `[child database: ${data.title || ''}]`;
      break;
    case 'bookmark':
    case 'embed':
    case 'link_preview':
      line = data.url ? `<${data.url}>` : '';
      break;
    case 'equation':
      line = data.expression ? `$${data.expression}$` : '';
      break;
    case 'table':
    case 'column_list':
    case 'column':
      // Structural containers — content comes entirely from children.
      line = '';
      break;
    case 'table_row': {
      const cells = (data.cells || []).map((c) => richTextToString(c).trim());
      line = `${indent}| ${cells.join(' | ')} |`;
      break;
    }
    default:
      // Unknown/unsupported block — fall back to any rich_text it carries.
      line = rt();
      break;
  }

  const parts = [];
  if (line && line.trim()) parts.push(line);
  if (childrenText && childrenText.trim()) parts.push(childrenText);
  return parts.join('\n');
}

/**
 * Recursively fetch + flatten a block subtree into markdown.
 * Paginates GET /blocks/{id}/children. Bounded by MAX_BLOCK_PAGES and
 * by an early-exit once we've gathered MAX_TEXT_CHARS of text.
 */
async function flattenBlockChildren(blockId, depth, budget) {
  const out = [];
  let cursor;
  let pages = 0;
  do {
    if (budget.used >= MAX_TEXT_CHARS) break;
    const qs = new URLSearchParams({ page_size: '100' });
    if (cursor) qs.set('start_cursor', cursor);
    const data = await notionApi(`/blocks/${blockId}/children?${qs.toString()}`);
    const results = Array.isArray(data.results) ? data.results : [];
    for (const block of results) {
      let childrenText = '';
      if (block.has_children) {
        childrenText = await flattenBlockChildren(block.id, depth + 1, budget);
      }
      const md = blockToMarkdown(block, depth, childrenText);
      if (md) {
        out.push(md);
        budget.used += md.length + 1;
      }
      if (budget.used >= MAX_TEXT_CHARS) break;
    }
    cursor = data.has_more ? data.next_cursor : undefined;
    pages += 1;
  } while (cursor && pages < MAX_BLOCK_PAGES);
  return out.join('\n');
}

/**
 * Pull the human title off a page object. Pages expose their title via the
 * one property whose type is 'title' (database pages) or a synthetic
 * 'title' property (workspace pages).
 */
function pageTitle(page) {
  const props = page?.properties || {};
  for (const value of (Object.values(props) as any[])) {
    if (value?.type === 'title') {
      const t = richTextToString(value.title).trim();
      if (t) return t;
    }
  }
  return '';
}

/**
 * Build a Notion rich_text array from a plain string. Notion caps a single
 * rich_text text object at 2000 chars, so we chunk longer bodies across
 * multiple objects (the API concatenates them). This is the inverse of
 * richTextToString — used by notion_add_comment to post a reply body.
 */
function stringToRichText(text) {
  const s = String(text ?? '');
  if (!s) return [{ type: 'text', text: { content: '' } }];
  const chunks = [];
  for (let i = 0; i < s.length; i += 2000) {
    chunks.push({ type: 'text', text: { content: s.slice(i, i + 2000) } });
  }
  return chunks;
}

/**
 * Flatten a Notion comment object → a small { id, discussionId, text, author }
 * summary for the agent's thread context.
 */
function commentSummary(c) {
  return {
    id: c?.id || '',
    discussionId: c?.discussion_id || '',
    text: richTextToString(c?.rich_text).trim(),
    author: c?.created_by?.id || '',
    createdTime: c?.created_time || '',
  };
}

/**
 * Reduce a database-row property to a short scalar string for the row summary.
 */
function propToString(prop) {
  if (!prop || !prop.type) return '';
  const t = prop.type;
  switch (t) {
    case 'title': return richTextToString(prop.title).trim();
    case 'rich_text': return richTextToString(prop.rich_text).trim();
    case 'number': return prop.number == null ? '' : String(prop.number);
    case 'select': return prop.select?.name || '';
    case 'status': return prop.status?.name || '';
    case 'multi_select': return (prop.multi_select || []).map((s) => s.name).join(', ');
    case 'checkbox': return prop.checkbox ? 'true' : 'false';
    case 'url': return prop.url || '';
    case 'email': return prop.email || '';
    case 'phone_number': return prop.phone_number || '';
    case 'date': return prop.date?.start || '';
    case 'people': return (prop.people || []).map((p) => p.name || p.id).join(', ');
    default: return '';
  }
}

// ── Write path (create/append pages, blocks, images) ────────────────────────

/** Canonical Notion page URL from a dashed page id. */
function notionPageUrl(id) {
  return `https://www.notion.so/${String(id || '').replace(/-/g, '')}`;
}

/**
 * Map a small, common subset of markdown into Notion block objects.
 * Each block is a single line: headings (#/##/### → heading_1/2/3), bullets
 * (- / *), ordered (1.) — everything else a paragraph. Inline marks are kept
 * as literal text (content preserved; no annotation parsing — honest +
 * robust). Empty lines are skipped. Mirrors larkDocs.js markdownToLarkBlocks.
 */
export function markdownToNotionBlocks(markdown) {
  const source = String(markdown ?? '').replace(/\r\n/g, '\n');
  const blocks = [];
  for (const rawLine of source.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;

    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);

    let type;
    let content;
    if (h) {
      type = `heading_${h[1].length}`;
      content = h[2];
    } else if (ul) {
      type = 'bulleted_list_item';
      content = ul[1];
    } else if (ol) {
      type = 'numbered_list_item';
      content = ol[1];
    } else {
      type = 'paragraph';
      content = line;
    }

    blocks.push({ object: 'block', type, [type]: { rich_text: stringToRichText(content) } });
  }
  return blocks;
}

/**
 * The write-body arg: raw `blocks` (bounded pass-through) win over
 * `markdown` (converted). Returns null when neither is usable.
 */
function writeBlocksArg(args) {
  if (Array.isArray(args?.blocks) && args.blocks.length) {
    return args.blocks.slice(0, MAX_WRITE_BLOCKS);
  }
  if (typeof args?.markdown === 'string' && args.markdown.trim()) {
    return markdownToNotionBlocks(args.markdown).slice(0, MAX_WRITE_BLOCKS);
  }
  return null;
}

/**
 * Append children to a block/page in ≤100-block chunks (Notion's
 * per-request cap) via PATCH /v1/blocks/{id}/children.
 */
async function appendChildrenChunked(blockId, blocks) {
  for (let i = 0; i < blocks.length; i += MAX_CHILDREN_PER_REQUEST) {
    await notionApi(`/blocks/${blockId}/children`, {
      method: 'PATCH',
      body: { children: blocks.slice(i, i + MAX_CHILDREN_PER_REQUEST) },
    });
  }
}

/**
 * Validate + read a local image file for the Notion File Upload API.
 * Throws a clear error (caught + fail-softed by handleToolCall).
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
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new Error(`image is ${(bytes.length / (1024 * 1024)).toFixed(1)}MB — max 20MB (Notion single_part upload cap)`);
  }
  return bytes;
}

/**
 * Upload a local image via Notion's File Upload API (VERIFIED contract,
 * GA'd 2025, works under the pinned 2022-06-28 version header):
 *   1. POST /v1/file_uploads { mode:'single_part', filename } → { id }
 *   2. POST /v1/file_uploads/{id}/send — multipart/form-data, field `file`
 * Returns the file_upload id, referenced from an image block as
 * { type:'file_upload', file_upload:{ id } }. Single-part cap: 20MB.
 */
async function uploadImageFile(imagePath) {
  const bytes = readImageBytes(imagePath);
  const fileName = basename(imagePath.trim());
  const contentType = /\.png$/i.test(fileName) ? 'image/png' : 'image/jpeg';

  const created = await notionApi('/file_uploads', {
    method: 'POST',
    body: { mode: 'single_part', filename: fileName },
  });
  const uploadId = created?.id;
  if (!uploadId) throw new Error('Notion file upload create returned no id');

  const form = new FormData();
  form.set('file', new Blob([bytes], { type: contentType }), fileName);
  await notionApi(`/file_uploads/${uploadId}/send`, { method: 'POST', formData: form });
  return uploadId;
}

export const notionSkill: any = {
  id: 'notion',
  serverName: 'notion',
  allowedTools: ['mcp__notion__*'],
  requiresIntegration: INTEGRATIONS.NOTION, // see jiraSkill.requiresIntegration for semantics
  description: 'Notion — read pages/databases as context + create pages, append blocks, and insert images',

  promptFragment: `## Notion
You can read Notion content as context AND write to Notion (create pages, append blocks, insert images).
- notion_get_page: pass a Notion page id OR a full Notion URL; returns { id, title, url, text } where text is the page flattened to markdown (truncated to ~20k chars). Use the text as reference context.
- notion_query_database: pass a database id/URL; returns a small list of rows ({ id, title, url, props }). Use to find a specific page, then notion_get_page it.
- notion_create_page: create a page under a parent page ({ parentPageId, title, markdown }) or in a database ({ databaseId, title, markdown }) — one parent is required. Body from markdown (#/##/### headings, - bullets, 1. ordered) or raw Notion blocks. Returns { ok, pageId, url } — share the url.
- notion_append_blocks: append markdown (or raw blocks) to the end of an existing page — pass { pageId, markdown }. Returns { ok, pageId, url }.
- notion_insert_image: append an image block to a page. Pass { pageId, imagePath } for a LOCAL png/jpg file (≤20MB, uploaded via Notion's File Upload API) or { pageId, imageUrl } for an external, publicly reachable image URL. Optional caption. Returns { ok, pageId, url }.
- notion_list_comments: pass a page/block id OR URL; returns the open comment discussions on it ({ id, discussionId, text, author }). Use to read the comment thread you are replying to.
- notion_add_comment: post a comment. To REPLY in an existing discussion pass { discussionId, text }; to start a NEW top-level comment on a page pass { pageId, text }. Returns { ok, id, discussionId }. Use this to answer a user who @mentioned Zibby in a Notion comment — reply in the SAME discussionId.
Do not block the task if Notion is unavailable — these tools return { ok:false, error } on failure; treat a missing page as "no extra context" / "cannot deliver to Notion" and continue.`,

  /**
   * Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs) pointing at this
   * module's notionSkill export, so the AGENT gets real mcp__notion__* tools
   * and can pull a referenced page itself (the agent-driven code-review flow).
   *
   * Previously this returned null (no MCP server) because Notion was only ever
   * called by deterministic node code via handleToolCall — there was no agent
   * tool surface. Now the review agent gathers context itself, so it needs the
   * tools. The bin imports ../dist/notion.js (resolved relative to bin/, like
   * mcp-sentry.mjs) and dispatches through handleToolCall; auth flows through
   * the INHERITED env (PROJECT_API_TOKEN → resolveIntegrationToken('notion')),
   * so no provider-specific env keys are needed here. When unconnected,
   * handleToolCall returns { ok:false, error } — the agent tolerates it.
   */
  resolve() {
    const bin = resolveSkillBin();
    if (!bin) return null;
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/notion.js', 'notionSkill'],
      env: {},
      description: this.description,
      // Force tools into the system prompt instead of deferring behind the
      // SDK's ToolSearch (see github.js / sentry.js resolve()).
      alwaysLoad: true,
    };
  },

  async handleToolCall(name, args) {
    try {
      switch (name) {
        case 'notion_get_page': {
          const ref = args?.pageId || args?.page || args?.url || args?.id;
          const id = parseNotionId(ref);
          if (!id) return JSON.stringify({ ok: false, error: 'A valid Notion page id or URL is required' });

          const page = await notionApi(`/pages/${id}`);
          const title = pageTitle(page);
          const url = page?.url || `https://www.notion.so/${id.replace(/-/g, '')}`;

          const budget: any = { used: 0 };
          let text = await flattenBlockChildren(id, 0, budget);
          let truncated = false;
          if (text.length > MAX_TEXT_CHARS) {
            text = text.slice(0, MAX_TEXT_CHARS);
            truncated = true;
          }
          return JSON.stringify({ ok: true, id, title, url, text, ...(truncated ? { truncated: true } : {}) });
        }

        case 'notion_query_database': {
          const ref = args?.databaseId || args?.database || args?.url || args?.id;
          const id = parseNotionId(ref);
          if (!id) return JSON.stringify({ ok: false, error: 'A valid Notion database id or URL is required' });

          const pageSize = Math.max(1, Math.min(Number(args?.maxResults) || MAX_DB_ROWS, MAX_DB_ROWS));
          const body: any = { page_size: pageSize };
          if (args?.filter && typeof args.filter === 'object') body.filter = args.filter;

          const data = await notionApi(`/databases/${id}/query`, { method: 'POST', body });
          const results = Array.isArray(data.results) ? data.results : [];
          const rows = results.map((row) => {
            const props: any = {};
            for (const [key, value] of Object.entries(row.properties || {})) {
              const s = propToString(value);
              if (s) props[key] = s;
            }
            return {
              id: row.id,
              title: pageTitle(row),
              url: row.url || `https://www.notion.so/${String(row.id || '').replace(/-/g, '')}`,
              props,
            };
          });
          return JSON.stringify({ ok: true, id, count: rows.length, hasMore: !!data.has_more, rows });
        }

        case 'notion_create_page': {
          const title = typeof args?.title === 'string' && args.title.trim()
            ? args.title.trim()
            : null;
          if (!title) return JSON.stringify({ ok: false, error: 'title is required' });

          // Exactly one parent: a page OR a database. When both are somehow
          // present, the database wins (a database row is the more specific
          // destination).
          const databaseId = args?.databaseId ? parseNotionId(args.databaseId) : null;
          const parentPageId = args?.parentPageId
            ? parseNotionId(args.parentPageId)
            : parseNotionId(args?.parent || args?.pageId);
          if (!databaseId && !parentPageId) {
            return JSON.stringify({ ok: false, error: 'A valid parentPageId or databaseId is required' });
          }
          const parent = databaseId ? { database_id: databaseId } : { page_id: parentPageId };

          // 'title' is the ID of the title property on EVERY page/database
          // (regardless of the property's display name), so keying by id
          // works for both parent kinds.
          const properties: any = { title: { title: stringToRichText(title) } };

          const blocks = writeBlocksArg(args) || [];
          const first = blocks.slice(0, MAX_CHILDREN_PER_REQUEST);
          const page = await notionApi('/pages', {
            method: 'POST',
            body: { parent, properties, ...(first.length ? { children: first } : {}) },
          });
          const pageId = page?.id;
          if (!pageId) return JSON.stringify({ ok: false, error: 'Notion page create returned no id' });

          // Notion caps children at 100 per request — append the remainder.
          const rest = blocks.slice(MAX_CHILDREN_PER_REQUEST);
          if (rest.length) await appendChildrenChunked(pageId, rest);

          return JSON.stringify({ ok: true, pageId, url: page?.url || notionPageUrl(pageId) });
        }

        case 'notion_append_blocks': {
          const pageId = parseNotionId(args?.pageId || args?.blockId || args?.url || args?.id);
          if (!pageId) return JSON.stringify({ ok: false, error: 'A valid Notion page id or URL is required' });

          const blocks = writeBlocksArg(args);
          if (!blocks || !blocks.length) {
            return JSON.stringify({ ok: false, error: 'markdown or blocks content is required' });
          }
          await appendChildrenChunked(pageId, blocks);
          return JSON.stringify({ ok: true, pageId, url: notionPageUrl(pageId) });
        }

        case 'notion_insert_image': {
          const pageId = parseNotionId(args?.pageId || args?.url || args?.id);
          if (!pageId) return JSON.stringify({ ok: false, error: 'A valid Notion page id or URL is required' });

          const caption = typeof args?.caption === 'string' && args.caption.trim()
            ? stringToRichText(args.caption.trim())
            : null;

          // Two sources: a LOCAL file (uploaded via the File Upload API,
          // attached as type:'file_upload') or an EXTERNAL public URL.
          let image;
          let fileUploadId;
          if (typeof args?.imagePath === 'string' && args.imagePath.trim()) {
            fileUploadId = await uploadImageFile(args.imagePath);
            image = { type: 'file_upload', file_upload: { id: fileUploadId } };
          } else if (typeof args?.imageUrl === 'string' && args.imageUrl.trim()) {
            image = { type: 'external', external: { url: args.imageUrl.trim() } };
          } else {
            return JSON.stringify({ ok: false, error: 'imagePath (local png/jpg) or imageUrl is required' });
          }
          if (caption) image.caption = caption;

          await notionApi(`/blocks/${pageId}/children`, {
            method: 'PATCH',
            body: { children: [{ object: 'block', type: 'image', image }] },
          });
          return JSON.stringify({
            ok: true, pageId, url: notionPageUrl(pageId),
            ...(fileUploadId ? { fileUploadId } : {}),
          });
        }

        case 'notion_list_comments': {
          // Notion lists comments per BLOCK (a page IS a block). Accept a page
          // id, block id, or URL. Returns the open (unresolved) comment
          // discussions so the agent can read the thread it's replying to.
          const ref = args?.blockId || args?.pageId || args?.block || args?.page || args?.url || args?.id;
          const id = parseNotionId(ref);
          if (!id) return JSON.stringify({ ok: false, error: 'A valid Notion page/block id or URL is required' });

          const qs = new URLSearchParams({ block_id: id, page_size: '100' });
          const data = await notionApi(`/comments?${qs.toString()}`);
          const results = Array.isArray(data.results) ? data.results : [];
          const comments = results.map(commentSummary);
          return JSON.stringify({ ok: true, id, count: comments.length, comments });
        }

        case 'notion_add_comment': {
          // Two modes (Notion's POST /v1/comments):
          //   - reply in a thread   → { discussion_id, rich_text }
          //   - new comment on page → { parent: { page_id }, rich_text }
          // discussionId wins when both are present (a reply is more specific).
          const text = typeof args?.text === 'string' ? args.text
            : (typeof args?.body === 'string' ? args.body : '');
          if (!text || !text.trim()) {
            return JSON.stringify({ ok: false, error: 'text is required' });
          }

          const discussionId = args?.discussionId || args?.discussion_id || null;
          let body;
          if (discussionId) {
            body = { discussion_id: String(discussionId), rich_text: stringToRichText(text) };
          } else {
            const pageRef = args?.pageId || args?.page || args?.url || args?.id;
            const pageId = parseNotionId(pageRef);
            if (!pageId) {
              return JSON.stringify({ ok: false, error: 'Either discussionId (to reply) or a valid pageId (to start a comment) is required' });
            }
            body = { parent: { page_id: pageId }, rich_text: stringToRichText(text) };
          }

          const created = await notionApi('/comments', { method: 'POST', body });
          return JSON.stringify({
            ok: true,
            id: created?.id || '',
            discussionId: created?.discussion_id || discussionId || '',
          });
        }

        default:
          return JSON.stringify({ ok: false, error: `Unknown tool: ${name}` });
      }
    } catch (e) {
      // NEVER throw — an optional context source must not crash the caller.
      return JSON.stringify({ ok: false, error: e.message });
    }
  },

  tools: [
    {
      name: 'notion_get_page',
      description: 'Fetch a Notion page and its content flattened to markdown, for use as read-only context. Accepts a raw page id OR a full Notion URL. Returns { ok, id, title, url, text }. Text is truncated to ~20k chars.',
      input_schema: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: 'Notion page id (dashed UUID or 32-char) OR a full Notion page URL.' },
        },
        required: ['pageId'],
      },
    },
    {
      name: 'notion_query_database',
      description: 'Query a Notion database and return a bounded list of rows (id, title, url, key props). Accepts a database id OR full Notion URL. Optional Notion filter object. Returns at most 25 rows.',
      input_schema: {
        type: 'object',
        properties: {
          databaseId: { type: 'string', description: 'Notion database id (dashed UUID or 32-char) OR a full Notion database URL.' },
          filter: { type: 'object', description: 'Optional Notion filter object (Notion query filter syntax).', additionalProperties: true },
          maxResults: { type: 'number', description: 'Max rows to return (default 25, max 25).' },
        },
        required: ['databaseId'],
      },
    },
    {
      name: 'notion_create_page',
      description: 'Create a new Notion page under a parent page (parentPageId) OR in a database (databaseId) — exactly one parent is required. Body from markdown (#/##/### headings, - bullets, 1. ordered lists; inline marks kept as literal text) or raw Notion block objects. Long bodies are chunked automatically (Notion caps 100 blocks/request). Returns { ok, pageId, url } — share the url with the user.',
      input_schema: {
        type: 'object',
        properties: {
          parentPageId: { type: 'string', description: 'Parent PAGE id/URL to create the page under (used when databaseId is absent).' },
          databaseId: { type: 'string', description: 'Parent DATABASE id/URL to create the page in (title goes into the title property).' },
          title: { type: 'string', description: 'Page title.' },
          markdown: { type: 'string', description: 'Page body as markdown (preferred).' },
          blocks: { type: 'array', description: 'Raw Notion block objects (advanced; used instead of markdown, max 500).', items: { type: 'object', additionalProperties: true } },
        },
        required: ['title'],
      },
    },
    {
      name: 'notion_append_blocks',
      description: 'Append markdown (or raw Notion blocks) to the END of an existing Notion page. Accepts a page id or full Notion URL. Chunks automatically at Notion\'s 100-blocks-per-request cap. Returns { ok, pageId, url }.',
      input_schema: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: 'Notion page id (dashed UUID or 32-char) OR a full Notion page URL.' },
          markdown: { type: 'string', description: 'Content to append, as markdown (preferred).' },
          blocks: { type: 'array', description: 'Raw Notion block objects (advanced; used instead of markdown, max 500).', items: { type: 'object', additionalProperties: true } },
        },
        required: ['pageId'],
      },
    },
    {
      name: 'notion_insert_image',
      description: "Append an image block to a Notion page. Pass imagePath for a LOCAL .png/.jpg file (max 20MB — uploaded via Notion's File Upload API, stored by Notion) or imageUrl for an external publicly-reachable image URL. Optional caption. Returns { ok, pageId, url }.",
      input_schema: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: 'Notion page id (dashed UUID or 32-char) OR a full Notion page URL.' },
          imagePath: { type: 'string', description: 'Local filesystem path to a .png or .jpg/.jpeg image (max 20MB). Preferred for locally rendered charts.' },
          imageUrl: { type: 'string', description: 'External image URL (must be publicly reachable; used when imagePath is absent).' },
          caption: { type: 'string', description: 'Optional image caption.' },
        },
        required: ['pageId'],
      },
    },
    {
      name: 'notion_list_comments',
      description: 'List the open comment discussions on a Notion page/block. Accepts a page/block id OR a full Notion URL. Returns { ok, comments:[{ id, discussionId, text, author }] }. Use to read the comment thread you are replying to.',
      input_schema: {
        type: 'object',
        properties: {
          blockId: { type: 'string', description: 'Notion page or block id (dashed UUID or 32-char) OR a full Notion URL.' },
        },
        required: ['blockId'],
      },
    },
    {
      name: 'notion_add_comment',
      description: 'Post a comment on Notion. To REPLY within an existing discussion, pass { discussionId, text }. To start a NEW top-level comment on a page, pass { pageId, text }. Returns { ok, id, discussionId }. Use this to answer a user who @mentioned Zibby in a Notion comment (reply in the same discussionId).',
      input_schema: {
        type: 'object',
        properties: {
          discussionId: { type: 'string', description: 'The discussion_id to reply into (from notion_list_comments). Preferred for replies.' },
          pageId: { type: 'string', description: 'Page id/URL to start a NEW top-level comment on (used when discussionId is absent).' },
          text: { type: 'string', description: 'The comment body (plain text).' },
        },
        required: ['text'],
      },
    },
  ],
};
