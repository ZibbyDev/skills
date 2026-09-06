/**
 * Base (多维表格) query building — the half of a read that Lark evaluates.
 *
 * WHY THIS EXISTS (2026-09-06)
 * ────────────────────────────
 * Asked "what changed in this Base since yesterday", the agent could only pull
 * the whole table twice on two different days and subtract — because the read
 * sent Lark nothing but `view_id`/`field_names`. Two capabilities Lark has had
 * all along were simply never passed: `automatic_fields` (the per-row
 * created/last-modified who-and-when) and `filter`/`sort` (evaluated server
 * side, so `total` is a MATCH count).
 *
 * Properties pinned here:
 *   - includeRowMeta is what puts `automatic_fields` on the wire — absent by
 *     default, because it costs four extra values per row against a character
 *     budget that already truncates wide tables
 *   - a column name in filter/sort is validated against THIS table, with the
 *     same "names can carry spaces" candidate hint as fieldNames
 *   - an operator Lark doesn't know is refused HERE, naming the valid ones
 *   - isEmpty/isNotEmpty carry NO value key; everything else requires one and
 *     is normalised to an array of strings
 *   - record-level times are SECONDS while a date CELL is MILLISECONDS —
 *     normalising on magnitude is what stops every row rendering as 1970
 */
import { describe, it, expect } from 'vitest';
import { buildBitableSearchBody, bitableRowMeta } from '../larkDocs.js';

// A real Base's columns look like this: a leading space on the first one and
// a " (1)" duplicate suffix, both from the Base that motivated this change.
const COLUMNS = [
  { name: ' 项目名称', type: 1 },
  { name: '状态', type: 3 },
  { name: '最后更新时间', type: 1002 },
  { name: '优先级 (1)', type: 3 },
];

describe('buildBitableSearchBody', () => {
  it('sends nothing but the view when nothing is asked for', () => {
    expect(buildBitableSearchBody({ columns: COLUMNS, viewId: 'vew1' })).toEqual({ view_id: 'vew1' });
  });

  it('only sets automatic_fields when row metadata is requested', () => {
    expect(buildBitableSearchBody({ columns: COLUMNS }).automatic_fields).toBeUndefined();
    expect(buildBitableSearchBody({ columns: COLUMNS, includeRowMeta: true }).automatic_fields).toBe(true);
  });

  it('maps a filter to Lark snake_case, defaulting the conjunction to and', () => {
    const body = buildBitableSearchBody({
      columns: COLUMNS,
      filter: { conditions: [{ fieldName: '状态', operator: 'is', value: '研发中' }] },
    });
    expect(body.filter).toEqual({
      conjunction: 'and',
      conditions: [{ field_name: '状态', operator: 'is', value: ['研发中'] }],
    });
  });

  it('normalises a numeric value to an array of strings', () => {
    const body = buildBitableSearchBody({
      columns: COLUMNS,
      filter: { conjunction: 'or', conditions: [{ fieldName: '最后更新时间', operator: 'isGreater', value: ['ExactDate', 1788566400000] }] },
    });
    expect(body.filter.conjunction).toBe('or');
    expect(body.filter.conditions[0].value).toEqual(['ExactDate', '1788566400000']);
  });

  it('drops the value key for the valueless operators', () => {
    const body = buildBitableSearchBody({
      columns: COLUMNS,
      filter: { conditions: [{ fieldName: '状态', operator: 'isEmpty' }] },
    });
    expect(body.filter.conditions[0]).toEqual({ field_name: '状态', operator: 'isEmpty' });
  });

  it('refuses an operator Lark does not know, naming the ones it does', () => {
    expect(() => buildBitableSearchBody({
      columns: COLUMNS,
      filter: { conditions: [{ fieldName: '状态', operator: 'equals' }] },
    })).toThrow(/unknown filter operator "equals".*isNot/s);
  });

  it('requires a value for an operator that takes one', () => {
    expect(() => buildBitableSearchBody({
      columns: COLUMNS,
      filter: { conditions: [{ fieldName: '状态', operator: 'contains' }] },
    })).toThrow(/requires a value/);
  });

  it('refuses an empty condition list rather than sending a filter that matches nothing', () => {
    expect(() => buildBitableSearchBody({ columns: COLUMNS, filter: { conditions: [] } }))
      .toThrow(/non-empty/);
  });

  it('validates filter and sort column names against this table, offering the space-only near-miss', () => {
    expect(() => buildBitableSearchBody({
      columns: COLUMNS,
      filter: { conditions: [{ fieldName: '项目名称', operator: 'is', value: 'x' }] },
    })).toThrow(/unknown column\(s\) in filter.*did you mean " 项目名称"/s);

    expect(() => buildBitableSearchBody({ columns: COLUMNS, sort: [{ fieldName: '优先级' }] }))
      .toThrow(/unknown column\(s\) in sort/);
  });

  it('maps sort to field_name/desc', () => {
    const body = buildBitableSearchBody({ columns: COLUMNS, sort: [{ fieldName: '最后更新时间', desc: true }] });
    expect(body.sort).toEqual([{ field_name: '最后更新时间', desc: true }]);
  });
});

describe('bitableRowMeta', () => {
  it('reads seconds and milliseconds as the same instant, and flattens the person', () => {
    const meta = bitableRowMeta({
      created_time: 1788566400,          // Lark stamps record times in SECONDS
      last_modified_time: 1788652800000, // a date CELL is milliseconds
      created_by: { id: 'ou_1', name: '小迪', en_name: 'Xiaodi' },
      last_modified_by: { id: 'ou_2', name: '小李' },
    });
    expect(meta).toEqual({
      createdTime: '2026-09-05T00:00:00.000Z',
      createdBy: '小迪',
      lastModifiedTime: '2026-09-06T00:00:00.000Z',
      lastModifiedBy: '小李',
    });
  });

  it('omits what Lark did not send rather than emitting an epoch-zero date', () => {
    expect(bitableRowMeta({ last_modified_time: 0, created_by: null })).toEqual({});
    expect(bitableRowMeta({})).toEqual({});
  });
});
