/**
 * reportCheck.ts — a DATA-DRIVEN pre-flight check for a rendered report page.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT THE PUBLISH GATE
 * ───────────────────────────────────────────────────
 * `backend/src/utils/artifact-validate.js` is the ONE authoritative gate on
 * artifact content and it stays that way. It is regex-over-source with eight
 * static rules (escaped markup, markdown-in-html, html-in-markdown, blocked
 * subresources, script syntax, structure, empty body, zero-width bar). Those
 * rules answer ONE question: *is this document well-formed enough to render?*
 * None of them is reimplemented here — that would be exactly the two-places
 * drift CLAUDE.md keeps getting burned by.
 *
 * This module answers the DIFFERENT question the gate's own header says it
 * structurally cannot: *does the rendered page agree with the DATA it was built
 * from?* The gate says it "cannot see that 42 should have been 45". That
 * sentence is this module's entire scope:
 *
 *   1. DATA ↔ RENDER   — the data has 23 records, the table renders 20.
 *                        A bar drawn at 4% of full scale for the LARGEST value.
 *                        A printed number that disagrees with its own datum.
 *   2. GEOMETRY        — a bar whose width looks fine in source but is
 *                        NULLIFIED by the cascade (a % width on an inline box).
 *   3. OVERFLOW        — a fixed-px child inside a narrower clipping ancestor.
 *   4. PLACEHOLDER     — `[object Object]`, a bare `NaN`, an un-substituted
 *                        `${…}` that reached the page as VISIBLE TEXT.
 *
 * THE DESIGN RULE THAT MATTERS MOST — NO PER-PAGE EXPECTATIONS
 * ────────────────────────────────────────────────────────────
 * The failed prior attempt was for the model to hand-write "bar widths should be
 * 900/80/200/140/300" in the SAME pass that authored the HTML. That is not a
 * check: the pass that got the page wrong writes assertions that agree with it,
 * and the next report needs brand-new assertions.
 *
 * So the caller supplies `{ html, data }` and NOTHING ELSE. `data` is whatever
 * JSON the page was built from. This module DISCOVERS the collections and the
 * numeric series inside it, DISCOVERS the tables and bars inside the page, binds
 * them to each other using evidence found in the markup, and derives what must
 * be true. Written once; generic over any report. If a change here ever needs a
 * caller to describe its own page, the change is wrong.
 *
 * HOW GEOMETRY IS MEASURED — AND WHY THERE IS NO BROWSER
 * ──────────────────────────────────────────────────────
 * By PARSING, because the numbers are literally in the source:
 *
 *   - An ECharts SSR chart emits each bar as `<path d="M86.6 220l51.8 0l0
 *     -139.5l-51.7 0Z" ecmeta_series_index="0" ecmeta_data_index="0">`. The
 *     geometry is literal numbers AND the binding back to the datum is an
 *     explicit attribute — no heuristic, no layout engine.
 *   - An HTML bar is `style="width:45%"` — also a literal number.
 *
 * jsdom was evaluated and REJECTED: it resolves the cascade but performs NO
 * layout, so `getBoundingClientRect()`, `scrollWidth`, `clientWidth` and
 * `offsetWidth` all return 0 (measured, jsdom 29.1.1). It therefore buys nothing
 * this file cannot compute, at 25 MB in a package that installs into every run
 * container and is vendored into the Copilot Lambda image. A real browser IS the
 * only way to get TRUE layout — flex/grid shrink, text wrapping, a table wider
 * than its column — and that class is deliberately OUT OF SCOPE here rather than
 * faked. What IS in scope is the arithmetic subset: an explicit width nullified
 * by an explicit display, and an explicit px child inside an explicit px
 * clipping box.
 *
 * FALSE POSITIVES ARE THE ENEMY — EVERY RULE FAILS OPEN
 * ─────────────────────────────────────────────────────
 * A pre-flight that cries wolf burns the model's repair budget on nothing. So
 * every rule is conservative in the FLAGGING direction: a complex CSS selector
 * is ignored rather than guessed at, a page that renders a top-N subset of a big
 * collection is not "missing rows", a series with fewer than three bars gets no
 * proportionality verdict, and a literal `width:0` is left to the gate that
 * already owns it. The cost is false negatives, which is the right trade for a
 * check that runs before a human ever sees the page.
 *
 * ...WHICH IS WHY THE RESULT CARRIES A PROBE RECEIPT
 * ───────────────────────────────────────────────────
 * "A NEGATIVE result means suspect your PROBE first" (CLAUDE.md). A checker that
 * finds nothing because its selector never matched is indistinguishable from a
 * clean page — unless it says what it looked at. Every result therefore carries
 * `checked`: how many tables, body rows, bars, collections and series it found,
 * and how many bars it actually managed to BIND to a datum. `bars: 5, boundBars:
 * 0` is a broken probe wearing a clean result's clothes, and it is visible.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── defect codes ────────────────────────────────────────────────────────────

/**
 * The defect shape is identical to the gate's (`{ code, line, message, hint }`)
 * so the Copilot handles pre-flight defects and gate defects through ONE code
 * path.
 *
 * `zero-width-bar` is REUSED from the gate's vocabulary deliberately: it means
 * the same thing to the model ("this bar will render invisible") and the two
 * DETECTIONS are disjoint — the gate fires when a bar-ish element has no width
 * source anywhere or a literally broken one (`width:0`, `width:NaN%`,
 * `width:${pct}%`); this fires only when the element HAS a valid positive width
 * that the cascade then throws away. A page cannot trip both for the same
 * element. Every other code below is a failure kind the gate has no rule for.
 */
export const REPORT_CODES = {
  ZERO_WIDTH: 'zero-width-bar',        // reused from artifact-validate.js CODES
  ROW_COUNT: 'data-row-count',
  ROW_MISSING: 'data-row-missing',
  BAR_COUNT: 'data-bar-count',
  BAR_PROPORTION: 'bar-proportion',
  VALUE_MISMATCH: 'data-value-mismatch',
  PLACEHOLDER_TEXT: 'placeholder-text',
  OVERFLOW: 'overflow-clipped',
};

/** Same caps as the gate: enough for the model to act, not a wall of text. */
const PER_RULE_MAX = 5;
const TOTAL_MAX = 20;

/**
 * A rendered bar may deviate from its datum by this fraction OF FULL SCALE
 * before it counts as a defect. 4% of the longest bar is far wider than any
 * rounding a renderer does and far narrower than a bar that is simply wrong.
 */
const PROPORTION_TOLERANCE = 0.04;

/** Below this many usable bars a median-of-ratios scale is not trustworthy. */
const MIN_BARS_FOR_PROPORTION = 3;

/**
 * If fewer than this fraction of a collection's records appear on the page, the
 * page is a top-N summary, not a truncated full render — naming every absent
 * record would be noise. Reported in `checked.collections[].renderedFraction`
 * either way, so the judgement is never silent.
 */
const FULL_RENDER_THRESHOLD = 0.5;

// ── generic helpers ─────────────────────────────────────────────────────────

/** 1-based line number of a character offset (same convention as the gate). */
function lineAt(src: string, index: number): number | null {
  if (index == null || index < 0) return null;
  let line = 1;
  for (let i = 0; i < index && i < src.length; i += 1) if (src.charCodeAt(i) === 10) line += 1;
  return line;
}

function pushDefect(defects: any[], counts: any, defect: any) {
  const n = counts[defect.code] || 0;
  if (n >= PER_RULE_MAX || defects.length >= TOTAL_MAX) return;
  counts[defect.code] = n + 1;
  defects.push(defect);
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
};

function decodeEntities(s: string): string {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const hit = ENTITIES[String(body).toLowerCase()];
    return hit == null ? whole : hit;
  });
}

/** Whitespace-collapsed, entity-decoded, case-folded — the form every text comparison uses. */
function normText(s: any): string {
  return decodeEntities(String(s == null ? '' : s)).replace(/\s+/g, ' ').trim().toLowerCase();
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ── the tokenizer ───────────────────────────────────────────────────────────
//
// A small tag-scanner with an element stack. NOT a spec-compliant HTML parser
// and not trying to be — it needs exactly four things from the document: the
// element tree, each element's attributes, each text node's content, and every
// node's source offset (so a defect can name a line). Same TAG/attribute regex
// shape the gate already uses, plus nesting. These are MECHANICS, not rules:
// nothing in this section decides whether anything is a defect.

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea']);

/** Elements whose CSS default display is inline (the subset that matters for bars). */
const INLINE_BY_DEFAULT = new Set(['span', 'a', 'em', 'strong', 'b', 'i', 'u', 's', 'small', 'code', 'label', 'abbr', 'cite', 'q', 'sub', 'sup', 'mark', 'time', 'var', 'kbd', 'samp', 'font', 'tt']);

interface HNode {
  tag: string;
  attrs: Record<string, string>;
  children: HNode[];
  parent: HNode | null;
  start: number;
  value?: string;      // #text only
  raw?: string;        // script/style/textarea body
}

const OPEN_TAG_RE = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:_.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/;

/** Parse an attribute blob into a lowercase-keyed map (same shape as the gate's parseAttrs). */
function parseAttrs(blob: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))|([a-zA-Z_:][-a-zA-Z0-9_:.]*)/g;
  let m;
  while ((m = re.exec(blob)) !== null) {
    if (m[1]) attrs[m[1].toLowerCase()] = m[3] != null ? m[3] : (m[4] != null ? m[4] : (m[5] == null ? '' : m[5]));
    else if (m[6]) attrs[m[6].toLowerCase()] = '';
  }
  return attrs;
}

function parseDocument(src: string): HNode {
  const root: HNode = { tag: '#root', attrs: {}, children: [], parent: null, start: 0 };
  let cur = root;
  const stack: HNode[] = [root];
  let i = 0;

  const addText = (from: number, to: number) => {
    if (to <= from) return;
    const value = src.slice(from, to);
    if (!value.trim()) return;
    cur.children.push({ tag: '#text', attrs: {}, children: [], parent: cur, start: from, value });
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { addText(i, src.length); break; }
    addText(i, lt);

    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt); i = e < 0 ? src.length : e + 3; continue; }
    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) { const e = src.indexOf('>', lt); i = e < 0 ? src.length : e + 1; continue; }

    const m = OPEN_TAG_RE.exec(src.slice(lt));
    if (!m) { i = lt + 1; continue; }               // a stray '<' — not markup
    const whole = m[0];
    const tag = m[2].toLowerCase();

    if (m[1]) {
      // Pop to the nearest matching open element. An unmatched close tag is
      // IGNORED — close-order is the gate's rule (ruleStructure), not ours.
      for (let s = stack.length - 1; s > 0; s -= 1) {
        if (stack[s].tag === tag) { stack.length = s; cur = stack[s - 1]; break; }
      }
      i = lt + whole.length;
      continue;
    }

    const node: HNode = { tag, attrs: parseAttrs(m[3] || ''), children: [], parent: cur, start: lt };
    cur.children.push(node);
    i = lt + whole.length;

    if (m[4] || VOID_TAGS.has(tag)) continue;

    if (RAW_TEXT_TAGS.has(tag)) {
      const rest = src.slice(i);
      const cm = new RegExp(`</\\s*${tag}\\s*>`, 'i').exec(rest);
      node.raw = cm ? rest.slice(0, cm.index) : rest;
      i += cm ? cm.index + cm[0].length : rest.length;
      continue;
    }

    stack.push(node);
    cur = node;
  }
  return root;
}

/** Depth-first walk over ELEMENT nodes (text nodes excluded). */
function walk(node: HNode, fn: (n: HNode) => void) {
  for (const child of node.children) {
    if (child.tag === '#text') continue;
    fn(child);
    walk(child, fn);
  }
}

/** All descendant text of a node, normalised. Raw-text bodies are never text. */
function textOf(node: HNode): string {
  const out: string[] = [];
  const rec = (n: HNode) => {
    for (const c of n.children) {
      if (c.tag === '#text') out.push(c.value || '');
      else { out.push(' '); rec(c); out.push(' '); }
    }
  };
  rec(node);
  return normText(out.join(''));
}

/** Every text node with its source offset, skipping regions where literals are legitimate. */
function textNodes(root: HNode): Array<{ value: string; start: number; parent: HNode }> {
  const out: Array<{ value: string; start: number; parent: HNode }> = [];
  const rec = (n: HNode) => {
    for (const c of n.children) {
      if (c.tag === '#text') out.push({ value: c.value || '', start: c.start, parent: n });
      // <pre>/<code> legitimately contain `${…}` and `NaN` — the same masking
      // rationale the gate uses in maskLiteralRegions().
      else if (c.tag !== 'pre' && c.tag !== 'code') rec(c);
    }
  };
  rec(root);
  return out;
}

// ── style resolution (the CASCADE, not layout) ──────────────────────────────

/** Split a `style=""` value (or a rule body) into a property map. */
function declarations(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of String(css || '').split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    out[decl.slice(0, idx).trim().toLowerCase()] = decl.slice(idx + 1).trim().replace(/\s*!important$/i, '');
  }
  return out;
}

interface SimpleRule { classes: string[]; id: string | null; tag: string | null; decls: Record<string, string>; }

/**
 * Collect the SIMPLE rules from every `<style>` block — a single compound
 * selector with no combinator (`.bar`, `span.bar`, `#total`).
 *
 * Complex selectors (`.chart .bar`, `.a > .b`, `:hover`) are deliberately
 * DROPPED rather than approximated. Approximating a descendant selector would
 * make this module invent collapses the browser never produces; dropping it can
 * only cause a miss. Conservative in the flagging direction, as the header says.
 */
function collectSimpleRules(root: HNode): SimpleRule[] {
  const rules: SimpleRule[] = [];
  walk(root, (n) => {
    if (n.tag !== 'style' || !n.raw) return;
    // Strip at-rule OPENERS (@media/@supports/@layer) so the rules nested inside
    // them are still seen; the orphaned `}` cannot form a `sel{…}` match.
    const css = n.raw.replace(/@[a-z-]+[^{]*\{/gi, ' ');
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let r;
    while ((r = ruleRe.exec(css)) !== null) {
      const decls = declarations(r[2]);
      for (const sel of r[1].split(',')) {
        const s = sel.trim();
        if (!s || /[\s>+~:[\]*]/.test(s)) continue;    // not a simple compound
        const classes: string[] = [];
        let id: string | null = null;
        let tag: string | null = null;
        let ok = true;
        const tokenRe = /([.#]?)([A-Za-z_][-\w]*)/g;
        let t;
        while ((t = tokenRe.exec(s)) !== null) {
          if (t[1] === '.') classes.push(t[2].toLowerCase());
          else if (t[1] === '#') id = t[2];
          else if (t.index === 0) tag = t[2].toLowerCase();
          else { ok = false; break; }
        }
        if (ok && (tag || id || classes.length)) rules.push({ classes, id, tag, decls });
      }
    }
  });
  return rules;
}

function classesOf(node: HNode): string[] {
  return String(node.attrs.class || '').split(/\s+/).filter(Boolean).map((c) => c.toLowerCase());
}

function ruleMatches(rule: SimpleRule, node: HNode, nodeClasses: string[]): boolean {
  if (rule.tag && rule.tag !== node.tag) return false;
  if (rule.id && rule.id !== node.attrs.id) return false;
  for (const c of rule.classes) if (nodeClasses.indexOf(c) < 0) return false;
  return true;
}

/**
 * What a property resolves to for this element: the inline style wins, else the
 * LAST matching simple rule (source order ≈ the cascade for the equal
 * specificity that simple selectors give us). `null` = set nowhere, so the
 * caller falls back to the element's CSS default.
 */
function resolvedProp(node: HNode, prop: string, rules: SimpleRule[]): string | null {
  const inline = declarations(node.attrs.style)[prop];
  if (inline != null && inline !== '') return inline.toLowerCase();
  const nodeClasses = classesOf(node);
  let found: string | null = null;
  for (const rule of rules) {
    if (!ruleMatches(rule, node, nodeClasses)) continue;
    const v = rule.decls[prop];
    if (v != null && v !== '') found = v.toLowerCase();
  }
  return found;
}

/** Effective `display`, falling back to the element's CSS default. */
function effectiveDisplay(node: HNode, rules: SimpleRule[]): string {
  const set = resolvedProp(node, 'display', rules);
  if (set) return set;
  return INLINE_BY_DEFAULT.has(node.tag) ? 'inline' : 'block';
}

/** A length in CSS px, or null when the unit is not absolute. */
function pxLength(v: string | null): number | null {
  if (!v) return null;
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(String(v).trim());
  return m ? Number(m[1]) : null;
}

/** A percentage 0..100, or null. */
function pctLength(v: string | null): number | null {
  if (!v) return null;
  const m = /^(-?\d+(?:\.\d+)?)%$/.exec(String(v).trim());
  return m ? Number(m[1]) : null;
}

// ── discovering the DATA side ───────────────────────────────────────────────

interface DataCollection { path: string; records: any[]; identities: string[]; }
interface DataSeries { path: string; labels: string[]; values: number[]; }

function isPlainObject(v: any): boolean {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Pick the field that identifies a record on the page — the string field with
 * the most distinct values across the collection, so a status column ("open",
 * "open", "open") never becomes the identity.
 */
function identitiesFor(records: any[]): string[] {
  if (!records.length || !isPlainObject(records[0])) {
    return records.map((r) => (r == null ? '' : String(r)));
  }
  let best: string[] | null = null;
  let bestUnique = 0;
  for (const key of Object.keys(records[0])) {
    const vals = records.map((r) => (isPlainObject(r) && r[key] != null ? String(r[key]) : ''));
    if (vals.some((v) => v.length < 2)) continue;
    const unique = new Set(vals.map(normText)).size;
    if (unique > bestUnique) { bestUnique = unique; best = vals; }
    if (unique === records.length) break;
  }
  return best || records.map((r, i) => String(isPlainObject(r) ? (Object.values(r)[0] == null ? i : Object.values(r)[0]) : r));
}

/**
 * Walk arbitrary caller JSON and pull out (a) every array of records and (b)
 * every label→number series inside it. THIS is what makes the checker generic:
 * the caller hands over the data it rendered from and describes nothing.
 */
function discoverData(data: any): { collections: DataCollection[]; series: DataSeries[] } {
  const collections: DataCollection[] = [];
  const series: DataSeries[] = [];
  const seen = new Set<any>();

  const consider = (path: string, arr: any[]) => {
    if (arr.length < 2) return;
    if (arr.every(isPlainObject)) {
      collections.push({ path, records: arr, identities: identitiesFor(arr) });
      // A series is a collection whose records carry exactly ONE numeric field
      // and at least one string field — {label,value}, {name,count}, {q,total}…
      const keys = Object.keys(arr[0]);
      const numericKeys = keys.filter((k) => arr.every((r) => typeof r[k] === 'number' && Number.isFinite(r[k])));
      const stringKeys = keys.filter((k) => arr.every((r) => typeof r[k] === 'string'));
      if (numericKeys.length === 1 && stringKeys.length >= 1) {
        series.push({
          path,
          labels: arr.map((r) => String(r[stringKeys[0]])),
          values: arr.map((r) => Number(r[numericKeys[0]])),
        });
      }
      return;
    }
    // A bare numeric array is a series with no labels.
    if (arr.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      series.push({ path, labels: arr.map((_, i) => `#${i}`), values: arr.slice() });
    }
  };

  const rec = (value: any, path: string, depth: number) => {
    if (depth > 6 || value == null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      consider(path, value);
      for (let i = 0; i < value.length && i < 200; i += 1) rec(value[i], `${path}[${i}]`, depth + 1);
      return;
    }
    for (const k of Object.keys(value)) rec(value[k], path ? `${path}.${k}` : k, depth + 1);
  };

  rec(data, '', 0);
  return { collections, series };
}

// ── discovering the RENDER side: bars ───────────────────────────────────────

interface RenderedBar {
  node: HNode;
  /** The measured extent along the VARYING axis, in this group's own units. */
  extent: number;
  unit: '%' | 'px' | 'user';
  /** Explicit datum index when the renderer published one (ECharts `ecmeta_data_index`). */
  dataIndex: number | null;
  /** Text of the bar's own row/group — used to bind it to a label and read its printed value. */
  context: string;
  start: number;
}

/** Bounding box of an SVG path `d` built from M/L/H/V (absolute + relative) + Z. */
function pathBBox(d: string): { w: number; h: number } | null {
  const tokens = String(d || '').match(/[MmLlHhVvZz]|-?\d*\.?\d+(?:e-?\d+)?/gi);
  if (!tokens) return null;
  let x = 0; let y = 0; let cmd = '';
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  const mark = () => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  let i = 0;
  let guard = 0;
  while (i < tokens.length && guard++ < 20000) {
    const t = tokens[i];
    if (/[A-Za-z]/.test(t)) {
      cmd = t; i += 1;
      if (cmd === 'Z' || cmd === 'z') continue;
    }
    if (i >= tokens.length) break;
    const num = () => { const v = Number(tokens[i]); i += 1; return v; };
    switch (cmd) {
      case 'M': x = num(); y = num(); mark(); cmd = 'L'; break;
      case 'm': x += num(); y += num(); mark(); cmd = 'l'; break;
      case 'L': x = num(); y = num(); mark(); break;
      case 'l': x += num(); y += num(); mark(); break;
      case 'H': x = num(); mark(); break;
      case 'h': x += num(); mark(); break;
      case 'V': y = num(); mark(); break;
      case 'v': y += num(); mark(); break;
      default: i += 1; break;            // an unsupported command's operand — skip
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { w: maxX - minX, h: maxY - minY };
}

/** Class tokens that mark an element as a bar. Same vocabulary as the gate's BAR_CLASS_RE. */
const BAR_CLASS_RE = /(^|[-_])(bar|gauge|meter|fill|progress|track)([-_]|$)/i;

/** The nearest ancestor that actually has text — the bar's own row. */
function contextTextFor(node: HNode): string {
  let n: HNode | null = node.parent;
  for (let hops = 0; n && hops < 3; hops += 1, n = n.parent) {
    const t = textOf(n);
    if (t) return t;
  }
  return '';
}

/** Is this element bar-shaped? A bar-ish class, or an empty box that paints a background. */
function looksLikeBar(n: HNode, rules: SimpleRule[]): boolean {
  if (classesOf(n).some((c) => BAR_CLASS_RE.test(c))) return true;
  const inline = declarations(n.attrs.style);
  const painted = Boolean(inline.background || inline['background-color']
    || resolvedProp(n, 'background', rules) || resolvedProp(n, 'background-color', rules));
  return painted && textOf(n) === '';
}

/**
 * Group HTML bars into CHARTS. A page can hold several charts; comparing bars
 * across them would invent proportionality defects out of nothing. The group is
 * the DEEPEST ancestor that contains two or more bars — for two side-by-side
 * charts that resolves to each chart's own container, never to <body>.
 */
function groupByContainer(bars: RenderedBar[]): RenderedBar[][] {
  const counts = new Map<HNode, number>();
  for (const bar of bars) {
    for (let p = bar.node.parent; p; p = p.parent) counts.set(p, (counts.get(p) || 0) + 1);
  }
  const groups = new Map<HNode, RenderedBar[]>();
  for (const bar of bars) {
    let container: HNode | null = null;
    for (let p = bar.node.parent; p; p = p.parent) {
      if ((counts.get(p) || 0) >= 2) { container = p; break; }   // deepest wins — we walk UP
    }
    if (!container) continue;
    if (!groups.has(container)) groups.set(container, []);
    groups.get(container)!.push(bar);
  }
  return [...groups.values()].filter((g) => g.length >= 2);
}

function discoverBars(root: HNode, rules: SimpleRule[]): RenderedBar[][] {
  const svgGroups = new Map<string, Array<{ bar: RenderedBar; box: { w: number; h: number } }>>();
  const htmlBars: RenderedBar[] = [];

  walk(root, (n) => {
    // ── SVG shapes emitted by a chart renderer ───────────────────────────
    if (n.tag === 'path' || n.tag === 'rect') {
      const seriesIdx = n.attrs.ecmeta_series_index;
      if (seriesIdx == null) return;              // chrome (axes, split lines) — not data
      let box: { w: number; h: number } | null = null;
      if (n.tag === 'rect') {
        const w = Number(n.attrs.width); const h = Number(n.attrs.height);
        if (Number.isFinite(w) && Number.isFinite(h)) box = { w, h };
      } else {
        box = pathBBox(n.attrs.d || '');
      }
      if (!box) return;
      const dataIdx = n.attrs.ecmeta_data_index;
      const key = String(seriesIdx);
      if (!svgGroups.has(key)) svgGroups.set(key, []);
      svgGroups.get(key)!.push({
        bar: {
          node: n, extent: NaN, unit: 'user',
          dataIndex: dataIdx == null || dataIdx === '' ? null : Number(dataIdx),
          context: '', start: n.start,
        },
        box,
      });
      return;
    }

    // ── HTML bars ─────────────────────────────────────────────────────────
    if (RAW_TEXT_TAGS.has(n.tag) || n.tag === 'svg') return;
    const inline = declarations(n.attrs.style);
    const widthDecl = inline.width == null ? inline['inline-size'] : inline.width;
    if (widthDecl == null || widthDecl === '') return;
    const pct = pctLength(widthDecl);
    const px = pxLength(widthDecl);
    if (pct == null && px == null) return;        // calc(), auto, a var() — not measurable
    if (!looksLikeBar(n, rules)) return;
    htmlBars.push({
      node: n,
      extent: pct == null ? (px as number) : pct,
      unit: pct == null ? 'px' : '%',
      dataIndex: null,
      context: contextTextFor(n),
      start: n.start,
    });
  });

  const groups: RenderedBar[][] = [];

  for (const entries of svgGroups.values()) {
    if (entries.length < 2) continue;
    // A bar series varies along exactly ONE axis — pick the axis with the wider
    // spread so vertical and horizontal charts run through the same code.
    const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    const vertical = spread(entries.map((e) => e.box.h)) >= spread(entries.map((e) => e.box.w));
    for (const e of entries) e.bar.extent = vertical ? e.box.h : e.box.w;
    const bars = entries.map((e) => e.bar).sort((a, b) => {
      if (a.dataIndex != null && b.dataIndex != null) return a.dataIndex - b.dataIndex;
      return a.start - b.start;
    });
    groups.push(bars);
  }

  for (const group of groupByContainer(htmlBars)) {
    // Bars in one chart share a unit; a mix of px and % is not one comparable
    // series, so keep the majority unit and drop the rest.
    const pctBars = group.filter((b) => b.unit === '%');
    const pxBars = group.filter((b) => b.unit === 'px');
    const chosen = pctBars.length >= pxBars.length ? pctBars : pxBars;
    if (chosen.length >= 2) groups.push(chosen);
  }

  return groups;
}

// ── discovering the RENDER side: tables ─────────────────────────────────────

interface RenderedTable { node: HNode; rows: HNode[]; rowTexts: string[]; start: number; }

function discoverTables(root: HNode): RenderedTable[] {
  const tables: RenderedTable[] = [];
  walk(root, (n) => {
    if (n.tag !== 'table') return;
    const rows: HNode[] = [];
    walk(n, (r) => {
      if (r.tag !== 'tr') return;
      const cells = r.children.filter((c) => c.tag === 'td' || c.tag === 'th');
      if (cells.length && cells.every((c) => c.tag === 'th')) return;   // a header row, not data
      rows.push(r);
    });
    tables.push({ node: n, rows, rowTexts: rows.map(textOf), start: n.start });
  });
  return tables;
}

// ── CHECK 1: every record in the data reaches the page ──────────────────────

function checkCollections(
  src: string, root: HNode, tables: RenderedTable[], collections: DataCollection[],
  defects: any[], counts: any, receipt: any[],
) {
  const pageText = textOf(root);
  for (const col of collections) {
    const n = col.records.length;
    if (n < 3) continue;                          // too small for a count to mean anything

    const missing: string[] = [];
    let usable = 0;
    for (const raw of col.identities) {
      const id = normText(raw);
      if (!id || id.length < 2) continue;
      usable += 1;
      if (!pageText.includes(id)) missing.push(String(raw));
    }
    if (usable < 3) continue;                     // no distinctive identity to search for

    const present = usable - missing.length;
    const fraction = usable ? present / usable : 1;

    // Bind a table to this collection — from the page's own evidence, with no
    // name matching and no per-page hint. The binding must be NEAR-INJECTIVE:
    // most rows carry an identity AND those hits are mostly DISTINCT records.
    // Without the injectivity test a 5-record `areas` series binds to the
    // 20-row incident table (every incident row names an area) and the checker
    // reports a table "missing 15 rows" that is perfectly correct — a false
    // positive that would burn the model's whole repair budget.
    let bound: RenderedTable | null = null;
    let bestRowHits = 0;
    for (const t of tables) {
      if (!t.rows.length) continue;
      let rowHits = 0;
      const distinct = new Set<number>();
      for (const rowText of t.rowTexts) {
        let matched = false;
        col.identities.forEach((id, idx) => {
          const k = normText(id);
          if (k.length >= 2 && rowText.indexOf(k) >= 0) { matched = true; distinct.add(idx); }
        });
        if (matched) rowHits += 1;
      }
      if (rowHits < Math.max(2, Math.ceil(t.rows.length * 0.5))) continue;
      if (distinct.size < Math.ceil(rowHits * 0.8)) continue;      // one row per record, not many-to-one
      if (rowHits > bestRowHits) { bestRowHits = rowHits; bound = t; }
    }
    const tableBound = bound != null;

    receipt.push({
      path: col.path || '(root)',
      records: n,
      identitiesSearched: usable,
      presentInPage: present,
      renderedFraction: Number(fraction.toFixed(3)),
      boundTableRows: tableBound ? bound!.rows.length : null,
    });

    // Under the threshold the page is a top-N summary, not a truncation bug —
    // reported in `checked` above and nowhere else. See FULL_RENDER_THRESHOLD.
    if (fraction < FULL_RENDER_THRESHOLD) continue;

    if (missing.length) {
      pushDefect(defects, counts, {
        code: REPORT_CODES.ROW_MISSING,
        line: tableBound ? lineAt(src, bound!.start) : 1,
        message: `The data at \`${col.path || '(root)'}\` has ${n} records but ${missing.length} of them appear NOWHERE on the page: ${missing.slice(0, 6).map((s) => JSON.stringify(String(s).slice(0, 40))).join(', ')}${missing.length > 6 ? `, +${missing.length - 6} more` : ''}.`,
        hint: 'Render every record you were given, or say in the page that it is a partial view and how many were left out. A silently truncated table reads as the complete answer.',
      });
    }

    // ROW_COUNT only when ROW_MISSING did not already fire: naming WHICH records
    // are absent strictly beats restating the same delta as a count. When every
    // record IS on the page but the table is short or long (a duplicated row, a
    // record printed outside the table) the count is the only signal there is.
    if (missing.length === 0 && tableBound && bound!.rows.length !== n) {
      pushDefect(defects, counts, {
        code: REPORT_CODES.ROW_COUNT,
        line: lineAt(src, bound!.start),
        message: `The table renders ${bound!.rows.length} body row(s) but the data at \`${col.path || '(root)'}\` has ${n} records — ${Math.abs(n - bound!.rows.length)} ${n > bound!.rows.length ? 'missing' : 'extra'}.`,
        hint: 'Emit exactly one <tr> per record. If you meant to show only some of them, state the cut ("top 10 of 23") in the page itself.',
      });
    }
  }
}

// ── CHECK 2: bars agree with their data ─────────────────────────────────────

/** Bind bars to a series: by the renderer's own index, else by label, else by order. */
function bindBars(bars: RenderedBar[], series: DataSeries): number[] | null {
  const out: number[] = new Array(bars.length).fill(-1);

  if (bars.every((b) => b.dataIndex != null)) {
    let bound = 0;
    bars.forEach((b, i) => {
      const di = b.dataIndex as number;
      if (di >= 0 && di < series.values.length) { out[i] = di; bound += 1; }
    });
    if (bound === bars.length) return out;
  }

  // Label binding: the bar's own row text names its datum.
  out.fill(-1);
  const used = new Set<number>();
  let bound = 0;
  bars.forEach((b, i) => {
    for (let j = 0; j < series.labels.length; j += 1) {
      if (used.has(j)) continue;
      const label = normText(series.labels[j]);
      if (label.length >= 2 && b.context.indexOf(label) >= 0) { out[i] = j; used.add(j); bound += 1; break; }
    }
  });
  if (bound === bars.length) return out;

  // Positional binding — only honest when the counts already agree.
  if (bars.length !== series.values.length) return null;
  for (let i = 0; i < bars.length; i += 1) out[i] = i;
  return out;
}

/** Pick the series a group of bars renders, from the page's own evidence. */
function seriesForBars(bars: RenderedBar[], allSeries: DataSeries[]): DataSeries | null {
  let best: DataSeries | null = null;
  let bestHits = 0;
  for (const s of allSeries) {
    const hits = s.labels.filter((l) => {
      const k = normText(l);
      return k.length >= 2 && bars.some((b) => b.context.indexOf(k) >= 0);
    }).length;
    if (hits > bestHits) { bestHits = hits; best = s; }
  }
  if (bestHits >= 2) return best;
  const byLength = allSeries.filter((s) => s.values.length === bars.length);
  if (byLength.length === 1) return byLength[0];
  // Ambiguous: several series could be this chart. Guessing here is how a
  // checker invents defects — say nothing instead.
  return null;
}

function checkBars(
  src: string, barGroups: RenderedBar[][], allSeries: DataSeries[],
  defects: any[], counts: any, receipt: any,
) {
  receipt.barGroups = barGroups.map((g) => g.length);
  receipt.boundBars = 0;

  for (const bars of barGroups) {
    const series = seriesForBars(bars, allSeries);
    if (!series) continue;

    if (series.values.length !== bars.length) {
      pushDefect(defects, counts, {
        code: REPORT_CODES.BAR_COUNT,
        line: lineAt(src, bars[0].start),
        message: `The chart draws ${bars.length} bar(s) but the series at \`${series.path || '(root)'}\` has ${series.values.length} value(s).`,
        hint: 'Draw one bar per value. A dropped bar silently removes a whole category from the reader\'s view of the data.',
      });
      continue;
    }

    const binding = bindBars(bars, series);
    if (!binding || binding.some((b) => b < 0)) continue;
    receipt.boundBars += bars.length;

    // A literal zero width is the GATE's rule (BROKEN_WIDTH_RE) — it already
    // reports it, so leave those bars out of the scale and out of our defects.
    const usable: number[] = [];
    for (let i = 0; i < bars.length; i += 1) if (bars[i].extent > 0 && series.values[binding[i]] > 0) usable.push(i);

    // A ROBUST scale: the MEDIAN of per-bar (extent / value). Least squares is
    // wrong here — one badly drawn bar drags the fit and the checker then reports
    // every OTHER bar as off, turning one defect into five.
    if (usable.length >= MIN_BARS_FOR_PROPORTION) {
      const ratios = usable.map((i) => bars[i].extent / series.values[binding[i]]).sort((a, b) => a - b);
      const mid = Math.floor(ratios.length / 2);
      const scale = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
      const maxValue = Math.max(...series.values.map((v) => Math.abs(v)));
      const fullScale = scale * maxValue;
      if (scale > 0 && fullScale > 0) {
        for (const i of usable) {
          const value = series.values[binding[i]];
          const expected = scale * value;
          const off = Math.abs(bars[i].extent - expected) / fullScale;
          if (off <= PROPORTION_TOLERANCE) continue;
          const unit = bars[i].unit === '%' ? '%' : '';
          pushDefect(defects, counts, {
            code: REPORT_CODES.BAR_PROPORTION,
            line: lineAt(src, bars[i].start),
            message: `The bar for ${JSON.stringify(series.labels[binding[i]])} (value ${value}) is drawn at ${round1(bars[i].extent)}${unit}, but every other bar in this chart puts it at ${round1(expected)}${unit} — off by ${Math.round(off * 100)}% of the full-scale bar. The chart misrepresents the data.`,
            hint: 'Every bar in one chart must use the SAME value→length scale. Compute each length from its datum with one formula (value / max * 100), never by writing the numbers out by hand.',
          });
        }
      }
    }

    // The number printed beside a bar must be that bar's own datum. This is the
    // case the gate explicitly cannot see ("42 should have been 45").
    const total = series.values.reduce((a, b) => a + b, 0);
    const maxValue = Math.max(...series.values.map((v) => Math.abs(v)));
    for (let i = 0; i < bars.length; i += 1) {
      const value = series.values[binding[i]];
      const ctx = bars[i].context;
      if (!ctx) continue;
      const nums = (ctx.match(/-?\d[\d,]*(?:\.\d+)?/g) || [])
        .map((s) => Number(s.replace(/,/g, ''))).filter((x) => Number.isFinite(x));
      if (!nums.length) continue;
      if (nums.some((x) => Math.abs(x - value) < 1e-9)) continue;
      // A share-of-total or share-of-max rendering is legitimate, not a mismatch.
      if (total > 0 && nums.some((x) => Math.abs(x - (value / total) * 100) < 0.6)) continue;
      if (maxValue > 0 && nums.some((x) => Math.abs(x - (value / maxValue) * 100) < 0.6)) continue;
      pushDefect(defects, counts, {
        code: REPORT_CODES.VALUE_MISMATCH,
        line: lineAt(src, bars[i].start),
        message: `The row for ${JSON.stringify(series.labels[binding[i]])} prints ${nums.slice(0, 3).join(', ')} but its datum is ${value}.`,
        hint: 'Print the figure your tools returned, unchanged, and use that same figure everywhere it appears on the page.',
      });
    }
  }
}

// ── CHECK 3: a width the cascade throws away ────────────────────────────────

/** Displays that BLOCKIFY their children, so a % width on the child does apply. */
const BLOCKIFYING_PARENT = /^(flex|inline-flex|grid|inline-grid)$/;

function checkCollapsedBars(src: string, root: HNode, rules: SimpleRule[], defects: any[], counts: any, receipt: any) {
  let examined = 0;
  walk(root, (n) => {
    if (RAW_TEXT_TAGS.has(n.tag)) return;
    const widthDecl = declarations(n.attrs.style).width;
    if (!widthDecl) return;
    const pct = pctLength(widthDecl);
    if (pct == null || pct <= 0) return;         // width:0 / NaN% / ${pct}% is the GATE's rule
    if (!looksLikeBar(n, rules)) return;
    examined += 1;

    const display = effectiveDisplay(n, rules);
    if (display === 'none') {
      pushDefect(defects, counts, {
        code: REPORT_CODES.ZERO_WIDTH,
        line: lineAt(src, n.start),
        message: `<${n.tag}> is given style="width:${widthDecl}" but its effective display is \`none\` — it is not rendered at all.`,
        hint: 'Remove the display:none rule that matches this element, or remove the element. A width on a display:none box is dead code.',
      });
      return;
    }
    if (display !== 'inline') return;

    // A flex/grid parent blockifies its children, so the % width DOES apply.
    const parent = n.parent;
    if (parent && parent.tag !== '#root' && BLOCKIFYING_PARENT.test(effectiveDisplay(parent, rules))) return;
    // position:absolute/fixed and float also blockify.
    const pos = resolvedProp(n, 'position', rules);
    if (pos === 'absolute' || pos === 'fixed') return;
    const float = resolvedProp(n, 'float', rules);
    if (float === 'left' || float === 'right') return;

    pushDefect(defects, counts, {
      code: REPORT_CODES.ZERO_WIDTH,
      line: lineAt(src, n.start),
      message: `<${n.tag}${n.attrs.class ? ` class="${n.attrs.class}"` : ''}> is given style="width:${widthDecl}" but its effective display is \`inline\` — CSS IGNORES width on a non-replaced inline box, so this bar renders with no length at all. The source looks right; the page will not.`,
      hint: 'Give the bar display:block or display:inline-block (or make its container display:flex). A <span> is inline by DEFAULT — that alone is enough to swallow the width.',
    });
  });
  receipt.percentWidthBars = examined;
}

// ── CHECK 4: a fixed-px child inside a narrower clipping ancestor ───────────

function checkOverflow(src: string, root: HNode, rules: SimpleRule[], defects: any[], counts: any) {
  walk(root, (n) => {
    const w = pxLength(resolvedProp(n, 'width', rules));
    if (w == null || w <= 0) return;
    for (let p = n.parent; p && p.tag !== '#root'; p = p.parent) {
      const pw = pxLength(resolvedProp(p, 'width', rules));
      if (pw == null || pw <= 0) continue;
      if (w <= pw) return;                        // fits its nearest sized ancestor
      const overflow = resolvedProp(p, 'overflow', rules) || resolvedProp(p, 'overflow-x', rules);
      if (overflow !== 'hidden' && overflow !== 'clip') return;
      pushDefect(defects, counts, {
        code: REPORT_CODES.OVERFLOW,
        line: lineAt(src, n.start),
        message: `<${n.tag}> is ${w}px wide inside a ${pw}px ancestor with overflow:${overflow} — ${Math.round(w - pw)}px of it is clipped and can never be seen.`,
        hint: 'Size the child from its container (a percentage, or max-width:100%), or widen the container. Content the reader cannot see is content you did not publish.',
      });
      return;
    }
  });
}

// ── CHECK 5: placeholder residue in VISIBLE TEXT ────────────────────────────

/**
 * Residue proving a value never made it into the string. Deliberately NOT
 * overlapping the gate: the gate looks for `${…}` inside a WIDTH DECLARATION
 * (a broken bar); this looks for it in the text a reader sees (a broken cell).
 */
const RESIDUE_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /\[object (?:Object|Array|Promise|Map|Set|Null|Undefined)\]/g, what: 'an object stringified instead of a field being picked off it' },
  { re: /\$\{[^}\n]{0,80}\}/g, what: 'an un-substituted JavaScript template placeholder' },
  { re: /\{\{[^}\n]{0,80}\}\}/g, what: 'an un-substituted moustache placeholder' },
  { re: /(?:^|[^\w.])(NaN)(?![\w])/g, what: 'NaN — an arithmetic result that was never a number' },
  { re: /(?:^|[^\w.])(-?Infinity)(?![\w])/g, what: 'Infinity — a division by zero reached the page' },
];

/** Bare `undefined`/`null` only when they are the WHOLE value of a cell — prose says these words legitimately. */
const BARE_NULLISH_RE = /^(undefined|null)$/i;
const CELLISH = new Set(['td', 'th', 'li', 'span', 'div', 'strong', 'em', 'b']);

function checkPlaceholders(src: string, root: HNode, defects: any[], counts: any, receipt: any) {
  let scanned = 0;
  for (const t of textNodes(root)) {
    const raw = t.value;
    scanned += raw.length;
    for (const probe of RESIDUE_PATTERNS) {
      probe.re.lastIndex = 0;
      let m;
      while ((m = probe.re.exec(raw)) !== null) {
        const hit = m[1] == null ? m[0] : m[1];
        pushDefect(defects, counts, {
          code: REPORT_CODES.PLACEHOLDER_TEXT,
          line: lineAt(src, t.start + m.index + m[0].indexOf(hit)),
          message: `The page prints ${JSON.stringify(hit.slice(0, 60))} as VISIBLE TEXT — ${probe.what}. A reader sees this literally.`,
          hint: 'Format the value before it reaches the page: pick the field you meant off the object, and guard the arithmetic so a missing input renders as an em dash rather than NaN.',
        });
        if (m.index === probe.re.lastIndex) probe.re.lastIndex += 1;
      }
    }
    const trimmed = decodeEntities(raw).trim();
    if (BARE_NULLISH_RE.test(trimmed) && CELLISH.has(t.parent.tag)) {
      pushDefect(defects, counts, {
        code: REPORT_CODES.PLACEHOLDER_TEXT,
        line: lineAt(src, t.start),
        message: `A <${t.parent.tag}> contains only the literal text "${trimmed}" — the value it was meant to hold was ${trimmed}.`,
        hint: 'Render an em dash (—) or "n/a" for a missing value; never let the JavaScript literal reach the reader.',
      });
    }
  }
  receipt.textCharsScanned = scanned;
}

// ── the entry point ─────────────────────────────────────────────────────────

export interface ReportCheckResult {
  ok: boolean;
  defects: Array<{ code: string; line: number | null; message: string; hint: string }>;
  /**
   * The PROBE RECEIPT — what was actually measured. A clean verdict with zeros
   * here is a broken probe, not a clean page. Always read it.
   */
  checked: any;
}

/**
 * Check a rendered page against the data it was built from.
 *
 * @param html  the exact HTML that would be published
 * @param data  whatever JSON the page was rendered from — collections and
 *              series are DISCOVERED inside it, never declared by the caller
 */
export function checkRenderedReport({ html, data }: { html: string; data: any }): ReportCheckResult {
  const src = typeof html === 'string' ? html : '';
  const defects: any[] = [];
  const counts: any = {};

  if (!src.trim()) {
    return {
      ok: false,
      defects: [{ code: 'empty-content', line: 1, message: 'No html was passed to the check.', hint: 'Pass the exact page source you are about to publish.' }],
      checked: { tables: 0, bodyRows: 0, bars: 0, barGroups: [], boundBars: 0, seriesInData: 0, collections: [] },
    };
  }

  const root = parseDocument(src);
  const rules = collectSimpleRules(root);
  const tables = discoverTables(root);
  const barGroups = discoverBars(root, rules);
  const discovered = discoverData(data);

  const receipt: any = {
    tables: tables.length,
    bodyRows: tables.reduce((a, t) => a + t.rows.length, 0),
    bars: barGroups.reduce((a, g) => a + g.length, 0),
    barGroups: [],
    boundBars: 0,
    seriesInData: discovered.series.length,
    collections: [],
  };

  checkCollections(src, root, tables, discovered.collections, defects, counts, receipt.collections);
  checkBars(src, barGroups, discovered.series, defects, counts, receipt);
  checkCollapsedBars(src, root, rules, defects, counts, receipt);
  checkOverflow(src, root, rules, defects, counts);
  checkPlaceholders(src, root, defects, counts, receipt);

  defects.sort((a, b) => (a.line || 0) - (b.line || 0));
  return { ok: defects.length === 0, defects, checked: receipt };
}

/** Test hook — the internals are implementation detail, but a probe deserves its own unit tests. */
export const __reportCheckInternals: any = { parseDocument, pathBBox, discoverData, textOf, collectSimpleRules, effectiveDisplay };

// ── the skill ───────────────────────────────────────────────────────────────

/**
 * Resolve the generic skill MCP server binary — identical rationale to
 * kvMemory.ts resolveSkillBin(): derive from import.meta.url so it works in
 * src/ (dev), dist/ (bundled), and node_modules/@zibby/skills/ (published).
 */
function resolveSkillBin(): string | null {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

/**
 * A pure, offline, zero-credential skill: it reads two arguments and returns
 * JSON. No network, no filesystem, no env — so it declares no `envKeys`, is not
 * `callsBackend`, and runs anywhere `@zibby/skills` is installed (the Fargate
 * run container AND the Copilot Lambda, which vendors the same tarball).
 */
export const reportCheckSkill: any = {
  id: 'report-check',
  serverName: 'report_check',
  allowedTools: ['mcp__report_check__*'],
  envKeys: [],
  description: 'Report check — verify a rendered report page against the DATA it was built from (row counts, bar proportionality, collapsed bars, placeholder residue) before publishing it.',

  promptFragment: `## Report Check (run this BEFORE you publish a data page)
When you are about to publish a page that RENDERS DATA — a table of records, a
bar chart, a set of meters — call \`report_check\` first with the exact \`html\`
you are about to publish and the \`data\` you built it from (the raw tool
results, as JSON). It compares the two and tells you where the page disagrees
with the data: a table short of rows, a bar drawn at the wrong length, a printed
number that is not its datum, a bar whose width the CSS silently throws away, an
\`[object Object]\` or an un-substituted \`\${…}\` left in a cell.

This is NOT the publish validator — that one runs server-side and checks the
MARKUP. This one checks the FACTS. Pass the data unchanged; do not write your own
expectations and do not describe the page. The check derives what must be true
from the data by itself.

Then READ the \`checked\` block in the result: it says how many tables, rows and
bars were actually found. If it reports 0 bars for a page full of bars, the check
never saw your chart and a clean verdict means nothing.`,

  resolve() {
    // Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs) pointing at this
    // module's reportCheckSkill export — same FIXED pattern as kvMemory /
    // datasetStore / chartRender (NEVER return { command: null }).
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env: {}, description: this.description };
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/reportCheck.js', 'reportCheckSkill'],
      env: {},
      description: this.description,
      // NO `alwaysLoad`: the SDK defers MCP tools behind ToolSearch by design and
      // ToolSearch reaches them — measured, see MCP_TOOL_LOADING.md.
    };
  },

  async handleToolCall(name, args) {
    if (name !== 'report_check') return JSON.stringify({ error: `Unknown tool: ${name}` });
    try {
      const html = typeof args?.html === 'string' ? args.html : '';
      if (!html.trim()) return JSON.stringify({ error: 'html is required — pass the exact page source you are about to publish.' });
      let data = args?.data;
      // The model may hand the data over as a JSON string; accept both.
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { return JSON.stringify({ error: 'data was a string but not valid JSON — pass the data as a JSON object.' }); }
      }
      if (data == null) return JSON.stringify({ error: 'data is required — pass the tool results the page was built from, unchanged.' });
      return JSON.stringify(checkRenderedReport({ html, data }));
    } catch (e: any) {
      return JSON.stringify({ error: `report_check failed: ${e.message}` });
    }
  },

  tools: [
    {
      name: 'report_check',
      description:
        'Pre-flight a data page BEFORE publishing it: compares the rendered HTML against the DATA it was built from and reports every place they disagree. '
        + 'Catches what the publish validator structurally cannot — a table that renders fewer rows than the data has records, a bar drawn at a length that is not proportional to its value, '
        + 'a number printed beside a bar that is not that bar\'s datum, a bar whose width is silently nullified by the CSS cascade, and placeholder residue ([object Object], NaN, an un-substituted ${…}) left in visible text. '
        + 'Pass the data UNCHANGED, exactly as your tools returned it (wrap a bare array as {"rows": [...]}) — the check discovers the collections and series inside it and derives what must be true on its own. Do NOT write your own expectations. '
        + 'Returns { ok, defects:[{code,line,message,hint}], checked }. Always read `checked`: it reports how many tables, rows and bars were found, so a clean `ok:true` with `bars: 0` on a chart page tells you the check never saw your chart.',
      input_schema: {
        type: 'object',
        properties: {
          html: { type: 'string', description: 'The exact HTML you are about to publish (the same string you would pass to artifact_publish).' },
          data: { type: 'object', description: 'The data the page was built from, as JSON — the raw tool results. Any shape: arrays of records and label/value series are found automatically. Wrap a bare top-level array as {"rows": [...]}.' },
        },
        required: ['html', 'data'],
      },
    },
  ],
};
