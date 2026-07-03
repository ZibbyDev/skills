import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock backend-client BEFORE importing the skill so resolveIntegrationToken
// is replaced at load time. Shape mirrors GET /integrations/token/google.
vi.mock('@zibby/core/backend-client.js', () => ({
  resolveIntegrationToken: vi.fn(async () => ({
    provider: 'google',
    token: 'ya29.test-token',
    email: 'founder@example.com',
    scopes: 'openid email https://www.googleapis.com/auth/drive.file',
  })),
  clearTokenCache: vi.fn(),
}));

const { resolveIntegrationToken } = await import('@zibby/core/backend-client.js');
const {
  googleDocsSkill,
  parseDocId,
  parseInlineMarkdown,
  markdownToRequests,
  extractPlainText,
} = await import('../src/googleDocs.js');

// Build a fetch Response-like object. googleApi reads res.ok + res.text().
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

// ───────────────────────── structure ─────────────────────────

describe('googleDocsSkill structure', () => {
  it('has correct id + serverName + requiresIntegration', () => {
    expect(googleDocsSkill.id).toBe('google-docs');
    expect(googleDocsSkill.serverName).toBe('gdocs');
    expect(googleDocsSkill.requiresIntegration).toBe('google');
  });

  it('exposes the four gdocs tools', () => {
    const names = googleDocsSkill.tools.map((t) => t.name).sort();
    expect(names).toEqual(['gdocs_append', 'gdocs_create_doc', 'gdocs_get', 'gdocs_list_created']);
  });

  it('resolve() spawns the generic skill MCP server', () => {
    const spec = googleDocsSkill.resolve();
    expect(spec).not.toBeNull();
    expect(spec.command).toBe('node');
    expect(spec.args).toEqual(expect.arrayContaining(['../dist/googleDocs.js', 'googleDocsSkill']));
    expect(spec.alwaysLoad).toBe(true);
    expect(googleDocsSkill.allowedTools).toEqual(['mcp__gdocs__*']);
  });

  it('promptFragment documents the drive.file visibility caveat', () => {
    expect(googleDocsSkill.promptFragment).toMatch(/drive\.file/);
    expect(googleDocsSkill.promptFragment).toMatch(/only see docs/i);
  });
});

// ───────────────────────── parseDocId ─────────────────────────

describe('parseDocId — URL/id parsing', () => {
  it('parses a bare document id', () => {
    expect(parseDocId('1AbC_dEf-GhIjKlMnOpQrStUvWxYz012345'))
      .toBe('1AbC_dEf-GhIjKlMnOpQrStUvWxYz012345');
  });

  it('extracts the id from a docs.google.com URL', () => {
    expect(parseDocId('https://docs.google.com/document/d/1AbC_dEf-GhIjKlMnOpQrStUvWxYz012345/edit#heading=h.x'))
      .toBe('1AbC_dEf-GhIjKlMnOpQrStUvWxYz012345');
  });

  it('extracts the id from a /u/0/ user-scoped URL', () => {
    expect(parseDocId('https://docs.google.com/document/u/0/d/1AbC_dEf-GhIjKlMnOpQrStUvWxYz012345/edit'))
      .toBe('1AbC_dEf-GhIjKlMnOpQrStUvWxYz012345');
  });

  it('returns null for junk', () => {
    expect(parseDocId('not a doc')).toBeNull();
    expect(parseDocId('')).toBeNull();
    expect(parseDocId(null)).toBeNull();
  });
});

// ───────────────────────── markdown converter ─────────────────────────

describe('parseInlineMarkdown', () => {
  it('extracts bold ranges', () => {
    const { text, styles } = parseInlineMarkdown('a **bold** word');
    expect(text).toBe('a bold word');
    expect(styles).toEqual([{ start: 2, end: 6, bold: true }]);
  });

  it('extracts link ranges', () => {
    const { text, styles } = parseInlineMarkdown('see [docs](https://x.dev) now');
    expect(text).toBe('see docs now');
    expect(styles).toEqual([{ start: 4, end: 8, link: 'https://x.dev' }]);
  });

  it('extracts inline code ranges', () => {
    const { text, styles } = parseInlineMarkdown('run `npm test` ok');
    expect(text).toBe('run npm test ok');
    expect(styles).toEqual([{ start: 4, end: 12, code: true }]);
  });

  it('passes plain text through untouched', () => {
    const { text, styles } = parseInlineMarkdown('nothing fancy');
    expect(text).toBe('nothing fancy');
    expect(styles).toEqual([]);
  });
});

describe('markdownToRequests', () => {
  it('emits a single insertText carrying every paragraph, newline-terminated', () => {
    const { requests } = markdownToRequests('# Title\nHello world', 1);
    expect(requests[0]).toEqual({
      insertText: { location: { index: 1 }, text: 'Title\nHello world\n' },
    });
  });

  it('styles headings with the right namedStyleType over the right ranges', () => {
    const { requests } = markdownToRequests('# Big\n## Mid\n### Small', 1);
    const styles = requests.filter((r) => r.updateParagraphStyle);
    expect(styles).toHaveLength(3);
    // 'Big\n' spans [1,5), 'Mid\n' spans [5,9), 'Small\n' spans [9,15)
    expect(styles[0].updateParagraphStyle).toEqual({
      range: { startIndex: 1, endIndex: 5 },
      paragraphStyle: { namedStyleType: 'HEADING_1' },
      fields: 'namedStyleType',
    });
    expect(styles[1].updateParagraphStyle.paragraphStyle.namedStyleType).toBe('HEADING_2');
    expect(styles[1].updateParagraphStyle.range).toEqual({ startIndex: 5, endIndex: 9 });
    expect(styles[2].updateParagraphStyle.paragraphStyle.namedStyleType).toBe('HEADING_3');
  });

  it('groups consecutive bullets into ONE createParagraphBullets request', () => {
    const { requests } = markdownToRequests('- one\n- two\nplain', 1);
    const bullets = requests.filter((r) => r.createParagraphBullets);
    expect(bullets).toHaveLength(1);
    // 'one\n' [1,5) + 'two\n' [5,9)
    expect(bullets[0].createParagraphBullets).toEqual({
      range: { startIndex: 1, endIndex: 9 },
      bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
    });
  });

  it('uses the numbered preset for ordered lists', () => {
    const { requests } = markdownToRequests('1. first\n2. second', 1);
    const bullets = requests.filter((r) => r.createParagraphBullets);
    expect(bullets).toHaveLength(1);
    expect(bullets[0].createParagraphBullets.bulletPreset).toBe('NUMBERED_DECIMAL_ALPHA_ROMAN');
  });

  it('emits bold + link text styles at absolute indices', () => {
    const { requests } = markdownToRequests('a **b** [c](https://c.dev)', 1);
    // plain text: 'a b c\n' at index 1 → 'b' at [3,4), 'c' at [5,6)
    const text = requests.find((r) => r.insertText);
    expect(text.insertText.text).toBe('a b c\n');
    const bold = requests.find((r) => r.updateTextStyle?.textStyle?.bold);
    expect(bold.updateTextStyle.range).toEqual({ startIndex: 3, endIndex: 4 });
    const link = requests.find((r) => r.updateTextStyle?.textStyle?.link);
    expect(link.updateTextStyle.range).toEqual({ startIndex: 5, endIndex: 6 });
    expect(link.updateTextStyle.textStyle.link.url).toBe('https://c.dev');
  });

  it('returns no requests for empty content', () => {
    expect(markdownToRequests('', 1).requests).toEqual([]);
  });

  it('honors a non-1 startIndex (the append path)', () => {
    const { requests, endIndex } = markdownToRequests('hi', 42);
    expect(requests[0].insertText.location.index).toBe(42);
    expect(endIndex).toBe(45); // 'hi\n' = 3 chars
  });
});

// ───────────────────────── extractPlainText ─────────────────────────

describe('extractPlainText', () => {
  it('joins paragraph text runs, including table cells', () => {
    const body = {
      content: [
        { paragraph: { elements: [{ textRun: { content: 'Hello ' } }, { textRun: { content: 'world\n' } }] } },
        {
          table: {
            tableRows: [
              { tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: 'cell\n' } }] } }] }] },
            ],
          },
        },
      ],
    };
    expect(extractPlainText(body)).toBe('Hello world\ncell\n');
  });

  it('tolerates an absent body', () => {
    expect(extractPlainText(undefined)).toBe('');
  });
});

// ───────────────────────── tools (fetch-mocked) ─────────────────────────

describe('gdocs_create_doc', () => {
  it('creates the doc then batchUpdates the content; returns { documentId, url }', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      calls.push({ url, opts });
      if (String(url).endsWith('/documents')) return fetchJson({ documentId: 'doc-123', title: 'T' });
      return fetchJson({});
    }));

    const res = JSON.parse(await googleDocsSkill.handleToolCall('gdocs_create_doc', {
      title: 'T',
      markdown: '# Hello\n- a',
    }));

    expect(res.ok).toBe(true);
    expect(res.documentId).toBe('doc-123');
    expect(res.url).toBe('https://docs.google.com/document/d/doc-123/edit');

    // Call 1: documents.create with the title, Bearer-authed.
    expect(calls[0].url).toBe('https://docs.googleapis.com/v1/documents');
    expect(calls[0].opts.method).toBe('POST');
    expect(JSON.parse(calls[0].opts.body)).toEqual({ title: 'T' });
    expect(calls[0].opts.headers.Authorization).toBe('Bearer ya29.test-token');

    // Call 2: batchUpdate on the new doc, content inserted at index 1.
    expect(calls[1].url).toBe('https://docs.googleapis.com/v1/documents/doc-123:batchUpdate');
    const { requests } = JSON.parse(calls[1].opts.body);
    expect(requests[0].insertText.location.index).toBe(1);
    expect(requests.some((r) => r.updateParagraphStyle)).toBe(true);
    expect(requests.some((r) => r.createParagraphBullets)).toBe(true);
  });

  it('skips the batchUpdate when no content is given', async () => {
    const fetchMock = vi.fn(async () => fetchJson({ documentId: 'doc-9' }));
    vi.stubGlobal('fetch', fetchMock);
    const res = JSON.parse(await googleDocsSkill.handleToolCall('gdocs_create_doc', { title: 'Empty' }));
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requires a title', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = JSON.parse(await googleDocsSkill.handleToolCall('gdocs_create_doc', { markdown: 'x' }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/title/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns { ok:false } and performs NO write when the token cannot be resolved', async () => {
    // ONE queued rejection: "not connected" is not retried by googleApi (no
    // token/401 marker), so exactly one resolveIntegrationToken call happens.
    resolveIntegrationToken.mockRejectedValueOnce(new Error('Google integration missing (not connected)'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = JSON.parse(await googleDocsSkill.handleToolCall('gdocs_create_doc', { title: 'T', text: 'x' }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not connected/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('gdocs_append', () => {
  it('reads the end index, breaks the paragraph, appends at end-of-body', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      calls.push({ url, opts });
      if (!opts?.method || opts.method === 'GET') {
        // documents.get → last structural element ends at 25.
        return fetchJson({ documentId: 'doc-1', body: { content: [{ endIndex: 10 }, { endIndex: 25 }] } });
      }
      return fetchJson({});
    }));

    const res = JSON.parse(await googleDocsSkill.handleToolCall('gdocs_append', {
      documentId: 'https://docs.google.com/document/d/1AbC_dEf-GhIjKlMnOpQrStUvWxYz012345/edit',
      markdown: 'tail',
    }));
    expect(res.ok).toBe(true);
    expect(res.documentId).toBe('1AbC_dEf-GhIjKlMnOpQrStUvWxYz012345');

    const update = calls.find((c) => String(c.url).includes(':batchUpdate'));
    const { requests } = JSON.parse(update.opts.body);
    // Insert point = endIndex-1 = 24; first request is the paragraph break,
    // then the content insert at 25.
    expect(requests[0]).toEqual({ insertText: { location: { index: 24 }, text: '\n' } });
    expect(requests[1].insertText.location.index).toBe(25);
    expect(requests[1].insertText.text).toBe('tail\n');
  });

  it('requires content', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = JSON.parse(await googleDocsSkill.handleToolCall('gdocs_append', {
      documentId: '1AbC_dEf-GhIjKlMnOpQrStUvWxYz012345',
    }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/content/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an unparsable document ref without any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = JSON.parse(await googleDocsSkill.handleToolCall('gdocs_append', {
      documentId: 'nope', markdown: 'x',
    }));
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns { ok:false } (no throw, no write) when the Docs API errors', async () => {
    let batchCalled = false;
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (String(url).includes(':batchUpdate')) batchCalled = true;
      return fetchJson({ error: { message: 'The caller does not have permission' } }, false, 403);
    }));
    const res = JSON.parse(await googleDocsSkill.handleToolCall('gdocs_append', {
      documentId: '1AbC_dEf-GhIjKlMnOpQrStUvWxYz012345', markdown: 'x',
    }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/403/);
    // The write never fired — the documents.get failed first.
    expect(batchCalled).toBe(false);
  });
});

describe('gdocs_get', () => {
  it('returns title + extracted plain text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fetchJson({
      documentId: 'doc-1',
      title: 'My Doc',
      body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Body text\n' } }] } }] },
    })));
    const res = JSON.parse(await googleDocsSkill.handleToolCall('gdocs_get', { documentId: '1AbC_dEf-GhIjKlMnOpQrStUvWxYz012345' }));
    expect(res.ok).toBe(true);
    expect(res.title).toBe('My Doc');
    expect(res.text).toBe('Body text\n');
  });

  it('surfaces a drive.file permission failure as { ok:false }', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fetchJson({ error: 'PERMISSION_DENIED' }, false, 403)));
    const res = JSON.parse(await googleDocsSkill.handleToolCall('gdocs_get', { documentId: '1AbC_dEf-GhIjKlMnOpQrStUvWxYz012345' }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/403/);
  });
});

describe('gdocs_list_created', () => {
  it('queries Drive for app-visible Google Docs and maps the rows', async () => {
    let seenUrl;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      seenUrl = String(url);
      return fetchJson({ files: [{ id: 'f1', name: 'Report', modifiedTime: '2026-07-01T00:00:00Z', webViewLink: 'https://docs.google.com/document/d/f1/edit' }] });
    }));
    const res = JSON.parse(await googleDocsSkill.handleToolCall('gdocs_list_created', {}));
    expect(res.ok).toBe(true);
    expect(res.count).toBe(1);
    expect(res.files[0]).toEqual({
      documentId: 'f1',
      title: 'Report',
      modifiedTime: '2026-07-01T00:00:00Z',
      url: 'https://docs.google.com/document/d/f1/edit',
    });
    const parsed = new URL(seenUrl);
    expect(parsed.origin + parsed.pathname).toBe('https://www.googleapis.com/drive/v3/files');
    expect(parsed.searchParams.get('q')).toContain("mimeType='application/vnd.google-apps.document'");
    expect(parsed.searchParams.get('q')).toContain("'me' in owners");
  });
});

describe('unknown tool', () => {
  it('returns { ok:false } for an unknown tool name', async () => {
    const res = JSON.parse(await googleDocsSkill.handleToolCall('gdocs_nope', {}));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Unknown tool/);
  });
});

// ───────── injected-token path + NON-OWNER safety gate (Copilot per-turn) ─────────

describe('injected-token path + non-owner safety gate', () => {
  const T = 'ZIBBY_INJECTED_GOOGLE_TOKEN';
  const E = 'ZIBBY_INJECTED_GOOGLE_EMAIL';
  const F = 'ZIBBY_SENDER_IS_NON_OWNER';
  const S = 'ZIBBY_CHAT_STRICT_PERSONAL';

  beforeEach(() => {
    delete process.env[T];
    delete process.env[E];
    delete process.env[F];
    delete process.env[S];
    vi.mocked(resolveIntegrationToken).mockClear();
  });

  afterEach(() => {
    delete process.env[T];
    delete process.env[E];
    delete process.env[F];
    delete process.env[S];
  });

  it('uses the INJECTED sender token — resolveIntegrationToken (the PAT/owner path) is NEVER called', async () => {
    process.env[T] = 'ya29.sender-injected';
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      return fetchJson({ documentId: 'docX' });
    }));
    const res = JSON.parse(await googleDocsSkill.handleToolCall('gdocs_create_doc', { title: 'T' }));
    expect(res.ok).toBe(true);
    expect(res.documentId).toBe('docX');
    // The Bearer is the injected sender token, not the PAT-account token.
    expect(calls[0].init.headers.Authorization).toBe('Bearer ya29.sender-injected');
    expect(resolveIntegrationToken).not.toHaveBeenCalled();
  });

  it('injected token wins even when the non-owner flag is ALSO set (sender has their own Google)', async () => {
    process.env[T] = 'ya29.sender-injected';
    process.env[F] = '1';
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      return fetchJson({ title: 'Doc', body: { content: [] } });
    }));
    const res = JSON.parse(await googleDocsSkill.handleToolCall('gdocs_get', { documentId: '1AbC_dEf-GhIjKlMnOpQrStUvWxYz012345' }));
    expect(res.ok).toBe(true);
    expect(calls[0].init.headers.Authorization).toBe('Bearer ya29.sender-injected');
    expect(resolveIntegrationToken).not.toHaveBeenCalled();
  });

  it('NON-OWNER with NO injected token → EVERY tool hard-refuses; no owner fallback, no network', async () => {
    process.env[F] = '1';
    const fetchSpy = vi.fn(async () => fetchJson({}));
    vi.stubGlobal('fetch', fetchSpy);
    const attempts = [
      ['gdocs_create_doc', { title: 'T', markdown: 'body' }],
      ['gdocs_append', { documentId: '1AbC_dEf-GhIjKlMnOpQrStUvWxYz012345', text: 'x' }],
      ['gdocs_get', { documentId: '1AbC_dEf-GhIjKlMnOpQrStUvWxYz012345' }],
      ['gdocs_list_created', {}],
    ];
    for (const [tool, args] of attempts) {
      const res = JSON.parse(await googleDocsSkill.handleToolCall(tool, args));
      expect(res.ok, tool).toBe(false);
      expect(res.error, tool).toContain("You haven't connected your own Google account");
      expect(res.error, tool).toContain('https://studio.zibby.dev/integrations');
      expect(res.error, tool).toContain("including the project owner's");
    }
    // SECURITY: the PAT/owner token was never resolved and no API call was made.
    expect(resolveIntegrationToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the refusal message never trips the transient-auth retry heuristic', async () => {
    // googleApi retries (via clearTokenCache) when the error message mentions
    // token/401/unauthorized — the refusal must not be retried/masked.
    const { NON_OWNER_REFUSAL } = await import('../src/googleDocs.js');
    const msg = NON_OWNER_REFUSAL.toLowerCase();
    expect(msg.includes('token')).toBe(false);
    expect(msg.includes('401')).toBe(false);
    expect(msg.includes('unauthorized')).toBe(false);
  });

  // ── STRICT CHAT-TURN INVARIANT (ZIBBY_CHAT_STRICT_PERSONAL=1) — the PRIMARY,
  // fail-CLOSED gate: EVERY chat turn refuses without an injected token, for
  // ANY sender (owner, non-owner, UNVERIFIED — the class the non-owner flag
  // failed open on). ──────────────────────────────────────────────────────────

  it('STRICT chat turn with NO injected token → EVERY tool hard-refuses; resolveIntegrationToken NEVER called (even without the non-owner flag — the unverified-sender / owner-no-google case)', async () => {
    process.env[S] = '1'; // note: F deliberately NOT set — old gate would fail OPEN here
    const fetchSpy = vi.fn(async () => fetchJson({}));
    vi.stubGlobal('fetch', fetchSpy);
    const attempts = [
      ['gdocs_create_doc', { title: 'T', markdown: 'body' }],
      ['gdocs_append', { documentId: '1AbC_dEf-GhIjKlMnOpQrStUvWxYz012345', text: 'x' }],
      ['gdocs_get', { documentId: '1AbC_dEf-GhIjKlMnOpQrStUvWxYz012345' }],
      ['gdocs_list_created', {}],
    ];
    for (const [tool, args] of attempts) {
      const res = JSON.parse(await googleDocsSkill.handleToolCall(tool, args));
      expect(res.ok, tool).toBe(false);
      expect(res.error, tool).toContain("You haven't connected your own Google account");
    }
    // SECURITY: zero backend/token resolution, zero network.
    expect(resolveIntegrationToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('STRICT chat turn WITH an injected token → works (owner + connected senders keep working through injection)', async () => {
    process.env[S] = '1';
    process.env[T] = 'ya29.injected-under-strict';
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      return fetchJson({ documentId: 'docStrict' });
    }));
    const res = JSON.parse(await googleDocsSkill.handleToolCall('gdocs_create_doc', { title: 'T' }));
    expect(res.ok).toBe(true);
    expect(calls[0].init.headers.Authorization).toBe('Bearer ya29.injected-under-strict');
    expect(resolveIntegrationToken).not.toHaveBeenCalled();
  });

  it('strict flag ABSENT (Fargate workflows / self-host / direct tool use) → legacy PAT path intact', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      expect(init.headers.Authorization).toBe('Bearer ya29.test-token');
      return fetchJson({ files: [] });
    }));
    const res = JSON.parse(await googleDocsSkill.handleToolCall('gdocs_list_created', {}));
    expect(res.ok).toBe(true);
    expect(resolveIntegrationToken).toHaveBeenCalledWith('google');
  });

  it('resolve() forwards ZIBBY_CHAT_STRICT_PERSONAL to the MCP child (an env-filtering spawner must not drop the gate)', async () => {
    process.env[S] = '1';
    const { chatStrictPersonal } = await import('../src/googleDocs.js');
    expect(chatStrictPersonal()).toBe(true);
    const spec = googleDocsSkill.resolve();
    expect(spec.env[S]).toBe('1');
  });

  it('owner/self (no injection, no flag) → the existing PAT path runs unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      expect(init.headers.Authorization).toBe('Bearer ya29.test-token'); // the mocked PAT-resolved token
      return fetchJson({ documentId: 'docOwner' });
    }));
    const res = JSON.parse(await googleDocsSkill.handleToolCall('gdocs_create_doc', { title: 'T' }));
    expect(res.ok).toBe(true);
    expect(resolveIntegrationToken).toHaveBeenCalledWith('google');
  });

  it('resolve() forwards the injection/gate env to the MCP child; helpers parse the env', async () => {
    process.env[T] = 'tok';
    process.env[E] = 'sunwuk@corp.com';
    process.env[F] = '1';
    const { injectedGoogleToken, senderIsNonOwner } = await import('../src/googleDocs.js');
    expect(injectedGoogleToken()).toEqual({ token: 'tok', email: 'sunwuk@corp.com' });
    expect(senderIsNonOwner()).toBe(true);
    const spec = googleDocsSkill.resolve();
    expect(spec.env[T]).toBe('tok');
    expect(spec.env[E]).toBe('sunwuk@corp.com');
    expect(spec.env[F]).toBe('1');
    // …and stays empty when the turn carries no injection context.
    delete process.env[T];
    delete process.env[E];
    delete process.env[F];
    expect(googleDocsSkill.resolve().env).toEqual({});
    expect(injectedGoogleToken()).toBeNull();
    expect(senderIsNonOwner()).toBe(false);
  });

  it('promptFragment documents the per-user (per-teammate) Google model', () => {
    expect(googleDocsSkill.promptFragment).toMatch(/PER-USER/i);
    expect(googleDocsSkill.promptFragment).toMatch(/own Google/i);
  });
});
