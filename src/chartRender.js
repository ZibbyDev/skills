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
 * SAFETY INJECTIONS before render (never trusts SSR text measurement):
 *   - spec must be a plain JSON object (validated; clear errors for the LLM)
 *   - animation is FORCED off (SSR has no frames)
 *   - backgroundColor defaults to '#fff' (PNG would otherwise be transparent)
 *   - width/height default 800×600, capped at 4096, floored at 16
 *   - very long labels in known label slots are truncated (SSR text
 *     measurement is estimated — unbounded labels overflow the canvas)
 */

import { createRequire } from 'node:module';
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

export const chartRenderSkill = {
  id: 'chart-render',
  serverName: 'chart_render',
  allowedTools: ['mcp__chart_render__*'],
  description: 'Chart render — local server-side chart rendering (Apache ECharts SVG SSR + resvg PNG); data never leaves the box',

  promptFragment: `## Chart Render (local, no external service)
You can render charts LOCALLY with the chart_render tool — pass a standard
Apache ECharts option object as \`spec\` (any chart type: bar, line, pie,
radar, scatter, heatmap, …). It renders server-side to SVG/PNG files in the
run's output folder (auto-attached to the run as artifacts) and returns the
file paths. No browser, no external chart service — the data never leaves
the machine. Don't set animation (it's forced off). Default 800×600 PNG.`,

  resolve({ sessionPath, nodeName } = {}) {
    // Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs) pointing at this
    // module's chartRenderSkill export — same FIXED pattern as kvMemory/
    // datasetStore/github (NEVER return { command: null }).
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env: {}, description: this.description };
    // Forward the output-dir context to the spawned MCP process (browser.js
    // convention): prefer the per-node folder so the session-uploader —
    // which scans <sessionPath>/<nodeName>/** — picks the files up.
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
      const output = ['svg', 'png', 'both'].includes(args?.output) ? args.output : 'png';
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
      description: 'Render a chart LOCALLY (no external service) from a standard Apache ECharts option and save it as SVG/PNG files in the run output folder. '
        + 'Pass the raw ECharts option as `spec` — every ECharts chart type works (bar, line, pie, radar, scatter, heatmap, …). '
        + 'Returns the written file path(s). animation is forced off; background defaults to white. '
        + 'Bar example: {"xAxis":{"type":"category","data":["Q1","Q2"]},"yAxis":{},"series":[{"type":"bar","data":[12,30]}]}. '
        + 'Radar example: {"legend":{"data":["A","B"]},"radar":{"indicator":[{"name":"speed","max":10},{"name":"cost","max":10},{"name":"quality","max":10}]},"series":[{"type":"radar","data":[{"name":"A","value":[7,4,9]},{"name":"B","value":[5,8,6]}]}]}.',
      input_schema: {
        type: 'object',
        properties: {
          spec: { type: 'object', description: 'The Apache ECharts option object, passed through as-is (series, xAxis/yAxis, radar, legend, title, …).' },
          width: { type: 'number', description: 'Image width in px (default 800, max 4096).' },
          height: { type: 'number', description: 'Image height in px (default 600, max 4096).' },
          output: { type: 'string', enum: ['svg', 'png', 'both'], description: "Which file(s) to write (default 'png')." },
          filename: { type: 'string', description: 'Optional file basename (no extension); defaults to chart-<timestamp>.' },
        },
        required: ['spec'],
      },
    },
  ],
};
