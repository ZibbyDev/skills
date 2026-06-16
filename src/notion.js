/**
 * Notion (read-only CONTEXT skill).
 *
 * Unlike the notify skills (slack/lark/chat-notify), this skill PULLS
 * content: it fetches a Notion page (or database) and flattens it into
 * readable markdown so a downstream agent — e.g. a code-review agent —
 * can use a referenced engineering-standards page as extra context.
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
 * This is a context-only, in-process skill: there is no MCP server, so
 * resolve() returns null (no MCP spawn spec) — the agent calls the tools
 * via handleToolCall, same as the in-process path for jira/slack.
 */

import { resolveIntegrationToken, clearTokenCache } from '@zibby/core/backend-client.js';
import { INTEGRATIONS } from './integrations.js';

// Current stable Notion API version. Notion requires this header on every
// request; the value pins the response schema (block/property shapes).
const NOTION_VERSION = '2022-06-28';
const NOTION_BASE = 'https://api.notion.com/v1';

// Cap on flattened text so a large page can't blow the prompt budget.
const MAX_TEXT_CHARS = 20000;
// Cap on rows returned by notion_query_database.
const MAX_DB_ROWS = 25;
// Hard ceiling on block-children pagination so a huge page can't loop forever.
const MAX_BLOCK_PAGES = 25;

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
 */
export async function notionApi(path, opts = {}) {
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
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
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
  for (const value of Object.values(props)) {
    if (value?.type === 'title') {
      const t = richTextToString(value.title).trim();
      if (t) return t;
    }
  }
  return '';
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

export const notionSkill = {
  id: 'notion',
  serverName: 'notion',
  requiresIntegration: INTEGRATIONS.NOTION, // see jiraSkill.requiresIntegration for semantics
  description: 'Notion read-only context (pull a page/database as markdown)',

  promptFragment: `## Notion (connected, read-only context)
You can pull a referenced Notion page in as extra context. This is OPTIONAL — only use it when the task references a Notion page/URL (e.g. an engineering-standards or design doc to review against).
- notion_get_page: pass a Notion page id OR a full Notion URL; returns { id, title, url, text } where text is the page flattened to markdown (truncated to ~20k chars). Use the text as reference context.
- notion_query_database: pass a database id/URL; returns a small list of rows ({ id, title, url, props }). Use to find a specific page, then notion_get_page it.
Do not block the task if Notion is unavailable — these tools return { ok:false, error } on failure; treat a missing page as "no extra context" and continue.`,

  /**
   * Context-only in-process skill — no MCP server binary. Mirrors how
   * jira/slack fall back to handleToolCall; here there's no MCP path at
   * all, so return null (no spawn spec).
   */
  resolve() {
    return null;
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

          const budget = { used: 0 };
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
          const body = { page_size: pageSize };
          if (args?.filter && typeof args.filter === 'object') body.filter = args.filter;

          const data = await notionApi(`/databases/${id}/query`, { method: 'POST', body });
          const results = Array.isArray(data.results) ? data.results : [];
          const rows = results.map((row) => {
            const props = {};
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
  ],
};
