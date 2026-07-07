import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock backend-client BEFORE importing the skill so resolveIntegrationToken
// is replaced at load time. Shape mirrors GET /integrations/token/notion.
vi.mock('@zibby/core/backend-client.js', () => ({
  resolveIntegrationToken: vi.fn(async () => ({ provider: 'notion', token: 'secret_notion', workspaceId: 'ws1' })),
  clearTokenCache: vi.fn(),
}));

const { notionSkill, parseNotionId, markdownToNotionBlocks } = await import('../src/notion.js');

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

  it('exposes the read + comment + write tools', () => {
    const names = notionSkill.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'notion_add_comment', 'notion_append_blocks', 'notion_create_page',
      'notion_get_page', 'notion_insert_image', 'notion_list_comments',
      'notion_query_database',
    ]);
  });

  it('promptFragment documents the write surface (no longer read-only)', () => {
    expect(notionSkill.promptFragment).not.toMatch(/read-only context\)/);
    expect(notionSkill.promptFragment).toMatch(/notion_create_page/);
    expect(notionSkill.promptFragment).toMatch(/notion_append_blocks/);
    expect(notionSkill.promptFragment).toMatch(/notion_insert_image/);
  });

  it('resolve() spawns the generic skill MCP server so the AGENT can call notion tools', () => {
    // Changed for agent-driven code review: notion used to be called only by
    // deterministic node code (resolve()→null, no agent tool surface). Now the
    // review agent pulls a page itself, so notion is served over MCP via the
    // generic bin/mcp-skill.mjs, exactly like github/linear/figma.
    const spec = notionSkill.resolve();
    expect(spec).not.toBeNull();
    expect(spec.command).toBe('node');
    expect(spec.args).toEqual(expect.arrayContaining(['../dist/notion.js', 'notionSkill']));
    expect(spec.alwaysLoad).toBe(true);
    // and the skill advertises its mcp__notion__* tool prefix
    expect(notionSkill.allowedTools).toEqual(['mcp__notion__*']);
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

describe('notion_list_comments', () => {
  it('lists open comment discussions on a page/block', async () => {
    const id = '1a2b3c4d5e6f70819203a4b5c6d7e8f9';
    globalThis.fetch = vi.fn().mockResolvedValueOnce(fetchJson({
      results: [
        { id: 'c1', discussion_id: 'd1', rich_text: [{ plain_text: '@zibby please review' }], created_by: { id: 'u1' }, created_time: 't1' },
      ],
    }));
    const result = JSON.parse(await notionSkill.handleToolCall('notion_list_comments', { blockId: id }));
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.comments[0]).toMatchObject({ id: 'c1', discussionId: 'd1', text: '@zibby please review', author: 'u1' });
    // Hit the /comments?block_id= endpoint.
    const url = globalThis.fetch.mock.calls[0][0];
    expect(url).toContain('/comments?');
    expect(url).toContain('block_id=');
  });

  it('rejects a missing block reference', async () => {
    const result = JSON.parse(await notionSkill.handleToolCall('notion_list_comments', {}));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/valid Notion page\/block id/i);
  });
});

describe('notion_add_comment', () => {
  it('replies into an existing discussion (discussion_id body)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(fetchJson({ id: 'newc', discussion_id: 'd1' }));
    const result = JSON.parse(await notionSkill.handleToolCall('notion_add_comment', {
      discussionId: 'd1', text: 'On it — reviewing now.',
    }));
    expect(result.ok).toBe(true);
    expect(result.id).toBe('newc');
    expect(result.discussionId).toBe('d1');
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toContain('/comments');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.discussion_id).toBe('d1');
    expect(body.rich_text[0].text.content).toBe('On it — reviewing now.');
    expect(body.parent).toBeUndefined();
  });

  it('starts a new top-level page comment (parent.page_id body)', async () => {
    const id = '1a2b3c4d5e6f70819203a4b5c6d7e8f9';
    globalThis.fetch = vi.fn().mockResolvedValueOnce(fetchJson({ id: 'newc2', discussion_id: 'd2' }));
    const result = JSON.parse(await notionSkill.handleToolCall('notion_add_comment', { pageId: id, text: 'FYI' }));
    expect(result.ok).toBe(true);
    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.parent.page_id).toBe('1a2b3c4d-5e6f-7081-9203-a4b5c6d7e8f9');
    expect(body.discussion_id).toBeUndefined();
  });

  it('requires text', async () => {
    const result = JSON.parse(await notionSkill.handleToolCall('notion_add_comment', { discussionId: 'd1' }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/text is required/i);
  });

  it('requires discussionId or a valid pageId', async () => {
    const result = JSON.parse(await notionSkill.handleToolCall('notion_add_comment', { text: 'hi' }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/discussionId .* or a valid pageId/i);
  });

  it('fail-softs on an API error (never throws)', async () => {
    // Use a non-retryable status (notionApi retries once on token/401/unauthorized).
    globalThis.fetch = vi.fn().mockResolvedValueOnce(fetchJson({ message: 'server error' }, false, 500));
    const result = JSON.parse(await notionSkill.handleToolCall('notion_add_comment', { discussionId: 'd1', text: 'hi' }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/500/);
  });
});

// ───────────────────────── markdownToNotionBlocks ─────────────────────────

describe('markdownToNotionBlocks', () => {
  it('maps headings, bullets, ordered, and text; skips blank lines', () => {
    const blocks = markdownToNotionBlocks('# Title\n## Sub\n\n- one\n1. first\nbody line');
    expect(blocks).toHaveLength(5);
    expect(blocks[0].type).toBe('heading_1');
    expect(blocks[0].heading_1.rich_text[0].text.content).toBe('Title');
    expect(blocks[1].type).toBe('heading_2');
    expect(blocks[2].type).toBe('bulleted_list_item');
    expect(blocks[2].bulleted_list_item.rich_text[0].text.content).toBe('one');
    expect(blocks[3].type).toBe('numbered_list_item');
    expect(blocks[4].type).toBe('paragraph');
    expect(blocks[4].paragraph.rich_text[0].text.content).toBe('body line');
    // Every block carries object='block' (Notion API contract).
    for (const b of blocks) expect(b.object).toBe('block');
  });

  it('returns an empty array for empty/whitespace input', () => {
    expect(markdownToNotionBlocks('')).toEqual([]);
    expect(markdownToNotionBlocks('\n  \n')).toEqual([]);
  });
});

// ───────────────────────── notion_create_page ─────────────────────────

describe('notion_create_page', () => {
  const parentId = '1a2b3c4d5e6f70819203a4b5c6d7e8f9';
  const parentDashed = '1a2b3c4d-5e6f-7081-9203-a4b5c6d7e8f9';

  it('creates a page under a parent PAGE with markdown children', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(fetchJson({
      id: 'pg-new', url: 'https://www.notion.so/Report-pgnew',
    }));
    const result = JSON.parse(await notionSkill.handleToolCall('notion_create_page', {
      parentPageId: parentId, title: 'Weekly Report', markdown: '# Head\n- a\nbody',
    }));
    expect(result.ok).toBe(true);
    expect(result.pageId).toBe('pg-new');
    expect(result.url).toBe('https://www.notion.so/Report-pgnew');

    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://api.notion.com/v1/pages');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Notion-Version']).toBe('2022-06-28');
    const body = JSON.parse(opts.body);
    expect(body.parent).toEqual({ page_id: parentDashed });
    expect(body.properties.title.title[0].text.content).toBe('Weekly Report');
    expect(body.children).toHaveLength(3);
    expect(body.children[0].type).toBe('heading_1');
  });

  it('creates a page in a DATABASE (parent.database_id, title into the title property)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(fetchJson({ id: 'row-new' }));
    const result = JSON.parse(await notionSkill.handleToolCall('notion_create_page', {
      databaseId: parentId, title: 'Row title',
    }));
    expect(result.ok).toBe(true);
    expect(result.pageId).toBe('row-new');
    // No page.url in the reply → canonical fallback URL (dashes stripped).
    expect(result.url).toBe('https://www.notion.so/rownew');
    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.parent).toEqual({ database_id: parentDashed });
    expect(body.properties.title.title[0].text.content).toBe('Row title');
    expect(body.children).toBeUndefined();
  });

  it('chunks >100 blocks: 100 into pages.create, the rest via PATCH /blocks/{id}/children', async () => {
    const blocks = Array.from({ length: 150 }, (_, i) => ({
      object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: `p${i}` } }] },
    }));
    const calls = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      calls.push({ url: String(url), opts });
      if (String(url).endsWith('/pages')) return fetchJson({ id: 'pg-big' });
      return fetchJson({ results: [] });
    });
    const result = JSON.parse(await notionSkill.handleToolCall('notion_create_page', {
      parentPageId: parentId, title: 'Big', blocks,
    }));
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    const createBody = JSON.parse(calls[0].opts.body);
    expect(createBody.children).toHaveLength(100);
    expect(createBody.children[99].paragraph.rich_text[0].text.content).toBe('p99');
    // Remainder appended in one PATCH chunk.
    expect(calls[1].url).toContain('/blocks/pg-big/children');
    expect(calls[1].opts.method).toBe('PATCH');
    const appendBody = JSON.parse(calls[1].opts.body);
    expect(appendBody.children).toHaveLength(50);
    expect(appendBody.children[0].paragraph.rich_text[0].text.content).toBe('p100');
  });

  it('requires a title', async () => {
    const result = JSON.parse(await notionSkill.handleToolCall('notion_create_page', { parentPageId: parentId }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/title is required/i);
  });

  it('requires a parentPageId or databaseId', async () => {
    const result = JSON.parse(await notionSkill.handleToolCall('notion_create_page', { title: 'T' }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/parentPageId or databaseId/i);
  });
});

// ───────────────────────── notion_append_blocks ─────────────────────────

describe('notion_append_blocks', () => {
  const pageId = '1a2b3c4d5e6f70819203a4b5c6d7e8f9';
  const pageDashed = '1a2b3c4d-5e6f-7081-9203-a4b5c6d7e8f9';

  it('converts markdown and PATCHes the page children', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(fetchJson({ results: [] }));
    const result = JSON.parse(await notionSkill.handleToolCall('notion_append_blocks', {
      pageId, markdown: '## Section\n- item',
    }));
    expect(result.ok).toBe(true);
    expect(result.pageId).toBe(pageDashed);
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe(`https://api.notion.com/v1/blocks/${pageDashed}/children`);
    expect(opts.method).toBe('PATCH');
    const body = JSON.parse(opts.body);
    expect(body.children).toHaveLength(2);
    expect(body.children[0].type).toBe('heading_2');
    expect(body.children[1].type).toBe('bulleted_list_item');
  });

  it('chunks >100 blocks across multiple PATCH requests', async () => {
    const blocks = Array.from({ length: 205 }, (_, i) => ({
      object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: `x${i}` } }] },
    }));
    globalThis.fetch = vi.fn(async () => fetchJson({ results: [] }));
    const result = JSON.parse(await notionSkill.handleToolCall('notion_append_blocks', { pageId, blocks }));
    expect(result.ok).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3); // 100 + 100 + 5
    const sizes = globalThis.fetch.mock.calls.map(([, o]) => JSON.parse(o.body).children.length);
    expect(sizes).toEqual([100, 100, 5]);
  });

  it('requires markdown or blocks', async () => {
    const result = JSON.parse(await notionSkill.handleToolCall('notion_append_blocks', { pageId }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/markdown or blocks/i);
  });

  it('rejects an invalid page reference', async () => {
    const result = JSON.parse(await notionSkill.handleToolCall('notion_append_blocks', { pageId: 'junk', markdown: 'x' }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/valid Notion page/i);
  });
});

// ───────────────────────── notion_insert_image ─────────────────────────

describe('notion_insert_image', () => {
  const pageId = '1a2b3c4d5e6f70819203a4b5c6d7e8f9';
  const pageDashed = '1a2b3c4d-5e6f-7081-9203-a4b5c6d7e8f9';

  const dir = mkdtempSync(join(tmpdir(), 'notion-img-'));
  const imagePath = join(dir, 'chart.png');
  const imageBytes = Buffer.from('fake-png-bytes');
  writeFileSync(imagePath, imageBytes);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('LOCAL file: creates a file upload, sends the bytes, appends a file_upload image block', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      calls.push({ url: String(url), opts });
      if (String(url).endsWith('/file_uploads')) return fetchJson({ id: 'fu-1', status: 'pending' });
      if (String(url).includes('/file_uploads/fu-1/send')) return fetchJson({ id: 'fu-1', status: 'uploaded' });
      return fetchJson({ results: [] }); // append children
    });

    const result = JSON.parse(await notionSkill.handleToolCall('notion_insert_image', {
      pageId, imagePath, caption: 'Weekly trend',
    }));
    expect(result.ok).toBe(true);
    expect(result.pageId).toBe(pageDashed);
    expect(result.fileUploadId).toBe('fu-1');
    expect(calls).toHaveLength(3);

    // 1. create the upload (single_part) — pinned Notion-Version works for it.
    expect(calls[0].url).toBe('https://api.notion.com/v1/file_uploads');
    expect(calls[0].opts.headers['Notion-Version']).toBe('2022-06-28');
    expect(JSON.parse(calls[0].opts.body)).toEqual({ mode: 'single_part', filename: 'chart.png' });

    // 2. send the bytes as multipart/form-data field `file` (no JSON content-type).
    expect(calls[1].url).toBe('https://api.notion.com/v1/file_uploads/fu-1/send');
    expect(calls[1].opts.method).toBe('POST');
    expect(calls[1].opts.headers['Content-Type']).toBeUndefined();
    const form = calls[1].opts.body;
    expect(form).toBeInstanceOf(FormData);
    const filePart = form.get('file');
    expect(filePart).toBeInstanceOf(Blob);
    expect(filePart.size).toBe(imageBytes.length);
    expect(filePart.type).toBe('image/png');

    // 3. append the image block referencing the upload id + caption.
    expect(calls[2].url).toBe(`https://api.notion.com/v1/blocks/${pageDashed}/children`);
    const body = JSON.parse(calls[2].opts.body);
    expect(body.children).toHaveLength(1);
    expect(body.children[0].type).toBe('image');
    expect(body.children[0].image.type).toBe('file_upload');
    expect(body.children[0].image.file_upload).toEqual({ id: 'fu-1' });
    expect(body.children[0].image.caption[0].text.content).toBe('Weekly trend');
  });

  it('EXTERNAL url: appends an external image block (no upload calls)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(fetchJson({ results: [] }));
    const result = JSON.parse(await notionSkill.handleToolCall('notion_insert_image', {
      pageId, imageUrl: 'https://cdn.example.com/chart.png',
    }));
    expect(result.ok).toBe(true);
    expect(result.fileUploadId).toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.children[0].image).toEqual({
      type: 'external', external: { url: 'https://cdn.example.com/chart.png' },
    });
  });

  it('fail-softs on a missing local file (no network call)', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const result = JSON.parse(await notionSkill.handleToolCall('notion_insert_image', {
      pageId, imagePath: join(dir, 'nope.png'),
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires imagePath or imageUrl', async () => {
    const result = JSON.parse(await notionSkill.handleToolCall('notion_insert_image', { pageId }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/imagePath .*or imageUrl/i);
  });

  it('fail-softs when the upload send fails (image block never appended)', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/file_uploads')) return fetchJson({ id: 'fu-2' });
      return fetchJson({ message: 'upload failed' }, false, 400);
    });
    const result = JSON.parse(await notionSkill.handleToolCall('notion_insert_image', { pageId, imagePath }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/400/);
    expect(calls.some((u) => u.includes('/blocks/'))).toBe(false);
  });
});
