/**
 * chartRender.js — local, server-side chart rendering skill (tier ①: API-only,
 * fully local — data NEVER leaves the box; no browser, no external service).
 *
 * WHAT IT IS
 * ──────────
 * A hand-written multi-tool skill (same shape as kvMemory.js / datasetStore.js /
 * github.js): `serverName`, `allowedTools`, `tools[]`, `handleToolCall`, and a
 * `resolve()` that spawns the GENERIC bin/mcp-skill.mjs. One tool —
 * `chart_render` — takes a RAW Apache ECharts option object (pass-through
 * dialect, NO invented normalized schema), renders it to SVG via ECharts'
 * zero-dependency pure-SVG SSR, and rasterizes to PNG via @resvg/resvg-js
 * (napi-rs PREBUILT binaries — no node-gyp; the code is structured so the
 * @resvg/resvg-wasm variant could be swapped in via loadResvg() if a target
 * ever lacks a prebuild).
 *
 * RENDER PIPELINE (validated by the research spike)
 * ─────────────────────────────────────────────────
 *   echarts.init(null, null, { renderer:'svg', ssr:true, width, height })
 *     → chart.setOption(spec) → chart.renderToSVGString() → chart.dispose()
 *     → (png/both) new Resvg(svg, { font }) → .render().asPng()
 *
 * FONTS — the agent container (node:20-bullseye-slim) may ship NO fonts, and
 * resvg renders EMPTY text without one. We bundle Noto Sans Regular + Bold
 * (SIL OFL 1.1 — license file alongside, assets/fonts/OFL.txt) and pass them
 * via resvg `font.fontFiles` + set 'Noto Sans' as the default ECharts
 * textStyle.fontFamily. `loadSystemFonts:true` stays on so a host WITH fonts
 * can still satisfy exotic families the spec asks for.
 *
 * OUTPUT FILES — same convention as the other artifact-writing surfaces:
 * files land under the run's session output dir so the CLI session-uploader
 * (which scans `<sessionPath>/<nodeName>/**`) auto-uploads them with the run:
 *   1. ZIBBY_NODE_SESSION_PATH   (browser.js convention — <sessionPath>/<node>)
 *   2. ZIBBY_SESSION_PATH/chart-render  (a node-shaped folder the uploader sees)
 *   3. <cwd>/.zibby/output/charts       (local dev fallback, agent-workflow's
 *      DEFAULT_OUTPUT_BASE '.zibby/output')
 *
 * INLINE SVG (`output:'svg-inline'`) — the HTML-page path. A published
 * artifact/report page is strictly SELF-CONTAINED (a strict CSP blocks every
 * external host), so a file on disk is useless to it: the chart can only
 * appear as an inline <svg> element. This path writes NO file and returns the
 * markup in the tool result. See prepareInlineSvg() for the three transforms
 * that make ECharts' SSR output actually safe to paste into an HTML document
 * (they are NOT free — each one is a hazard verified against real output).
 *
 * SAFETY INJECTIONS before render (never trusts SSR text measurement):
 *   - spec must be a plain JSON object (validated; clear errors for the LLM)
 *   - animation is FORCED off (SSR has no frames)
 *   - backgroundColor defaults to '#fff' (PNG would otherwise be transparent)
 *   - width/height default 800×600, capped at 4096, floored at 16
 *   - very long labels in known label slots are truncated (SSR text
 *     measurement is estimated — unbounded labels overflow the canvas)
 */

import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

// Lazy, non-bundled dependency loading (same rationale as chat-memory.js):
// the shared esbuild build bundles anything imported statically that isn't in
// its external list — echarts (~1MB of pure JS) must stay a normal node_modules
// dependency and @resvg/resvg-js is a NATIVE napi module that CANNOT be
// bundled. `_require(...)` is a runtime call esbuild leaves untouched.
const _require = createRequire(import.meta.url);

let _echarts = null;
function loadEcharts() {
  if (!_echarts) _echarts = _require('echarts');
  return _echarts;
}

let _resvg = null;
/**
 * Load the SVG→PNG rasterizer. Isolated behind one function so the
 * @resvg/resvg-wasm variant (needs explicit fontBuffers, zero native code)
 * could be swapped in here without touching the render path.
 */
function loadResvg() {
  if (!_resvg) _resvg = _require('@resvg/resvg-js');
  return _resvg;
}

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 600;
const MAX_DIM = 4096;
const MIN_DIM = 16;
const MAX_LABEL_LEN = 60;
const FONT_FAMILY = 'Noto Sans';

/**
 * Ceiling on a RETURNED inline SVG. This is NOT the artifact page's 16MB
 * ceiling — it is far tighter, because an inline SVG is returned through the
 * model's context window and must be copied verbatim into the page. Measured
 * real SSR output (echarts 6.1.0, 800×600): 5-bar 3.7KB · 50-bar 12.7KB ·
 * 1000-point line 21.6KB · 5k-point scatter 1.1MB · 50k-point scatter 11.3MB.
 * 256KiB is ~20x the largest sane presentation chart while still refusing the
 * point-cloud cases that would blow up both the context and the page.
 */
const MAX_INLINE_SVG_BYTES = 256 * 1024;

/**
 * Resolve the generic skill MCP server binary — identical rationale to
 * kvMemory.js resolveSkillBin(): derive from import.meta.url so it works in
 * src/ (dev), dist/ (bundled), and node_modules/@zibby/skills/ (published).
 */
function resolveSkillBin() {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

/**
 * The bundled OFL Noto Sans faces. src/ and dist/ are both one level below
 * the package root, so `../assets/fonts` resolves in dev, built, and
 * published installs alike. Returns only files that exist so a partial
 * install degrades to system fonts instead of crashing resvg.
 */
function bundledFontFiles() {
  const here = dirname(fileURLToPath(import.meta.url));
  const fontsDir = resolvePath(here, '..', 'assets', 'fonts');
  return ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf']
    .map((f) => join(fontsDir, f))
    .filter((p) => existsSync(p));
}

/**
 * The directory chart files are written to — the run's artifact/output dir
 * (see the header). Creates it if missing.
 */
function resolveOutputDir() {
  const nodeDir = process.env.ZIBBY_NODE_SESSION_PATH;
  const sessionDir = process.env.ZIBBY_SESSION_PATH;
  const dir = nodeDir
    || (sessionDir ? join(sessionDir, 'chart-render') : join(process.cwd(), '.zibby', 'output', 'charts'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A plain JSON-ish object (not null, not an array). */
function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** Clamp a requested dimension into [MIN_DIM, MAX_DIM]; NaN → fallback. */
function clampDim(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(MIN_DIM, Math.min(MAX_DIM, Math.round(n)));
}

/** Truncate one label string; SSR text measurement is estimated, so unbounded labels overflow. */
function truncateLabel(s) {
  if (typeof s !== 'string' || s.length <= MAX_LABEL_LEN) return s;
  return `${s.slice(0, MAX_LABEL_LEN - 1)}…`;
}

/** Truncate the string entries of a category-data / legend-data array in place. */
function truncateDataLabels(arr) {
  if (!Array.isArray(arr)) return;
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (typeof item === 'string') arr[i] = truncateLabel(item);
    else if (isPlainObject(item) && typeof item.name === 'string') item.name = truncateLabel(item.name);
  }
}

/**
 * Guard the known label slots against very long strings: radar indicator
 * names, category axis data, legend data, and per-datum names. Operates on
 * the CLONED spec only — the caller's object is never mutated.
 */
function truncateLongLabels(spec) {
  for (const axisKey of ['xAxis', 'yAxis']) {
    const axes = Array.isArray(spec[axisKey]) ? spec[axisKey] : (spec[axisKey] ? [spec[axisKey]] : []);
    for (const axis of axes) {
      if (isPlainObject(axis)) truncateDataLabels(axis.data);
    }
  }
  const radars = Array.isArray(spec.radar) ? spec.radar : (spec.radar ? [spec.radar] : []);
  for (const radar of radars) {
    if (isPlainObject(radar)) truncateDataLabels(radar.indicator);
  }
  if (isPlainObject(spec.legend)) truncateDataLabels(spec.legend.data);
  const series = Array.isArray(spec.series) ? spec.series : (spec.series ? [spec.series] : []);
  for (const s of series) {
    if (isPlainObject(s)) {
      if (typeof s.name === 'string') s.name = truncateLabel(s.name);
      truncateDataLabels(s.data);
    }
  }
}

/**
 * Deep-clone the caller's spec (tolerating whatever JSON-safe shape the LLM
 * sent — unknown props pass straight through to ECharts) and force the SSR
 * safety defaults on the CLONE.
 */
function prepareSpec(spec) {
  const prepared = JSON.parse(JSON.stringify(spec));
  prepared.animation = false;                                 // SSR has no frames — always forced
  if (prepared.backgroundColor == null) prepared.backgroundColor = '#fff';
  // Default font family → the bundled face, so SVG text matches what resvg
  // can actually rasterize. An explicit user fontFamily wins.
  if (!isPlainObject(prepared.textStyle)) prepared.textStyle = {};
  if (prepared.textStyle.fontFamily == null) prepared.textStyle.fontFamily = FONT_FAMILY;
  truncateLongLabels(prepared);
  return prepared;
}

/** Sanitize a caller-supplied filename into a safe basename (no paths, no extension). */
function sanitizeFilename(name) {
  if (typeof name !== 'string') return null;
  const base = name.trim()
    .replace(/\.(svg|png)$/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return base || null;
}

/** Render the prepared spec to an SVG string via ECharts zero-dep SSR. */
function renderSvg(spec, width, height) {
  const echarts = loadEcharts();
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height });
  try {
    chart.setOption(spec);
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}

/**
 * ── INLINE-SVG SAFETY ─────────────────────────────────────────────────────
 * ECharts SSR output is NOT safe to paste into an HTML document as-is. Three
 * hazards, each VERIFIED against real echarts 6.1.0 output (not assumed):
 *
 *  1. THE <style> BLOCK IS DOCUMENT-GLOBAL. An inline <svg> in HTML is not a
 *     scoping boundary, so `<style><![CDATA[ .zr0-cls-1:hover{…} ]]></style>`
 *     leaks into the whole page's stylesheet. Worse, its declarations are
 *     built from caller-supplied colour strings with no escaping, so a spec
 *     with emphasis.itemStyle.color = "red} .x{display:none} @import url(…);"
 *     injects arbitrary page-wide CSS (reproduced verbatim). The block only
 *     ever carries :hover cursor/fill polish, so we DROP it: removing the
 *     concept kills the leak, the injection, and the class-name collision
 *     below all at once. Losing a hover tint on a static page is the right
 *     trade against writing CSS into someone else's document.
 *
 *  2. IDs ARE ONLY UNIQUE WITHIN ONE PROCESS. zrender namespaces gradients and
 *     clip paths as `zr<N>-g0` / `zr<N>-c0`, where N is a per-process counter
 *     that restarts at 0. Two charts rendered in two tool calls therefore both
 *     emit `id="zr0-g0"`, and duplicate IDs in one HTML document mean the
 *     second chart silently resolves `url(#zr0-g0)` to the FIRST chart's
 *     gradient — wrong colours, no error. We re-namespace every id + local
 *     reference to a per-render random prefix.
 *
 *  3. EXTERNAL REFERENCES ARE REACHABLE FROM THE SPEC. `symbol:'image://https
 *     ://host/x.png'` makes ECharts emit `<image href="https://host/x.png">`
 *     (reproduced). The artifact CSP blocks every external host, so that is a
 *     guaranteed-broken render — and an outbound beacon from a published page.
 *     We REJECT rather than silently strip: a chart missing its marks should
 *     fail loudly with an actionable message, not ship broken.
 *
 * Only the inline path runs these. The file-writing paths are untouched and
 * byte-identical — a .svg file on disk has none of these three problems.
 */

/** Drop the hover-only <style> block (hazard 1). Text content is entity-escaped, so `</style>` cannot appear inside a label and terminate the match early. */
function stripStyleBlocks(svg) {
  return svg.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
}

/**
 * Re-namespace zrender's per-process `zr<N>-…` tokens to a per-render prefix
 * (hazard 2). The three patterns are anchored on `id="`, `url(#` and `class="`
 * — a text label cannot forge any of them because `"` is escaped to `&quot;`
 * in content, so this can never rewrite user data.
 */
function namespaceIds(svg, prefix) {
  return svg
    .replace(/id="zr\d+-/g, `id="${prefix}-`)
    .replace(/url\(#zr\d+-/g, `url(#${prefix}-`)
    .replace(/class="zr\d+-/g, `class="${prefix}-`);
}

/**
 * Find anything that would make the page reach off-host (hazard 3). Allows the
 * two self-contained forms: a local fragment (`#id`) and a `data:` URI.
 */
function findExternalRefs(svg) {
  const offenders = [];
  for (const m of svg.matchAll(/(?:xlink:)?href\s*=\s*"([^"]*)"/gi)) {
    const v = m[1].trim();
    if (v && !v.startsWith('#') && !/^data:/i.test(v)) offenders.push(v);
  }
  for (const m of svg.matchAll(/url\(\s*['"]?([^'")]*)['"]?\s*\)/gi)) {
    const v = m[1].trim();
    if (v && !v.startsWith('#') && !/^data:/i.test(v)) offenders.push(v);
  }
  if (/@import/i.test(svg)) offenders.push('@import');
  if (/<script\b/i.test(svg)) offenders.push('<script>');
  if (/<foreignObject\b/i.test(svg)) offenders.push('<foreignObject>');
  return offenders;
}

/**
 * Turn raw SSR output into markup that is safe to paste straight into an HTML
 * document. Throws with an actionable message when the spec produced something
 * that cannot be made self-contained. ECharts SSR emits no <?xml?> prolog and
 * no DOCTYPE (verified), so there is nothing to strip there.
 */
function prepareInlineSvg(svg) {
  const cleaned = namespaceIds(stripStyleBlocks(svg), `chart-${randomBytes(4).toString('hex')}`);
  const offenders = findExternalRefs(cleaned);
  if (offenders.length) {
    const list = [...new Set(offenders)].slice(0, 3).join(', ');
    throw new Error(
      `the rendered chart references external resources (${list}), which a self-contained HTML page blocks. `
      + 'Remove image:// symbols / external image fills from the spec (use plain colors or a data: URI), or use '
      + "output:'svg' to write a file instead.",
    );
  }
  return cleaned;
}

/** Rasterize an SVG string to PNG bytes via resvg (bundled fonts + system fonts). */
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

export const chartRenderSkill: any = {
  id: 'chart-render',
  serverName: 'chart_render',
  allowedTools: ['mcp__chart_render__*'],
  description: 'Chart render — local server-side chart rendering (Apache ECharts SVG SSR + resvg PNG); data never leaves the box',

  promptFragment: `## Chart Render (local, no external service)
You can render charts LOCALLY with the chart_render tool — pass a standard
Apache ECharts option object as \`spec\` (any chart type: bar, line, pie,
radar, scatter, heatmap, …). No browser, no external chart service — the data
never leaves the machine. Don't set animation (it's forced off).

Pick the destination with \`output\`:
- **Building an HTML page / artifact / report → \`output:'svg-inline'\`.** It
  returns the \`svg\` markup in the result; paste that <svg> element straight
  into your HTML. A published page is self-contained and blocks every external
  host, so a file path is useless there — inline is the ONLY way a chart shows
  up. Never hand-write bar/gauge markup with percentage widths; let ECharts
  compute the geometry from the data so the bars cannot come out wrong.
- **Attaching a chart to the run → \`output:'png'\` (default), \`'svg'\` or
  \`'both'\`.** Writes files to the run's output folder (auto-uploaded as run
  artifacts) and returns the paths. Default 800×600.`,

  resolve({ sessionPath, nodeName }: any = {}) {
    // Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs) pointing at this
    // module's chartRenderSkill export — same FIXED pattern as kvMemory/
    // datasetStore/github (NEVER return { command: null }).
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env: {}, description: this.description };
    // Forward the output-dir context to the spawned MCP process (browser.js
    // convention): prefer the per-node folder so the session-uploader —
    // which scans <sessionPath>/<nodeName>/** — picks the files up.
    const env: any = {};
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
      args: [bin, '../dist/chartRender.js', 'chartRenderSkill'],
      env,
      description: this.description,
      // Force tools into the system prompt instead of deferring behind the
      // SDK's ToolSearch (same as github.js / kvMemory.js).
      alwaysLoad: true,
    };
  },

  async handleToolCall(name, args) {
    if (name !== 'chart_render') {
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
    try {
      const spec = args?.spec;
      if (!isPlainObject(spec)) {
        return JSON.stringify({
          error: "spec must be a plain ECharts option OBJECT (e.g. { xAxis: {...}, yAxis: {...}, series: [...] }) — got "
            + (spec === null ? 'null' : Array.isArray(spec) ? 'an array' : typeof spec)
            + '. Pass the option object itself, not a string or an array.',
        });
      }

      const width = clampDim(args?.width, DEFAULT_WIDTH);
      const height = clampDim(args?.height, DEFAULT_HEIGHT);
      // ONE knob decides the destination. 'svg-inline' is a new enum VALUE
      // rather than a separate `inline:true` flag on purpose: a second knob
      // could disagree with this one ("inline:true, output:'png'" — which
      // wins?), and the model already reasons about `output`. Every pre-
      // existing value keeps its exact behaviour.
      const output = ['svg', 'png', 'both', 'svg-inline'].includes(args?.output) ? args.output : 'png';
      const basename = sanitizeFilename(args?.filename) || `chart-${Date.now()}`;

      let svg;
      try {
        svg = renderSvg(prepareSpec(spec), width, height);
      } catch (e) {
        return JSON.stringify({
          error: `Chart render failed: ${e.message}. The spec must be a valid Apache ECharts option `
            + '(check series[].type, and that xAxis/yAxis/radar match the series type). Fix the spec and retry.',
        });
      }
      if (typeof svg !== 'string' || !svg.includes('<svg')) {
        return JSON.stringify({ error: 'Chart render produced no SVG — the spec likely describes an empty chart (no series?). Add at least one series and retry.' });
      }

      // Inline path: return the markup, touch no filesystem. Deliberately
      // BEFORE resolveOutputDir() — a caller publishing an HTML page (e.g. a
      // Lambda runtime) may have no run output dir at all, and creating one
      // would leave an empty folder the session-uploader then reports.
      if (output === 'svg-inline') {
        let inline;
        try {
          inline = prepareInlineSvg(svg);
        } catch (e) {
          return JSON.stringify({ error: `Chart cannot be inlined: ${e.message}` });
        }
        const bytes = Buffer.byteLength(inline, 'utf-8');
        if (bytes > MAX_INLINE_SVG_BYTES) {
          return JSON.stringify({
            error: `Rendered SVG is ${Math.round(bytes / 1024)}KB, over the ${Math.round(MAX_INLINE_SVG_BYTES / 1024)}KB inline limit. `
              + 'Inline SVG is returned through the conversation and pasted into the page, so it must stay small. '
              + "Aggregate or sample the data down (a readable chart rarely needs >1000 points), or use output:'svg' to write a file instead.",
          });
        }
        return JSON.stringify({ ok: true, width, height, svg: inline, bytes, files: [] });
      }

      const outDir = resolveOutputDir();
      const files = [];
      if (output === 'svg' || output === 'both') {
        const p = join(outDir, `${basename}.svg`);
        writeFileSync(p, svg, 'utf-8');
        files.push({ path: p, format: 'svg', bytes: Buffer.byteLength(svg, 'utf-8') });
      }
      if (output === 'png' || output === 'both') {
        let png;
        try {
          png = renderPng(svg);
        } catch (e) {
          return JSON.stringify({ error: `PNG rasterization failed: ${e.message}. Retry with output:'svg' if you only need the vector.` });
        }
        const p = join(outDir, `${basename}.png`);
        writeFileSync(p, png);
        files.push({ path: p, format: 'png', bytes: png.length });
      }

      return JSON.stringify({ ok: true, width, height, files });
    } catch (e) {
      return JSON.stringify({ error: `chart_render failed: ${e.message}` });
    }
  },

  tools: [
    {
      name: 'chart_render',
      description: 'Render a chart LOCALLY (no external service) from a standard Apache ECharts option. '
        + 'Pass the raw ECharts option as `spec` — every ECharts chart type works (bar, line, pie, radar, scatter, heatmap, …). '
        + "USE output:'svg-inline' WHEN BUILDING AN HTML PAGE, ARTIFACT OR REPORT: it returns the chart as an `svg` string "
        + '(self-contained, no external refs) to paste directly into your HTML — a published page blocks external hosts, so a '
        + 'file path will not render there, and hand-written bar markup is never needed because ECharts computes the geometry. '
        + "Otherwise output 'png' (default) / 'svg' / 'both' writes files to the run output folder and returns their paths. "
        + 'animation is forced off; background defaults to white. '
        + 'Bar example: {"xAxis":{"type":"category","data":["Q1","Q2"]},"yAxis":{},"series":[{"type":"bar","data":[12,30]}]}. '
        + 'Radar example: {"legend":{"data":["A","B"]},"radar":{"indicator":[{"name":"speed","max":10},{"name":"cost","max":10},{"name":"quality","max":10}]},"series":[{"type":"radar","data":[{"name":"A","value":[7,4,9]},{"name":"B","value":[5,8,6]}]}]}.',
      input_schema: {
        type: 'object',
        properties: {
          spec: { type: 'object', description: 'The Apache ECharts option object, passed through as-is (series, xAxis/yAxis, radar, legend, title, …).' },
          width: { type: 'number', description: 'Image width in px (default 800, max 4096).' },
          height: { type: 'number', description: 'Image height in px (default 600, max 4096).' },
          output: {
            type: 'string',
            enum: ['svg', 'png', 'both', 'svg-inline'],
            description: "Destination. 'svg-inline' writes NO file and returns the SVG markup in the result for pasting into an HTML page/artifact — use this whenever you are building HTML. 'png' (default) / 'svg' / 'both' write files to the run output folder and return their paths.",
          },
          filename: { type: 'string', description: 'Optional file basename (no extension); defaults to chart-<timestamp>.' },
        },
        required: ['spec'],
      },
    },
  ],
};
