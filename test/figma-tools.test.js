import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock backend-client BEFORE importing the skill (same setup as the other skill
// tests) so figmaFetch's resolveIntegrationToken('figma') yields a fixed PAT.
vi.mock('@zibby/core/backend-client.js', () => ({
  resolveIntegrationToken: vi.fn(async () => ({ provider: 'figma', token: 'secret_figma_pat' })),
  clearTokenCache: vi.fn(),
}));

const { figmaSkill, fileKeyFrom, normalizeNodeIds, nodeSpec } = await import('../src/figma.js');

// A fetch Response-like object (mirrors the other figma/linkedin tests).
function fetchJson(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('figma helpers', () => {
  it('(a) fileKeyFrom returns the key for a raw key AND a figma.com/design URL', () => {
    expect(fileKeyFrom('aBcD1234')).toBe('aBcD1234');
    expect(fileKeyFrom('https://www.figma.com/design/aBcD1234/My-File?node-id=1-23')).toBe('aBcD1234');
    // also handles the legacy /file/ form
    expect(fileKeyFrom('https://figma.com/file/XyZ9876/Whatever')).toBe('XyZ9876');
  });

  it('(b) normalizeNodeIds maps URL form dashes to API colons', () => {
    expect(normalizeNodeIds('1-23,4-56')).toBe('1:23,4:56');
    expect(normalizeNodeIds(['1-23', '4-56'])).toBe('1:23,4:56');
  });

  it('(c) nodeSpec on a SOLID-fill TEXT node returns size, uppercase hex fill, and textStyle.fontFamily', () => {
    const textNode = {
      id: '1:23',
      name: 'Heading',
      type: 'TEXT',
      absoluteBoundingBox: { x: 10, y: 20, width: 240, height: 48 },
      characters: 'Hello',
      style: { fontFamily: 'Inter', fontWeight: 600, fontSize: 24, textAlignHorizontal: 'LEFT' },
      fills: [{ type: 'SOLID', color: { r: 1, g: 0.5, b: 0, a: 1 } }],
    };
    const spec = nodeSpec(textNode, 0);
    expect(spec.size).toEqual({ w: 240, h: 48 });
    expect(spec.position).toEqual({ x: 10, y: 20 });
    // #FF8000 — uppercase hex
    expect(spec.fills[0].hex).toBe('#FF8000');
    expect(spec.fills[0].hex).toBe(spec.fills[0].hex.toUpperCase());
    expect(spec.textStyle.fontFamily).toBe('Inter');
    expect(spec.text).toBe('Hello');
  });
});

describe('figma tool count', () => {
  it('exposes 12 tools', () => {
    expect(figmaSkill.tools).toHaveLength(12);
    const names = figmaSkill.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'figma_get_comments',
      'figma_get_file',
      'figma_get_file_versions',
      'figma_get_image_fills',
      'figma_get_me',
      'figma_get_node_specs',
      'figma_get_nodes',
      'figma_get_project_files',
      'figma_get_team_projects',
      'figma_parse_url',
      'figma_post_comment',
      'figma_render_png',
    ]);
  });
});

describe('figma_post_comment', () => {
  it('(d) builds a POST body with message and client_meta.node_id in colon form when node_id is passed', async () => {
    let captured;
    globalThis.fetch = vi.fn(async (url, init) => {
      captured = { url, init };
      return fetchJson({ id: 'c1', message: 'hi there', created_at: '2026-01-01' });
    });

    const result = JSON.parse(await figmaSkill.handleToolCall('figma_post_comment', {
      file: 'https://www.figma.com/design/aBcD1234/My-File',
      message: 'hi there',
      node_id: '1-23',
    }));

    expect(result.id).toBe('c1');
    // The request went to the file's comments endpoint (file key parsed from the URL).
    expect(captured.url).toContain('/v1/files/aBcD1234/comments');
    expect(captured.init.method).toBe('POST');
    const body = JSON.parse(captured.init.body);
    expect(body.message).toBe('hi there');
    // node_id normalized to colon form inside client_meta.
    expect(body.client_meta.node_id).toBe('1:23');
    expect(body.client_meta.node_offset).toEqual({ x: 0, y: 0 });
  });
});

describe('figma_parse_url', () => {
  it('(e) returns file_key/node_id with NO network call', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('fetch must NOT be called by figma_parse_url'); });

    const result = JSON.parse(await figmaSkill.handleToolCall('figma_parse_url', {
      url: 'https://www.figma.com/design/aBcD1234/My-File?node-id=1-23&t=abc',
    }));

    expect(result.file_key).toBe('aBcD1234');
    expect(result.node_id).toBe('1:23');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
