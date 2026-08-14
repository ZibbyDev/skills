/**
 * chartRenderSkill tests — the inline-SVG return path (`output:'svg-inline'`)
 * and the backward compatibility of the three file-writing shapes.
 *
 * Companion to test/chartRender.test.js, which covers this skill's structure,
 * resolve() wiring and the file-writing modes; this file covers the inline path.
 *
 * These render for REAL (echarts SSR, no mocks) — the whole point is to assert
 * against actual SSR output, because every inline hazard this path guards was
 * found by running the renderer, not by reading its docs. Files go to a temp
 * dir via ZIBBY_SESSION_PATH (the env resolveOutputDir() honours).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let sessionDir;
beforeAll(() => {
  sessionDir = mkdtempSync(join(tmpdir(), 'chart-render-test-'));
  process.env.ZIBBY_SESSION_PATH = sessionDir;
  delete process.env.ZIBBY_NODE_SESSION_PATH;
});
afterAll(() => {
  delete process.env.ZIBBY_SESSION_PATH;
  rmSync(sessionDir, { recursive: true, force: true });
});

const { chartRenderSkill } = await import('../chartRender.js');

const call = async (args) => JSON.parse(await chartRenderSkill.handleToolCall('chart_render', args));

/** The exact regression that shipped: a five-row horizontal bar chart. */
const BAR_VALUES = [45, 4, 10, 7, 15];
const barSpec = () => ({
  xAxis: { type: 'value' },
  yAxis: { type: 'category', data: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'] },
  series: [{ type: 'bar', data: [...BAR_VALUES] }],
});

/** Pull the drawn width of each bar out of its path: `M<x> <y>l<width> 0l0 <height>…`. */
function barWidths(svg) {
  return [...svg.matchAll(/<path d="M[\d.-]+ [\d.-]+l([\d.-]+) 0l0 [\d.-]+[^"]*"[^>]*ecmeta_series_index="0"[^>]*>/g)]
    .map((m) => parseFloat(m[1]));
}

describe('output:\'svg-inline\' — the HTML-page path', () => {
  it('returns the SVG markup in the result and writes NO file', async () => {
    const before = readdirSync(sessionDir);
    const out = await call({ spec: barSpec(), output: 'svg-inline' });

    expect(out.ok).toBe(true);
    expect(out.width).toBe(800);
    expect(out.height).toBe(600);
    expect(typeof out.svg).toBe('string');
    expect(out.svg.startsWith('<svg')).toBe(true);
    expect(out.svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(out.bytes).toBe(Buffer.byteLength(out.svg, 'utf-8'));
    expect(out.files).toEqual([]);
    // No file, and not even an output directory created.
    expect(readdirSync(sessionDir)).toEqual(before);
    expect(existsSync(join(sessionDir, 'chart-render'))).toBe(false);
  });

  it('emits no XML prolog and no DOCTYPE', async () => {
    const { svg } = await call({ spec: barSpec(), output: 'svg-inline' });
    expect(svg).not.toMatch(/<\?xml/i);
    expect(svg).not.toMatch(/<!DOCTYPE/i);
  });

  it('contains no external reference of any kind', async () => {
    const { svg } = await call({
      spec: {
        title: { text: 'Quarterly' },
        legend: { data: ['s'] },
        xAxis: { type: 'category', data: ['q1', 'q2', 'q3'] },
        yAxis: {},
        series: [{ name: 's', type: 'bar', data: [3, 1, 2], label: { show: true } }],
      },
      output: 'svg-inline',
    });
    // Every href/url() must be a local fragment or a data: URI; nothing else.
    for (const m of svg.matchAll(/(?:xlink:)?href\s*=\s*"([^"]*)"/gi)) {
      expect(m[1]).toMatch(/^(#|data:)/i);
    }
    for (const m of svg.matchAll(/url\(\s*['"]?([^'")]*)['"]?\s*\)/gi)) {
      expect(m[1]).toMatch(/^(#|data:)/i);
    }
    expect(svg).not.toMatch(/@import/i);
    expect(svg).not.toMatch(/<script\b/i);
    expect(svg).not.toMatch(/<foreignObject\b/i);
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/i); // only the SVG/xlink namespace URIs
  });

  it('rejects a spec whose render would reach an external host', async () => {
    const out = await call({
      spec: {
        xAxis: { type: 'category', data: ['a', 'b'] },
        yAxis: {},
        series: [{ type: 'scatter', symbol: 'image://https://example.invalid/x.png', symbolSize: 20, data: [1, 2] }],
      },
      output: 'svg-inline',
    });
    expect(out.svg).toBeUndefined();
    expect(out.error).toMatch(/external resources/i);
    expect(out.error).toContain('https://example.invalid/x.png');
  });

  it('drops the document-global <style> block, so a colour string cannot inject page-wide CSS', async () => {
    const { svg } = await call({
      spec: {
        xAxis: { type: 'category', data: ['a'] },
        yAxis: {},
        series: [{
          type: 'bar',
          data: [1],
          // Verified to land verbatim inside the <style> CDATA in raw SSR output.
          emphasis: { itemStyle: { color: 'red}\n.injected{display:none}\n@import url("https://evil.invalid/x.css");\n.x{' } },
        }],
      },
      output: 'svg-inline',
    });
    expect(svg).not.toMatch(/<style\b/i);
    expect(svg).not.toContain('.injected');
    expect(svg).not.toMatch(/@import/i);
    expect(svg).not.toContain('evil.invalid');
  });

  it('namespaces ids per render, so two charts on one page cannot collide', async () => {
    const gradient = () => ({
      xAxis: { type: 'category', data: ['a', 'b'] },
      yAxis: {},
      series: [{
        type: 'bar',
        data: [1, 2],
        itemStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: '#f00' }, { offset: 1, color: '#00f' }] } },
      }],
    });
    const a = (await call({ spec: gradient(), output: 'svg-inline' })).svg;
    const b = (await call({ spec: gradient(), output: 'svg-inline' })).svg;

    // zrender's per-process `zr<N>-` prefix restarts at 0 in a fresh process,
    // so it must not survive into inlined markup.
    expect(a).not.toMatch(/zr\d+-/);
    expect(b).not.toMatch(/zr\d+-/);

    const idsOf = (s) => [...s.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    const idsA = idsOf(a);
    const idsB = idsOf(b);
    expect(idsA.length).toBeGreaterThan(0);
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);

    // Every local reference still resolves to an id defined in the SAME svg.
    for (const s of [a, b]) {
      const defined = new Set(idsOf(s));
      for (const m of s.matchAll(/url\(#([^)]+)\)/g)) expect(defined.has(m[1])).toBe(true);
    }
  });

  it('refuses an SVG too large to inline, with an actionable message', async () => {
    const out = await call({
      spec: {
        xAxis: {},
        yAxis: {},
        series: [{ type: 'scatter', data: Array.from({ length: 5000 }, (_, i) => [i % 97, (i * 37) % 89]) }],
      },
      output: 'svg-inline',
    });
    expect(out.svg).toBeUndefined();
    expect(out.error).toMatch(/over the 256KB inline limit/);
    expect(out.error).toMatch(/output:'svg'/);
  });
});

describe('bar geometry — the regression that shipped hand-written markup', () => {
  it('draws five bars whose widths are strictly proportional to [45,4,10,7,15]', async () => {
    const { svg } = await call({ spec: barSpec(), output: 'svg-inline' });
    const widths = barWidths(svg);

    expect(widths).toHaveLength(BAR_VALUES.length);
    // The bug was a bar rendering at width 0. None may be degenerate.
    for (const w of widths) expect(w).toBeGreaterThan(0);

    // Proportional: one px-per-unit scale explains every bar.
    const scale = widths[0] / BAR_VALUES[0];
    widths.forEach((w, i) => expect(w / BAR_VALUES[i]).toBeCloseTo(scale, 6));

    // And the smallest value really is the smallest bar (ordering preserved).
    expect(Math.min(...widths)).toBe(widths[BAR_VALUES.indexOf(Math.min(...BAR_VALUES))]);
  });
});

describe('backward compatibility — the file-writing shapes are unchanged', () => {
  it("output:'svg' still writes a .svg file and returns only file metadata", async () => {
    const out = await call({ spec: barSpec(), output: 'svg', filename: 'compat-svg' });
    expect(out).toEqual({
      ok: true,
      width: 800,
      height: 600,
      files: [{ path: join(sessionDir, 'chart-render', 'compat-svg.svg'), format: 'svg', bytes: expect.any(Number) }],
    });
    expect(out.svg).toBeUndefined();
    expect(existsSync(out.files[0].path)).toBe(true);
  });

  it('the written .svg is RAW SSR output — the inline transforms never touch the file path', async () => {
    const out = await call({ spec: barSpec(), output: 'svg', filename: 'compat-raw' });
    const onDisk = readFileSync(out.files[0].path, 'utf-8');
    // Raw output keeps both things the inline path removes/rewrites.
    expect(onDisk).toMatch(/<style\b/i);
    expect(onDisk).toMatch(/zr\d+-cls-/);
    expect(Buffer.byteLength(onDisk, 'utf-8')).toBe(out.files[0].bytes);
  });

  it("output:'both' writes a .svg and a .png; the default (no output) writes only a .png", async () => {
    const both = await call({ spec: barSpec(), output: 'both', filename: 'compat-both' });
    expect(both.files.map((f) => f.format)).toEqual(['svg', 'png']);
    for (const f of both.files) expect(existsSync(f.path)).toBe(true);

    const dflt = await call({ spec: barSpec(), filename: 'compat-default' });
    expect(dflt.files.map((f) => f.format)).toEqual(['png']);
    expect(dflt.files[0].path.endsWith('compat-default.png')).toBe(true);
    expect(dflt.svg).toBeUndefined();
  });

  it('an unknown output value still falls back to png (unchanged)', async () => {
    const out = await call({ spec: barSpec(), output: 'nonsense', filename: 'compat-fallback' });
    expect(out.files.map((f) => f.format)).toEqual(['png']);
  });

  it('rejects a non-object spec the same way on every output mode', async () => {
    for (const output of ['png', 'svg', 'both', 'svg-inline']) {
      const out = await call({ spec: 'not an object', output });
      expect(out.error).toMatch(/spec must be a plain ECharts option OBJECT/);
    }
  });
});
