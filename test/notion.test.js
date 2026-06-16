import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock backend-client BEFORE importing the skill so resolveIntegrationToken
// is replaced at load time. Shape mirrors GET /integrations/token/notion.
vi.mock('@zibby/core/backend-client.js', () => ({
  resolveIntegrationToken: vi.fn(async () => ({ provider: 'notion', token: 'secret_notion', workspaceId: 'ws1' })),
  clearTokenCache: vi.fn(),
}));

const { notionSkill, parseNotionId } = await import('../src/notion.js');

// Build a fetch Response-like object. notionApi reads res.ok + res.text().
function fetchJson(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(payload),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('notionSkill structure', () => {
  it('has correct id + requiresIntegration', () => {
    expect(notionSkill.id).toBe('notion');
    expect(notionSkill.requiresIntegration).toBe('notion');
  });

  it('exposes notion_get_page + notion_query_database', () => {
    const names = notionSkill.tools.map((t) => t.name).sort();
    expect(names).toEqual(['notion_get_page', 'notion_query_database']);
  });

  it('resolve() returns null (no MCP server — in-process context skill)', () => {
    expect(notionSkill.resolve()).toBeNull();
  });
});

describe('parseNotionId — URL/id parsing', () => {
  it('parses a dashed UUID verbatim', () => {
    expect(parseNotionId('1a2b3c4d-5e6f-7081-9203-a4b5c6d7e8f9'))
      .toBe('1a2b3c4d-5e6f-7081-9203-a4b5c6d7e8f9');
  });

  it('dashes an undashed 32-char id', () => {
    expect(parseNotionId('1a2b3c4d5e6f70819203a4b5c6d7e8f9'))
      .toBe('1a2b3c4d-5e6f-7081-9203-a4b5c6d7e8f9');
  });

  it('extracts the trailing id from a slugged Notion URL', () => {
    const url = 'https://www.notion.so/myws/Engineering-Standards-1a2b3c4d5e6f70819203a4b5c6d7e8f9';
    expect(parseNotionId(url)).toBe('1a2b3c4d-5e6f-7081-9203-a4b5c6d7e8f9');
  });

  it('ignores query params and parses the path id', () => {
    const url = 'https://www.notion.so/Page-1a2b3c4d5e6f70819203a4b5c6d7e8f9?pvs=4';
    expect(parseNotionId(url)).toBe('1a2b3c4d-5e6f-7081-9203-a4b5c6d7e8f9');
  });

  it('returns null when there is no id', () => {
    expect(parseNotionId('https://www.notion.so/just-a-slug')).toBeNull();
    expect(parseNotionId('')).toBeNull();
    expect(parseNotionId(null)).toBeNull();
  });
});

describe('notion_get_page — fetch + block flattening', () => {
  it('flattens headings, paragraphs, lists, to-do, code, quote into markdown', async () => {
    const pageId = '1a2b3c4d-5e6f-7081-9203-a4b5c6d7e8f9';
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(url);
      if (url.includes(`/pages/${pageId}`)) {
        return fetchJson({
          id: pageId,
          url: 'https://www.notion.so/Engineering-Standards-x',
          properties: {
            Name: { type: 'title', title: [{ plain_text: 'Engineering Standards' }] },
          },
        });
      }
      // block children
      return fetchJson({
        has_more: false,
        next_cursor: null,
        results: [
          { id: 'b1', type: 'heading_1', has_children: false, heading_1: { rich_text: [{ plain_text: 'Rules' }] } },
          { id: 'b2', type: 'paragraph', has_children: false, paragraph: { rich_text: [{ plain_text: 'No hacks ever.' }] } },
          { id: 'b3', type: 'bulleted_list_item', has_children: false, bulleted_list_item: { rich_text: [{ plain_text: 'One field one type' }] } },
          { id: 'b4', type: 'to_do', has_children: false, to_do: { checked: true, rich_text: [{ plain_text: 'Verify live' }] } },
          { id: 'b5', type: 'code', has_children: false, code: { language: 'js', rich_text: [{ plain_text: 'const x = 1;' }] } },
          { id: 'b6', type: 'quote', has_children: false, quote: { rich_text: [{ plain_text: 'Index for the access pattern' }] } },
        ],
      });
    });

    const result = JSON.parse(await notionSkill.handleToolCall('notion_get_page', { pageId }));
    expect(result.ok).toBe(true);
    expect(result.id).toBe(pageId);
    expect(result.title).toBe('Engineering Standards');
    expect(result.text).toContain('# Rules');
    expect(result.text).toContain('No hacks ever.');
    expect(result.text).toContain('- One field one type');
    expect(result.text).toContain('- [x] Verify live');
    expect(result.text).toContain('```js');
    expect(result.text).toContain('const x = 1;');
    expect(result.text).toContain('> Index for the access pattern');
    // Both endpoints were hit: page + block children.
    expect(calls.some((c) => c.includes(`/pages/${pageId}`))).toBe(true);
    expect(calls.some((c) => c.includes(`/blocks/${pageId}/children`))).toBe(true);
  });

  it('recurses into nested child blocks', async () => {
    const pageId = '1a2b3c4d-5e6f-7081-9203-a4b5c6d7e8f9';
    globalThis.fetch = vi.fn(async (url) => {
      if (url.includes(`/pages/${pageId}`)) {
        return fetchJson({ id: pageId, properties: {} });
      }
      if (url.includes(`/blocks/${pageId}/children`)) {
        return fetchJson({
          has_more: false,
          results: [
            { id: 'parent', type: 'bulleted_list_item', has_children: true, bulleted_list_item: { rich_text: [{ plain_text: 'Parent' }] } },
          ],
        });
      }
      // children of 'parent'
      return fetchJson({
        has_more: false,
        results: [
          { id: 'child', type: 'bulleted_list_item', has_children: false, bulleted_list_item: { rich_text: [{ plain_text: 'Child' }] } },
        ],
      });
    });
    const result = JSON.parse(await notionSkill.handleToolCall('notion_get_page', { pageId }));
    expect(result.text).toContain('Parent');
    expect(result.text).toContain('Child');
    // Child is indented one level under the parent.
    expect(result.text).toContain('  - Child');
  });

  it('rejects an invalid/missing reference without throwing', async () => {
    const result = JSON.parse(await notionSkill.handleToolCall('notion_get_page', { pageId: 'not-an-id' }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/valid Notion page id/i);
  });
});

describe('graceful error path (mocked fetch)', () => {
  it('returns { ok:false, error } on an HTTP failure — never throws', async () => {
    globalThis.fetch = vi.fn(async () => fetchJson({ message: 'object not found' }, false, 404));
    const result = JSON.parse(await notionSkill.handleToolCall('notion_get_page', {
      pageId: '1a2b3c4d-5e6f-7081-9203-a4b5c6d7e8f9',
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Notion API 404/);
  });

  it('unknown tool returns { ok:false, error }', async () => {
    const result = JSON.parse(await notionSkill.handleToolCall('notion_bogus', {}));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown tool/);
  });
});

describe('notion_query_database', () => {
  it('maps rows to { id, title, url, props } and bounds the result', async () => {
    const dbId = '1a2b3c4d-5e6f-7081-9203-a4b5c6d7e8f9';
    globalThis.fetch = vi.fn(async () => fetchJson({
      has_more: false,
      results: [
        {
          id: 'row1',
          url: 'https://www.notion.so/row1',
          properties: {
            Name: { type: 'title', title: [{ plain_text: 'Ticket A' }] },
            Status: { type: 'status', status: { name: 'In Progress' } },
            Empty: { type: 'rich_text', rich_text: [] },
          },
        },
      ],
    }));
    const result = JSON.parse(await notionSkill.handleToolCall('notion_query_database', { databaseId: dbId }));
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.rows[0]).toMatchObject({
      id: 'row1',
      title: 'Ticket A',
      url: 'https://www.notion.so/row1',
      props: { Name: 'Ticket A', Status: 'In Progress' },
    });
    // Empty props are dropped.
    expect(result.rows[0].props.Empty).toBeUndefined();
  });

  it('rejects a missing database reference', async () => {
    const result = JSON.parse(await notionSkill.handleToolCall('notion_query_database', {}));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/valid Notion database id/i);
  });
});
