/**
 * Google Docs skill — create / append / read Google Docs from an agent.
 *
 * Modelled on notion.js:
 *   - resolveIntegrationToken('google') is the SINGLE auth chokepoint (via
 *     the googleApi() helper below). Don't re-resolve at call sites. The
 *     backend resolver auto-refreshes the ~1h Google access token
 *     server-side, so the skill only ever sees a valid bearer.
 *   - handleToolCall() dispatches the tools and NEVER throws — any HTTP or
 *     parse failure is returned as { ok:false, error } so a missing/broken
 *     Google connection can't crash the run.
 *
 * Token shape (GET /integrations/token/google → resolveIntegrationToken):
 *   { provider:'google', token, email, scopes, expiresInSec }
 *
 * SCOPE / VISIBILITY (drive.file — Phase 1):
 *   The integration requests ONLY the non-sensitive
 *   https://www.googleapis.com/auth/drive.file scope, which grants per-file
 *   access to files this app CREATED or the user explicitly PICKED. The Docs
 *   API's documents.create / documents.get / documents.batchUpdate all accept
 *   drive.file, so create→append→read-back of our own docs works fully. What
 *   does NOT work under Phase 1 is reading arbitrary pre-existing docs — that
 *   needs the Phase-2 documents.readonly scope (extended connect). The same
 *   code path serves both phases; only the granted scope differs.
 */

import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve as resolvePath } from 'path';
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

const DOCS_BASE = 'https://docs.googleapis.com/v1';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';

// Cap on extracted text so a huge doc can't blow the prompt budget.
const MAX_TEXT_CHARS = 20000;
// Cap on rows returned by gdocs_list_created.
const MAX_LIST_FILES = 25;

/**
 * Extract a Google Docs document id from a raw id OR a Docs URL
 * (https://docs.google.com/document/d/<id>/edit...). Returns the id string
 * or null.
 */
export function parseDocId(ref) {
  if (!ref || typeof ref !== 'string') return null;
  const input = ref.trim();
  const urlMatch = input.match(/\/document\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)/);
  if (urlMatch) return urlMatch[1];
  // Bare id: Drive file ids are URL-safe base64-ish, ≥20 chars, no slashes.
  if (/^[a-zA-Z0-9_-]{20,}$/.test(input)) return input;
  return null;
}

/**
 * Low-level Google REST helper. Resolves the bearer via
 * resolveIntegrationToken('google'), retries once on transient auth errors
 * (clearing the client-side token cache so the backend re-refreshes), and
 * returns parsed JSON.
 *
 * Keep this the single auth chokepoint — don't resolve tokens at call sites.
 */
export async function googleApi(url, opts = {}) {
  const makeRequest = async () => {
    const { token } = await resolveIntegrationToken('google');
    if (typeof token !== 'string' || !token) {
      throw new Error(`Invalid google token type: ${typeof token}`);
    }
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Google API ${res.status}: ${err.slice(0, 300)}`);
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
    clearTokenCache('google');
    return makeRequest();
  }
}

// ── Markdown → Docs batchUpdate requests ────────────────────────────────────

/**
 * Parse ONE markdown line's inline marks (bold `**x**`, links `[t](u)`,
 * inline code `` `x` ``) into { text, styles } where `styles` are ranges
 * RELATIVE to the returned plain text.
 */
export function parseInlineMarkdown(line) {
  const styles = [];
  let text = '';
  let i = 0;
  while (i < line.length) {
    // Link: [label](url)
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(line.slice(i));
    if (link) {
      styles.push({ start: text.length, end: text.length + link[1].length, link: link[2] });
      text += link[1];
      i += link[0].length;
      continue;
    }
    // Bold: **label**
    const bold = /^\*\*([^*]+)\*\*/.exec(line.slice(i));
    if (bold) {
      styles.push({ start: text.length, end: text.length + bold[1].length, bold: true });
      text += bold[1];
      i += bold[0].length;
      continue;
    }
    // Inline code: `label` — rendered as monospace (Courier New).
    const code = /^`([^`]+)`/.exec(line.slice(i));
    if (code) {
      styles.push({ start: text.length, end: text.length + code[1].length, code: true });
      text += code[1];
      i += code[0].length;
      continue;
    }
    text += line[i];
    i += 1;
  }
  return { text, styles };
}

/**
 * Convert a small, common subset of markdown (headings #/##/###, bullet
 * lists -/*, numbered lists `1.`, bold, links, inline code) into Google Docs
 * batchUpdate requests that insert the content at `startIndex`.
 *
 * Strategy: ONE insertText request carrying the whole plain text (every line
 * newline-terminated → each becomes its own paragraph), followed by
 * updateParagraphStyle (headings), createParagraphBullets (consecutive list
 * runs) and updateTextStyle (bold/link/code) requests over the computed
 * ranges. Indices are UTF-16 code units — JS string .length matches the Docs
 * API's index space exactly.
 *
 * Returns { requests, endIndex }. Plain text (no markdown) passes through as
 * plain paragraphs — the converter is safe for the `text` input too.
 */
export function markdownToRequests(markdown, startIndex) {
  const source = String(markdown ?? '').replace(/\r\n/g, '\n');
  if (!source.trim()) return { requests: [], endIndex: startIndex };
  const lines = source.split('\n');
  let fullText = '';
  const paragraphs = []; // { start, end, named?, bullet? } absolute ranges
  const textStyles = []; // { start, end, bold?, link?, code? } absolute ranges

  for (const rawLine of lines) {
    let line = rawLine;
    let named = null;
    let bullet = null;

    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h) {
      named = `HEADING_${h[1].length}`;
      line = h[2];
    } else if (ul) {
      bullet = 'BULLET_DISC_CIRCLE_SQUARE';
      line = ul[1];
    } else if (ol) {
      bullet = 'NUMBERED_DECIMAL_ALPHA_ROMAN';
      line = ol[1];
    }

    const { text, styles } = parseInlineMarkdown(line);
    const paraStart = startIndex + fullText.length;
    for (const s of styles) {
      textStyles.push({ ...s, start: paraStart + s.start, end: paraStart + s.end });
    }
    fullText += `${text}\n`;
    paragraphs.push({ start: paraStart, end: startIndex + fullText.length, named, bullet });
  }

  if (!fullText) return { requests: [], endIndex: startIndex };

  const requests = [
    { insertText: { location: { index: startIndex }, text: fullText } },
  ];

  // Heading paragraph styles.
  for (const p of paragraphs) {
    if (p.named) {
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: p.start, endIndex: p.end },
          paragraphStyle: { namedStyleType: p.named },
          fields: 'namedStyleType',
        },
      });
    }
  }

  // Bullets: group CONSECUTIVE same-preset list lines into one request each
  // (createParagraphBullets applies per paragraph range).
  let run = null;
  const flushRun = () => {
    if (!run) return;
    requests.push({
      createParagraphBullets: {
        range: { startIndex: run.start, endIndex: run.end },
        bulletPreset: run.preset,
      },
    });
    run = null;
  };
  for (const p of paragraphs) {
    if (p.bullet) {
      if (run && run.preset === p.bullet) {
        run.end = p.end;
      } else {
        flushRun();
        run = { start: p.start, end: p.end, preset: p.bullet };
      }
    } else {
      flushRun();
    }
  }
  flushRun();

  // Inline text styles.
  for (const s of textStyles) {
    if (s.end <= s.start) continue;
    if (s.bold) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: s.start, endIndex: s.end },
          textStyle: { bold: true },
          fields: 'bold',
        },
      });
    } else if (s.link) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: s.start, endIndex: s.end },
          textStyle: { link: { url: s.link } },
          fields: 'link',
        },
      });
    } else if (s.code) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: s.start, endIndex: s.end },
          textStyle: { weightedFontFamily: { fontFamily: 'Courier New' } },
          fields: 'weightedFontFamily',
        },
      });
    }
  }

  return { requests, endIndex: startIndex + fullText.length };
}

/**
 * Flatten a documents.get body into plain text (paragraph text runs joined,
 * newline-separated — table cells + nested content included via recursion).
 * Bounded by MAX_TEXT_CHARS.
 */
export function extractPlainText(body) {
  let out = '';
  const walk = (content) => {
    for (const el of Array.isArray(content) ? content : []) {
      if (out.length >= MAX_TEXT_CHARS) return;
      if (el.paragraph) {
        for (const pe of el.paragraph.elements || []) {
          out += pe?.textRun?.content || '';
        }
      } else if (el.table) {
        for (const row of el.table.tableRows || []) {
          for (const cell of row.tableCells || []) {
            walk(cell.content);
          }
        }
      } else if (el.tableOfContents) {
        walk(el.tableOfContents.content);
      }
    }
  };
  walk(body?.content);
  return out.slice(0, MAX_TEXT_CHARS);
}

const docUrl = (id) => `https://docs.google.com/document/d/${id}/edit`;

/** The markdown OR text content arg — markdown wins when both are present. */
const contentArg = (args) => {
  const md = typeof args?.markdown === 'string' ? args.markdown : null;
  const txt = typeof args?.text === 'string' ? args.text : null;
  return md ?? txt;
};

export const googleDocsSkill = {
  id: 'google-docs',
  serverName: 'gdocs',
  allowedTools: ['mcp__gdocs__*'],
  requiresIntegration: INTEGRATIONS.GOOGLE, // see jiraSkill.requiresIntegration for semantics
  description: 'Google Docs — create, append to, and read Google Docs (drive.file scoped)',

  promptFragment: `## Google Docs (connected)
You can create and edit Google Docs for the user. IMPORTANT visibility caveat: the integration uses Google's per-file drive.file scope, so you can only see docs this app CREATED (or the user explicitly picked) — not the user's whole Drive.
- gdocs_create_doc: create a new Google Doc from a title + markdown (headings/bold/bullets/links supported) or plain text; returns { documentId, url }. Share the url with the user.
- gdocs_append: append markdown/text to the end of a doc you created earlier (pass the documentId or doc URL).
- gdocs_get: read a doc back as plain text (works for app-created/user-picked docs; arbitrary docs need the extended documents.readonly connection).
- gdocs_list_created: list the Google Docs visible to this app (drive.file → only docs it created or the user picked).
These tools return { ok:false, error } on failure — treat an unavailable Google connection as "cannot deliver to Docs" and report it rather than blocking the task.`,

  /**
   * Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs) pointing at this
   * module's googleDocsSkill export, so the AGENT gets real mcp__gdocs__*
   * tools. Auth flows through the INHERITED env (PROJECT_API_TOKEN →
   * resolveIntegrationToken('google')), so no provider-specific env keys are
   * needed here. When unconnected, handleToolCall returns { ok:false, error }
   * — the agent tolerates it.
   */
  resolve() {
    const bin = resolveSkillBin();
    if (!bin) return null;
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/googleDocs.js', 'googleDocsSkill'],
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
        case 'gdocs_create_doc': {
          const title = typeof args?.title === 'string' && args.title.trim()
            ? args.title.trim()
            : null;
          if (!title) return JSON.stringify({ ok: false, error: 'title is required' });

          const doc = await googleApi(`${DOCS_BASE}/documents`, {
            method: 'POST',
            body: { title },
          });
          const documentId = doc?.documentId;
          if (!documentId) {
            return JSON.stringify({ ok: false, error: 'Google Docs create returned no documentId' });
          }

          const content = contentArg(args);
          if (content && content.trim()) {
            // A fresh doc's body starts at index 1.
            const { requests } = markdownToRequests(content, 1);
            if (requests.length) {
              await googleApi(`${DOCS_BASE}/documents/${documentId}:batchUpdate`, {
                method: 'POST',
                body: { requests },
              });
            }
          }
          return JSON.stringify({ ok: true, documentId, title, url: docUrl(documentId) });
        }

        case 'gdocs_append': {
          const id = parseDocId(args?.documentId || args?.url || args?.id);
          if (!id) return JSON.stringify({ ok: false, error: 'A valid Google Docs documentId or URL is required' });
          const content = contentArg(args);
          if (!content || !content.trim()) {
            return JSON.stringify({ ok: false, error: 'markdown or text content is required' });
          }

          // Find the end-of-body index: the last structural element's
          // endIndex includes the trailing newline, which is NOT insertable —
          // insert just before it (endIndex - 1).
          const doc = await googleApi(`${DOCS_BASE}/documents/${id}`);
          const body = doc?.body;
          const contentArr = Array.isArray(body?.content) ? body.content : [];
          const endIndex = contentArr.length
            ? contentArr[contentArr.length - 1].endIndex || 2
            : 2;
          const insertAt = Math.max(1, endIndex - 1);

          // Start the appended content on its OWN paragraph: a doc's last
          // paragraph may carry text, so break first (unless the doc is empty).
          const requests = [];
          let contentStart = insertAt;
          if (insertAt > 1) {
            requests.push({ insertText: { location: { index: insertAt }, text: '\n' } });
            contentStart = insertAt + 1;
          }
          const converted = markdownToRequests(content, contentStart);
          requests.push(...converted.requests);

          await googleApi(`${DOCS_BASE}/documents/${id}:batchUpdate`, {
            method: 'POST',
            body: { requests },
          });
          return JSON.stringify({ ok: true, documentId: id, url: docUrl(id) });
        }

        case 'gdocs_get': {
          const id = parseDocId(args?.documentId || args?.url || args?.id);
          if (!id) return JSON.stringify({ ok: false, error: 'A valid Google Docs documentId or URL is required' });

          const doc = await googleApi(`${DOCS_BASE}/documents/${id}`);
          const text = extractPlainText(doc?.body);
          return JSON.stringify({
            ok: true,
            documentId: id,
            title: doc?.title || '',
            url: docUrl(id),
            text,
            ...(text.length >= MAX_TEXT_CHARS ? { truncated: true } : {}),
          });
        }

        case 'gdocs_list_created': {
          const qs = new URLSearchParams({
            q: "'me' in owners and mimeType='application/vnd.google-apps.document' and trashed=false",
            fields: 'files(id,name,modifiedTime,webViewLink)',
            pageSize: String(MAX_LIST_FILES),
            orderBy: 'modifiedTime desc',
          });
          const data = await googleApi(`${DRIVE_BASE}/files?${qs.toString()}`);
          const files = (Array.isArray(data?.files) ? data.files : []).map((f) => ({
            documentId: f.id,
            title: f.name,
            modifiedTime: f.modifiedTime,
            url: f.webViewLink || docUrl(f.id),
          }));
          return JSON.stringify({ ok: true, count: files.length, files });
        }

        default:
          return JSON.stringify({ ok: false, error: `Unknown tool: ${name}` });
      }
    } catch (e) {
      // NEVER throw — a broken/missing Google connection must not crash the caller.
      return JSON.stringify({ ok: false, error: e.message });
    }
  },

  tools: [
    {
      name: 'gdocs_create_doc',
      description: 'Create a new Google Doc with a title and optional content (markdown: #/##/### headings, - bullets, 1. numbered lists, **bold**, [links](url), `code`; or plain text). Returns { ok, documentId, url } — share the url with the user.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Document title.' },
          markdown: { type: 'string', description: 'Document body as markdown (preferred).' },
          text: { type: 'string', description: 'Document body as plain text (used when markdown is absent).' },
        },
        required: ['title'],
      },
    },
    {
      name: 'gdocs_append',
      description: 'Append markdown/text content to the END of an existing Google Doc. Only works on docs this app created or the user explicitly picked (drive.file scope). Accepts a documentId or a full docs.google.com URL. Returns { ok, documentId, url }.',
      input_schema: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'Google Docs documentId OR a full https://docs.google.com/document/d/... URL.' },
          markdown: { type: 'string', description: 'Content to append, as markdown (preferred).' },
          text: { type: 'string', description: 'Content to append, as plain text (used when markdown is absent).' },
        },
        required: ['documentId'],
      },
    },
    {
      name: 'gdocs_get',
      description: 'Read a Google Doc back as plain text (truncated to ~20k chars). Under the default drive.file scope this works ONLY for docs this app created or the user explicitly picked; reading arbitrary docs requires the extended documents.readonly connection. Returns { ok, documentId, title, url, text }.',
      input_schema: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'Google Docs documentId OR a full https://docs.google.com/document/d/... URL.' },
        },
        required: ['documentId'],
      },
    },
    {
      name: 'gdocs_list_created',
      description: 'List the Google Docs visible to this integration, newest first (max 25). NOTE: under the drive.file scope this lists ONLY docs the app created or the user explicitly picked — it is NOT a full Drive search. Returns { ok, count, files:[{ documentId, title, modifiedTime, url }] }.',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
  ],
};
