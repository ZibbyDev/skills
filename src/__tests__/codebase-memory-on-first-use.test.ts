/**
 * The codebase-memory binary is prepared when a run first USES it.
 *
 * A run whose MCP the platform serves lists these tools from their declaration;
 * the binary runs only for a tool call, or to index a checkout that is already
 * there. Unpacking it at every node start cost a product owner's chat turn
 * ~2.4 s before its model was asked, for tools the turn never called
 * (run_log/product-owner/2026-10-25-chat-turn-tool-startup-latency).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const prepared = vi.hoisted(() => ({ calls: 0, bin: '' }));
vi.mock('@zibby/bin-registry', async (importOriginal) => {
  const real: any = await importOriginal();
  return { ...real,
    cachedToolPath: () => null,
    ensureTool: async () => { prepared.calls += 1; return prepared.bin; } };
});

const { codebaseMemorySkill } = await import('../codebaseMemory.ts');

const KEYS = ['WORKSPACE', 'CBM_BIN', 'CBM_CACHE_DIR', 'MCP_SHARED_PLATFORM'];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cbm-first-use-'));
  prepared.calls = 0;
  prepared.bin = join(root, 'cbm');
  writeFileSync(prepared.bin, '#!/bin/sh\ncat >/dev/null\nprintf \'{"projects":[]}\\n\'\n');
  chmodSync(prepared.bin, 0o755);
  delete process.env.CBM_BIN;
  process.env.WORKSPACE = root;
  process.env.CBM_CACHE_DIR = join(root, 'cache');
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('codebase-memory binary on first use', () => {
  it('a platform-served run with nothing to index does not prepare the binary at node start', async () => {
    process.env.MCP_SHARED_PLATFORM = '1';
    expect(await codebaseMemorySkill.invokeAgentOptions()).toEqual({});
    expect(prepared.calls).toBe(0);
  });

  it('the first tool call prepares it and answers', async () => {
    process.env.MCP_SHARED_PLATFORM = '1';
    expect(await codebaseMemorySkill.handleToolCall('list_projects', {})).toEqual({
      content: [{ type: 'text', text: '{"projects":[]}' }],
    });
    expect(prepared.calls).toBe(1);
  });

  it('still prepares it at node start when a stdio server will be started here', async () => {
    process.env.MCP_SHARED_PLATFORM = '0';
    await codebaseMemorySkill.invokeAgentOptions();
    expect(prepared.calls).toBe(1);
  });

  it('still prepares it at node start when a checkout is there to index', async () => {
    process.env.MCP_SHARED_PLATFORM = '1';
    mkdirSync(join(root, '.zibby', 'repos', 'sample'), { recursive: true });
    await codebaseMemorySkill.invokeAgentOptions();
    expect(prepared.calls).toBe(1);
  });
});
