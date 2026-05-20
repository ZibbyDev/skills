/**
 * Unit tests for @zibby/skills/report.
 *
 *  - Schema: validates valid input + rejects invalid (mismatched
 *    labels/values lengths, row vs header arity, missing required)
 *  - reportToBlockKit:
 *      header / subtitle / headline rendering
 *      each section kind (trend, table, callouts, breakdown, paragraph)
 *      footer buttons
 *      breakdown row chunking when > 10 fields
 *  - reportToLarkCard:
 *      same coverage, plus template color picked from headline severity
 *      subtitle plumbing
 */

import { describe, it, expect } from 'vitest';
import {
  reportObjectSchema,
  reportToBlockKit,
  reportToLarkCard,
  reportToNotionBlocks,
  SEVERITIES,
} from '../src/report.js';

// Minimal valid report — used as a base for many tests via spread.
function baseReport(overrides = {}) {
  return {
    title: 'Weekly AI Spend',
    subtitle: 'May 13 — May 20',
    headline: {
      primary: '$8,240',
      delta: { value: '+12% wow', direction: 'up', severity: 'warn' },
      summary: 'Anthropic +47%, /api/agent-run after PR #4214.',
    },
    sections: [],
    ...overrides,
  };
}

// ─────────────────────── Schema ───────────────────────

describe('reportObjectSchema', () => {
  it('accepts a minimal valid report', () => {
    const parsed = reportObjectSchema.safeParse(baseReport());
    expect(parsed.success).toBe(true);
  });

  it('rejects missing title', () => {
    const r = baseReport();
    delete r.title;
    expect(reportObjectSchema.safeParse(r).success).toBe(false);
  });

  it('trend section: rejects labels/values length mismatch', () => {
    const r = baseReport({
      sections: [
        { kind: 'trend', labels: ['A', 'B', 'C'], values: [1, 2] },
      ],
    });
    expect(reportObjectSchema.safeParse(r).success).toBe(false);
  });

  it('table section: rejects row arity mismatch', () => {
    const r = baseReport({
      sections: [
        { kind: 'table', headers: ['a', 'b'], rows: [['x', 'y', 'z']] },
      ],
    });
    expect(reportObjectSchema.safeParse(r).success).toBe(false);
  });

  it('SEVERITIES is closed at the four expected tones', () => {
    expect([...SEVERITIES]).toEqual(['ok', 'info', 'warn', 'critical']);
  });
});

// ─────────────────────── reportToBlockKit ───────────────────────

describe('reportToBlockKit', () => {
  it('emits a Slack header block with title + subtitle context', () => {
    const blocks = reportToBlockKit(baseReport());
    expect(blocks[0]).toEqual({
      type: 'header',
      text: { type: 'plain_text', text: 'Weekly AI Spend', emoji: true },
    });
    expect(blocks[1]).toEqual({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'May 13 — May 20' }],
    });
  });

  it('renders headline with delta + arrow + severity emoji + summary', () => {
    const blocks = reportToBlockKit(baseReport());
    const headline = blocks.find((b) => b.type === 'section' && b.text?.text?.includes('*$8,240*'));
    expect(headline).toBeDefined();
    expect(headline.text.text).toContain('*$8,240*');
    expect(headline.text.text).toContain('↑');
    expect(headline.text.text).toContain('+12% wow');
    expect(headline.text.text).toContain('🟠');
    expect(headline.text.text).toContain('Anthropic +47%');
  });

  it('trend section: emits divider + monospace block with unicode bars', () => {
    const blocks = reportToBlockKit(baseReport({
      sections: [
        {
          kind: 'trend',
          title: '4-Week Trend',
          labels: ['Week-3', 'Week-2', 'Week-1', 'This wk'],
          values: [6200, 7100, 7400, 8240],
          highlight: 'last',
          severity: 'warn',
        },
      ],
    }));
    const dividerIdx = blocks.findIndex((b) => b.type === 'divider');
    expect(dividerIdx).toBeGreaterThan(0);
    const titleBlock = blocks[dividerIdx + 1];
    expect(titleBlock.text.text).toBe('*4-Week Trend*');
    const trendBlock = blocks[dividerIdx + 2];
    expect(trendBlock.text.text).toMatch(/```\n.*```/s);
    expect(trendBlock.text.text).toContain('▓');
    // Last bucket highlighted with severity emoji
    expect(trendBlock.text.text).toMatch(/This wk.*🟠/);
  });

  it('table section: emits markdown code block aligned to widest cell', () => {
    const blocks = reportToBlockKit(baseReport({
      sections: [
        {
          kind: 'table',
          title: 'Top Projects',
          headers: ['Project', 'Cost', 'wow'],
          rows: [
            ['acme-prod', '$2,140', '+12%'],
            ['globex-stg', '$1,820', '+3%'],
          ],
        },
      ],
    }));
    const tableBlock = blocks.find((b) => b.text?.text?.includes('acme-prod'));
    expect(tableBlock).toBeDefined();
    expect(tableBlock.text.text).toContain('Project');
    expect(tableBlock.text.text).toContain('acme-prod');
    expect(tableBlock.text.text).toMatch(/^```\n/);
  });

  it('callouts section: emoji per item using tone', () => {
    const blocks = reportToBlockKit(baseReport({
      sections: [
        {
          kind: 'callouts',
          tone: 'warn',
          items: ['acme +320% — investigate', 'spike-tests +180% — load test'],
        },
      ],
    }));
    const callouts = blocks.find((b) => b.text?.text?.includes('acme +320%'));
    expect(callouts.text.text).toContain('🟠 acme +320%');
    expect(callouts.text.text).toContain('🟠 spike-tests');
  });

  it('breakdown section: emits a fields block', () => {
    const blocks = reportToBlockKit(baseReport({
      sections: [
        {
          kind: 'breakdown',
          rows: [
            { label: 'OpenAI', value: '$3,200', sub: '-3% wow', severity: 'ok' },
            { label: 'Anthropic', value: '$4,200', sub: '+47% wow', severity: 'warn' },
          ],
        },
      ],
    }));
    const fields = blocks.find((b) => b.fields);
    expect(fields).toBeDefined();
    expect(fields.fields).toHaveLength(2);
    expect(fields.fields[0].text).toContain('*OpenAI*');
    expect(fields.fields[0].text).toContain('🟢');
    expect(fields.fields[1].text).toContain('*Anthropic*');
    expect(fields.fields[1].text).toContain('🟠');
  });

  it('breakdown section: chunks at 10 fields per Slack block limit', () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      label: `r${i}`, value: `$${i}`,
    }));
    const blocks = reportToBlockKit(baseReport({
      sections: [{ kind: 'breakdown', rows }],
    }));
    const fieldsBlocks = blocks.filter((b) => Array.isArray(b.fields));
    expect(fieldsBlocks).toHaveLength(2);
    expect(fieldsBlocks[0].fields).toHaveLength(10);
    expect(fieldsBlocks[1].fields).toHaveLength(5);
  });

  it('paragraph section: emits a plain mrkdwn section block', () => {
    const blocks = reportToBlockKit(baseReport({
      sections: [{ kind: 'paragraph', text: 'Hello *world*' }],
    }));
    const para = blocks.find((b) => b.text?.text === 'Hello *world*');
    expect(para).toBeDefined();
  });

  it('footer: emits divider + actions with View / Run buttons', () => {
    const blocks = reportToBlockKit(baseReport({
      footer: {
        viewUrl: 'https://zibby.dev/x',
        rerunUrl: 'https://zibby.dev/x/rerun',
      },
    }));
    const actions = blocks.find((b) => b.type === 'actions');
    expect(actions).toBeDefined();
    expect(actions.elements).toHaveLength(2);
    expect(actions.elements[0].url).toBe('https://zibby.dev/x');
    expect(actions.elements[0].style).toBe('primary');
    expect(actions.elements[1].url).toBe('https://zibby.dev/x/rerun');
  });

  it('throws on invalid input (schema parse error surfaces)', () => {
    expect(() => reportToBlockKit({ title: 'x' })).toThrow();
    expect(() => reportToBlockKit({})).toThrow();
  });
});

// ─────────────────────── reportToLarkCard ───────────────────────

describe('reportToLarkCard', () => {
  it('returns a Lark interactive-card with header + elements', () => {
    const card = reportToLarkCard(baseReport());
    expect(card.config.wide_screen_mode).toBe(true);
    expect(card.header.title.content).toBe('Weekly AI Spend');
    expect(card.header.subtitle.content).toBe('May 13 — May 20');
    // headline severity=warn → orange template
    expect(card.header.template).toBe('orange');
    expect(card.elements[0].text.content).toContain('**$8,240**');
    expect(card.elements[0].text.content).toContain('↑');
    expect(card.elements[0].text.content).toContain('+12% wow');
  });

  it('template picks "red" for critical severity, "green" for ok', () => {
    expect(reportToLarkCard(baseReport({
      headline: { primary: '$0', delta: { value: '0%', severity: 'critical' } },
    })).header.template).toBe('red');
    expect(reportToLarkCard(baseReport({
      headline: { primary: '$0', delta: { value: '0%', severity: 'ok' } },
    })).header.template).toBe('green');
  });

  it('falls back to "blue" when no headline severity', () => {
    expect(reportToLarkCard(baseReport({
      headline: { primary: '$0' },
    })).header.template).toBe('blue');
  });

  it('renders trend as monospace bars with highlight emoji on last bucket', () => {
    const card = reportToLarkCard(baseReport({
      sections: [{
        kind: 'trend',
        labels: ['A', 'B', 'C'],
        values: [10, 20, 30],
        highlight: 'last',
        severity: 'critical',
      }],
    }));
    const trend = card.elements.find((e) => e.text?.content?.includes('▓'));
    expect(trend.text.content).toMatch(/```\n.*```/s);
    expect(trend.text.content).toMatch(/C\s+.*30.*🔴/);
  });

  it('renders table as a md code-block', () => {
    const card = reportToLarkCard(baseReport({
      sections: [{
        kind: 'table',
        headers: ['Project', 'Cost'],
        rows: [['x', '$1']],
      }],
    }));
    const tbl = card.elements.find((e) => e.text?.content?.includes('Project'));
    expect(tbl.text.content).toMatch(/^```/);
    expect(tbl.text.content).toContain('Project');
    expect(tbl.text.content).toContain('x');
  });

  it('renders callouts with tone emoji per item', () => {
    const card = reportToLarkCard(baseReport({
      sections: [{ kind: 'callouts', tone: 'warn', items: ['oops'] }],
    }));
    const c = card.elements.find((e) => e.text?.content?.includes('oops'));
    expect(c.text.content).toBe('🟠 oops');
  });

  it('renders breakdown rows with bold label + value + optional sub', () => {
    const card = reportToLarkCard(baseReport({
      sections: [{
        kind: 'breakdown',
        rows: [
          { label: 'OpenAI', value: '$3,200', sub: '-3% wow', severity: 'ok' },
        ],
      }],
    }));
    const bd = card.elements.find((e) => e.text?.content?.includes('OpenAI'));
    expect(bd.text.content).toContain('**OpenAI**');
    expect(bd.text.content).toContain('$3,200');
    expect(bd.text.content).toContain('*-3% wow*');
    expect(bd.text.content).toContain('🟢');
  });

  it('renders footer with two buttons', () => {
    const card = reportToLarkCard(baseReport({
      footer: { viewUrl: 'https://a.com', rerunUrl: 'https://b.com' },
    }));
    const action = card.elements.find((e) => e.tag === 'action');
    expect(action.actions).toHaveLength(2);
    expect(action.actions[0].url).toBe('https://a.com');
    expect(action.actions[0].type).toBe('primary');
    expect(action.actions[1].url).toBe('https://b.com');
  });

  it('drops subtitle when not provided', () => {
    const r = baseReport();
    delete r.subtitle;
    const card = reportToLarkCard(r);
    expect(card.header.subtitle).toBeUndefined();
  });

  it('throws on invalid input', () => {
    expect(() => reportToLarkCard({})).toThrow();
  });
});

// ─────────────────────── reportToNotionBlocks ───────────────────────

describe('reportToNotionBlocks', () => {
  it('returns { blocks, title, icon } shape', () => {
    const result = reportToNotionBlocks(baseReport());
    expect(result).toHaveProperty('blocks');
    expect(result).toHaveProperty('title');
    expect(result).toHaveProperty('icon');
    expect(Array.isArray(result.blocks)).toBe(true);
    expect(typeof result.title).toBe('string');
  });

  it('title is the report.title (preserved through the renderer)', () => {
    // Schema caps title at 200 chars (rejected at parse-time if longer).
    // The renderer's `.slice(0, 200)` is defensive — verify it preserves
    // a max-length input unchanged.
    const { title } = reportToNotionBlocks(baseReport({ title: 'A'.repeat(200) }));
    expect(title.length).toBe(200);
    expect(title).toBe('A'.repeat(200));
  });

  it('emits a heading_1 block with the title as the first content block', () => {
    const { blocks } = reportToNotionBlocks(baseReport());
    expect(blocks[0].type).toBe('heading_1');
    expect(blocks[0].heading_1.rich_text[0].text.content).toBe('Weekly AI Spend');
  });

  it('emits a grey-background paragraph for the subtitle', () => {
    const { blocks } = reportToNotionBlocks(baseReport());
    // The subtitle paragraph follows the heading_1.
    const sub = blocks[1];
    expect(sub.type).toBe('paragraph');
    expect(sub.paragraph.color).toBe('gray_background');
    expect(sub.paragraph.rich_text[0].text.content).toBe('May 13 — May 20');
  });

  it('drops subtitle paragraph when subtitle is absent', () => {
    const r = baseReport();
    delete r.subtitle;
    const { blocks } = reportToNotionBlocks(r);
    // blocks[0] = heading_1, blocks[1] = headline paragraph (no subtitle slot)
    expect(blocks[1].type).toBe('paragraph');
    expect(blocks[1].paragraph.color).toBeUndefined();
  });

  it('renders headline with bold primary + delta arrow + severity emoji', () => {
    const { blocks } = reportToNotionBlocks(baseReport());
    // After heading_1 + subtitle paragraph, blocks[2] is the headline.
    const headline = blocks[2];
    expect(headline.type).toBe('paragraph');
    const richText = headline.paragraph.rich_text;
    expect(richText[0].text.content).toBe('$8,240');
    expect(richText[0].annotations.bold).toBe(true);
    // Delta segment contains the arrow + value + severity emoji
    expect(richText[1].text.content).toContain('↑');
    expect(richText[1].text.content).toContain('+12% wow');
    expect(richText[1].text.content).toContain('🟠');
  });

  it('emits the headline summary as a plain paragraph', () => {
    const { blocks } = reportToNotionBlocks(baseReport());
    const summary = blocks.find((b) =>
      b.type === 'paragraph'
      && b.paragraph?.rich_text?.[0]?.text?.content?.includes('Anthropic +47%'));
    expect(summary).toBeDefined();
    expect(summary.paragraph.color).toBeUndefined();
  });

  it('icon: maps headline.delta.severity to a page-icon emoji', () => {
    expect(reportToNotionBlocks(baseReport({
      headline: { primary: '$0', delta: { value: '0%', severity: 'critical' } },
    })).icon).toBe('🚨');
    expect(reportToNotionBlocks(baseReport({
      headline: { primary: '$0', delta: { value: '0%', severity: 'ok' } },
    })).icon).toBe('🟢');
    expect(reportToNotionBlocks(baseReport({
      headline: { primary: '$0', delta: { value: '0%', severity: 'warn' } },
    })).icon).toBe('⚠️');
    expect(reportToNotionBlocks(baseReport({
      headline: { primary: '$0', delta: { value: '0%', severity: 'info' } },
    })).icon).toBe('ℹ️');
  });

  it('icon: undefined when no headline.delta.severity', () => {
    const { icon } = reportToNotionBlocks(baseReport({
      headline: { primary: '$100' },
    }));
    expect(icon).toBeUndefined();
  });

  it('emits a divider before each section', () => {
    const { blocks } = reportToNotionBlocks(baseReport({
      sections: [
        { kind: 'paragraph', text: 'hi' },
        { kind: 'paragraph', text: 'bye' },
      ],
    }));
    const dividers = blocks.filter((b) => b.type === 'divider');
    // One divider before each of the two sections (footer divider only
    // emitted when footer URLs are present).
    expect(dividers.length).toBe(2);
  });

  it('emits a heading_2 block for sections with titles', () => {
    const { blocks } = reportToNotionBlocks(baseReport({
      sections: [{ kind: 'paragraph', title: 'Notes', text: 'hi' }],
    }));
    const h2 = blocks.find((b) => b.type === 'heading_2');
    expect(h2).toBeDefined();
    expect(h2.heading_2.rich_text[0].text.content).toBe('Notes');
  });

  it('paragraph section: emits a paragraph block with the text', () => {
    const { blocks } = reportToNotionBlocks(baseReport({
      sections: [{ kind: 'paragraph', text: 'Hello *world*' }],
    }));
    const para = blocks.find((b) =>
      b.type === 'paragraph'
      && b.paragraph.rich_text[0].text.content === 'Hello *world*');
    expect(para).toBeDefined();
  });

  it('trend section: emits a code block (plain text) with monospace bars', () => {
    const { blocks } = reportToNotionBlocks(baseReport({
      sections: [{
        kind: 'trend',
        title: '4-Week Trend',
        labels: ['Week-3', 'Week-2', 'Week-1', 'This wk'],
        values: [6200, 7100, 7400, 8240],
        highlight: 'last',
        severity: 'warn',
      }],
    }));
    const code = blocks.find((b) => b.type === 'code');
    expect(code).toBeDefined();
    expect(code.code.language).toBe('plain text');
    const text = code.code.rich_text[0].text.content;
    expect(text).toContain('▓');
    // Last bucket gets the severity highlight emoji
    expect(text).toMatch(/This wk.*🟠/);
  });

  it('trend section: highlight=max picks the largest value', () => {
    const { blocks } = reportToNotionBlocks(baseReport({
      sections: [{
        kind: 'trend',
        labels: ['A', 'B', 'C'],
        values: [10, 99, 20],
        highlight: 'max',
        severity: 'critical',
      }],
    }));
    const code = blocks.find((b) => b.type === 'code');
    expect(code.code.rich_text[0].text.content).toMatch(/B\s+99\s+▓+\s*🔴/);
  });

  it('trend section: highlight=min picks the smallest value', () => {
    const { blocks } = reportToNotionBlocks(baseReport({
      sections: [{
        kind: 'trend',
        labels: ['A', 'B', 'C'],
        values: [10, 99, 20],
        highlight: 'min',
        severity: 'ok',
      }],
    }));
    const code = blocks.find((b) => b.type === 'code');
    expect(code.code.rich_text[0].text.content).toMatch(/A\s+10\s+[▓░]+\s*🟢/);
  });

  it('table section: emits a Notion table block with header + data rows', () => {
    const { blocks } = reportToNotionBlocks(baseReport({
      sections: [{
        kind: 'table',
        title: 'Top Projects',
        headers: ['Project', 'Cost', 'wow'],
        rows: [
          ['acme-prod', '$2,140', '+12%'],
          ['globex-stg', '$1,820', '+3%'],
        ],
      }],
    }));
    const table = blocks.find((b) => b.type === 'table');
    expect(table).toBeDefined();
    expect(table.table.table_width).toBe(3);
    expect(table.table.has_column_header).toBe(true);
    // children: 1 header row + 2 data rows
    expect(table.table.children).toHaveLength(3);
    // Header row
    expect(table.table.children[0].type).toBe('table_row');
    expect(table.table.children[0].table_row.cells).toHaveLength(3);
    expect(table.table.children[0].table_row.cells[0][0].text.content).toBe('Project');
    // First data row
    expect(table.table.children[1].table_row.cells[0][0].text.content).toBe('acme-prod');
    expect(table.table.children[1].table_row.cells[1][0].text.content).toBe('$2,140');
  });

  it('table section: stringifies numeric cells', () => {
    const { blocks } = reportToNotionBlocks(baseReport({
      sections: [{
        kind: 'table',
        headers: ['Project', 'Count'],
        rows: [['acme', 42]],
      }],
    }));
    const table = blocks.find((b) => b.type === 'table');
    expect(table.table.children[1].table_row.cells[1][0].text.content).toBe('42');
  });

  it('callouts section: each item becomes a separate callout block with tone color', () => {
    const { blocks } = reportToNotionBlocks(baseReport({
      sections: [{
        kind: 'callouts',
        tone: 'warn',
        items: ['acme +320% — investigate', 'spike-tests +180% — load test'],
      }],
    }));
    const callouts = blocks.filter((b) => b.type === 'callout');
    expect(callouts).toHaveLength(2);
    for (const c of callouts) {
      expect(c.callout.color).toBe('orange_background');
      expect(c.callout.icon.type).toBe('emoji');
      expect(c.callout.icon.emoji).toBe('⚠️');
    }
    expect(callouts[0].callout.rich_text[0].text.content).toBe('acme +320% — investigate');
  });

  it('callouts section: each tone maps to the correct Notion background color', () => {
    const colors = {};
    for (const tone of ['ok', 'info', 'warn', 'critical']) {
      const { blocks } = reportToNotionBlocks(baseReport({
        sections: [{ kind: 'callouts', tone, items: ['x'] }],
      }));
      colors[tone] = blocks.find((b) => b.type === 'callout').callout.color;
    }
    expect(colors).toEqual({
      ok:       'green_background',
      info:     'blue_background',
      warn:     'orange_background',
      critical: 'red_background',
    });
  });

  it('callouts section: defaults tone to info when omitted', () => {
    const { blocks } = reportToNotionBlocks(baseReport({
      sections: [{ kind: 'callouts', items: ['x'] }],
    }));
    expect(blocks.find((b) => b.type === 'callout').callout.color).toBe('blue_background');
  });

  it('breakdown section: emits one bulleted_list_item per row with bold label', () => {
    const { blocks } = reportToNotionBlocks(baseReport({
      sections: [{
        kind: 'breakdown',
        rows: [
          { label: 'OpenAI', value: '$3,200', sub: '-3% wow', severity: 'ok' },
          { label: 'Anthropic', value: '$4,200', sub: '+47% wow', severity: 'warn' },
        ],
      }],
    }));
    const bullets = blocks.filter((b) => b.type === 'bulleted_list_item');
    expect(bullets).toHaveLength(2);
    // First bullet: bold label + value + italic sub + severity emoji
    const richText = bullets[0].bulleted_list_item.rich_text;
    expect(richText[0].text.content).toBe('OpenAI: ');
    expect(richText[0].annotations.bold).toBe(true);
    expect(richText[1].text.content).toBe('$3,200');
    expect(richText[2].text.content).toContain('-3% wow');
    expect(richText[2].annotations.italic).toBe(true);
    expect(richText[3].text.content).toContain('🟢');
  });

  it('breakdown section: omits sub + severity segments when not provided', () => {
    const { blocks } = reportToNotionBlocks(baseReport({
      sections: [{
        kind: 'breakdown',
        rows: [{ label: 'OpenAI', value: '$3,200' }],
      }],
    }));
    const richText = blocks.find((b) => b.type === 'bulleted_list_item').bulleted_list_item.rich_text;
    expect(richText).toHaveLength(2); // bold-label + value only
    expect(richText[0].text.content).toBe('OpenAI: ');
    expect(richText[1].text.content).toBe('$3,200');
  });

  it('footer: emits divider + embed blocks for viewUrl + rerunUrl', () => {
    const { blocks } = reportToNotionBlocks(baseReport({
      footer: {
        viewUrl: 'https://zibby.dev/x',
        rerunUrl: 'https://zibby.dev/x/rerun',
      },
    }));
    const embeds = blocks.filter((b) => b.type === 'embed');
    expect(embeds).toHaveLength(2);
    expect(embeds[0].embed.url).toBe('https://zibby.dev/x');
    expect(embeds[1].embed.url).toBe('https://zibby.dev/x/rerun');
  });

  it('footer: omits embeds entirely when footer is absent', () => {
    const { blocks } = reportToNotionBlocks(baseReport());
    expect(blocks.find((b) => b.type === 'embed')).toBeUndefined();
  });

  it('footer: only viewUrl → one embed', () => {
    const { blocks } = reportToNotionBlocks(baseReport({
      footer: { viewUrl: 'https://zibby.dev/x' },
    }));
    expect(blocks.filter((b) => b.type === 'embed')).toHaveLength(1);
  });

  it('full kitchen-sink: all 5 section kinds + footer in one render', () => {
    const { blocks, title, icon } = reportToNotionBlocks(baseReport({
      sections: [
        { kind: 'paragraph', text: 'Intro paragraph' },
        { kind: 'trend', labels: ['A', 'B'], values: [1, 2] },
        { kind: 'table', headers: ['x'], rows: [['y']] },
        { kind: 'callouts', items: ['note 1'] },
        { kind: 'breakdown', rows: [{ label: 'k', value: 'v' }] },
      ],
      footer: { viewUrl: 'https://a.com' },
    }));
    expect(title).toBe('Weekly AI Spend');
    // Headline severity=warn → ⚠️ icon
    expect(icon).toBe('⚠️');
    // Sanity: at least one of each block kind
    const types = new Set(blocks.map((b) => b.type));
    expect(types.has('heading_1')).toBe(true);
    expect(types.has('paragraph')).toBe(true);
    expect(types.has('divider')).toBe(true);
    expect(types.has('code')).toBe(true);
    expect(types.has('table')).toBe(true);
    expect(types.has('callout')).toBe(true);
    expect(types.has('bulleted_list_item')).toBe(true);
    expect(types.has('embed')).toBe(true);
  });

  it('every emitted block carries object="block" (Notion API contract)', () => {
    const { blocks } = reportToNotionBlocks(baseReport({
      sections: [
        { kind: 'paragraph', text: 'p' },
        { kind: 'trend', labels: ['A', 'B'], values: [1, 2] },
        { kind: 'table', headers: ['x'], rows: [['y']] },
        { kind: 'callouts', items: ['c'] },
        { kind: 'breakdown', rows: [{ label: 'k', value: 'v' }] },
      ],
    }));
    for (const b of blocks) {
      expect(b.object).toBe('block');
    }
  });

  it('throws on invalid input (schema parse error surfaces)', () => {
    expect(() => reportToNotionBlocks({})).toThrow();
    expect(() => reportToNotionBlocks({ title: 'x' })).toThrow();
  });
});
