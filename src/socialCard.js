/**
 * socialCard.js — local, server-side "concept card" renderer (tier ①: API-only,
 * fully local — nothing leaves the box; no browser, no external service).
 *
 * WHAT IT IS
 * ──────────
 * A hand-written single-tool skill (same shape as chartRender.js / kvMemory.js:
 * `serverName`, `allowedTools`, `tools[]`, `handleToolCall`, and a `resolve()`
 * that spawns the GENERIC bin/mcp-skill.mjs). One tool — `social_card_render` —
 * takes STRUCTURED, agent-supplied fields (headline, eyebrow, subhead, stat,
 * footer, diagram, theme, accent) and renders a branded LinkedIn "concept card"
 * PNG in the Darren-Bounds style (bold headline + small uppercase eyebrow +
 * optional stat/footer + optional A—✓—B diagram).
 *
 * RENDER PIPELINE
 * ───────────────
 * A HAND-AUTHORED SVG string (NOT ECharts) → rasterized to PNG via
 * @resvg/resvg-js, EXACTLY like chartRender's renderPng() helper. No echarts
 * dependency — the composition is laid out here in plain SVG.
 *
 * FONTS — the agent container may ship NO fonts, and resvg renders EMPTY text
 * without one. We reuse the bundled Noto Sans Regular + Bold faces (the same
 * assets/fonts chartRender bundles) and set 'Noto Sans' as the default family.
 * `loadSystemFonts:true` stays on so a host WITH fonts can still satisfy exotic
 * glyphs (e.g. a ★ in a caller's stat) the bundled faces may lack. The one
 * glyph WE draw (the diagram checkmark) is a vector <path>, never a font glyph,
 * so it renders regardless of available fonts.
 *
 * OUTPUT FILES — same convention as chartRender: the PNG lands under the run's
 * session output dir (ZIBBY_NODE_SESSION_PATH / ZIBBY_SESSION_PATH) so the CLI
 * session-uploader auto-attaches it; local dev falls back to
 * <cwd>/.zibby/output/social-cards. The returned `path` can be passed to a
 * LinkedIn post's `imagePath`.
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

// Lazy, non-bundled native load (same rationale as chartRender.js): the shared
// esbuild build bundles anything imported statically, and @resvg/resvg-js is a
// NATIVE napi module that CANNOT be bundled. `_require(...)` is a runtime call
// esbuild leaves untouched.
const _require = createRequire(import.meta.url);

let _resvg = null;
/** Load the SVG→PNG rasterizer (isolated so a wasm variant could be swapped in). */
function loadResvg() {
  if (!_resvg) _resvg = _require('@resvg/resvg-js');
  return _resvg;
}

const DEFAULT_WIDTH = 1200;   // LinkedIn link-image 1.91:1
const DEFAULT_HEIGHT = 627;
const MAX_DIM = 4096;
const MIN_DIM = 320;
const DEFAULT_ACCENT = '#3b82f6'; // a tasteful blue
const FONT_FAMILY = 'Noto Sans';
const MAX_DIAGRAM_LABELS = 3;

/** Resolve the generic skill MCP server binary (same derivation as chartRender.js). */
function resolveSkillBin() {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

/** The bundled OFL Noto Sans faces (shared with chartRender.js). */
function bundledFontFiles() {
  const here = dirname(fileURLToPath(import.meta.url));
  const fontsDir = resolvePath(here, '..', 'assets', 'fonts');
  return ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf']
    .map((f) => join(fontsDir, f))
    .filter((p) => existsSync(p));
}

/** The run's artifact/output dir (same convention as chartRender.resolveOutputDir). */
function resolveOutputDir() {
  const nodeDir = process.env.ZIBBY_NODE_SESSION_PATH;
  const sessionDir = process.env.ZIBBY_SESSION_PATH;
  const dir = nodeDir
    || (sessionDir ? join(sessionDir, 'social-card') : join(process.cwd(), '.zibby', 'output', 'social-cards'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Clamp a requested dimension into [MIN_DIM, MAX_DIM]; NaN → fallback. */
function clampDim(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(MIN_DIM, Math.min(MAX_DIM, Math.round(n)));
}

/** XML-escape a string for safe embedding in SVG text/attributes. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Sanitize a caller-supplied filename into a safe basename (no paths, no extension). */
function sanitizeFilename(name) {
  if (typeof name !== 'string') return null;
  const base = name.trim()
    .replace(/\.(png|svg)$/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return base || null;
}

/** Validate a hex color (#rgb / #rrggbb); return the fallback otherwise. */
function safeColor(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const s = value.trim();
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s) ? s : fallback;
}

/** Rough text width estimate — chars * fontSize * per-family factor. */
function estWidth(text, fontSize, factor) {
  return String(text).length * fontSize * factor;
}

/**
 * Greedy word-wrap `text` into lines that each estimate under `maxWidth` at the
 * given font size. A single over-long word is placed on its own line (it may
 * slightly overflow — better than dropping it).
 */
function wrapText(text, maxWidth, fontSize, factor) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (line && estWidth(candidate, fontSize, factor) > maxWidth) {
      lines.push(line);
      line = w;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/** Theme palette. Dark is the default (matches the reference concept cards). */
function palette(theme) {
  if (theme === 'light') {
    return { bg: '#ffffff', fg: '#0b0f14', muted: '#5b6673', pillText: '#0b0f14', checkFg: '#ffffff', divider: '#e2e6ea' };
  }
  return { bg: '#0b0f14', fg: '#e9edf1', muted: '#8b98a5', pillText: '#e9edf1', checkFg: '#0b0f14', divider: '#22303c' };
}

/**
 * Build the diagram (A —✓— B [ —✓— C ]) as SVG: rounded-rect pills joined by a
 * connector line with a vector checkmark in an accent circle. Returns
 * { svg, height } or null when there is nothing to draw. Centered on `cx`.
 */
function buildDiagram(labels, cx, topY, pal, accent) {
  const clean = (Array.isArray(labels) ? labels : [])
    .map((l) => String(l == null ? '' : l).trim())
    .filter(Boolean)
    .slice(0, MAX_DIAGRAM_LABELS);
  if (clean.length < 2) return null;

  const pillFs = 24;
  const pillH = 54;
  const padX = 26;
  const connectorW = 90;
  const r = 17; // check circle radius

  const pillWidths = clean.map((l) => Math.max(96, estWidth(l, pillFs, 0.58) + padX * 2));
  const chainW = pillWidths.reduce((a, b) => a + b, 0) + connectorW * (clean.length - 1);
  let x = cx - chainW / 2;
  const midY = topY + pillH / 2;
  const parts = [];

  for (let i = 0; i < clean.length; i++) {
    const w = pillWidths[i];
    parts.push(
      `<rect x="${x.toFixed(1)}" y="${topY}" width="${w.toFixed(1)}" height="${pillH}" rx="${pillH / 2}" `
      + `fill="${accent}" fill-opacity="0.12" stroke="${accent}" stroke-opacity="0.55" stroke-width="1.5"/>`,
      `<text x="${(x + w / 2).toFixed(1)}" y="${(midY + pillFs * 0.35).toFixed(1)}" text-anchor="middle" `
      + `font-family="${FONT_FAMILY}" font-size="${pillFs}" font-weight="700" fill="${pal.pillText}">${esc(clean[i])}</text>`,
    );
    x += w;
    if (i < clean.length - 1) {
      const segStart = x;
      const segEnd = x + connectorW;
      const ccx = (segStart + segEnd) / 2;
      // connector line behind the check circle
      parts.push(
        `<line x1="${segStart.toFixed(1)}" y1="${midY}" x2="${segEnd.toFixed(1)}" y2="${midY}" `
        + `stroke="${accent}" stroke-opacity="0.55" stroke-width="2"/>`,
        `<circle cx="${ccx.toFixed(1)}" cy="${midY}" r="${r}" fill="${accent}"/>`,
        // vector checkmark (never a font glyph → renders without any font)
        `<path d="M ${(ccx - 8).toFixed(1)} ${midY.toFixed(1)} l 5 5 l 9 -11" `
        + `fill="none" stroke="${pal.checkFg}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
      x = segEnd;
    }
  }
  return { svg: parts.join('\n'), height: pillH };
}

/**
 * Compose the full card SVG string from the structured fields. Pure layout —
 * no I/O. All text is XML-escaped; the headline is word-wrapped and its font
 * size auto-fit; the whole stack is vertically centered.
 */
function buildCardSvg(opts) {
  const { width, height, theme, accent } = opts;
  const pal = palette(theme);
  const cx = width / 2;
  const pad = Math.round(width * 0.07);
  const availW = width - pad * 2;

  const headline = String(opts.headline).trim();
  const eyebrow = opts.eyebrow ? String(opts.eyebrow).trim().toUpperCase() : '';
  const subhead = opts.subhead ? String(opts.subhead).trim() : '';
  const stat = opts.stat ? String(opts.stat).trim() : '';
  const footer = opts.footer ? String(opts.footer).trim() : '';

  const scale = width / DEFAULT_WIDTH;

  // Fixed-size pieces (independent of the headline font size).
  const eyebrowFs = Math.round(22 * scale);
  const subFs = Math.round(29 * scale);
  const subLines = subhead ? wrapText(subhead, availW, subFs, 0.52) : [];
  const subLH = Math.round(subFs * 1.28);

  const ruleH = 4;
  const gapAfterRule = Math.round(26 * scale);
  const gapAfterEyebrow = Math.round(20 * scale);
  const gapAfterHead = Math.round(24 * scale);
  const gapBeforeDiagram = Math.round(30 * scale);

  // The footer row occupies a reserved band at the very bottom; the centered
  // content stack must fit ENTIRELY inside `region` (above that band). A taller
  // headline shrinks to fit — it never overflows downward, which is what let a
  // 4-line headline push the subhead's descenders into the footer text.
  const hasFooterRow = Boolean(stat || footer);
  const topSafe = pad;
  const bottomSafe = hasFooterRow ? Math.round(110 * scale) : pad;
  const region = height - topSafe - bottomSafe;

  const diagramProbe = buildDiagram(opts.diagram, cx, 0, pal, accent);

  // HEIGHT-AWARE auto-fit: largest headline size whose WHOLE stack (rule +
  // eyebrow + wrapped headline + subhead + diagram) fits within `region` in
  // <= maxLines lines. Falls back to the smallest candidate if nothing fits.
  const measureStack = (fs, lines) => {
    let h = ruleH + gapAfterRule;
    if (eyebrow) h += eyebrowFs + gapAfterEyebrow;
    h += lines.length * Math.round(fs * 1.16);
    if (subLines.length) h += gapAfterHead + subLines.length * subLH;
    if (diagramProbe) h += gapBeforeDiagram + diagramProbe.height;
    return h;
  };
  const candidates = [76, 66, 58, 50, 44, 38].map((s) => Math.round(s * scale));
  const maxLines = 4;
  let headFs = candidates[candidates.length - 1];
  let headLines = wrapText(headline, availW, headFs, 0.6);
  for (const fs of candidates) {
    const lines = wrapText(headline, availW, fs, 0.6);
    if (lines.length <= maxLines && measureStack(fs, lines) <= region) {
      headFs = fs; headLines = lines; break;
    }
  }
  const headLH = Math.round(headFs * 1.16);
  const stackH = measureStack(headFs, headLines);

  // Center the stack within the region that sits above the footer band.
  let y = topSafe + Math.max(0, (region - stackH) / 2);

  const parts = [];
  // Background
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${pal.bg}"/>`);

  // Accent rule (brand mark) — short, centered.
  const ruleW = Math.round(60 * scale);
  parts.push(`<rect x="${(cx - ruleW / 2).toFixed(1)}" y="${y}" width="${ruleW}" height="${ruleH}" rx="2" fill="${accent}"/>`);
  y += ruleH + gapAfterRule;

  // Eyebrow (small uppercase kicker, accent, letter-spaced).
  if (eyebrow) {
    parts.push(
      `<text x="${cx}" y="${(y + eyebrowFs * 0.82).toFixed(1)}" text-anchor="middle" `
      + `font-family="${FONT_FAMILY}" font-size="${eyebrowFs}" font-weight="700" letter-spacing="3" `
      + `fill="${accent}">${esc(eyebrow)}</text>`,
    );
    y += eyebrowFs + gapAfterEyebrow;
  }

  // Headline (big, bold, wrapped, centered).
  for (const line of headLines) {
    parts.push(
      `<text x="${cx}" y="${(y + headFs * 0.82).toFixed(1)}" text-anchor="middle" `
      + `font-family="${FONT_FAMILY}" font-size="${headFs}" font-weight="700" fill="${pal.fg}">${esc(line)}</text>`,
    );
    y += headLH;
  }

  // Subhead (one/few supporting lines, muted).
  if (subLines.length) {
    y += gapAfterHead;
    for (const line of subLines) {
      parts.push(
        `<text x="${cx}" y="${(y + subFs * 0.82).toFixed(1)}" text-anchor="middle" `
        + `font-family="${FONT_FAMILY}" font-size="${subFs}" font-weight="400" fill="${pal.muted}">${esc(line)}</text>`,
      );
      y += subLH;
    }
  }

  // Diagram (A —✓— B chain), centered under the stack.
  if (diagramProbe) {
    y += gapBeforeDiagram;
    const diagram = buildDiagram(opts.diagram, cx, y, pal, accent);
    if (diagram) parts.push(diagram.svg);
  }

  // Footer row: footer bottom-left, stat bottom-right (accent).
  if (hasFooterRow) {
    const footFs = Math.round(24 * scale);
    const footY = height - Math.round(46 * scale);
    if (footer) {
      parts.push(
        `<text x="${pad}" y="${footY}" text-anchor="start" `
        + `font-family="${FONT_FAMILY}" font-size="${footFs}" font-weight="400" fill="${pal.muted}">${esc(footer)}</text>`,
      );
    }
    if (stat) {
      parts.push(
        `<text x="${width - pad}" y="${footY}" text-anchor="end" `
        + `font-family="${FONT_FAMILY}" font-size="${footFs}" font-weight="700" fill="${accent}">${esc(stat)}</text>`,
      );
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `
    + `viewBox="0 0 ${width} ${height}">\n${parts.join('\n')}\n</svg>`;
}

/** Rasterize an SVG string to PNG bytes via resvg (bundled + system fonts). */
function renderPng(svg) {
  const { Resvg } = loadResvg();
  const resvg = new Resvg(svg, {
    font: {
      fontFiles: bundledFontFiles(),
      loadSystemFonts: true,
      defaultFontFamily: FONT_FAMILY,
    },
  });
  return resvg.render().asPng();
}

export const socialCardSkill = {
  id: 'social-card',
  serverName: 'social_card',
  allowedTools: ['mcp__social_card__*'],
  description: 'Social card — render a branded LinkedIn "concept card" PNG locally (bold headline + eyebrow + optional stat/footer/diagram); nothing leaves the box',

  promptFragment: `## Social Card (branded concept card, local)
You can render a BRANDED concept card PNG with the social_card_render tool — the
clean, high-signal LinkedIn "concept card" style (bold headline + small uppercase
eyebrow + optional stat/footer + optional A—✓—B diagram). Give it STRUCTURED
fields that capture the ONE key idea of your post:
- headline (required): the big, bold line — the single takeaway.
- eyebrow: a short uppercase kicker (e.g. "MY WORKFLOW", "OPEN SOURCE").
- subhead: one supporting line under the headline.
- stat / footer: e.g. stat "11.8k stars", footer "Apache 2.0".
- diagram: 2-3 short labels rendered as a chain, e.g. ["Claude Code","Codex"].
- theme ('dark' default | 'light'), accent (hex).
It renders server-side to a PNG in the run's output folder and returns
{ ok:true, files:[{ path, format:'png', bytes }] }. Pass the returned \`path\` as
\`imagePath\` when you draft/publish a LinkedIn post to ATTACH the card as the
post image. No browser, no external service — the data never leaves the machine.`,

  resolve({ sessionPath, nodeName } = {}) {
    // Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs) pointing at this
    // module's socialCardSkill export — same FIXED pattern as chartRender.js.
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env: {}, description: this.description };
    const env = {};
    const nodeSessionPath = (sessionPath && nodeName) ? join(sessionPath, nodeName) : null;
    if (nodeSessionPath) env.ZIBBY_NODE_SESSION_PATH = nodeSessionPath;
    if (sessionPath) env.ZIBBY_SESSION_PATH = sessionPath;
    // Engine path (tool-resolver) calls resolve() with NO args — fall back to
    // the env the workflow-executor already set on the agent process.
    for (const key of ['ZIBBY_NODE_SESSION_PATH', 'ZIBBY_SESSION_PATH']) {
      if (!env[key] && process.env[key]) env[key] = process.env[key];
    }
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/socialCard.js', 'socialCardSkill'],
      env,
      description: this.description,
      // Force tools into the system prompt instead of deferring behind the
      // SDK's ToolSearch (same as chartRender.js / github.js).
      alwaysLoad: true,
    };
  },

  async handleToolCall(name, args) {
    if (name !== 'social_card_render') {
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
    try {
      const headline = args?.headline;
      if (typeof headline !== 'string' || !headline.trim()) {
        return JSON.stringify({ error: 'headline (the big bold line) is required and must be a non-empty string.' });
      }

      const width = clampDim(args?.width, DEFAULT_WIDTH);
      const height = clampDim(args?.height, DEFAULT_HEIGHT);
      const theme = args?.theme === 'light' ? 'light' : 'dark';
      const accent = safeColor(args?.accent, DEFAULT_ACCENT);

      let svg;
      try {
        svg = buildCardSvg({
          width, height, theme, accent,
          headline,
          eyebrow: args?.eyebrow,
          subhead: args?.subhead,
          stat: args?.stat,
          footer: args?.footer,
          diagram: args?.diagram,
        });
      } catch (e) {
        return JSON.stringify({ error: `Card layout failed: ${e.message}` });
      }

      let png;
      try {
        png = renderPng(svg);
      } catch (e) {
        return JSON.stringify({ error: `PNG rasterization failed: ${e.message}` });
      }

      const outDir = resolveOutputDir();
      const basename = sanitizeFilename(args?.filename) || `social-card-${Date.now()}`;
      const p = join(outDir, `${basename}.png`);
      writeFileSync(p, png);

      const files = [{ path: p, format: 'png', bytes: png.length }];
      if (args?.output === 'both' || args?.output === 'svg') {
        const sp = join(outDir, `${basename}.svg`);
        writeFileSync(sp, svg, 'utf-8');
        files.push({ path: sp, format: 'svg', bytes: Buffer.byteLength(svg, 'utf-8') });
      }
      return JSON.stringify({ ok: true, width, height, theme, files });
    } catch (e) {
      return JSON.stringify({ error: `social_card_render failed: ${e.message}` });
    }
  },

  tools: [
    {
      name: 'social_card_render',
      description: 'Render a BRANDED "concept card" PNG LOCALLY (no external service) from structured fields — the clean LinkedIn concept-card style: bold headline + small uppercase eyebrow + optional supporting subhead, stat, footer, and an A—✓—B diagram. '
        + 'Returns { ok:true, files:[{ path, format:"png", bytes }] }. Pass the returned `path` as `imagePath` to a LinkedIn post tool to attach it as the post image. '
        + 'Example: { "headline":"No more copy-paste between AI tools", "eyebrow":"MY WORKFLOW", "stat":"11.8k stars", "footer":"Apache 2.0", "diagram":["Claude Code","Codex"] }.',
      input_schema: {
        type: 'object',
        properties: {
          headline: { type: 'string', description: 'REQUIRED. The big, bold line — the single key idea/takeaway. Word-wrapped + auto-sized.' },
          eyebrow: { type: 'string', description: 'Small uppercase kicker above the headline (e.g. "MY WORKFLOW", "OPEN SOURCE"). Rendered uppercased in the accent color.' },
          subhead: { type: 'string', description: 'One supporting line under the headline (muted).' },
          stat: { type: 'string', description: 'Optional stat, shown bottom-right in the accent color (e.g. "11.8k stars", "3x faster").' },
          footer: { type: 'string', description: 'Optional footer, shown bottom-left (muted) (e.g. "Apache 2.0", a repo name).' },
          diagram: { type: 'array', items: { type: 'string' }, description: 'Optional 2-3 short labels rendered as a chain of pills joined by a checkmark (A —✓— B), e.g. ["Claude Code","Codex"].' },
          theme: { type: 'string', enum: ['dark', 'light'], description: "Card theme (default 'dark' — near-black bg, off-white text)." },
          accent: { type: 'string', description: 'Accent hex color (e.g. "#f97316"). Defaults to a tasteful blue (#3b82f6).' },
          width: { type: 'number', description: 'Image width in px (default 1200 — LinkedIn 1.91:1 link image).' },
          height: { type: 'number', description: 'Image height in px (default 627).' },
          filename: { type: 'string', description: 'Optional file basename (no extension); defaults to social-card-<timestamp>.' },
          output: { type: 'string', enum: ['png', 'both'], description: "Which file(s) to write (default 'png'; 'both' also writes the .svg)." },
        },
        required: ['headline'],
      },
    },
  ],
};
