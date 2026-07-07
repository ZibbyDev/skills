import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock the backend-client BEFORE importing the skill so resolveIntegrationToken
// is replaced at load time. Shape mirrors GET /integrations/token/lark.
vi.mock('@zibby/core/backend-client.js', () => ({
  resolveIntegrationToken: vi.fn(async () => ({
    appId: 'cli_test',
    appSecret: 'sec_test',
    host: 'https://open.larksuite.com',
  })),
}));

const { resolveIntegrationToken } = await import('@zibby/core/backend-client.js');
const {
  larkDocsSkill,
  parseLarkDocRef,
  markdownToLarkBlocks,
  docWebUrl,
  _resetLarkDocsTokenCache,
} = await import('../src/larkDocs.js');

// Lark helpers read res.json(). Build a queued fetch mock (token first).
function tokenReply() {
  return { json: async () => ({ code: 0, tenant_access_token: 't-xxx', expire: 7200 }) };
}
function dataReply(data) {
  return { json: async () => ({ code: 0, data }) };
}
function errReply(msg) {
  return { json: async () => ({ code: 99991663, msg }) };
}

beforeEach(() => {
  _resetLarkDocsTokenCache();
  resolveIntegrationToken.mockResolvedValue({
    appId: 'cli_test', appSecret: 'sec_test', host: 'https://open.larksuite.com',
  });
});

// ───────────────────────── structure ─────────────────────────

describe('larkDocsSkill structure', () => {
  it('has correct id + serverName + requiresIntegration', () => {
    expect(larkDocsSkill.id).toBe('lark-docs');
    expect(larkDocsSkill.serverName).toBe('larkdocs');
    expect(larkDocsSkill.requiresIntegration).toBe('lark');
  });

  it('exposes the docx + comment + image tools', () => {
    const names = larkDocsSkill.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'larkdoc_add_comment', 'larkdoc_append', 'larkdoc_create',
      'larkdoc_get', 'larkdoc_insert_image', 'larkdoc_list_comments',
      'larkdoc_reply_comment',
    ]);
  });

  it('resolve() spawns the generic skill MCP server', () => {
    const spec = larkDocsSkill.resolve();
    expect(spec).not.toBeNull();
    expect(spec.command).toBe('node');
    expect(spec.args).toEqual(expect.arrayContaining(['../dist/larkDocs.js', 'larkDocsSkill']));
    expect(spec.alwaysLoad).toBe(true);
    expect(larkDocsSkill.allowedTools).toEqual(['mcp__larkdocs__*']);
  });
});

// ───────────────────────── pure helpers ─────────────────────────

describe('parseLarkDocRef', () => {
  it('extracts a docx token from a /docx/ URL', () => {
    expect(parseLarkDocRef('https://acme.feishu.cn/docx/DocABC123xyz?from=space'))
      .toEqual({ type: 'docx', token: 'DocABC123xyz' });
  });
  it('extracts a wiki token from a /wiki/ URL', () => {
    expect(parseLarkDocRef('https://acme.larksuite.com/wiki/WikTOKEN999'))
      .toEqual({ type: 'wiki', token: 'WikTOKEN999' });
  });
  it('accepts a bare token as docx', () => {
    expect(parseLarkDocRef('DocABC123xyz456')).toEqual({ type: 'docx', token: 'DocABC123xyz456' });
  });
  it('returns null for junk', () => {
    expect(parseLarkDocRef('not a url')).toBeNull();
    expect(parseLarkDocRef('')).toBeNull();
    expect(parseLarkDocRef(null)).toBeNull();
  });
});

describe('markdownToLarkBlocks', () => {
  it('maps headings, bullets, ordered, and text; skips blank lines', () => {
    const blocks = markdownToLarkBlocks('# Title\n\n- one\n1. first\nbody line');
    expect(blocks).toHaveLength(4);
    expect(blocks[0].block_type).toBe(3); // heading1
    expect(blocks[0].heading1.elements[0].text_run.content).toBe('Title');
    expect(blocks[1].block_type).toBe(12); // bullet
    expect(blocks[1].bullet.elements[0].text_run.content).toBe('one');
    expect(blocks[2].block_type).toBe(13); // ordered
    expect(blocks[3].block_type).toBe(2); // text
    expect(blocks[3].text.elements[0].text_run.content).toBe('body line');
  });
});

describe('docWebUrl — region host respected', () => {
  it('builds a feishu URL from a feishu host', () => {
    expect(docWebUrl('https://open.feishu.cn', 'Doc1')).toBe('https://feishu.cn/docx/Doc1');
  });
  it('builds a larksuite URL otherwise', () => {
    expect(docWebUrl('https://open.larksuite.com', 'Doc1')).toBe('https://www.larksuite.com/docx/Doc1');
  });
});

// ───────────────────────── larkdoc_get ─────────────────────────

describe('larkdoc_get', () => {
  it('reads raw_content, hits the docx endpoints, respects the region host', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(tokenReply())
      .mockResolvedValueOnce(dataReply({ document: { document_id: 'Doc1', title: 'My PRD' } })) // meta
      .mockResolvedValueOnce(dataReply({ content: 'PRD body text' })); // raw_content

    const res = JSON.parse(await larkDocsSkill.handleToolCall('larkdoc_get', {
      documentId: 'https://acme.larksuite.com/docx/Doc1',
    }));
    expect(res.ok).toBe(true);
    expect(res.documentId).toBe('Doc1');
    expect(res.title).toBe('My PRD');
    expect(res.text).toBe('PRD body text');
    expect(res.url).toBe('https://www.larksuite.com/docx/Doc1');
    // raw_content endpoint was hit.
    const urls = globalThis.fetch.mock.calls.map((c) => c[0]);
    expect(urls.some((u) => u.includes('/documents/Doc1/raw_content'))).toBe(true);
  });

  it('resolves a wiki node to its backing docx object', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(tokenReply())
      .mockResolvedValueOnce(dataReply({ node: { obj_type: 'docx', obj_token: 'DocReal' } })) // get_node
      .mockResolvedValueOnce(dataReply({ document: { document_id: 'DocReal', title: 'Wiki PRD' } })) // meta
      .mockResolvedValueOnce(dataReply({ content: 'wiki body' })); // raw_content

    const res = JSON.parse(await larkDocsSkill.handleToolCall('larkdoc_get', {
      documentId: 'https://acme.feishu.cn/wiki/WikTok',
    }));
    expect(res.ok).toBe(true);
    expect(res.documentId).toBe('DocReal');
    expect(res.text).toBe('wiki body');
  });

  it('fail-softs on an API error', async () => {
    // meta is best-effort (swallowed); the raw_content read is the fatal path.
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(tokenReply())
      .mockResolvedValueOnce(dataReply({ document: { document_id: 'DocOneReal1', title: '' } }))
      .mockResolvedValueOnce(errReply('permission denied'));
    const res = JSON.parse(await larkDocsSkill.handleToolCall('larkdoc_get', { documentId: 'DocOneReal1' }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/permission denied/);
  });

  it('requires a doc id/url', async () => {
    const res = JSON.parse(await larkDocsSkill.handleToolCall('larkdoc_get', {}));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/valid Lark doc/);
  });
});

// ───────────────────────── larkdoc_create ─────────────────────────

describe('larkdoc_create', () => {
  it('creates a doc and appends the markdown body', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(tokenReply())
      .mockResolvedValueOnce(dataReply({ document: { document_id: 'DocNew', title: 'Spec' } })) // create
      .mockResolvedValueOnce(dataReply({ children: [] })); // append blocks

    const res = JSON.parse(await larkDocsSkill.handleToolCall('larkdoc_create', {
      title: 'Spec',
      markdown: '# Heading\nbody',
    }));
    expect(res.ok).toBe(true);
    expect(res.documentId).toBe('DocNew');
    expect(res.url).toBe('https://www.larksuite.com/docx/DocNew');
    const calls = globalThis.fetch.mock.calls;
    // create hit the documents collection endpoint.
    expect(calls[1][0]).toMatch(/\/docx\/v1\/documents$/);
    // append hit the blocks/children endpoint on the new doc root.
    expect(calls[2][0]).toContain('/documents/DocNew/blocks/DocNew/children');
    const body = JSON.parse(calls[2][1].body);
    expect(Array.isArray(body.children)).toBe(true);
    expect(body.children[0].block_type).toBe(3); // heading1
  });

  it('requires a title', async () => {
    const res = JSON.parse(await larkDocsSkill.handleToolCall('larkdoc_create', { markdown: 'x' }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/title is required/);
  });
});

// ───────────────────────── larkdoc_append ─────────────────────────

describe('larkdoc_append', () => {
  it('appends blocks to an existing doc', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(tokenReply())
      .mockResolvedValueOnce(dataReply({ children: [] })); // append

    const res = JSON.parse(await larkDocsSkill.handleToolCall('larkdoc_append', {
      documentId: 'DocExisting',
      text: 'more content',
    }));
    expect(res.ok).toBe(true);
    expect(res.documentId).toBe('DocExisting');
    const calls = globalThis.fetch.mock.calls;
    expect(calls[1][0]).toContain('/documents/DocExisting/blocks/DocExisting/children');
  });

  it('requires content', async () => {
    const res = JSON.parse(await larkDocsSkill.handleToolCall('larkdoc_append', { documentId: 'DocOneReal1' }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/content is required/);
  });
});

// ───────────────────────── larkdoc_insert_image ─────────────────────────

describe('larkdoc_insert_image', () => {
  // A real temp file — the tool readFileSync's it before any network call.
  const dir = mkdtempSync(join(tmpdir(), 'larkdoc-img-'));
  const imagePath = join(dir, 'chart.png');
  const imageBytes = Buffer.from('fake-png-bytes-for-upload');
  writeFileSync(imagePath, imageBytes);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('creates an empty image block, uploads the bytes, then binds the token', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(tokenReply())
      .mockResolvedValueOnce(dataReply({ children: [{ block_id: 'blkImg1', block_type: 27 }] })) // block create
      .mockResolvedValueOnce(dataReply({ file_token: 'ftok123' })) // upload_all
      .mockResolvedValueOnce(dataReply({})); // replace_image patch

    const res = JSON.parse(await larkDocsSkill.handleToolCall('larkdoc_insert_image', {
      documentId: 'https://acme.larksuite.com/docx/DocImg1', imagePath, width: 640, height: 360,
    }));
    expect(res.ok).toBe(true);
    expect(res.documentId).toBe('DocImg1');
    expect(res.blockId).toBe('blkImg1');
    expect(res.fileToken).toBe('ftok123');
    expect(res.url).toBe('https://www.larksuite.com/docx/DocImg1');

    const calls = globalThis.fetch.mock.calls;
    // 1. empty image block appended at the doc root.
    expect(calls[1][0]).toContain('/documents/DocImg1/blocks/DocImg1/children');
    const createBody = JSON.parse(calls[1][1].body);
    expect(createBody.children).toEqual([{ block_type: 27, image: {} }]);
    // 2. multipart upload with the docx_image parenting fields.
    expect(calls[2][0]).toContain('/open-apis/drive/v1/medias/upload_all');
    const form = calls[2][1].body;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('file_name')).toBe('chart.png');
    expect(form.get('parent_type')).toBe('docx_image');
    expect(form.get('parent_node')).toBe('blkImg1');
    expect(form.get('size')).toBe(String(imageBytes.length));
    const filePart = form.get('file');
    expect(filePart).toBeInstanceOf(Blob);
    expect(filePart.size).toBe(imageBytes.length);
    // auth still flows through the tenant token chokepoint.
    expect(calls[2][1].headers.Authorization).toBe('Bearer t-xxx');
    // 3. replace_image PATCH binds the token to the block (px dimensions).
    expect(calls[3][0]).toContain('/documents/DocImg1/blocks/blkImg1?document_revision_id=-1');
    expect(calls[3][1].method).toBe('PATCH');
    const patchBody = JSON.parse(calls[3][1].body);
    expect(patchBody).toEqual({ replace_image: { token: 'ftok123', width: 640, height: 360 } });
  });

  it('omits width/height from replace_image when not provided', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(tokenReply())
      .mockResolvedValueOnce(dataReply({ children: [{ block_id: 'blk2' }] }))
      .mockResolvedValueOnce(dataReply({ file_token: 'ftok2' }))
      .mockResolvedValueOnce(dataReply({}));
    const res = JSON.parse(await larkDocsSkill.handleToolCall('larkdoc_insert_image', {
      documentId: 'DocImgTwo22', imagePath,
    }));
    expect(res.ok).toBe(true);
    const patchBody = JSON.parse(globalThis.fetch.mock.calls[3][1].body);
    expect(patchBody).toEqual({ replace_image: { token: 'ftok2' } });
  });

  it('fail-softs on a missing image file (no write happens)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(tokenReply());
    const res = JSON.parse(await larkDocsSkill.handleToolCall('larkdoc_insert_image', {
      documentId: 'DocImgTwo22', imagePath: join(dir, 'nope.png'),
    }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/);
    // The block create never fired — only the (cached-token) mint at most.
    expect(globalThis.fetch.mock.calls.every(([u]) => !String(u).includes('/blocks/'))).toBe(true);
  });

  it('rejects a non-image extension', async () => {
    const txtPath = join(dir, 'notes.txt');
    writeFileSync(txtPath, 'hi');
    globalThis.fetch = vi.fn().mockResolvedValueOnce(tokenReply());
    const res = JSON.parse(await larkDocsSkill.handleToolCall('larkdoc_insert_image', {
      documentId: 'DocImgTwo22', imagePath: txtPath,
    }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/\.png or \.jpg/);
  });

  it('requires imagePath', async () => {
    const res = JSON.parse(await larkDocsSkill.handleToolCall('larkdoc_insert_image', { documentId: 'DocImgTwo22' }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/imagePath is required/);
  });

  it('fail-softs when the media upload fails (block created, no bind)', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(tokenReply())
      .mockResolvedValueOnce(dataReply({ children: [{ block_id: 'blk3' }] }))
      .mockResolvedValueOnce(errReply('file size exceeded'));
    const res = JSON.parse(await larkDocsSkill.handleToolCall('larkdoc_insert_image', {
      documentId: 'DocImgTwo22', imagePath,
    }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/file size exceeded/);
    // The replace_image PATCH never fired.
    expect(globalThis.fetch.mock.calls).toHaveLength(3);
  });
});

// ───────────────────────── comments ─────────────────────────

describe('larkdoc_list_comments', () => {
  it('lists comment threads with their replies', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(tokenReply())
      .mockResolvedValueOnce(dataReply({
        items: [
          { comment_id: 'cmt1', is_solved: false, reply_list: { replies: [
            { reply_id: 'r1', user_id: 'ou_a', content: { elements: [{ type: 'text_run', text_run: { text: '@Zibby thoughts?' } }] }, create_time: '111' },
          ] } },
        ],
      }));
    const res = JSON.parse(await larkDocsSkill.handleToolCall('larkdoc_list_comments', { documentId: 'DocOneReal1' }));
    expect(res.ok).toBe(true);
    expect(res.count).toBe(1);
    expect(res.comments[0].commentId).toBe('cmt1');
    expect(res.comments[0].replies[0]).toMatchObject({ replyId: 'r1', author: 'ou_a', text: '@Zibby thoughts?' });
    const url = globalThis.fetch.mock.calls[1][0];
    expect(url).toContain('/drive/v1/files/DocOneReal1/comments');
    expect(url).toContain('file_type=docx');
  });

  it('requires a doc id/url', async () => {
    const res = JSON.parse(await larkDocsSkill.handleToolCall('larkdoc_list_comments', {}));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/valid Lark doc/);
  });
});

describe('larkdoc_add_comment', () => {
  it('creates a new top-level comment', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(tokenReply())
      .mockResolvedValueOnce(dataReply({ comment_id: 'newcmt' }));
    const res = JSON.parse(await larkDocsSkill.handleToolCall('larkdoc_add_comment', {
      documentId: 'DocOneReal1', text: 'Looks good to me.',
    }));
    expect(res.ok).toBe(true);
    expect(res.commentId).toBe('newcmt');
    const [url, opts] = globalThis.fetch.mock.calls[1];
    expect(url).toContain('/drive/v1/files/DocOneReal1/comments?file_type=docx');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.reply_list.replies[0].content.elements[0].text_run.text).toBe('Looks good to me.');
  });

  it('requires text', async () => {
    const res = JSON.parse(await larkDocsSkill.handleToolCall('larkdoc_add_comment', { documentId: 'DocOneReal1' }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/text is required/);
  });
});

describe('larkdoc_reply_comment', () => {
  it('replies inside an existing comment thread', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(tokenReply())
      .mockResolvedValueOnce(dataReply({ reply_id: 'rr1' }));
    const res = JSON.parse(await larkDocsSkill.handleToolCall('larkdoc_reply_comment', {
      documentId: 'DocOneReal1', commentId: 'cmt1', text: 'On it — reviewing now.',
    }));
    expect(res.ok).toBe(true);
    expect(res.commentId).toBe('cmt1');
    expect(res.replyId).toBe('rr1');
    const [url, opts] = globalThis.fetch.mock.calls[1];
    expect(url).toContain('/drive/v1/files/DocOneReal1/comments/cmt1/replies?file_type=docx');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.content.elements[0].text_run.text).toBe('On it — reviewing now.');
  });

  it('requires a commentId', async () => {
    const res = JSON.parse(await larkDocsSkill.handleToolCall('larkdoc_reply_comment', { documentId: 'DocOneReal1', text: 'x' }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/commentId is required/);
  });

  it('fail-softs on an API error', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(tokenReply())
      .mockResolvedValueOnce(errReply('permission denied'));
    const res = JSON.parse(await larkDocsSkill.handleToolCall('larkdoc_reply_comment', {
      documentId: 'DocOneReal1', commentId: 'cmt1', text: 'hi',
    }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/permission denied/);
  });
});
