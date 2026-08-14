/**
 * reportCheck tests — the DATA-DRIVEN pre-flight for a rendered report page.
 *
 * The suite is built around the failure that actually shipped: five bars whose
 * values are 45/4/10/7/15 and a 20-row detail table. `page()` below emits that
 * report, and every BROKEN case is the same page with exactly ONE mutation, so a
 * defect can only have come from that mutation.
 *
 * Three things this file is deliberately structured to prove, beyond "the good
 * page passes":
 *
 *   1. THE NEGATIVE CASES. A checker that only passes the good page is unproven.
 *      Every bug class gets a page that contains it and an assertion naming the
 *      code that must come back.
 *   2. THE PROBE IS NOT BLIND. "A NEGATIVE result means suspect your PROBE
 *      first" (CLAUDE.md). A clean verdict is only asserted together with the
 *      `checked` receipt showing the checker actually FOUND the bars and rows it
 *      was supposed to look at — and one test pins the opposite, that a page
 *      whose bars are invisible to the parser reports `bars: 0` rather than
 *      quietly passing.
 *   3. NO PER-PAGE EXPECTATIONS. `differentReport()` is a report with different
 *      keys, different labels, horizontal bars and a different row count. It
 *      goes through the SAME checker with zero configuration. If that ever needs
 *      a hint, the design has failed.
 */

import { describe, it, expect } from 'vitest';

const { checkRenderedReport, REPORT_CODES, reportCheckSkill, __reportCheckInternals } =
  await import('../reportCheck.js');

// ── the reconstruction ──────────────────────────────────────────────────────

const AREAS = [
  { area: 'Auth', incidents: 45 },
  { area: 'Billing', incidents: 4 },
  { area: 'API', incidents: 10 },
  { area: 'UI', incidents: 7 },
  { area: 'Data', incidents: 15 },
];
const OWNERS = ['r.patel', 'k.nakamura', 'l.ferreira', 'm.osei'];
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const INCIDENTS = Array.from({ length: 20 }, (_, i) => ({
  ticket: `ZB-${1001 + i}`,
  area: AREAS[i % AREAS.length].area,
  severity: SEVERITIES[i % SEVERITIES.length],
  owner: OWNERS[i % OWNERS.length],
  ageDays: ((i * 3) % 17) + 1,
}));
const DATA = { areas: AREAS, incidents: INCIDENTS };

const MAX = 45;
const pct = (v: number) => Number(((v / MAX) * 100).toFixed(3));

function page(mut: any = {}) {
  const barDisplay = mut.collapseBars ? '' : 'display: block;';
  const rows = mut.dropRows ? INCIDENTS.slice(0, INCIDENTS.length - mut.dropRows) : INCIDENTS;
  const bars = AREAS.map((a, i) => {
    const w = mut.wrongBarIndex === i ? mut.wrongBarWidth : pct(a.incidents);
    const printed = mut.wrongLabelIndex === i ? mut.wrongLabelValue : a.incidents;
    return `<div class="row"><span class="label">${a.area}</span>`
      + `<span class="track"><span class="bar" style="width:${w}%"></span></span>`
      + `<span class="value">${printed}</span></div>`;
  }).join('\n      ');
  const body = rows.map((r, i) => {
    const owner = mut.objectCellIndex === i ? '[object Object]' : r.owner;
    const age = mut.placeholderCellIndex === i ? '${pct}' : `${r.ageDays}d`;
    return `<tr><td>${r.ticket}</td><td>${r.area}</td><td>${r.severity}</td><td>${owner}</td><td>${age}</td></tr>`;
  }).join('\n        ');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Incident review</title><style>
  .row { display: grid; grid-template-columns: 90px 1fr 48px; align-items: center; gap: 12px; }
  .track { background: #eef0f4; }
  .bar { ${barDisplay} height: 16px; background: #5070dd; }
  table { border-collapse: collapse; }
</style></head><body>
  <h1>Incident review — last 30 days</h1>
  <section class="chart">
      ${bars}
  </section>
  <table><thead><tr><th>Ticket</th><th>Area</th><th>Severity</th><th>Owner</th><th>Age</th></tr></thead>
    <tbody>
        ${body}
    </tbody></table>
</body></html>`;
}

const codes = (r: any) => r.defects.map((d: any) => d.code);

// ── the good page, and the receipt that makes its verdict believable ────────

describe('the good page', () => {
  it('passes — AND the receipt proves the checker actually looked at the bars and rows', () => {
    const r = checkRenderedReport({ html: page(), data: DATA });
    expect(r.defects).toEqual([]);
    expect(r.ok).toBe(true);
    // Without these, `ok:true` could just mean the selectors never matched.
    expect(r.checked.bars).toBe(5);
    expect(r.checked.boundBars).toBe(5);
    expect(r.checked.tables).toBe(1);
    expect(r.checked.bodyRows).toBe(20);
    expect(r.checked.percentWidthBars).toBe(5);
    expect(r.checked.seriesInData).toBeGreaterThanOrEqual(1);
    const incidents = r.checked.collections.find((c: any) => c.path === 'incidents');
    expect(incidents).toMatchObject({ records: 20, presentInPage: 20, boundTableRows: 20 });
  });
});

// ── the negative cases: one mutation each ───────────────────────────────────

describe('a bar that collapses to zero width at layout time', () => {
  it('names it, even though the source width is a perfectly valid 100%', () => {
    const r = checkRenderedReport({ html: page({ collapseBars: true }), data: DATA });
    expect(codes(r)).toContain(REPORT_CODES.ZERO_WIDTH);
    const d = r.defects.find((x: any) => x.code === REPORT_CODES.ZERO_WIDTH);
    expect(d.message).toContain('width:100%');
    expect(d.message).toContain('inline');
    expect(d.line).toBeGreaterThan(1);
  });

  it('does NOT fire when the same span is blockified by a flex parent', () => {
    const html = `<!doctype html><html><head><style>
      .track { display: flex; } .bar { height: 16px; background: #333; }
    </style></head><body><h1>Totals by region</h1>
      <div class="track"><span class="bar" style="width:100%"></span></div>
      <div class="track"><span class="bar" style="width:40%"></span></div>
    </body></html>`;
    const r = checkRenderedReport({ html, data: { s: [{ k: 'a', v: 10 }, { k: 'b', v: 4 }] } });
    expect(codes(r)).not.toContain(REPORT_CODES.ZERO_WIDTH);
  });

  it('does NOT fire when the stylesheet gives the bar display:block', () => {
    const r = checkRenderedReport({ html: page(), data: DATA });
    expect(codes(r)).not.toContain(REPORT_CODES.ZERO_WIDTH);
  });
});

describe('a bar whose length disagrees with its datum', () => {
  it('names the bar, the datum and how far off it is', () => {
    const r = checkRenderedReport({ html: page({ wrongBarIndex: 0, wrongBarWidth: 42 }), data: DATA });
    expect(codes(r)).toEqual([REPORT_CODES.BAR_PROPORTION]);
    const d = r.defects[0];
    expect(d.message).toContain('"Auth"');
    expect(d.message).toContain('value 45');
    expect(d.message).toContain('42%');
    expect(d.message).toContain('100%');
  });

  it('blames ONE bar, not all five — a robust median scale, never least squares', () => {
    // A least-squares fit is dragged by the outlier and then reports every other
    // bar as off too, turning one defect into five.
    const r = checkRenderedReport({ html: page({ wrongBarIndex: 2, wrongBarWidth: 90 }), data: DATA });
    expect(r.defects.filter((d: any) => d.code === REPORT_CODES.BAR_PROPORTION)).toHaveLength(1);
    expect(r.defects[0].message).toContain('"API"');
  });

  it('accepts a faithful rescale — the check is on PROPORTION, not absolute width', () => {
    // Same data, every bar drawn at half scale. Still a correct chart.
    const html = page().replace(/width:([\d.]+)%/g, (_m, w) => `width:${Number(w) / 2}%`);
    const r = checkRenderedReport({ html, data: DATA });
    expect(codes(r)).not.toContain(REPORT_CODES.BAR_PROPORTION);
  });
});

describe('a printed number that is not its datum', () => {
  it('catches the "42 should have been 45" case the gate says it cannot see', () => {
    const r = checkRenderedReport({ html: page({ wrongLabelIndex: 0, wrongLabelValue: 42 }), data: DATA });
    expect(codes(r)).toContain(REPORT_CODES.VALUE_MISMATCH);
    expect(r.defects[0].message).toContain('prints 42');
    expect(r.defects[0].message).toContain('datum is 45');
  });

  it('accepts a share-of-max or share-of-total rendering as legitimate', () => {
    const html = page().replace(/<span class="value">(\d+)<\/span>/g, (_m, v) => `<span class="value">${Math.round((Number(v) / 45) * 100)}%</span>`);
    const r = checkRenderedReport({ html, data: DATA });
    expect(codes(r)).not.toContain(REPORT_CODES.VALUE_MISMATCH);
  });
});

describe('a table short of the records it was given', () => {
  it('names WHICH records never reached the page', () => {
    const r = checkRenderedReport({ html: page({ dropRows: 3 }), data: DATA });
    expect(codes(r)).toEqual([REPORT_CODES.ROW_MISSING]);
    expect(r.defects[0].message).toContain('has 20 records but 3 of them');
    expect(r.defects[0].message).toContain('ZB-1018');
    expect(r.defects[0].message).toContain('ZB-1020');
    expect(r.checked.collections.find((c: any) => c.path === 'incidents')).toMatchObject({ presentInPage: 17, boundTableRows: 17 });
  });

  it('reports the COUNT when every record is present but a row is duplicated', () => {
    const html = page().replace(
      '<tr><td>ZB-1001</td>',
      '<tr><td>ZB-1001</td><td>Auth</td><td>critical</td><td>r.patel</td><td>1d</td></tr>\n<tr><td>ZB-1001</td>',
    );
    const r = checkRenderedReport({ html, data: DATA });
    expect(codes(r)).toContain(REPORT_CODES.ROW_COUNT);
    expect(r.defects[0].message).toContain('21 body row');
    expect(r.defects[0].message).toContain('20 records');
  });

  it('does NOT report the same finding twice — ROW_MISSING supersedes ROW_COUNT', () => {
    const r = checkRenderedReport({ html: page({ dropRows: 3 }), data: DATA });
    expect(codes(r)).not.toContain(REPORT_CODES.ROW_COUNT);
  });

  it('does NOT treat a deliberate top-N page as a truncated one', () => {
    // 3 of 20 rendered: this is a summary, not a bug. Reported in `checked` only.
    const r = checkRenderedReport({ html: page({ dropRows: 17 }), data: DATA });
    expect(codes(r)).not.toContain(REPORT_CODES.ROW_MISSING);
    expect(r.checked.collections.find((c: any) => c.path === 'incidents').renderedFraction).toBeLessThan(0.5);
  });

  it('does NOT bind the 5-record series to the 20-row incident table', () => {
    // Every incident row names an area, so a naive binder "discovers" that the
    // areas table is missing 15 rows. The binding must be near-injective.
    const r = checkRenderedReport({ html: page(), data: DATA });
    expect(r.checked.collections.find((c: any) => c.path === 'areas').boundTableRows).toBeNull();
    expect(codes(r)).not.toContain(REPORT_CODES.ROW_COUNT);
  });
});

describe('placeholder residue in visible text', () => {
  it('catches an un-substituted ${…} and an [object Object] in a cell', () => {
    const r = checkRenderedReport({ html: page({ placeholderCellIndex: 4, objectCellIndex: 11 }), data: DATA });
    expect(codes(r)).toEqual([REPORT_CODES.PLACEHOLDER_TEXT, REPORT_CODES.PLACEHOLDER_TEXT]);
    expect(r.defects.map((d: any) => d.message).join(' ')).toContain('${pct}');
    expect(r.defects.map((d: any) => d.message).join(' ')).toContain('[object Object]');
  });

  it('catches a bare NaN and a cell whose whole content is "undefined"', () => {
    const html = `<!doctype html><html><body><h1>Throughput by shift</h1>
      <table><tbody><tr><td>morning</td><td>NaN</td></tr><tr><td>night</td><td>undefined</td></tr></tbody></table>
    </body></html>`;
    const r = checkRenderedReport({ html, data: { rows: [{ shift: 'morning' }, { shift: 'night' }] } });
    expect(codes(r).filter((c: string) => c === REPORT_CODES.PLACEHOLDER_TEXT)).toHaveLength(2);
  });

  it('does NOT flag prose that says "undefined behavior", or NaN inside <code>', () => {
    const html = `<!doctype html><html><body><h1>Notes on the parser rewrite</h1>
      <p>Reading past the end is undefined behavior in the C standard, so we bounds-check.</p>
      <pre><code>if (Number.isNaN(x)) return \${fallback};</code></pre>
      <p>The null hypothesis was not rejected at p &lt; 0.05.</p>
    </body></html>`;
    const r = checkRenderedReport({ html, data: { notes: [{ id: 'n1' }, { id: 'n2' }] } });
    expect(codes(r)).not.toContain(REPORT_CODES.PLACEHOLDER_TEXT);
  });
});

describe('overflow that is arithmetic rather than layout', () => {
  it('names a fixed-px child clipped by a narrower ancestor', () => {
    const html = `<!doctype html><html><body><h1>Regional revenue detail</h1>
      <div style="width:320px;overflow:hidden"><div style="width:900px">a very wide table</div></div>
    </body></html>`;
    const r = checkRenderedReport({ html, data: { rows: [{ id: 'a' }, { id: 'b' }] } });
    expect(codes(r)).toContain(REPORT_CODES.OVERFLOW);
    expect(r.defects[0].message).toContain('580px');
  });

  it('does NOT fire when the ancestor scrolls instead of clipping', () => {
    const html = `<!doctype html><html><body><h1>Regional revenue detail</h1>
      <div style="width:320px;overflow-x:auto"><div style="width:900px">a very wide table</div></div>
    </body></html>`;
    const r = checkRenderedReport({ html, data: { rows: [{ id: 'a' }, { id: 'b' }] } });
    expect(codes(r)).not.toContain(REPORT_CODES.OVERFLOW);
  });
});

// ── disjointness from the server-side gate ──────────────────────────────────

describe('the gate owns its own rules — this module never restates one', () => {
  it('stays SILENT on a literal width:0 bar (artifact-validate R8 already reports it)', () => {
    const html = page().replace('width:100%', 'width:0%');
    const r = checkRenderedReport({ html, data: DATA });
    // Neither our zero-width detection nor a proportionality complaint: one
    // owner per rule, so the model gets exactly one message about that bar.
    expect(codes(r)).not.toContain(REPORT_CODES.ZERO_WIDTH);
    expect(codes(r)).not.toContain(REPORT_CODES.BAR_PROPORTION);
  });

  it('stays SILENT on an un-substituted ${pct} inside a WIDTH (gate R8 owns that shape)', () => {
    const html = page().replace('width:100%', 'width:${pct}%');
    const r = checkRenderedReport({ html, data: DATA });
    expect(codes(r)).not.toContain(REPORT_CODES.ZERO_WIDTH);
    expect(codes(r)).not.toContain(REPORT_CODES.PLACEHOLDER_TEXT);
  });

  it('emits the gate\'s defect SHAPE so both sources flow through one code path', () => {
    const r = checkRenderedReport({ html: page({ dropRows: 3 }), data: DATA });
    for (const d of r.defects) {
      expect(Object.keys(d).sort()).toEqual(['code', 'hint', 'line', 'message']);
      expect(typeof d.code).toBe('string');
      expect(typeof d.message).toBe('string');
      expect(typeof d.hint).toBe('string');
      expect(typeof d.line === 'number' || d.line === null).toBe(true);
    }
  });
});

// ── the SSR-SVG path: geometry straight out of the markup ───────────────────

describe('an ECharts SSR chart', () => {
  const svgBar = (dataIndex: number, height: number) =>
    `<path d="M${100 + dataIndex * 75} 240l51.8 0l0 -${height}l-51.7 0Z" fill="#5070dd" `
    + `ecmeta_series_index="0" ecmeta_data_index="${dataIndex}"></path>`;

  const svgPage = (heights: number[]) => `<!doctype html><html><body><h1>Incidents by area</h1>
    <svg width="720" height="320">
      <rect width="720" height="320" x="0" y="0" fill="none"></rect>
      <path d="M75 240L700 240" fill="none" stroke="#dbdee4"></path>
      ${heights.map((h, i) => svgBar(i, h)).join('\n      ')}
    </svg></body></html>`;

  const faithful = AREAS.map((a) => a.incidents * 3.5);

  it('passes a faithful chart, binding each path to its datum via ecmeta_data_index', () => {
    const r = checkRenderedReport({ html: svgPage(faithful), data: { areas: AREAS } });
    expect(r.defects).toEqual([]);
    expect(r.checked.bars).toBe(5);
    expect(r.checked.boundBars).toBe(5);   // the probe really bound them
  });

  it('catches one path whose height no longer matches its datum', () => {
    const broken = faithful.slice();
    broken[0] = 8;
    const r = checkRenderedReport({ html: svgPage(broken), data: { areas: AREAS } });
    expect(codes(r)).toEqual([REPORT_CODES.BAR_PROPORTION]);
    expect(r.defects[0].message).toContain('"Auth"');
    expect(r.defects[0].message).toContain('value 45');
  });

  it('ignores axis lines and the background rect — only ecmeta-tagged shapes are data', () => {
    const r = checkRenderedReport({ html: svgPage(faithful), data: { areas: AREAS } });
    expect(r.checked.barGroups).toEqual([5]);
  });

  it('measures a path bounding box the way the renderer wrote it', () => {
    // Float accumulation is expected (86.6 + 51.8 - 51.7); the proportionality
    // check compares ratios with a 4%-of-full-scale tolerance, so this is exact
    // to every digit that matters.
    const box = __reportCheckInternals.pathBBox('M86.6 220l51.8 0l0 -139.5l-51.7 0Z');
    expect(box.w).toBeCloseTo(51.8, 6);
    expect(box.h).toBeCloseTo(139.5, 6);
  });
});

// ── genericity: a completely different report, zero configuration ───────────

function differentReport() {
  const teams = [
    { squad: 'Kestrel', velocity: 62 },
    { squad: 'Marlin', velocity: 31 },
    { squad: 'Osprey', velocity: 88 },
    { squad: 'Petrel', velocity: 12 },
  ];
  const releases = Array.from({ length: 7 }, (_, i) => ({
    tag: `v3.${i}.0`, squad: teams[i % teams.length].squad, notes: `release note ${i}`,
  }));
  const max = 88;
  const html = `<!doctype html><html><head><style>
    .meter { display: inline-block; height: 10px; background: #2a9d8f; }
  </style></head><body>
    <h2>Sprint velocity by squad</h2>
    <ul>${teams.map((t) => `<li>${t.squad} <span class="meter" style="width:${((t.velocity / max) * 100).toFixed(2)}%"></span> ${t.velocity}</li>`).join('')}</ul>
    <table><tbody>${releases.map((r) => `<tr><td>${r.tag}</td><td>${r.squad}</td><td>${r.notes}</td></tr>`).join('')}</tbody></table>
  </body></html>`;
  return { html, data: { teams, releases } };
}

describe('genericity — no per-page expectations anywhere', () => {
  it('passes a report with different keys, different labels and inline-block meters', () => {
    const { html, data } = differentReport();
    const r = checkRenderedReport({ html, data });
    expect(r.defects).toEqual([]);
    expect(r.checked.bars).toBe(4);
    expect(r.checked.boundBars).toBe(4);
    expect(r.checked.bodyRows).toBe(7);
  });

  it('catches a wrong meter in that same report, with no configuration change', () => {
    const { html, data } = differentReport();
    const broken = html.replace('width:70.45%', 'width:9.00%');   // Kestrel, 62 of 88
    expect(broken).not.toBe(html);                                 // the mutation must have landed
    const r = checkRenderedReport({ html: broken, data });
    expect(codes(r)).toEqual([REPORT_CODES.BAR_PROPORTION]);
    expect(r.defects[0].message).toContain('"Kestrel"');
  });

  it('keeps two charts on one page apart instead of comparing across them', () => {
    const html = `<!doctype html><html><head><style>.bar{display:block;height:8px;background:#333}</style></head><body>
      <h2>Two independent charts</h2>
      <div class="chartA">
        <div>alpha<span class="bar" style="width:100%"></span></div>
        <div>beta<span class="bar" style="width:50%"></span></div>
        <div>gamma<span class="bar" style="width:25%"></span></div>
      </div>
      <div class="chartB">
        <div>north<span class="bar" style="width:30%"></span></div>
        <div>south<span class="bar" style="width:90%"></span></div>
        <div>east<span class="bar" style="width:60%"></span></div>
      </div></body></html>`;
    const data = {
      first: [{ n: 'alpha', v: 40 }, { n: 'beta', v: 20 }, { n: 'gamma', v: 10 }],
      second: [{ n: 'north', v: 10 }, { n: 'south', v: 30 }, { n: 'east', v: 20 }],
    };
    const r = checkRenderedReport({ html, data });
    expect(r.checked.barGroups.sort()).toEqual([3, 3]);
    expect(r.defects).toEqual([]);
  });
});

// ── the probe receipt: a clean verdict the caller can distrust ──────────────

describe('the probe receipt', () => {
  it('reports bars:0 when the bar widths are expressed in a form it cannot measure', () => {
    // Widths come from a CSS custom property, so there is no literal number to
    // read. The verdict is clean — and `checked` says loudly why it is worthless.
    const html = `<!doctype html><html><head><style>.bar{display:block;height:8px;background:#333;width:var(--w)}</style></head>
      <body><h2>Widths behind a custom property</h2>
      <div><span class="bar" style="--w:100%"></span></div>
      <div><span class="bar" style="--w:9%"></span></div></body></html>`;
    const r = checkRenderedReport({ html, data: { s: [{ k: 'a', v: 45 }, { k: 'b', v: 4 }] } });
    expect(r.ok).toBe(true);
    expect(r.checked.bars).toBe(0);         // ← the tell: nothing was measured
    expect(r.checked.boundBars).toBe(0);
  });

  it('refuses an empty page outright rather than returning a clean verdict', () => {
    const r = checkRenderedReport({ html: '   ', data: DATA });
    expect(r.ok).toBe(false);
    expect(r.defects[0].code).toBe('empty-content');
  });
});

// ── the skill wrapper ───────────────────────────────────────────────────────

describe('reportCheckSkill', () => {
  it('follows the multi-tool skill shape', () => {
    expect(reportCheckSkill.id).toBe('report-check');
    expect(reportCheckSkill.serverName).toBe('report_check');
    expect(reportCheckSkill.allowedTools).toEqual(['mcp__report_check__*']);
    expect(reportCheckSkill.tools).toHaveLength(1);
    expect(reportCheckSkill.tools[0].name).toBe('report_check');
    expect(reportCheckSkill.tools[0].input_schema.required).toEqual(['html', 'data']);
    expect(typeof reportCheckSkill.handleToolCall).toBe('function');
    expect(typeof reportCheckSkill.resolve).toBe('function');
  });

  it('needs no credentials — it is pure, so it runs wherever @zibby/skills is installed', () => {
    expect(reportCheckSkill.envKeys).toEqual([]);
    expect(reportCheckSkill.callsBackend).toBeUndefined();
    expect(reportCheckSkill.resolve().env).toEqual({});
  });

  it('returns the structured result through the tool', async () => {
    const out = JSON.parse(await reportCheckSkill.handleToolCall('report_check', { html: page({ dropRows: 3 }), data: DATA }));
    expect(out.ok).toBe(false);
    expect(out.defects[0].code).toBe(REPORT_CODES.ROW_MISSING);
    expect(out.checked.bodyRows).toBe(17);
  });

  it('accepts data handed over as a JSON string', async () => {
    const out = JSON.parse(await reportCheckSkill.handleToolCall('report_check', { html: page(), data: JSON.stringify(DATA) }));
    expect(out.ok).toBe(true);
    expect(out.checked.bars).toBe(5);
  });

  it('asks for what it needs instead of guessing', async () => {
    expect(JSON.parse(await reportCheckSkill.handleToolCall('report_check', { data: DATA })).error).toMatch(/html is required/);
    expect(JSON.parse(await reportCheckSkill.handleToolCall('report_check', { html: page() })).error).toMatch(/data is required/);
    expect(JSON.parse(await reportCheckSkill.handleToolCall('nope', {})).error).toMatch(/Unknown tool/);
  });
});
