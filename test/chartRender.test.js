import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chartRenderSkill } from '../src/chartRender.js';

// chart-render renders a RAW ECharts option locally (SVG SSR → resvg PNG) and
// writes the files into the run's output dir (ZIBBY_NODE_SESSION_PATH first —
// the folder the CLI session-uploader scans). These tests assert: structure,
// resolve() env forwarding, a real radar + bar render (SVG labels + PNG magic),
// dirty-spec tolerance, output modes, filename handling, dim capping, and the
// clear-error contract on invalid specs.
//
// The inline-SVG return path (output:'svg-inline' — no file, markup in the
// result) is covered separately in src/__tests__/chartRender-inline.test.ts.

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The product radar from the acceptance spec: employee A vs B across 6 tags.
const RADAR_TAGS = ['core-feature', 'bugfix', 'refactor', 'chore', 'docs', 'tests'];
const radarSpec = {
  title: { text: 'Contribution radar' },
  legend: { data: ['Employee A', 'Employee B'] },
  radar: { indicator: RADAR_TAGS.map((name) => ({ name, max: 10 })) },
  series: [{
    type: 'radar',
    data: [
      { name: 'Employee A', value: [9, 4, 6, 2, 3, 7] },
      { name: 'Employee B', value: [5, 8, 3, 6, 7, 4] },
    ],
  }],
};

const barSpec = {
  xAxis: { type: 'category', data: ['Q1', 'Q2', 'Q3'] },
  yAxis: {},
  series: [{ type: 'bar', data: [12, 30, 22] }],
};

let outDir;

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), 'chart-render-test-'));
  process.env.ZIBBY_NODE_SESSION_PATH = outDir;
  delete process.env.ZIBBY_SESSION_PATH;
});

afterEach(() => {
  delete process.env.ZIBBY_NODE_SESSION_PATH;
  delete process.env.ZIBBY_SESSION_PATH;
  rmSync(outDir, { recursive: true, force: true });
});

async function call(args) {
  return JSON.parse(await chartRenderSkill.handleToolCall('chart_render', args));
}

describe('chartRenderSkill structure', () => {
  it('registers under id chart-render with neutral serverName + allowedTools', () => {
    expect(chartRenderSkill.id).toBe('chart-render');
    expect(chartRenderSkill.serverName).toBe('chart_render');
    expect(chartRenderSkill.allowedTools).toEqual(['mcp__chart_render__*']);
  });

  it('exposes exactly one pass-through tool with spec required', () => {
    expect(chartRenderSkill.tools.map((t) => t.name)).toEqual(['chart_render']);
    const tool = chartRenderSkill.tools[0];
    expect(tool.input_schema.required).toEqual(['spec']);
    expect(tool.input_schema.properties.spec.type).toBe('object');
    // 'svg-inline' returns the markup instead of writing a file (the HTML-page
    // path). The three file-writing values keep their exact meaning + order.
    expect(tool.input_schema.properties.output.enum).toEqual(['svg', 'png', 'both', 'svg-inline']);
    // The description carries the micro-examples that anchor LLM spec accuracy.
    expect(tool.description).toContain('"type":"bar"');
    expect(tool.description).toContain('"type":"radar"');
    // …and must tell the model WHEN the inline path applies, or it never uses it.
    expect(tool.description).toContain("output:'svg-inline'");
    expect(chartRenderSkill.promptFragment).toContain("output:'svg-inline'");
  });
});

describe('resolve() spawns the generic MCP bin (NOT command:null)', () => {
  it('returns a node stdio server pointing at ../dist/chartRender.js and forwards the session dirs', () => {
    const r = chartRenderSkill.resolve({ sessionPath: '/tmp/sess', nodeName: 'render' });
    expect(r.command).toBe('node');
    expect(r.args).toEqual([expect.stringContaining('mcp-skill.mjs'), '../dist/chartRender.js', 'chartRenderSkill']);
    expect(r.type).toBe('stdio');
    expect(r.alwaysLoad).toBe(true);
    expect(r.env.ZIBBY_NODE_SESSION_PATH).toBe(join('/tmp/sess', 'render'));
    expect(r.env.ZIBBY_SESSION_PATH).toBe('/tmp/sess');
  });

  it('falls back to process env when called with no args (engine tool-resolver path)', () => {
    const r = chartRenderSkill.resolve();
    expect(r.command).toBe('node');
    expect(r.env.ZIBBY_NODE_SESSION_PATH).toBe(outDir);
  });
});

describe('rendering — radar (A vs B, 6 tags) and bar', () => {
  it("renders the product radar to SVG+PNG with output:'both'", async () => {
    const out = await call({ spec: radarSpec, output: 'both', filename: 'radar-a-vs-b' });
    expect(out.ok).toBe(true);
    expect(out.width).toBe(800);
    expect(out.height).toBe(600);
    expect(out.files).toHaveLength(2);

    const svgFile = out.files.find((f) => f.format === 'svg');
    expect(svgFile.path).toBe(join(outDir, 'radar-a-vs-b.svg'));
    const svg = readFileSync(svgFile.path, 'utf-8');
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    for (const tag of RADAR_TAGS) expect(svg).toContain(tag);   // all 6 indicator labels present
    expect(svg).toContain('Employee A');
    expect(svg).toContain('Employee B');
    expect(svgFile.bytes).toBeGreaterThan(1000);

    const pngFile = out.files.find((f) => f.format === 'png');
    expect(pngFile.path).toBe(join(outDir, 'radar-a-vs-b.png'));
    const png = readFileSync(pngFile.path);
    expect(png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(png.length).toBeGreaterThan(5000);                   // real raster, not a stub
    expect(pngFile.bytes).toBe(png.length);
  });

  it('renders a bar chart PNG by default (no output arg) with a chart-<ts> filename', async () => {
    const out = await call({ spec: barSpec });
    expect(out.ok).toBe(true);
    expect(out.files).toHaveLength(1);
    expect(out.files[0].format).toBe('png');
    expect(out.files[0].path).toMatch(/chart-\d+\.png$/);
    const png = readFileSync(out.files[0].path);
    expect(png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
  });

  it("output:'svg' writes only the SVG", async () => {
    const out = await call({ spec: barSpec, output: 'svg', filename: 'bars' });
    expect(out.files.map((f) => f.format)).toEqual(['svg']);
    expect(existsSync(join(outDir, 'bars.svg'))).toBe(true);
    expect(existsSync(join(outDir, 'bars.png'))).toBe(false);
  });

  it('forces animation off and defaults a white background (safety injections, caller spec untouched)', async () => {
    const spec = { ...barSpec, animation: true };
    const out = await call({ spec, output: 'svg', filename: 'safe' });
    expect(out.ok).toBe(true);
    const svg = readFileSync(join(outDir, 'safe.svg'), 'utf-8');
    expect(svg).toMatch(/fill="#fff"|fill="#ffffff"|fill="rgb\(255,\s*255,\s*255\)"/i);
    expect(spec.animation).toBe(true);                          // never mutates the caller's object
  });

  it('tolerates dirty specs — unknown props pass through without throwing', async () => {
    const out = await call({
      spec: { ...barSpec, notARealOption: { nested: [1, 2, 3] }, series: [{ ...barSpec.series[0], bogusProp: 'x' }] },
      output: 'svg',
      filename: 'dirty',
    });
    expect(out.ok).toBe(true);
    expect(existsSync(join(outDir, 'dirty.svg'))).toBe(true);
  });

  it('caps oversized dimensions at 4096 and floors tiny ones', async () => {
    const big = await call({ spec: barSpec, width: 99999, height: 12000, output: 'svg', filename: 'big' });
    expect(big.width).toBe(4096);
    expect(big.height).toBe(4096);
    const svg = readFileSync(join(outDir, 'big.svg'), 'utf-8');
    expect(svg).toContain('width="4096"');

    const tiny = await call({ spec: barSpec, width: 1, height: -5, output: 'svg', filename: 'tiny' });
    expect(tiny.width).toBe(16);
    expect(tiny.height).toBe(16);
  });

  it('truncates very long labels (SSR text measurement guard)', async () => {
    const longName = 'x'.repeat(200);
    const out = await call({
      spec: { radar: { indicator: [{ name: longName, max: 1 }, { name: 'ok', max: 1 }] }, series: [{ type: 'radar', data: [{ name: 'A', value: [1, 1] }] }] },
      output: 'svg',
      filename: 'long',
    });
    expect(out.ok).toBe(true);
    const svg = readFileSync(join(outDir, 'long.svg'), 'utf-8');
    expect(svg).not.toContain(longName);
    expect(svg).toContain('x'.repeat(59) + '…');
  });

  it('sanitizes hostile filenames into a safe basename', async () => {
    const out = await call({ spec: barSpec, output: 'svg', filename: '../../etc/passwd' });
    expect(out.ok).toBe(true);
    expect(out.files[0].path.startsWith(outDir + '/')).toBe(true);
    expect(out.files[0].path).not.toContain('..');
  });
});

describe('error contract — clear messages the LLM can act on', () => {
  it.each([
    ['a string', 'not an object'],
    ['an array', [1, 2]],
    ['null', null],
    ['missing', undefined],
  ])('rejects a %s spec with a clear error', async (_label, spec) => {
    const out = await call({ spec });
    expect(out.error).toContain('spec must be a plain ECharts option OBJECT');
  });

  it('wraps ECharts render failures with retry guidance', async () => {
    // A bar series with NO xAxis/yAxis throws inside ECharts ('xAxis "0" not
    // found') — exactly the plausible-LLM-mistake class the guidance targets.
    const out = await call({ spec: { series: [{ type: 'bar', data: [1, 2] }] } });
    expect(out.error).toContain('Chart render failed');
    expect(out.error).toContain('valid Apache ECharts option');
  });

  it('unknown tool returns an error', async () => {
    const out = JSON.parse(await chartRenderSkill.handleToolCall('chart_bogus', {}));
    expect(out.error).toContain('Unknown tool');
  });
});

describe('registry wiring', () => {
  it('is registered under SKILLS.CHART_RENDER via the package index', async () => {
    const { SKILLS, hasSkill, getSkill, chartRenderSkill: exported } = await import('../src/index.js');
    expect(SKILLS.CHART_RENDER).toBe('chart-render');
    expect(hasSkill('chart-render')).toBe(true);
    // registerSkill stores Object.freeze({...skill}) — a shallow copy — so
    // compare the identity of the shared innards, not the wrapper object.
    const registered = getSkill('chart-render');
    expect(registered.id).toBe('chart-render');
    expect(registered.tools).toBe(chartRenderSkill.tools);
    expect(registered.handleToolCall).toBe(chartRenderSkill.handleToolCall);
    expect(exported).toBe(chartRenderSkill);
  });
});
