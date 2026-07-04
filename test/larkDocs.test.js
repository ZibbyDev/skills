import { describe, it, expect, beforeEach, vi } from 'vitest';

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

  it('exposes the three docx tools', () => {
    const names = larkDocsSkill.tools.map((t) => t.name).sort();
    expect(names).toEqual(['larkdoc_append', 'larkdoc_create', 'larkdoc_get']);
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
