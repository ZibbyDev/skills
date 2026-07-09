import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { socialCardSkill } from '../src/socialCard.js';

// social-card renders STRUCTURED fields (headline + eyebrow + optional
// stat/footer/diagram) into a branded "concept card" SVG → resvg PNG, written
// into the run's output dir (ZIBBY_NODE_SESSION_PATH first — the folder the CLI
// session-uploader scans). These tests assert: structure, resolve() env
// forwarding, a real render (PNG magic bytes + non-empty), theme/light + accent
// handling, the imagePath-pairing hint in the prompt, and the clear-error
// contract on a missing headline.

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let outDir;

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), 'zibby-social-card-'));
  process.env.ZIBBY_NODE_SESSION_PATH = outDir;
});

afterEach(() => {
  delete process.env.ZIBBY_NODE_SESSION_PATH;
  delete process.env.ZIBBY_SESSION_PATH;
  if (outDir && existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
});

describe('socialCardSkill structure', () => {
  it('has the expected id / serverName / allowedTools', () => {
    expect(socialCardSkill.id).toBe('social-card');
    expect(socialCardSkill.serverName).toBe('social_card');
    expect(socialCardSkill.allowedTools).toEqual(['mcp__social_card__*']);
  });

  it('exposes exactly one tool: social_card_render (headline required)', () => {
    const names = socialCardSkill.tools.map((t) => t.name);
    expect(names).toEqual(['social_card_render']);
    expect(socialCardSkill.tools[0].input_schema.required).toEqual(['headline']);
  });

  it('resolve() spawns the generic skill MCP server pointing at ../dist/socialCard.js', () => {
    const spec = socialCardSkill.resolve();
    expect(spec).not.toBeNull();
    expect(spec.command).toBe('node');
    expect(spec.args).toEqual(expect.arrayContaining(['../dist/socialCard.js', 'socialCardSkill']));
    expect(spec.alwaysLoad).toBe(true);
  });

  it('resolve() forwards the session output-dir env to the MCP child', () => {
    const spec = socialCardSkill.resolve({ sessionPath: '/tmp/sess', nodeName: 'draft' });
    expect(spec.env.ZIBBY_NODE_SESSION_PATH).toBe('/tmp/sess/draft');
    expect(spec.env.ZIBBY_SESSION_PATH).toBe('/tmp/sess');
  });

  it('promptFragment tells the agent to pass the returned path as a post imagePath', () => {
    expect(socialCardSkill.promptFragment).toMatch(/imagePath/);
    expect(socialCardSkill.promptFragment).toMatch(/social_card_render/);
  });
});

describe('social_card_render — renders a real PNG', () => {
  it('writes a PNG with the PNG signature (first 8 bytes) and bytes > 0', async () => {
    const result = JSON.parse(await socialCardSkill.handleToolCall('social_card_render', {
      headline: 'No more copy-paste',
      eyebrow: 'MY WORKFLOW',
      diagram: ['Claude Code', 'Codex'],
    }));

    expect(result.ok).toBe(true);
    expect(Array.isArray(result.files)).toBe(true);
    const png = result.files.find((f) => f.format === 'png');
    expect(png).toBeTruthy();
    expect(png.bytes).toBeGreaterThan(0);

    // The file exists in the run output dir and starts with the PNG magic bytes.
    expect(existsSync(png.path)).toBe(true);
    const bytes = readFileSync(png.path);
    expect(bytes.length).toBe(png.bytes);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
  });

  it('renders with all the optional fields (stat/footer/subhead/light/accent) without error', async () => {
    const result = JSON.parse(await socialCardSkill.handleToolCall('social_card_render', {
      headline: 'Ship your AI workflow to production in one command',
      eyebrow: 'open source',
      subhead: 'A single CLI that wires Claude Code, Codex and your repo together.',
      stat: '11.8k stars',
      footer: 'Apache 2.0',
      diagram: ['Repo', 'Agent', 'PR'],
      theme: 'light',
      accent: '#f97316',
    }));
    expect(result.ok).toBe(true);
    expect(result.theme).toBe('light');
    const png = result.files.find((f) => f.format === 'png');
    expect(readFileSync(png.path).subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
  });

  it("output:'both' also writes an SVG alongside the PNG", async () => {
    const result = JSON.parse(await socialCardSkill.handleToolCall('social_card_render', {
      headline: 'Both formats',
      output: 'both',
    }));
    expect(result.ok).toBe(true);
    expect(result.files.map((f) => f.format).sort()).toEqual(['png', 'svg']);
    const svg = result.files.find((f) => f.format === 'svg');
    expect(readFileSync(svg.path, 'utf-8')).toContain('<svg');
  });

  it('XML-escapes special characters in the headline (no raw & or <)', async () => {
    const result = JSON.parse(await socialCardSkill.handleToolCall('social_card_render', {
      headline: 'Tools & <agents> "win"',
      output: 'both',
    }));
    const svg = result.files.find((f) => f.format === 'svg');
    const xml = readFileSync(svg.path, 'utf-8');
    expect(xml).toContain('Tools &amp; &lt;agents&gt;');
    expect(xml).not.toContain('<agents>');
  });

  it('rejects a missing headline with a clear error (never throws)', async () => {
    const result = JSON.parse(await socialCardSkill.handleToolCall('social_card_render', { eyebrow: 'X' }));
    expect(result.error).toMatch(/headline/i);
    expect(result.ok).toBeUndefined();
  });

  it('unknown tool returns { error } (never throws)', async () => {
    const result = JSON.parse(await socialCardSkill.handleToolCall('bogus_tool', {}));
    expect(result.error).toMatch(/Unknown tool/);
  });
});
