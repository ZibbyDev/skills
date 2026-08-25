/**
 * markup.ts — ONE markup grammar for every board write and every board read.
 * ============================================================================
 *
 * Every Jira description/comment used to be posted as ONE ADF paragraph per
 * line of raw text, so the Markdown the fleet's writers already emit (`###`,
 * `**bold**`, `` `code` ``, `- ` lists, `1.` lists, `---`) rendered as literal
 * punctuation. Vikunja received the same raw text and its Tiptap editor showed
 * it verbatim. This module is the fix, and it is the ONLY place the grammar
 * lives:
 *
 *   Markdown ──parseMarkup──▶ Block[] ──markupToAdf──▶  ADF doc   (Jira)
 *                                     ──markupToHtml──▶ HTML      (Vikunja)
 *   ADF doc  ──adfToBlocks──▶ Block[] ──blocksToText──▶ Markdown  (readers)
 *   HTML     ──htmlToBlocks─▶ Block[] ──blocksToText──▶ Markdown  (readers)
 *
 * WHY THE GRAMMAR IS DELIBERATELY *NOT* CommonMark — three properties the
 * fleet's own parsers depend on, each of which CommonMark would break:
 *
 *   1. A LINE IS A BLOCK. A single newline ends a paragraph; blank lines are
 *      dropped, never rendered as empty paragraphs. The readers therefore hand
 *      back one line per block, joined by `\n` — byte-for-byte what the old
 *      one-paragraph-per-line writer produced, so `parseQuestion` (line 2 of a
 *      comment) and every `Key: value` field the fleet reads off a body keep
 *      working. Nothing ever emits a `hardBreak`.
 *   2. BLOCK SYNTAX STARTS AT COLUMN 0. A line that begins with whitespace is
 *      a paragraph, whatever follows the whitespace. `draft.js sanitizeBlock`
 *      and `create-node neutralizeChildProse` neutralise a hostile heading or
 *      field line by PREFIXING A SPACE (lossless, visible); CommonMark allows
 *      up to three leading spaces before `###`, which would re-open exactly the
 *      injection those sanitizers close. So a leading space is inert here.
 *   3. THE MACHINE LINE STAYS PLAIN. `[MAGNUM] verdict exec=… outcome=…
 *      pr=https://…` must come back off the board as the identical first line.
 *      `[x]` without a following `(url)` is text; `_` and `*` open emphasis
 *      only at a word boundary (so `worker=my_worker exec=a_b` has no italics);
 *      a bare URL autolinks only when preceded by whitespace or `(` — so
 *      `pr=https://…` is text while `**PR:** https://…` is a link. A link whose
 *      text equals its href reads back as the bare href, never `[u](u)`.
 *
 * SUPPORTED: paragraphs, `#`–`######` headings, `**bold**`/`__bold__`,
 * `*em*`/`_em_`, `~~strike~~`, `` `code` ``, fenced code blocks, `- `/`* `
 * bullets, `1.`/`1)` ordered lists, `- [ ]`/`- [x]` task items, `[text](url)`
 * + bare URLs, `---` rules, `> ` blockquotes, GitHub-style alert panels
 * (`> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` / `[!CAUTION]` →
 * ADF panel info / success / note / warning / error), and simple GFM tables.
 * Anything else is text. NOTHING HERE THROWS: every entry point catches and
 * degrades to the plain one-paragraph-per-line shape, because a render failure
 * that lost a comment would be strictly worse than the ugliness it fixes.
 *
 * The panel syntax is GitHub's alert extension (a real, documented dialect),
 * chosen over an invented one so the same Markdown reads correctly on GitHub,
 * GitLab, Linear and in a plain editor.
 */

// ── The block model ──────────────────────────────────────────────────────────

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'br' }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'strike'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] };

export type PanelKind = 'info' | 'success' | 'note' | 'warning' | 'error';

export type Block =
  | { t: 'paragraph'; c: Inline[] }
  | { t: 'heading'; level: number; c: Inline[] }
  | { t: 'bullet'; items: Block[][] }
  | { t: 'ordered'; start: number; items: Block[][] }
  | { t: 'task'; items: Array<{ checked: boolean; c: Inline[] }> }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; c: Block[] }
  | { t: 'panel'; kind: PanelKind; c: Block[] }
  | { t: 'rule' }
  | { t: 'table'; header: Inline[][] | null; rows: Inline[][][] };

// GitHub alert keyword ⇄ ADF panelType. ONE table, read in both directions.
const ALERT_TO_PANEL: Record<string, PanelKind> = {
  NOTE: 'info', TIP: 'success', IMPORTANT: 'note', WARNING: 'warning', CAUTION: 'error',
};
const PANEL_TO_ALERT: Record<PanelKind, string> = {
  info: 'NOTE', success: 'TIP', note: 'IMPORTANT', warning: 'WARNING', error: 'CAUTION',
};

const MAX_INPUT = 200_000;
const MAX_HEADING = 6;

// ── Markdown → blocks ────────────────────────────────────────────────────────

const RE_FENCE = /^```([A-Za-z0-9_+.-]{0,32})\s*$/;
const RE_HEADING = /^(#{1,6})[ \t]+(.*?)\s*$/;
const RE_RULE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const RE_QUOTE = /^>(?: ?(.*))?$/;
const RE_TASK = /^[-*][ \t]+\[([ xX])\][ \t]+(.*)$/;
const RE_BULLET = /^[-*][ \t]+(.*)$/;
const RE_ORDERED = /^(\d{1,3})[.)][ \t]+(.*)$/;
const RE_TABLE_ROW = /^\|.*\|\s*$/;
const RE_TABLE_SEP = /^\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const RE_ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;

function splitTableRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && inner[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** Markdown text → blocks. Line-oriented; never throws. */
export function parseMarkup(source: unknown): Block[] {
  const text = String(source == null ? '' : source).slice(0, MAX_INPUT).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  return parseLines(lines, 0);
}

function parseLines(lines: string[], depth: number): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    // Property 2: block syntax only at column 0.
    if (/^[ \t]/.test(line)) {
      out.push({ t: 'paragraph', c: parseInline(line) });
      i++;
      continue;
    }

    let m: RegExpExecArray | null;

    if ((m = RE_FENCE.exec(line))) {
      const lang = m[1] || '';
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
      i++; // the closing fence (or EOF)
      out.push({ t: 'code', lang, v: body.join('\n') });
      continue;
    }

    if (RE_RULE.test(line)) { out.push({ t: 'rule' }); i++; continue; }

    if ((m = RE_HEADING.exec(line))) {
      const level = Math.min(MAX_HEADING, m[1].length);
      out.push({ t: 'heading', level, c: parseInline(m[2]) });
      i++;
      continue;
    }

    if (RE_QUOTE.test(line) && depth < 3) {
      const inner: string[] = [];
      while (i < lines.length && (m = RE_QUOTE.exec(lines[i]))) { inner.push(m[1] ?? ''); i++; }
      const first = inner.findIndex((l) => l.trim() !== '');
      const alert = first >= 0 ? RE_ALERT.exec(inner[first].trim()) : null;
      if (alert) {
        const kind = ALERT_TO_PANEL[alert[1].toUpperCase()];
        out.push({ t: 'panel', kind, c: parseLines(inner.slice(first + 1), depth + 1) });
      } else {
        out.push({ t: 'quote', c: parseLines(inner, depth + 1) });
      }
      continue;
    }

    if (RE_TASK.test(line)) {
      const items: Array<{ checked: boolean; c: Inline[] }> = [];
      while (i < lines.length && (m = RE_TASK.exec(lines[i]))) {
        items.push({ checked: m[1] !== ' ', c: parseInline(m[2]) });
        i++;
      }
      out.push({ t: 'task', items });
      continue;
    }

    if (RE_BULLET.test(line)) {
      const items: Block[][] = [];
      while (i < lines.length && !RE_TASK.test(lines[i]) && (m = RE_BULLET.exec(lines[i]))) {
        items.push([{ t: 'paragraph', c: parseInline(m[1]) }]);
        i++;
      }
      out.push({ t: 'bullet', items });
      continue;
    }

    if ((m = RE_ORDERED.exec(line))) {
      const start = Math.max(1, parseInt(m[1], 10) || 1);
      const items: Block[][] = [];
      while (i < lines.length && (m = RE_ORDERED.exec(lines[i]))) {
        items.push([{ t: 'paragraph', c: parseInline(m[2]) }]);
        i++;
      }
      out.push({ t: 'ordered', start, items });
      continue;
    }

    if (RE_TABLE_ROW.test(line) && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
      const header = splitTableRow(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && RE_TABLE_ROW.test(lines[i])) {
        rows.push(splitTableRow(lines[i]).map(parseInline));
        i++;
      }
      out.push({ t: 'table', header, rows });
      continue;
    }

    out.push({ t: 'paragraph', c: parseInline(line) });
    i++;
  }
  return out;
}

// ── Inline ──────────────────────────────────────────────────────────────────

const RE_URL = /^https?:\/\/[^\s<>()[\]]+/;
const RE_LINK = /^\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]{1,2000})\)/;
const PUNCT_TAIL = /[.,;:!?'"]+$/;

function isWordBoundaryBefore(s: string, i: number): boolean {
  if (i <= 0) return true;
  return /[\s([{"'“‘>:—–-]/.test(s[i - 1]);
}
function isWordBoundaryAfter(s: string, i: number): boolean {
  if (i >= s.length) return true;
  return /[\s)\]}"'”’.,;:!?—–-]/.test(s[i]);
}

/** Find the closing delimiter `delim` for an emphasis run opened at `from`. */
function findCloser(s: string, from: number, delim: string): number {
  let j = from;
  while (j < s.length) {
    const k = s.indexOf(delim, j);
    if (k < 0) return -1;
    // A closer must follow non-whitespace and be followed by a boundary, and
    // (for the single-char delimiters) not be part of a longer run.
    const prev = s[k - 1];
    const next = s[k + delim.length];
    const longer = delim.length === 1 && (prev === delim || next === delim);
    if (k > from && prev && !/\s/.test(prev) && !longer && isWordBoundaryAfter(s, k + delim.length)) return k;
    j = k + 1;
  }
  return -1;
}

export function parseInline(source: unknown): Inline[] {
  const s = String(source == null ? '' : source);
  const out: Inline[] = [];
  let text = '';
  const flush = () => { if (text) { out.push({ t: 'text', v: text }); text = ''; } };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];

    if (ch === '`') {
      let run = 1;
      while (s[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      const close = s.indexOf(fence, i + run);
      if (close > i + run - 1 && close !== -1) {
        const code = s.slice(i + run, close);
        if (code.trim()) {
          flush();
          out.push({ t: 'code', v: code.length > 1 && code.startsWith(' ') && code.endsWith(' ') ? code.slice(1, -1) : code });
          i = close + run;
          continue;
        }
      }
      text += fence;
      i += run;
      continue;
    }

    if (ch === '[') {
      const m = RE_LINK.exec(s.slice(i));
      if (m) {
        flush();
        out.push({ t: 'link', href: m[2], c: parseInline(m[1]) });
        i += m[0].length;
        continue;
      }
    }

    if ((ch === '*' || ch === '_' || ch === '~') && isWordBoundaryBefore(s, i)) {
      const dbl = s[i + 1] === ch;
      if (ch === '~' && !dbl) { text += ch; i++; continue; }
      const delim = dbl ? ch + ch : ch;
      const from = i + delim.length;
      if (from < s.length && !/\s/.test(s[from])) {
        const close = findCloser(s, from, delim);
        if (close > from) {
          flush();
          const inner = parseInline(s.slice(from, close));
          out.push(ch === '~' ? { t: 'strike', c: inner } : dbl ? { t: 'strong', c: inner } : { t: 'em', c: inner });
          i = close + delim.length;
          continue;
        }
      }
    }

    if (ch === 'h' && (i === 0 || /[\s(<]/.test(s[i - 1]))) {
      const m = RE_URL.exec(s.slice(i));
      if (m) {
        let url = m[0];
        // Trailing sentence punctuation is prose, not URL — but a `)` that
        // balances a `(` inside the URL (Wikipedia-style) stays.
        const tail = PUNCT_TAIL.exec(url);
        if (tail) url = url.slice(0, -tail[0].length);
        if (url.length > 'https://'.length) {
          flush();
          out.push({ t: 'link', href: url, c: [{ t: 'text', v: url }] });
          i += url.length;
          continue;
        }
      }
    }

    text += ch;
    i++;
  }
  flush();
  return out;
}

// ── blocks → ADF ─────────────────────────────────────────────────────────────

export type AdfNode = { type: string; version?: number; attrs?: Record<string, unknown>; content?: AdfNode[]; text?: string; marks?: Array<{ type: string; attrs?: Record<string, unknown> }> };

function inlineToAdf(inline: Inline[], marks: Array<{ type: string; attrs?: Record<string, unknown> }> = []): AdfNode[] {
  const out: AdfNode[] = [];
  for (const node of inline) {
    switch (node.t) {
      case 'text':
        if (node.v) out.push({ type: 'text', text: node.v, ...(marks.length ? { marks } : {}) });
        break;
      case 'br':
        out.push({ type: 'hardBreak' });
        break;
      case 'code':
        // ADF: `code` combines with nothing but `link`.
        out.push({
          type: 'text', text: node.v,
          marks: [{ type: 'code' }, ...marks.filter((m) => m.type === 'link')],
        });
        break;
      case 'strong': out.push(...inlineToAdf(node.c, addMark(marks, { type: 'strong' }))); break;
      case 'em': out.push(...inlineToAdf(node.c, addMark(marks, { type: 'em' }))); break;
      case 'strike': out.push(...inlineToAdf(node.c, addMark(marks, { type: 'strike' }))); break;
      case 'link': out.push(...inlineToAdf(node.c, addMark(marks, { type: 'link', attrs: { href: node.href } }))); break;
    }
  }
  return out;
}
function addMark(marks: Array<{ type: string; attrs?: Record<string, unknown> }>, mark: { type: string; attrs?: Record<string, unknown> }) {
  return marks.some((m) => m.type === mark.type) ? marks : [...marks, mark];
}

let localIdSeq = 0;
function localId(): string {
  localIdSeq = (localIdSeq + 1) % 1_000_000;
  return `m${Date.now().toString(36)}-${localIdSeq}`;
}

const paragraph = (c: Inline[]): AdfNode => {
  const content = inlineToAdf(c);
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
};

/**
 * What each ADF container may hold. A doc the API rejects is a comment LOST,
 * so a block that is illegal where it sits is demoted, never emitted as-is:
 * a heading inside a blockquote becomes a bold paragraph, a nested quote or a
 * panel or a table inside a quote/panel/list is flattened to its contents.
 */
type Where = 'doc' | 'quote' | 'panel' | 'item';

function blocksToAdf(blocks: Block[], where: Where): AdfNode[] {
  const out: AdfNode[] = [];
  for (const b of blocks) {
    switch (b.t) {
      case 'paragraph':
        out.push(paragraph(b.c));
        break;
      case 'heading':
        if (where === 'quote' || where === 'item') out.push(paragraph([{ t: 'strong', c: b.c }]));
        else {
          const content = inlineToAdf(b.c);
          if (content.length) out.push({ type: 'heading', attrs: { level: b.level }, content });
        }
        break;
      case 'bullet':
        out.push({
          type: 'bulletList',
          content: b.items.map((item) => ({ type: 'listItem', content: nonEmpty(blocksToAdf(item, 'item')) })),
        });
        break;
      case 'ordered':
        out.push({
          type: 'orderedList',
          attrs: { order: b.start },
          content: b.items.map((item) => ({ type: 'listItem', content: nonEmpty(blocksToAdf(item, 'item')) })),
        });
        break;
      case 'task':
        if (where === 'quote' || where === 'item') {
          // taskList is not allowed inside blockquote/listItem — bullets with a box glyph instead.
          out.push({
            type: 'bulletList',
            content: b.items.map((it) => ({
              type: 'listItem',
              content: [paragraph([{ t: 'text', v: it.checked ? '☑ ' : '☐ ' }, ...it.c])],
            })),
          });
        } else {
          out.push({
            type: 'taskList',
            attrs: { localId: localId() },
            content: b.items.map((it) => ({
              type: 'taskItem',
              attrs: { localId: localId(), state: it.checked ? 'DONE' : 'TODO' },
              content: nonEmptyInline(inlineToAdf(it.c)),
            })),
          });
        }
        break;
      case 'code':
        out.push({
          type: 'codeBlock',
          attrs: b.lang ? { language: b.lang } : {},
          ...(b.v ? { content: [{ type: 'text', text: b.v }] } : {}),
        });
        break;
      case 'quote':
        if (where === 'quote' || where === 'item') out.push(...blocksToAdf(b.c, where));
        else out.push({ type: 'blockquote', content: nonEmpty(blocksToAdf(b.c, 'quote')) });
        break;
      case 'panel':
        if (where !== 'doc') out.push(...blocksToAdf(b.c, where));
        else out.push({ type: 'panel', attrs: { panelType: b.kind }, content: nonEmpty(blocksToAdf(b.c, 'panel')) });
        break;
      case 'rule':
        if (where === 'quote' || where === 'item') break;
        out.push({ type: 'rule' });
        break;
      case 'table': {
        if (where !== 'doc') {
          // No tables inside quotes/panels/items — one paragraph per row.
          for (const row of [...(b.header ? [b.header] : []), ...b.rows]) {
            out.push(paragraph(joinCells(row)));
          }
          break;
        }
        const rows: AdfNode[] = [];
        if (b.header) {
          rows.push({ type: 'tableRow', content: b.header.map((c) => ({ type: 'tableHeader', attrs: {}, content: [paragraph(c)] })) });
        }
        for (const r of b.rows) {
          rows.push({ type: 'tableRow', content: r.map((c) => ({ type: 'tableCell', attrs: {}, content: [paragraph(c)] })) });
        }
        if (rows.length) out.push({ type: 'table', attrs: { isNumberColumnEnabled: false, layout: 'default' }, content: rows });
        break;
      }
    }
  }
  return out;
}
function nonEmpty(nodes: AdfNode[]): AdfNode[] { return nodes.length ? nodes : [{ type: 'paragraph' }]; }
function nonEmptyInline(nodes: AdfNode[]): AdfNode[] { return nodes.length ? nodes : [{ type: 'text', text: ' ' }]; }
function joinCells(row: Inline[][]): Inline[] {
  const out: Inline[] = [];
  row.forEach((cell, i) => { if (i) out.push({ t: 'text', v: ' · ' }); out.push(...cell); });
  return out;
}

/**
 * The shape every board write used before this module existed — one paragraph
 * per line, no marks. It is the FALLBACK of `markupToAdf`, and what a caller
 * retries with when the API rejects the rich document. Exported so the two
 * cannot drift.
 */
export function plainTextToAdf(text: unknown): AdfNode {
  return {
    type: 'doc',
    version: 1,
    content: String(text == null ? '' : text).split('\n').map((line) => ({
      type: 'paragraph',
      ...(line ? { content: [{ type: 'text', text: line }] } : {}),
    })),
  };
}

/** Markdown → an ADF `doc`. Never throws; degrades to `plainTextToAdf`. */
export function markupToAdf(source: unknown): AdfNode {
  try {
    const content = blocksToAdf(parseMarkup(source), 'doc');
    return { type: 'doc', version: 1, content: content.length ? content : [{ type: 'paragraph' }] };
  } catch {
    return plainTextToAdf(source);
  }
}

// ── blocks → HTML (Vikunja / Tiptap) ─────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function inlineToHtml(inline: Inline[]): string {
  let out = '';
  for (const n of inline) {
    switch (n.t) {
      case 'text': out += esc(n.v); break;
      case 'br': out += '<br>'; break;
      case 'code': out += `<code>${esc(n.v)}</code>`; break;
      case 'strong': out += `<strong>${inlineToHtml(n.c)}</strong>`; break;
      case 'em': out += `<em>${inlineToHtml(n.c)}</em>`; break;
      case 'strike': out += `<s>${inlineToHtml(n.c)}</s>`; break;
      case 'link': out += `<a href="${esc(n.href)}" target="_blank" rel="noopener noreferrer">${inlineToHtml(n.c)}</a>`; break;
    }
  }
  return out;
}
// A paragraph that opens with a space is a sanitised line (see trimInline);
// HTML would collapse the space away, U+00A0 survives Tiptap and reads back as
// whitespace.
function keepLeadingSpace(c: Inline[]): Inline[] {
  if (c.length && c[0].t === 'text' && /^ /.test(c[0].v)) return [{ t: 'text', v: `\u00a0${c[0].v.slice(1)}` }, ...c.slice(1)];
  return c;
}
function blocksToHtml(blocks: Block[]): string {
  let out = '';
  for (const b of blocks) {
    switch (b.t) {
      case 'paragraph': out += `<p>${inlineToHtml(keepLeadingSpace(b.c))}</p>`; break;
      case 'heading': out += `<h${b.level}>${inlineToHtml(b.c)}</h${b.level}>`; break;
      case 'bullet': out += `<ul>${b.items.map((it) => `<li>${blocksToHtml(it)}</li>`).join('')}</ul>`; break;
      case 'ordered': out += `<ol${b.start !== 1 ? ` start="${b.start}"` : ''}>${b.items.map((it) => `<li>${blocksToHtml(it)}</li>`).join('')}</ol>`; break;
      case 'task':
        // Tiptap's task-list HTML — the shape Vikunja's own editor stores.
        out += `<ul data-type="taskList">${b.items.map((it) => (
          `<li data-type="taskItem" data-checked="${it.checked ? 'true' : 'false'}">`
          + `<label><input type="checkbox"${it.checked ? ' checked="checked"' : ''}><span></span></label>`
          + `<div><p>${inlineToHtml(it.c)}</p></div></li>`
        )).join('')}</ul>`;
        break;
      case 'code': out += `<pre><code${b.lang ? ` class="language-${esc(b.lang)}"` : ''}>${esc(b.v)}</code></pre>`; break;
      case 'quote': out += `<blockquote>${blocksToHtml(b.c)}</blockquote>`; break;
      case 'panel':
        // Tiptap has no panel: an honest degrade — a blockquote whose first
        // line names the kind in bold, which is also how GitHub renders the
        // alert syntax when unsupported.
        out += `<blockquote><p><strong>${PANEL_TO_ALERT[b.kind][0]}${PANEL_TO_ALERT[b.kind].slice(1).toLowerCase()}</strong></p>${blocksToHtml(b.c)}</blockquote>`;
        break;
      case 'rule': out += '<hr>'; break;
      case 'table': {
        let t = '<table><tbody>';
        if (b.header) t += `<tr>${b.header.map((c) => `<th><p>${inlineToHtml(c)}</p></th>`).join('')}</tr>`;
        for (const r of b.rows) t += `<tr>${r.map((c) => `<td><p>${inlineToHtml(c)}</p></td>`).join('')}</tr>`;
        out += `${t}</tbody></table>`;
        break;
      }
    }
  }
  return out;
}

/** Markdown → HTML for Tiptap-backed trackers (Vikunja). Never throws. */
export function markupToHtml(source: unknown): string {
  try {
    const html = blocksToHtml(parseMarkup(source));
    return html || `<p>${esc(String(source == null ? '' : source))}</p>`;
  } catch {
    return String(source == null ? '' : source).split('\n').map((l) => `<p>${esc(l)}</p>`).join('');
  }
}

// ── blocks → Markdown (the READ side) ────────────────────────────────────────

function inlineToText(inline: Inline[]): string {
  let out = '';
  for (const n of inline) {
    switch (n.t) {
      case 'text': out += n.v; break;
      case 'br': out += '\n'; break;
      case 'code': out += `\`${n.v}\``; break;
      case 'strong': out += `**${inlineToText(n.c)}**`; break;
      case 'em': out += `_${inlineToText(n.c)}_`; break;
      case 'strike': out += `~~${inlineToText(n.c)}~~`; break;
      case 'link': {
        const label = inlineToText(n.c);
        out += !label || label === n.href ? n.href : `[${label}](${n.href})`;
        break;
      }
    }
  }
  return out;
}

/**
 * Blocks → Markdown, ONE LINE PER BLOCK (property 1). Every block ends in `\n`;
 * nested blocks (quotes, panels) prefix `> `; list items are `- `/`1. `/`- [ ] `.
 * This is what every reader hands the fleet's parsers.
 */
export function blocksToText(blocks: Block[]): string {
  let out = '';
  for (const b of blocks) {
    switch (b.t) {
      case 'paragraph': out += `${inlineToText(b.c)}\n`; break;
      case 'heading': out += `${'#'.repeat(Math.max(1, Math.min(MAX_HEADING, b.level)))} ${inlineToText(b.c)}\n`; break;
      case 'bullet': for (const it of b.items) out += `- ${blocksToText(it).trim()}\n`; break;
      case 'ordered': b.items.forEach((it, i) => { out += `${b.start + i}. ${blocksToText(it).trim()}\n`; }); break;
      case 'task': for (const it of b.items) out += `- [${it.checked ? 'x' : ' '}] ${inlineToText(it.c)}\n`; break;
      case 'code': out += `\`\`\`${b.lang}\n${b.v}\n\`\`\`\n`; break;
      case 'quote': out += quoteLines(blocksToText(b.c)); break;
      case 'panel': out += `> [!${PANEL_TO_ALERT[b.kind]}]\n${quoteLines(blocksToText(b.c))}`; break;
      case 'rule': out += '---\n'; break;
      case 'table': {
        const row = (cells: Inline[][]) => `| ${cells.map((c) => inlineToText(c).replace(/\|/g, '\\|')).join(' | ')} |\n`;
        if (b.header) out += row(b.header) + `|${b.header.map(() => ' --- |').join('')}\n`;
        for (const r of b.rows) out += row(r);
        break;
      }
    }
  }
  return out;
}
/**
 * Trailing whitespace and leading BLANK LINES go; a leading space on the first
 * line stays (it may be a sanitised line — property 2). Callers that want a
 * fully trimmed body `.trim()` it, as the trackers always have.
 */
function finishText(text: string): string {
  return text.replace(/^\n+/, '').replace(/\s+$/, '');
}
function quoteLines(text: string): string {
  return text.replace(/\n$/, '').split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n') + '\n';
}

// ── ADF → blocks ─────────────────────────────────────────────────────────────

function adfInline(nodes: AdfNode[] | undefined): Inline[] {
  const out: Inline[] = [];
  for (const n of nodes || []) {
    if (!n || typeof n !== 'object') continue;
    switch (n.type) {
      case 'text': {
        let node: Inline = { t: 'text', v: String(n.text ?? '') };
        const marks = Array.isArray(n.marks) ? n.marks : [];
        if (marks.some((m) => m?.type === 'code')) node = { t: 'code', v: String(n.text ?? '') };
        for (const m of marks) {
          if (!m || m.type === 'code') continue;
          if (m.type === 'strong') node = { t: 'strong', c: [node] };
          else if (m.type === 'em') node = { t: 'em', c: [node] };
          else if (m.type === 'strike') node = { t: 'strike', c: [node] };
          else if (m.type === 'link' && m.attrs?.href) node = { t: 'link', href: String(m.attrs.href), c: [node] };
        }
        out.push(node);
        break;
      }
      case 'hardBreak': out.push({ t: 'br' }); break;
      case 'mention': out.push({ t: 'text', v: String(n.attrs?.text || (n.attrs?.id ? `@${n.attrs.id}` : '@someone')) }); break;
      case 'emoji': out.push({ t: 'text', v: String(n.attrs?.text || n.attrs?.shortName || '') }); break;
      case 'status': out.push({ t: 'text', v: String(n.attrs?.text || '') }); break;
      case 'date': out.push({ t: 'text', v: n.attrs?.timestamp ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10) : '' }); break;
      case 'inlineCard': {
        const url = String(n.attrs?.url || '');
        if (url) out.push({ t: 'link', href: url, c: [{ t: 'text', v: url }] });
        break;
      }
      default:
        if (Array.isArray(n.content)) out.push(...adfInline(n.content));
        else if (typeof n.text === 'string') out.push({ t: 'text', v: n.text });
    }
  }
  return out;
}

function adfBlocks(nodes: AdfNode[] | undefined): Block[] {
  const out: Block[] = [];
  for (const n of nodes || []) {
    if (!n || typeof n !== 'object') continue;
    switch (n.type) {
      case 'paragraph': out.push({ t: 'paragraph', c: adfInline(n.content) }); break;
      case 'heading': out.push({ t: 'heading', level: Number(n.attrs?.level) || 1, c: adfInline(n.content) }); break;
      case 'bulletList': out.push({ t: 'bullet', items: (n.content || []).map((li) => adfBlocks(li?.content)) }); break;
      case 'orderedList': out.push({ t: 'ordered', start: Number(n.attrs?.order) || 1, items: (n.content || []).map((li) => adfBlocks(li?.content)) }); break;
      case 'taskList':
        out.push({
          t: 'task',
          items: (n.content || []).map((ti) => ({ checked: ti?.attrs?.state === 'DONE', c: adfInline(ti?.content) })),
        });
        break;
      case 'decisionList':
        out.push({ t: 'bullet', items: (n.content || []).map((di) => [{ t: 'paragraph' as const, c: adfInline(di?.content) }]) });
        break;
      case 'codeBlock': out.push({ t: 'code', lang: String(n.attrs?.language || ''), v: (n.content || []).map((t) => String(t?.text ?? '')).join('') }); break;
      case 'blockquote': out.push({ t: 'quote', c: adfBlocks(n.content) }); break;
      case 'panel': {
        const kind = String(n.attrs?.panelType || 'info') as PanelKind;
        out.push({ t: 'panel', kind: (kind in PANEL_TO_ALERT ? kind : 'info'), c: adfBlocks(n.content) });
        break;
      }
      case 'rule': out.push({ t: 'rule' }); break;
      case 'table': {
        const rows = (n.content || []).filter((r) => r?.type === 'tableRow');
        const cells = (r: AdfNode) => (r.content || []).map((c) => {
          // A cell holds blocks; a multi-block cell is joined on one line.
          const inner = adfBlocks(c?.content);
          return parseInline(blocksToText(inner).trim().replace(/\n+/g, ' '));
        });
        const isHeader = (r: AdfNode) => (r.content || []).length > 0 && (r.content || []).every((c) => c?.type === 'tableHeader');
        const header = rows.length && isHeader(rows[0]) ? cells(rows[0]) : null;
        out.push({ t: 'table', header, rows: rows.slice(header ? 1 : 0).map(cells) });
        break;
      }
      case 'mediaSingle': case 'mediaGroup': case 'media': case 'mediaInline':
        out.push({ t: 'paragraph', c: [{ t: 'text', v: '[attachment]' }] });
        break;
      case 'expand': case 'nestedExpand': {
        const title = String(n.attrs?.title || '').trim();
        if (title) out.push({ t: 'paragraph', c: [{ t: 'strong', c: [{ t: 'text', v: title }] }] });
        out.push(...adfBlocks(n.content));
        break;
      }
      default: {
        // Layout sections, extensions, anything new: read through to whatever
        // text is inside rather than dropping it.
        const kids = Array.isArray(n.content) ? n.content : [];
        if (kids.some((k) => k?.type === 'text' || k?.type === 'hardBreak')) out.push({ t: 'paragraph', c: adfInline(kids) });
        else if (kids.length) out.push(...adfBlocks(kids));
        else if (typeof n.text === 'string' && n.text) out.push({ t: 'paragraph', c: [{ t: 'text', v: n.text }] });
      }
    }
  }
  return out;
}

/** An ADF doc (or its `content` array) → blocks. Never throws. */
export function adfToBlocks(adf: unknown): Block[] {
  try {
    if (Array.isArray(adf)) return adfBlocks(adf as AdfNode[]);
    if (adf && typeof adf === 'object') {
      const node = adf as AdfNode;
      if (node.type === 'doc' || (!node.type && Array.isArray(node.content))) return adfBlocks(node.content);
      return adfBlocks([node]);
    }
    if (typeof adf === 'string') return parseMarkup(adf);
  } catch { /* fall through */ }
  return [];
}

/**
 * An ADF doc → the Markdown the fleet's parsers read. One line per block,
 * trimmed. A doc the old writer produced (one plain paragraph per line) comes
 * back byte-for-byte as the text that was written, blank lines included as
 * empty paragraphs → empty lines.
 */
export function adfToMarkup(adf: unknown): string {
  try {
    return finishText(blocksToText(adfToBlocks(adf)));
  } catch {
    return '';
  }
}

// ── HTML → blocks ────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™',
};
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

type Tok = { kind: 'open'; name: string; attrs: Record<string, string>; selfClose: boolean } | { kind: 'close'; name: string } | { kind: 'text'; v: string };

function tokenizeHtml(html: string): Tok[] {
  const toks: Tok[] = [];
  const re = /<!--[\s\S]*?-->|<\/([A-Za-z][\w:-]*)\s*>|<([A-Za-z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)|(<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) toks.push({ kind: 'close', name: m[1].toLowerCase() });
    else if (m[2]) {
      const attrs: Record<string, string> = {};
      const ar = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let a: RegExpExecArray | null;
      while ((a = ar.exec(m[3] || ''))) attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
      const name = m[2].toLowerCase();
      toks.push({ kind: 'open', name, attrs, selfClose: !!m[4] || name === 'br' || name === 'hr' || name === 'img' || name === 'input' });
    } else if (m[5] !== undefined) toks.push({ kind: 'text', v: decodeEntities(m[5]) });
    else if (m[6]) toks.push({ kind: 'text', v: '<' });
  }
  return toks;
}

const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'section', 'article', 'header', 'footer', 'details', 'summary', 'figure', 'figcaption']);
const SKIP_TAGS = new Set(['script', 'style', 'label', 'input', 'button', 'svg', 'head', 'title']);

/**
 * A small, tolerant HTML reader for the subset Tiptap (Vikunja) emits. Builds
 * the same Block[] the ADF reader builds, so both trackers hand the fleet
 * IDENTICAL Markdown for identical content.
 */
function htmlBlocks(toks: Tok[]): Block[] {
  const out: Block[] = [];
  let i = 0;

  // Inline accumulation for the current paragraph-ish run.
  let run: Inline[] = [];
  const markStack: Array<'strong' | 'em' | 'strike' | { link: string }> = [];
  const flushRun = (asBlock?: (c: Inline[]) => Block) => {
    const trimmed = trimInline(run);
    run = [];
    if (!trimmed.length) return;
    out.push(asBlock ? asBlock(trimmed) : { t: 'paragraph', c: trimmed });
  };
  const pushText = (v: string) => {
    if (!v) return;
    let node: Inline = { t: 'text', v };
    for (let k = markStack.length - 1; k >= 0; k--) {
      const m = markStack[k];
      if (m === 'strong') node = { t: 'strong', c: [node] };
      else if (m === 'em') node = { t: 'em', c: [node] };
      else if (m === 'strike') node = { t: 'strike', c: [node] };
      else node = { t: 'link', href: m.link, c: [node] };
    }
    run.push(node);
  };

  // Collect the tokens of one element (from after its open tag to its close).
  const collect = (name: string): Tok[] => {
    const inner: Tok[] = [];
    let depth = 1;
    while (i < toks.length) {
      const t = toks[i++];
      if (t.kind === 'open' && t.name === name && !t.selfClose) depth++;
      if (t.kind === 'close' && t.name === name) { depth--; if (depth === 0) break; }
      inner.push(t);
    }
    return inner;
  };
  const textOf = (inner: Tok[]) => inner.filter((t): t is Extract<Tok, { kind: 'text' }> => t.kind === 'text').map((t) => t.v).join('');

  while (i < toks.length) {
    const t = toks[i++];
    if (t.kind === 'text') {
      pushText(t.v.replace(/\s+/g, ' '));
      continue;
    }
    if (t.kind === 'close') {
      if (t.name === 'strong' || t.name === 'b') popMark(markStack, 'strong');
      else if (t.name === 'em' || t.name === 'i') popMark(markStack, 'em');
      else if (t.name === 's' || t.name === 'del' || t.name === 'strike') popMark(markStack, 'strike');
      else if (t.name === 'a') { const k = markStack.map((m) => typeof m === 'object').lastIndexOf(true); if (k >= 0) markStack.splice(k, 1); }
      else if (BLOCK_TAGS.has(t.name)) flushRun();
      continue;
    }
    const name = t.name;
    if (SKIP_TAGS.has(name)) { if (!t.selfClose) collect(name); continue; }
    if (name === 'br') { run.push({ t: 'br' }); continue; }
    if (name === 'hr') { flushRun(); out.push({ t: 'rule' }); continue; }
    if (name === 'strong' || name === 'b') { markStack.push('strong'); continue; }
    if (name === 'em' || name === 'i') { markStack.push('em'); continue; }
    if (name === 's' || name === 'del' || name === 'strike') { markStack.push('strike'); continue; }
    if (name === 'a') { if (t.attrs.href) markStack.push({ link: t.attrs.href }); else markStack.push({ link: '' }); continue; }
    if (name === 'code') {
      const v = textOf(collect('code'));
      if (v) run.push({ t: 'code', v });
      continue;
    }
    if (name === 'pre') {
      flushRun();
      const inner = collect('pre');
      const codeOpen = inner.find((x): x is Extract<Tok, { kind: 'open' }> => x.kind === 'open' && x.name === 'code');
      const lang = codeOpen ? (/language-([\w+.-]+)/.exec(codeOpen.attrs.class || '')?.[1] || '') : '';
      out.push({ t: 'code', lang, v: textOf(inner).replace(/\n$/, '') });
      continue;
    }
    if (/^h[1-6]$/.test(name)) {
      flushRun();
      const level = Number(name[1]);
      const inner = htmlBlocks(collect(name));
      out.push({ t: 'heading', level, c: parseInline(blocksToText(inner).trim().replace(/\n+/g, ' ')) });
      continue;
    }
    if (name === 'blockquote') {
      flushRun();
      out.push({ t: 'quote', c: htmlBlocks(collect(name)) });
      continue;
    }
    if (name === 'ul' || name === 'ol') {
      flushRun();
      const inner = collect(name);
      const isTask = (t.attrs['data-type'] || '') === 'tasklist';
      const items: Tok[][] = [];
      const checks: boolean[] = [];
      let j = 0;
      while (j < inner.length) {
        const x = inner[j++];
        if (x.kind === 'open' && x.name === 'li') {
          const li: Tok[] = [];
          let depth = 1;
          while (j < inner.length) {
            const y = inner[j++];
            if (y.kind === 'open' && y.name === 'li' && !y.selfClose) depth++;
            if (y.kind === 'close' && y.name === 'li') { depth--; if (depth === 0) break; }
            li.push(y);
          }
          items.push(li);
          const checked = (x.attrs['data-checked'] || '') === 'true'
            || li.some((y) => y.kind === 'open' && y.name === 'input' && 'checked' in y.attrs);
          checks.push(checked);
        }
      }
      const isTaskList = isTask || items.some((li) => li.some((y) => y.kind === 'open' && y.name === 'input' && (y.attrs.type || '') === 'checkbox'));
      if (isTaskList) {
        out.push({
          t: 'task',
          items: items.map((li, k) => ({ checked: checks[k], c: parseInline(blocksToText(htmlBlocks(li)).trim().replace(/\n+/g, ' ')) })),
        });
      } else if (name === 'ul') {
        out.push({ t: 'bullet', items: items.map((li) => nonEmptyBlocks(htmlBlocks(li))) });
      } else {
        out.push({ t: 'ordered', start: Math.max(1, parseInt(t.attrs.start || '1', 10) || 1), items: items.map((li) => nonEmptyBlocks(htmlBlocks(li))) });
      }
      continue;
    }
    if (name === 'table') {
      flushRun();
      const inner = collect('table');
      const rows: Inline[][][] = [];
      const headerFlags: boolean[] = [];
      let j = 0;
      while (j < inner.length) {
        const x = inner[j++];
        if (x.kind === 'open' && x.name === 'tr') {
          const cells: Inline[][] = [];
          let allTh = true;
          let depth = 1;
          const trToks: Tok[] = [];
          while (j < inner.length) {
            const y = inner[j++];
            if (y.kind === 'open' && y.name === 'tr' && !y.selfClose) depth++;
            if (y.kind === 'close' && y.name === 'tr') { depth--; if (depth === 0) break; }
            trToks.push(y);
          }
          let k = 0;
          while (k < trToks.length) {
            const y = trToks[k++];
            if (y.kind === 'open' && (y.name === 'td' || y.name === 'th')) {
              if (y.name !== 'th') allTh = false;
              const cell: Tok[] = [];
              let d = 1;
              while (k < trToks.length) {
                const z = trToks[k++];
                if (z.kind === 'open' && z.name === y.name && !z.selfClose) d++;
                if (z.kind === 'close' && z.name === y.name) { d--; if (d === 0) break; }
                cell.push(z);
              }
              cells.push(parseInline(blocksToText(htmlBlocks(cell)).trim().replace(/\n+/g, ' ')));
            }
          }
          if (cells.length) { rows.push(cells); headerFlags.push(allTh); }
        }
      }
      const header = rows.length && headerFlags[0] ? rows[0] : null;
      out.push({ t: 'table', header, rows: rows.slice(header ? 1 : 0) });
      continue;
    }
    if (BLOCK_TAGS.has(name)) { flushRun(); continue; } // p/div/li/td…: their close flushes
    // span / mark / u / font / anything inline-unknown: read through.
  }
  flushRun();
  return out;
}
function popMark(stack: Array<'strong' | 'em' | 'strike' | { link: string }>, kind: 'strong' | 'em' | 'strike') {
  const k = stack.lastIndexOf(kind);
  if (k >= 0) stack.splice(k, 1);
}
function nonEmptyBlocks(b: Block[]): Block[] { return b.length ? b : [{ t: 'paragraph', c: [] }]; }
function trimInline(c: Inline[]): Inline[] {
  // Drop whitespace-only runs at the edges of a paragraph and trailing space.
  // A LEADING space on real content is KEPT (as one space): it is how the
  // fleet's sanitizers neutralise a hostile `### heading` / `Repo:` line
  // (property 2), and the HTML writer stores it as U+00A0 so Tiptap keeps it
  // too. Stripping it here would re-open on Vikunja the hole ADF keeps closed.
  const out = [...c];
  while (out.length && out[0].t === 'text' && !(out[0] as { v: string }).v.trim()) out.shift();
  while (out.length && out[out.length - 1].t === 'text' && !(out[out.length - 1] as { v: string }).v.trim()) out.pop();
  if (out.length && out[0].t === 'text') out[0] = { t: 'text', v: (out[0] as { v: string }).v.replace(/^\s+/, ' ') };
  const last = out.length - 1;
  if (last >= 0 && out[last].t === 'text') out[last] = { t: 'text', v: (out[last] as { v: string }).v.replace(/\s+$/, '') };
  return out;
}

/** HTML (Tiptap/Vikunja) → blocks. Never throws. Plain text without tags is read as Markdown. */
export function htmlToBlocks(html: unknown): Block[] {
  try {
    const s = String(html == null ? '' : html);
    if (!/<[a-z][\s\S]*>/i.test(s)) return parseMarkup(s);
    return htmlBlocks(tokenizeHtml(s));
  } catch {
    return [];
  }
}

/** HTML → the Markdown the fleet's parsers read (one line per block, trimmed). */
export function htmlToMarkup(html: unknown): string {
  try {
    return finishText(blocksToText(htmlToBlocks(html)));
  } catch {
    return '';
  }
}
