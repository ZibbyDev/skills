/**
 * report — universal "rich digest" structured object + per-destination
 * renderers.
 *
 * Why this lives in @zibby/skills (not workflow-templates):
 *
 *   - The SCHEMA is the contract between any producer (analyze nodes
 *     in digest workflows) and any consumer (notify-slack /
 *     notify-lark / future notify-notion / etc.). Centralizing it here
 *     keeps producer and consumer in lockstep without circular
 *     dependencies between sibling templates.
 *
 *   - The RENDERERS (reportToBlockKit, reportToLarkCard) are
 *     deterministic functions — pure mapping from report-object to the
 *     destination's native rich-card spec. They can be unit-tested in
 *     isolation; the notify-* templates wire them into their execute
 *     paths.
 *
 *   - Adding `notify-notion` later means writing a `reportToNotionBlocks`
 *     here, then a thin template node that imports it. No changes to
 *     existing templates or the schema.
 *
 * Format: 6 section kinds — headline, trend, table, callouts,
 * breakdown, paragraph. Each section is rendered to native Slack
 * Block-Kit / Lark-Card components. NO third-party chart-rendering,
 * NO image generation — we rely on the IM platform's native UI.
 */

import { z } from 'zod';

// ─────────────────────── Schema ───────────────────────

export const SEVERITIES = /** @type {const} */ (['ok', 'info', 'warn', 'critical']);

const headlineSchema = z.object({
  primary: z.string().min(1).max(200)
    .describe('Headline number or phrase (e.g. "$8,240"). Rendered in large/bold.'),
  delta: z.object({
    value: z.string().max(40)
      .describe('Delta vs baseline (e.g. "+12% wow"). Free-form string.'),
    direction: z.enum(['up', 'down', 'flat']).optional(),
    severity: z.enum(SEVERITIES).optional()
      .describe('Color severity for the delta (warn/critical highlights regressions).'),
  }).optional()
    .describe('Optional comparison vs baseline. Renders inline next to primary.'),
  summary: z.string().max(800).optional()
    .describe('One-sentence narrative ("why this number"). Plain prose.'),
});

const trendSectionSchema = z.object({
  kind: z.literal('trend'),
  title: z.string().max(120).optional(),
  labels: z.array(z.string().max(60)).min(2).max(20)
    .describe('Bucket labels (e.g. ["Week-3", "Week-2", "Week-1", "This wk"]).'),
  values: z.array(z.number()).min(2).max(20)
    .describe('Numeric values, one per label. Must match labels.length.'),
  highlight: z.enum(['last', 'max', 'min', 'none']).default('last').optional()
    .describe('Which bucket to visually highlight in the rendered card.'),
  severity: z.enum(SEVERITIES).optional(),
});

const tableSectionSchema = z.object({
  kind: z.literal('table'),
  title: z.string().max(120).optional(),
  headers: z.array(z.string().max(40)).min(1).max(8),
  rows: z.array(
    z.array(z.union([z.string().max(200), z.number()]))
      .min(1).max(8)
  ).max(40)
    .describe('2D matrix. Each inner array must have headers.length entries.'),
});

const calloutsSectionSchema = z.object({
  kind: z.literal('callouts'),
  title: z.string().max(120).optional(),
  tone: z.enum(SEVERITIES).default('info').optional(),
  items: z.array(z.string().min(1).max(600)).min(1).max(10)
    .describe('Each item renders as a bullet with a severity emoji.'),
});

const breakdownSectionSchema = z.object({
  kind: z.literal('breakdown'),
  title: z.string().max(120).optional(),
  rows: z.array(z.object({
    label: z.string().min(1).max(80),
    value: z.string().min(1).max(80),
    sub:   z.string().max(120).optional(),
    severity: z.enum(SEVERITIES).optional(),
  })).min(1).max(20),
});

const paragraphSectionSchema = z.object({
  kind: z.literal('paragraph'),
  title: z.string().max(120).optional(),
  text: z.string().min(1).max(3000),
});

const sectionSchema = z.discriminatedUnion('kind', [
  trendSectionSchema,
  tableSectionSchema,
  calloutsSectionSchema,
  breakdownSectionSchema,
  paragraphSectionSchema,
]);

export const reportObjectSchema = z.object({
  title: z.string().min(1).max(200)
    .describe('Card title (e.g. "Weekly AI Spend Report").'),
  subtitle: z.string().max(200).optional()
    .describe('Date range or smaller header (e.g. "May 13 — May 20").'),
  headline: headlineSchema,
  sections: z.array(sectionSchema).max(20).default([])
    // Cross-field checks that USED to live on the trend/table section
    // schemas as `.refine()`. They had to move here: `.refine()` wraps a
    // ZodObject in a ZodEffects, and z.discriminatedUnion() requires raw
    // ZodObjects (it reads each option's `.shape[discriminator]`). A
    // ZodEffects member made discriminatedUnion throw "Cannot read
    // properties of undefined (reading 'kind')" at import time, crashing
    // the whole @zibby/skills package for every workflow that loads it.
    .superRefine((arr, ctx) => {
      arr.forEach((s, i) => {
        if (s.kind === 'trend' && s.labels.length !== s.values.length) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'values'], message: 'labels.length must equal values.length' });
        }
        if (s.kind === 'table' && !s.rows.every((r) => r.length === s.headers.length)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'rows'], message: 'every row must have headers.length entries' });
        }
      });
    }),
  footer: z.object({
    viewUrl: z.string().url().optional()
      .describe('Optional "View in Zibby" button URL.'),
    rerunUrl: z.string().url().optional()
      .describe('Optional "Run again" button URL.'),
  }).optional(),
});

// Severity → ascii indicator (works in both Slack mrkdwn and Lark md).
// Slack/Lark also render emoji shortcodes, but a raw unicode emoji is
// rendered consistently across desktop + mobile. We use circle glyphs
// because they don't add visual weight to the text.
const SEVERITY_EMOJI = Object.freeze({
  ok:       '🟢',
  info:     '🔵',
  warn:     '🟠',
  critical: '🔴',
});

const DELTA_ARROW = Object.freeze({
  up: '↑',
  down: '↓',
  flat: '→',
});

// Slack Block-Kit header `template` color enum — best-effort mapping.
// 'orange' isn't actually supported by Slack (their docs only allow a
// fixed set of color names), but Lark accepts it. For Slack we
// approximate via emoji prefix in the header text + severity-colored
// callouts inside the card.
const SEVERITY_LARK_TEMPLATE = Object.freeze({
  ok:       'green',
  info:     'blue',
  warn:     'orange',
  critical: 'red',
});

function unicodeBar(value, max, width = 12) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return '';
  const pct = Math.max(0, Math.min(1, value / max));
  const filled = Math.round(pct * width);
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

function padRight(s, n) {
  const str = String(s);
  if (str.length >= n) return str;
  return str + ' '.repeat(n - str.length);
}

function padLeft(s, n) {
  const str = String(s);
  if (str.length >= n) return str;
  return ' '.repeat(n - str.length) + str;
}

function formatTableAsMarkdown({ headers, rows }) {
  // Compute column widths from the longest cell (cap at 32 to keep
  // mobile readable). The result is a monospace-aligned table that
  // both Slack mrkdwn and Lark md render inside ``` code fences.
  const widths = headers.map((h, i) => {
    const colMax = Math.max(
      String(h).length,
      ...rows.map((r) => String(r[i] ?? '').length),
    );
    return Math.min(colMax, 32);
  });
  const renderRow = (cells) => cells.map((c, i) => padRight(c, widths[i])).join('  ');
  const sep = widths.map((w) => '─'.repeat(w)).join('  ');
  const lines = [
    renderRow(headers),
    sep,
    ...rows.map((r) => renderRow(r)),
  ];
  return '```\n' + lines.join('\n') + '\n```';
}

// ─────────────────────── Slack Block-Kit renderer ───────────────────────

/**
 * Convert a report-object → Slack Block-Kit `blocks` array.
 *
 * Pure function: input → output, no I/O. Throws on invalid input
 * (zod parse error). Callers should validate before calling if they
 * want softer error messages.
 *
 * @param {z.infer<typeof reportObjectSchema>} report
 * @returns {Object[]} Block Kit blocks suitable for chat.postMessage's
 *                    `blocks` field.
 */
export function reportToBlockKit(report) {
  const parsed = reportObjectSchema.parse(report);
  const blocks = [];

  // Header — title (+ optional subtitle as secondary line)
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: parsed.title.slice(0, 150), emoji: true },
  });
  if (parsed.subtitle) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: parsed.subtitle }],
    });
  }

  // Headline (primary + delta + summary)
  const headlineParts = [`*${parsed.headline.primary}*`];
  if (parsed.headline.delta) {
    const arrow = DELTA_ARROW[parsed.headline.delta.direction] || '';
    const sev = parsed.headline.delta.severity
      ? SEVERITY_EMOJI[parsed.headline.delta.severity]
      : '';
    headlineParts.push(`${arrow} ${parsed.headline.delta.value} ${sev}`.trim());
  }
  let headlineText = headlineParts.join('   ');
  if (parsed.headline.summary) {
    headlineText += '\n' + parsed.headline.summary;
  }
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: headlineText } });

  // Sections
  for (const section of parsed.sections) {
    blocks.push({ type: 'divider' });

    if (section.title) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${section.title}*` },
      });
    }

    switch (section.kind) {
      case 'trend': {
        const max = Math.max(...section.values);
        const lines = section.labels.map((label, i) => {
          const value = section.values[i];
          const bar = unicodeBar(value, max);
          const highlight = (
            (section.highlight === 'last' && i === section.labels.length - 1)
            || (section.highlight === 'max' && value === max)
            || (section.highlight === 'min' && value === Math.min(...section.values))
          );
          const tag = highlight && section.severity
            ? ` ${SEVERITY_EMOJI[section.severity]}`
            : '';
          return `${padRight(label, 10)} ${padLeft(value.toLocaleString(), 8)}  ${bar}${tag}`;
        });
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: '```\n' + lines.join('\n') + '\n```' },
        });
        break;
      }
      case 'table': {
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: formatTableAsMarkdown(section) },
        });
        break;
      }
      case 'callouts': {
        const tone = SEVERITY_EMOJI[section.tone || 'info'];
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: section.items.map((it) => `${tone} ${it}`).join('\n'),
          },
        });
        break;
      }
      case 'breakdown': {
        // Two columns of fields when count is even, otherwise one column.
        const fields = section.rows.map((row) => ({
          type: 'mrkdwn',
          text: `*${row.label}*\n${row.value}${row.sub ? `\n_${row.sub}_` : ''}${row.severity ? ` ${SEVERITY_EMOJI[row.severity]}` : ''}`,
        }));
        // Block Kit caps `fields` at 10 entries per section block; chunk.
        for (let i = 0; i < fields.length; i += 10) {
          blocks.push({ type: 'section', fields: fields.slice(i, i + 10) });
        }
        break;
      }
      case 'paragraph': {
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: section.text },
        });
        break;
      }
      // exhaustive by zod discriminatedUnion — no default needed
    }
  }

  // Footer actions
  if (parsed.footer && (parsed.footer.viewUrl || parsed.footer.rerunUrl)) {
    const actions = [];
    if (parsed.footer.viewUrl) {
      actions.push({
        type: 'button',
        text: { type: 'plain_text', text: 'View in Zibby' },
        url: parsed.footer.viewUrl,
        style: 'primary',
      });
    }
    if (parsed.footer.rerunUrl) {
      actions.push({
        type: 'button',
        text: { type: 'plain_text', text: 'Run again' },
        url: parsed.footer.rerunUrl,
      });
    }
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'actions', elements: actions });
  }

  return blocks;
}

// ─────────────────────── Lark Card renderer ───────────────────────

/**
 * Convert a report-object → Lark interactive-card JSON.
 *
 * @param {z.infer<typeof reportObjectSchema>} report
 * @returns {Object} Lark message card payload — use as `card` field on
 *                   im/v1/messages with msg_type=interactive.
 */
export function reportToLarkCard(report) {
  const parsed = reportObjectSchema.parse(report);
  const elements = [];

  // Headline section
  const headlineParts = [`**${parsed.headline.primary}**`];
  if (parsed.headline.delta) {
    const arrow = DELTA_ARROW[parsed.headline.delta.direction] || '';
    const sev = parsed.headline.delta.severity
      ? SEVERITY_EMOJI[parsed.headline.delta.severity]
      : '';
    headlineParts.push(`${arrow} ${parsed.headline.delta.value} ${sev}`.trim());
  }
  let headlineText = headlineParts.join('   ');
  if (parsed.headline.summary) {
    headlineText += '\n' + parsed.headline.summary;
  }
  elements.push({ tag: 'div', text: { tag: 'lark_md', content: headlineText } });

  for (const section of parsed.sections) {
    elements.push({ tag: 'hr' });

    if (section.title) {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**${section.title}**` } });
    }

    switch (section.kind) {
      case 'trend': {
        const max = Math.max(...section.values);
        const lines = section.labels.map((label, i) => {
          const value = section.values[i];
          const bar = unicodeBar(value, max);
          const highlight = (
            (section.highlight === 'last' && i === section.labels.length - 1)
            || (section.highlight === 'max' && value === max)
            || (section.highlight === 'min' && value === Math.min(...section.values))
          );
          const tag = highlight && section.severity
            ? ` ${SEVERITY_EMOJI[section.severity]}`
            : '';
          return `${padRight(label, 10)} ${padLeft(value.toLocaleString(), 8)}  ${bar}${tag}`;
        });
        elements.push({
          tag: 'div',
          text: { tag: 'lark_md', content: '```\n' + lines.join('\n') + '\n```' },
        });
        break;
      }
      case 'table': {
        elements.push({
          tag: 'div',
          text: { tag: 'lark_md', content: formatTableAsMarkdown(section) },
        });
        break;
      }
      case 'callouts': {
        const tone = SEVERITY_EMOJI[section.tone || 'info'];
        elements.push({
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: section.items.map((it) => `${tone} ${it}`).join('\n'),
          },
        });
        break;
      }
      case 'breakdown': {
        // Lark supports `column_set` — but a simpler md table-style
        // rendering matches the trend section and is consistent across
        // desktop + mobile. We keep one bullet per row.
        const lines = section.rows.map((row) => {
          const sev = row.severity ? ` ${SEVERITY_EMOJI[row.severity]}` : '';
          const sub = row.sub ? `  *${row.sub}*` : '';
          return `**${row.label}**  ${row.value}${sub}${sev}`;
        });
        elements.push({
          tag: 'div',
          text: { tag: 'lark_md', content: lines.join('\n') },
        });
        break;
      }
      case 'paragraph': {
        elements.push({
          tag: 'div',
          text: { tag: 'lark_md', content: section.text },
        });
        break;
      }
    }
  }

  if (parsed.footer && (parsed.footer.viewUrl || parsed.footer.rerunUrl)) {
    const actions = [];
    if (parsed.footer.viewUrl) {
      actions.push({
        tag: 'button',
        text: { tag: 'plain_text', content: 'View in Zibby' },
        url: parsed.footer.viewUrl,
        type: 'primary',
      });
    }
    if (parsed.footer.rerunUrl) {
      actions.push({
        tag: 'button',
        text: { tag: 'plain_text', content: 'Run again' },
        url: parsed.footer.rerunUrl,
        type: 'default',
      });
    }
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'action', actions });
  }

  // Card-level header template color follows the highest-severity
  // signal — headline delta severity if present, otherwise first
  // callout's tone, otherwise blue.
  let template = 'blue';
  if (parsed.headline.delta?.severity) {
    template = SEVERITY_LARK_TEMPLATE[parsed.headline.delta.severity] || 'blue';
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: parsed.title.slice(0, 200) },
      subtitle: parsed.subtitle
        ? { tag: 'plain_text', content: parsed.subtitle.slice(0, 200) }
        : undefined,
      template,
    },
    elements,
  };
}

// ─────────────────────── Notion Blocks renderer ───────────────────────

// Notion supports a fixed set of "background" colors on callouts /
// paragraphs / etc. We map the four canonical SEVERITIES onto the
// closest available Notion color so callouts visually carry severity
// without needing image generation. See:
//   https://developers.notion.com/reference/rich-text#the-annotation-object
const SEVERITY_NOTION_COLOR = Object.freeze({
  ok:       'green_background',
  info:     'blue_background',
  warn:     'orange_background',
  critical: 'red_background',
});

// Notion's page-icon slot is an emoji. Severity → icon mirrors the
// SEVERITY_EMOJI table but uses bigger, more "page-icon-friendly"
// glyphs (the small unicode dots used in chat-card body text look lost
// at icon size).
const SEVERITY_NOTION_ICON = Object.freeze({
  ok:       '🟢',
  info:     'ℹ️',
  warn:     '⚠️',
  critical: '🚨',
});

/** Wrap a string into a Notion rich-text array (single segment). */
function notionRichText(text, opts = {}) {
  // Notion caps each rich-text text.content at 2000 chars. Splitting
  // is the API's responsibility for longer strings, but the schema
  // already caps each cell/paragraph well under 2000 so a single
  // segment per call is safe.
  const segment = {
    type: 'text',
    text: { content: String(text).slice(0, 2000) },
  };
  if (opts.annotations) segment.annotations = opts.annotations;
  return [segment];
}

/** A `paragraph` block holding a single rich-text run. */
function notionParagraph(text, color) {
  const block = {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: notionRichText(text) },
  };
  if (color) block.paragraph.color = color;
  return block;
}

/** A `code` block in plain text — used for trend bars + table grids. */
function notionCodeBlock(text) {
  return {
    object: 'block',
    type: 'code',
    code: {
      rich_text: notionRichText(text),
      // 'plain text' is Notion's literal language enum value for raw
      // monospace blocks (no syntax highlighting). Source:
      //   https://developers.notion.com/reference/block#code
      language: 'plain text',
    },
  };
}

/**
 * Convert a report-object → Notion blocks payload.
 *
 * Returns three things rather than just `blocks` because Notion's
 * page-create endpoint takes title + icon as page properties (separate
 * from the children blocks). Callers wire them as:
 *   POST /v1/pages
 *     { parent: { database_id }, properties: { Name: { title: [...] } },
 *       icon: { type: 'emoji', emoji }, children: blocks }
 * — or, for append-to-existing-page:
 *   PATCH /v1/blocks/{pageId}/children
 *     { children: blocks }
 * (the title + icon are dropped when appending).
 *
 * Pure function: input → output, no I/O. Throws on invalid input
 * (zod parse error). Notion's block schema documented at:
 *   https://developers.notion.com/reference/block
 *
 * @param {z.infer<typeof reportObjectSchema>} report
 * @returns {{ blocks: Object[], title: string, icon?: string }}
 *   blocks: array of Notion block objects (no `id` / `parent` — those
 *           are server-assigned at create time)
 *   title:  string for the page's Name title property
 *   icon:   optional severity-mapped emoji for the page icon
 */
export function reportToNotionBlocks(report) {
  const parsed = reportObjectSchema.parse(report);
  const blocks = [];

  // ── Headline group ────────────────────────────────────────────
  // The page title (and optional emoji icon) already cover the
  // headline at the page level. We additionally emit a heading_1 +
  // a paragraph so a user opening the page sees the same context as
  // someone reading the Slack card / Lark card.

  blocks.push({
    object: 'block',
    type: 'heading_1',
    heading_1: { rich_text: notionRichText(parsed.title.slice(0, 200)) },
  });

  if (parsed.subtitle) {
    // Use a paragraph with grey background to visually demote the
    // subtitle (Notion has no native "subtitle" block). The grey is
    // the only severity-neutral background and matches the visual
    // hierarchy of Slack's `context` block.
    blocks.push(notionParagraph(parsed.subtitle, 'gray_background'));
  }

  // Headline primary number + delta on one line via two text segments
  // with different annotations (bold primary, then plain delta+arrow).
  const headlineRich = [
    {
      type: 'text',
      text: { content: parsed.headline.primary.slice(0, 200) },
      annotations: { bold: true },
    },
  ];
  if (parsed.headline.delta) {
    const arrow = DELTA_ARROW[parsed.headline.delta.direction] || '';
    const sev = parsed.headline.delta.severity
      ? SEVERITY_EMOJI[parsed.headline.delta.severity]
      : '';
    const deltaText = `   ${arrow} ${parsed.headline.delta.value} ${sev}`.trimEnd();
    headlineRich.push({
      type: 'text',
      text: { content: deltaText },
    });
  }
  blocks.push({
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: headlineRich },
  });

  if (parsed.headline.summary) {
    blocks.push(notionParagraph(parsed.headline.summary));
  }

  // ── Sections ──────────────────────────────────────────────────
  for (const section of parsed.sections) {
    blocks.push({ object: 'block', type: 'divider', divider: {} });

    if (section.title) {
      blocks.push({
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: notionRichText(section.title) },
      });
    }

    switch (section.kind) {
      case 'trend': {
        // Notion has no native bar chart. We fall back to the same
        // monospace unicode-bar rendering used for Slack mrkdwn /
        // Lark md, dropped into a `code` block (`language: plain text`)
        // so it renders in a fixed-width font on all Notion clients.
        const max = Math.max(...section.values);
        const minVal = Math.min(...section.values);
        const lines = section.labels.map((label, i) => {
          const value = section.values[i];
          const bar = unicodeBar(value, max);
          const highlight = (
            (section.highlight === 'last' && i === section.labels.length - 1)
            || (section.highlight === 'max' && value === max)
            || (section.highlight === 'min' && value === minVal)
          );
          const tag = highlight && section.severity
            ? ` ${SEVERITY_EMOJI[section.severity]}`
            : '';
          return `${padRight(label, 10)} ${padLeft(value.toLocaleString(), 8)}  ${bar}${tag}`;
        });
        blocks.push(notionCodeBlock(lines.join('\n')));
        break;
      }
      case 'table': {
        // Notion's native `table` block takes children rows (each row
        // is a `table_row` block whose `cells` is a 2D array of
        // rich-text arrays, one inner-array per cell).
        //   https://developers.notion.com/reference/block#table
        const headerRow = {
          object: 'block',
          type: 'table_row',
          table_row: {
            cells: section.headers.map((h) => notionRichText(h)),
          },
        };
        const dataRows = section.rows.map((row) => ({
          object: 'block',
          type: 'table_row',
          table_row: {
            cells: row.map((cell) => notionRichText(String(cell))),
          },
        }));
        blocks.push({
          object: 'block',
          type: 'table',
          table: {
            table_width: section.headers.length,
            has_column_header: true,
            has_row_header: false,
            children: [headerRow, ...dataRows],
          },
        });
        break;
      }
      case 'callouts': {
        // Each callout item becomes its own Notion `callout` block —
        // this gives each item its own emoji + colored background,
        // which is more scannable than packing them as bullets inside
        // a single callout. The tone applies to ALL items (same as
        // the Slack / Lark renderers).
        const tone = section.tone || 'info';
        const icon = SEVERITY_NOTION_ICON[tone];
        const color = SEVERITY_NOTION_COLOR[tone];
        for (const item of section.items) {
          blocks.push({
            object: 'block',
            type: 'callout',
            callout: {
              rich_text: notionRichText(item),
              icon: { type: 'emoji', emoji: icon },
              color,
            },
          });
        }
        break;
      }
      case 'breakdown': {
        // Bulleted list — each row is `*label*: value (sub) sev`.
        // Notion supports `bold` annotation on a rich-text segment,
        // so we render the label bold + the rest plain.
        for (const row of section.rows) {
          const segments = [
            {
              type: 'text',
              text: { content: `${row.label}: ` },
              annotations: { bold: true },
            },
            {
              type: 'text',
              text: { content: String(row.value) },
            },
          ];
          if (row.sub) {
            segments.push({
              type: 'text',
              text: { content: `  (${row.sub})` },
              annotations: { italic: true },
            });
          }
          if (row.severity) {
            segments.push({
              type: 'text',
              text: { content: `  ${SEVERITY_EMOJI[row.severity]}` },
            });
          }
          blocks.push({
            object: 'block',
            type: 'bulleted_list_item',
            bulleted_list_item: { rich_text: segments },
          });
        }
        break;
      }
      case 'paragraph': {
        blocks.push(notionParagraph(section.text));
        break;
      }
      // exhaustive by zod discriminatedUnion — no default needed
    }
  }

  // ── Footer ────────────────────────────────────────────────────
  // Notion doesn't have a "button" block. The closest thing the
  // public API supports for an inline clickable card is `embed` (a
  // generic URL preview) or `bookmark` (which renders a URL card with
  // the link's og:title). We use `embed` because it doesn't depend on
  // the URL having og: metadata — Notion will render the URL as a
  // simple link block on create, and users can convert to bookmark
  // manually if they want a fancier preview.
  if (parsed.footer && (parsed.footer.viewUrl || parsed.footer.rerunUrl)) {
    blocks.push({ object: 'block', type: 'divider', divider: {} });
    if (parsed.footer.viewUrl) {
      blocks.push({
        object: 'block',
        type: 'embed',
        embed: { url: parsed.footer.viewUrl },
      });
    }
    if (parsed.footer.rerunUrl) {
      blocks.push({
        object: 'block',
        type: 'embed',
        embed: { url: parsed.footer.rerunUrl },
      });
    }
  }

  // Icon — best-effort. If headline.delta.severity is set we use it
  // so the page icon visually tracks the report's signal (warn/critical
  // pages stand out in the database list view). Otherwise we leave it
  // undefined so Notion picks no icon (renders as the default page glyph).
  const icon = parsed.headline.delta?.severity
    ? SEVERITY_NOTION_ICON[parsed.headline.delta.severity]
    : undefined;

  return {
    blocks,
    title: parsed.title.slice(0, 200),
    icon,
  };
}
