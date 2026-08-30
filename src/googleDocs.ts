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
 * SCOPE / VISIBILITY (drive.file):
 *   The integration requests ONLY the non-sensitive
 *   https://www.googleapis.com/auth/drive.file scope, which grants per-file
 *   access to files this app CREATED or the user explicitly PICKED (via the
 *   Google Picker). The Docs API's documents.create / documents.get /
 *   documents.batchUpdate all accept drive.file, so create→append→read-back of
 *   our own / picked docs works fully. Reading an arbitrary pre-existing doc
 *   requires the user to PICK it once first (the Picker grants drive.file on
 *   that file). We do NOT request the sensitive documents.readonly scope —
 *   Google's OAuth review rejected it; drive.file + Picker is the sanctioned
 *   path.
 */

import { existsSync, statSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { basename, dirname, resolve as resolvePath } from 'path';
import { resolveIntegrationToken, clearTokenCache } from '@zibby/core/backend-client.js';
import { INTEGRATIONS } from './integrations.js';
import { fetchWithDeadline } from './lib/http-deadline.js';

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
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

// Drive's uploadType=multipart cap is 5MB total request — plenty for a
// rendered chart, and it keeps the upload a single request.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * INJECTED-TOKEN fast path (Zibby Copilot per-turn credential injection) +
 * NON-OWNER SAFETY GATE — the Google twin of linkedin.js injectedPersonalToken.
 *
 * The Zibby Copilot is ONE shared chat bot backed by ONE project's
 * PROJECT_API_TOKEN. resolveIntegrationToken('google') authenticates with that
 * PAT, so the account is inferred SERVER-SIDE from the PAT — meaning the shared
 * bot would only ever see the PROJECT OWNER's Google (their readable Docs, their
 * Drive), never the (different) person who actually sent the chat message.
 *
 * Two per-turn env signals, set + restored by the copilot-runtime (a TRUSTED
 * backend service that already KMS-decrypts tenants' creds directly):
 *   - ZIBBY_INJECTED_GOOGLE_TOKEN (+ _EMAIL): the EMAIL-VERIFIED sender's OWN
 *     `google` integration access token (auto-refreshed server-side). When
 *     present it takes PRECEDENCE over resolveIntegrationToken, so every gdocs
 *     call runs against the SENDER's own Google.
 *   - ZIBBY_SENDER_IS_NON_OWNER=1: the verified sender's account differs from
 *     the PAT/tenant account. With NO injected token this is a HARD REFUSAL
 *     gate: the skill must NEVER fall through to the owner's token on a
 *     colleague's behalf (privacy: the owner's readable docs would be exposed
 *     and created docs would land in the owner's Drive). Every tool returns
 *     { ok:false, error } telling the sender to connect their own Google.
 *
 * Absent both (owner/self turns, Fargate workflows, self-host — no
 * sender-identity context) → the normal PAT chokepoint runs unchanged.
 */
export function injectedGoogleToken() {
  const token = String(process.env.ZIBBY_INJECTED_GOOGLE_TOKEN || '').trim();
  if (!token) return null;
  const email = String(process.env.ZIBBY_INJECTED_GOOGLE_EMAIL || '').trim();
  return { token, email };
}

/** True when the runtime flagged this turn's verified sender as NOT the tenant owner. */
export function senderIsNonOwner() {
  return String(process.env.ZIBBY_SENDER_IS_NON_OWNER || '').trim() === '1';
}

/**
 * STRICT CHAT-TURN INVARIANT (fail-CLOSED) — ZIBBY_CHAT_STRICT_PERSONAL=1.
 *
 * Set UNCONDITIONALLY by the Copilot runtime for EVERY chat turn (Slack +
 * Lark, owner or not). Under it, personal-tier providers (google here) must
 * NEVER fall through to the PAT-resolved project-owner token: the ONLY
 * accepted credential is the per-turn injected sender token
 * (ZIBBY_INJECTED_GOOGLE_TOKEN — the runtime injects the OWNER's own Google
 * through the same path, so the owner keeps working). No injected token →
 * HARD REFUSE, for ANY sender: verified non-owners, same-account colleagues,
 * UNVERIFIED senders (users.info failure / no email match — the exact class
 * the old ZIBBY_SENDER_IS_NON_OWNER flag failed OPEN on), and even the owner
 * when their own Google isn't connected. The non-owner flag stays as
 * belt-and-braces; this strict flag is the primary gate.
 *
 * Absent both flags (Fargate workflows, self-host, direct tool use — no chat
 * sender context) → the normal PAT chokepoint runs unchanged.
 */
export function chatStrictPersonal() {
  return String(process.env.ZIBBY_CHAT_STRICT_PERSONAL || '').trim() === '1';
}

// The HARD-REFUSAL message when a chat turn has no injected Google of the
// sender's own (sender-neutral: covers non-owners, unverified senders AND the
// owner with no Google connected). Deliberately does NOT contain the words
// "token"/"401"/"unauthorized" so the googleApi retry heuristic never retries
// it. Exported as NON_OWNER_REFUSAL for backward compatibility.
export const NON_OWNER_REFUSAL =
  "You haven't connected your own Google account — connect it at https://studio.zibby.dev/integrations (Google Docs). For privacy, I can't use anyone else's Google (including the project owner's) on your behalf.";

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
/**
 * Resolve the Google bearer for THIS call — the ONE place the credential
 * precedence lives (factored out so googleApi and any raw-body sibling can
 * share it without duplicating the gates):
 *   1. injected sender token (Copilot per-turn injection) — the sender's
 *      OWN Google (the runtime injects the owner's own Google through the
 *      same path); never the PAT account's.
 *   2. STRICT CHAT-TURN gate (primary, fail-CLOSED) — ANY chat turn
 *      (ZIBBY_CHAT_STRICT_PERSONAL=1) with NO injected token: HARD REFUSE.
 *      A chat turn must NEVER fall through to the PAT-resolved owner token
 *      — not for non-owners, not for unverified senders, not even for the
 *      owner (whose own Google arrives via injection when connected).
 *   3. non-owner gate (belt-and-braces, legacy) — verified non-owner
 *      sender with NO injected token: HARD REFUSE.
 *   4. no chat-sender context (Fargate workflows, self-host, direct tool
 *      use) — the existing resolveIntegrationToken path, unchanged.
 */
async function resolveGoogleBearer() {
  let token;
  const injected = injectedGoogleToken();
  if (injected) {
    token = injected.token;
  } else if (chatStrictPersonal() || senderIsNonOwner()) {
    throw new Error(NON_OWNER_REFUSAL);
  } else {
    ({ token } = await resolveIntegrationToken('google'));
  }
  if (typeof token !== 'string' || !token) {
    throw new Error(`Invalid google token type: ${typeof token}`);
  }
  return token;
}

export async function googleApi(url, opts: any = {}) {
  const makeRequest = async () => {
    // Single auth chokepoint — every gdocs tool routes through
    // resolveGoogleBearer() (injection + refusal gates) BEFORE any network
    // call. `opts.rawBody` + `opts.contentType` carry a non-JSON body (the
    // Drive multipart/related upload) through the SAME chokepoint + retry.
    const token = await resolveGoogleBearer();
    const res = await fetchWithDeadline(url, {
      method: opts.method || 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(opts.rawBody && opts.contentType
          ? { 'Content-Type': opts.contentType }
          : (opts.body ? { 'Content-Type': 'application/json' } : {})),
        ...opts.headers,
      },
      body: opts.rawBody ? opts.rawBody : (opts.body ? JSON.stringify(opts.body) : undefined),
    }, { kind: opts.rawBody ? 'transfer' : 'api', what: `Google ${opts.method || 'GET'} ${String(url).split('?')[0]}` });
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

  const requests: any[] = [
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

/**
 * Validate + read a local image file for the Drive multipart upload.
 * Throws a clear error (caught + fail-softed by handleToolCall). Returns
 * { bytes, fileName, mimeType }.
 */
function readImageFile(imagePath) {
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
    throw new Error(`image is ${(bytes.length / (1024 * 1024)).toFixed(1)}MB — max 5MB (Drive multipart upload cap)`);
  }
  return {
    bytes,
    fileName: basename(p),
    mimeType: /\.png$/i.test(p) ? 'image/png' : 'image/jpeg',
  };
}

/**
 * Build the multipart/related body for Drive's uploadType=multipart
 * (VERIFIED contract: metadata JSON part first, then the media part —
 * RFC 2387; ≤5MB). Returns { rawBody, contentType } for googleApi.
 */
function buildDriveMultipart(metadata, bytes, mimeType) {
  const boundary = `zibby-gdocs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const rawBody = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n`
      + 'Content-Type: application/json; charset=UTF-8\r\n\r\n'
      + `${JSON.stringify(metadata)}\r\n`
      + `--${boundary}\r\n`
      + `Content-Type: ${mimeType}\r\n\r\n`,
      'utf8',
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);
  return { rawBody, contentType: `multipart/related; boundary=${boundary}` };
}

/** The markdown OR text content arg — markdown wins when both are present. */
const contentArg = (args) => {
  const md = typeof args?.markdown === 'string' ? args.markdown : null;
  const txt = typeof args?.text === 'string' ? args.text : null;
  return md ?? txt;
};

export const googleDocsSkill: any = {
  id: 'google-docs',
  // Backend-calling: the MCP child talks to Zibby's own backend — the
  // session-env contract is guaranteed by backendSession.ts at registration
  // (declare ONCE here; see backend-session-env-contract.test.ts).
  callsBackend: true,
  serverName: 'gdocs',
  allowedTools: ['mcp__gdocs__*'],
  requiresIntegration: INTEGRATIONS.GOOGLE, // see jiraSkill.requiresIntegration for semantics
  description: 'Google Docs — create, append to, insert images into, and read Google Docs (drive.file scoped)',

  promptFragment: `## Google Docs
You can create and edit Google Docs for the user. IMPORTANT visibility caveat: the integration uses Google's per-file drive.file scope, so you can only see docs this app CREATED (or the user explicitly picked) — not the user's whole Drive.
Docs access is PER-USER: each teammate connects their OWN Google account (Integrations → Google Docs). In shared-chat contexts the runtime routes these tools to the SENDER's own Google; a teammate who hasn't connected their own Google gets { ok:false } with connect instructions — for privacy the project owner's Google is NEVER used on someone else's behalf. Relay those instructions rather than retrying.
- gdocs_create_doc: create a new Google Doc from a title + markdown (headings/bold/bullets/links supported) or plain text; returns { documentId, url }. Share the url with the user.
- gdocs_append: append markdown/text to the end of a doc you created earlier (pass the documentId or doc URL).
- gdocs_insert_image: append a LOCAL image file (png/jpg, ≤5MB) to the end of a doc — pass { documentId, imagePath, width?, height? } (width/height in PT, optional). The image is uploaded to the user's Drive and made link-readable (anyone with the link) so Docs can render it. Returns { ok, documentId, fileId, url }.
- gdocs_get: read a doc back as plain text (works for app-created/user-picked docs only; to read an arbitrary pre-existing doc the user must PICK it once first via the Google Picker — drive.file has no access to un-picked files).
- gdocs_list_created: list the Google Docs visible to this app (drive.file → only docs it created or the user picked).
These tools return { ok:false, error } on failure — treat an unavailable Google connection as "cannot deliver to Docs" and report it rather than blocking the task.`,

  /**
   * Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs) pointing at this
   * module's googleDocsSkill export, so the AGENT gets real mcp__gdocs__*
   * tools. The child does NOT inherit the run env — the env returned here is
   * its ENTIRE environment — so BOTH the backend-session allowlist (what
   * resolveIntegrationToken('google') needs to call Zibby's backend from
   * inside the child; the github/gitlab/lark trap, see
   * backend-session-env-contract.test.ts) AND the Copilot per-turn
   * injection/gate vars are forwarded explicitly. When unconnected,
   * handleToolCall returns { ok:false, error } — the agent tolerates it.
   */
  resolve() {
    const bin = resolveSkillBin();
    if (!bin) return null;
    // The gate vars keep their fail-CLOSED semantics: an env-filtering spawner
    // must never silently drop the SAFETY GATE flag — that would fail open to
    // the owner's token.
    const env: any = {};
    for (const k of ['PROJECT_API_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_ENV', 'ZIBBY_INJECTED_GOOGLE_TOKEN', 'ZIBBY_INJECTED_GOOGLE_EMAIL', 'ZIBBY_SENDER_IS_NON_OWNER', 'ZIBBY_CHAT_STRICT_PERSONAL']) {
      if (process.env[k]) env[k] = process.env[k];
    }
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/googleDocs.js', 'googleDocsSkill'],
      env,
      description: this.description,
      // NO `alwaysLoad`: the SDK defers MCP tools behind ToolSearch by design and
      // ToolSearch reaches them — measured, see MCP_TOOL_LOADING.md.
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

        case 'gdocs_insert_image': {
          const id = parseDocId(args?.documentId || args?.url || args?.id);
          if (!id) return JSON.stringify({ ok: false, error: 'A valid Google Docs documentId or URL is required' });
          if (!args?.imagePath || typeof args.imagePath !== 'string' || !args.imagePath.trim()) {
            return JSON.stringify({ ok: false, error: 'imagePath is required' });
          }
          const { bytes, fileName, mimeType } = readImageFile(args.imagePath);

          // 1. Upload the file to Drive (multipart/related: metadata + media).
          const { rawBody, contentType } = buildDriveMultipart({ name: fileName, mimeType }, bytes, mimeType);
          const uploaded = await googleApi(`${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id`, {
            method: 'POST', rawBody, contentType,
          });
          const fileId = uploaded?.id;
          if (!fileId) return JSON.stringify({ ok: false, error: 'Drive upload returned no file id' });

          // 2. Make the file link-readable: the Docs render service fetches
          // insertInlineImage URIs anonymously, so the image must be publicly
          // fetchable (anyone-with-link reader).
          await googleApi(`${DRIVE_BASE}/files/${fileId}/permissions`, {
            method: 'POST',
            body: { role: 'reader', type: 'anyone' },
          });

          // 3. Insert at end-of-body — same end-index logic as gdocs_append.
          const doc = await googleApi(`${DOCS_BASE}/documents/${id}`);
          const contentArr = Array.isArray(doc?.body?.content) ? doc.body.content : [];
          const endIndex = contentArr.length
            ? contentArr[contentArr.length - 1].endIndex || 2
            : 2;
          const insertAt = Math.max(1, endIndex - 1);

          const insertInlineImage: any = {
            location: { index: insertAt },
            uri: `https://drive.google.com/uc?export=download&id=${fileId}`,
          };
          const width = Number(args?.width);
          const height = Number(args?.height);
          if ((Number.isFinite(width) && width > 0) || (Number.isFinite(height) && height > 0)) {
            insertInlineImage.objectSize = {
              ...(Number.isFinite(width) && width > 0 ? { width: { magnitude: width, unit: 'PT' } } : {}),
              ...(Number.isFinite(height) && height > 0 ? { height: { magnitude: height, unit: 'PT' } } : {}),
            };
          }
          await googleApi(`${DOCS_BASE}/documents/${id}:batchUpdate`, {
            method: 'POST',
            body: { requests: [{ insertInlineImage }] },
          });
          return JSON.stringify({ ok: true, documentId: id, fileId, url: docUrl(id) });
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
      name: 'gdocs_insert_image',
      description: 'Append a LOCAL image file (png/jpg, max 5MB) to the END of an existing Google Doc. The image is uploaded to the user\'s Drive, made link-readable (role reader / type anyone — required: the Docs API only renders publicly fetchable image URIs, <2KB URI length, image <50MB and <25 megapixels), then inserted inline. Optional width/height in points (PT). Returns { ok, documentId, fileId, url }.',
      input_schema: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'Google Docs documentId OR a full https://docs.google.com/document/d/... URL.' },
          imagePath: { type: 'string', description: 'Local filesystem path to a .png or .jpg/.jpeg image (max 5MB).' },
          width: { type: 'number', description: 'Optional display width in points (PT).' },
          height: { type: 'number', description: 'Optional display height in points (PT).' },
        },
        required: ['documentId', 'imagePath'],
      },
    },
    {
      name: 'gdocs_get',
      description: 'Read a Google Doc back as plain text (truncated to ~20k chars). The drive.file scope grants access ONLY to docs this app created or the user explicitly picked; to read an arbitrary pre-existing doc the user must PICK it once first via the Google Picker (drive.file cannot see un-picked files). Returns { ok, documentId, title, url, text }.',
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
