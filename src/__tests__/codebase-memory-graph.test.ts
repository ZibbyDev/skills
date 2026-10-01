import { afterEach, expect, test, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowGraph } from '@zibby/agent-workflow';
import { codebaseMemorySkill } from '../codebaseMemory.ts';

const original = Object.fromEntries(['WORKSPACE', 'CBM_BIN', 'CBM_CACHE_DIR', 'CBM_TEST_LOG',
  'WORKFLOW_ENABLED_INTEGRATIONS'].map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('any graph declaring codebase-memory prepares it before its model call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cbm-any-graph-'));
  try {
    const repo = join(root, '.zibby', 'repos', 'sample');
    mkdirSync(repo, { recursive: true });
    const bin = join(root, 'mock-cbm');
    writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$@" > "$CBM_TEST_LOG"\n');
    chmodSync(bin, 0o755);
    process.env.WORKSPACE = root;
    process.env.CBM_BIN = bin;
    process.env.CBM_CACHE_DIR = join(root, 'index');
    process.env.CBM_TEST_LOG = join(root, 'invoked');
    process.env.WORKFLOW_ENABLED_INTEGRATIONS = 'codebase-memory';

    const invokeAgent = vi.fn(async () => {
      expect(codebaseMemorySkill.resolve().command).toBe(bin);
      expect(readFileSync(process.env.CBM_TEST_LOG!, 'utf8')).toContain('index_repository');
      expect(readFileSync(process.env.CBM_TEST_LOG!, 'utf8')).toContain(repo);
      return { success: true, output: {} };
    });
    const graph = new WorkflowGraph({ invokeAgent });
    graph.addNode('ordinary-work', { name: 'ordinary-work', skills: ['codebase-memory'], _isCustomCode: true,
      async execute(ctx: any) { await ctx._coreInvokeAgent('inspect repository', ctx, {}); return { success: true, output: {} }; } });
    graph.setEntryPoint('ordinary-work');
    graph.addEdge('ordinary-work', 'END');
    await graph.run({}, { config: { skills: { graph: codebaseMemorySkill } } });
    expect(invokeAgent).toHaveBeenCalledTimes(1);
    expect(existsSync(process.env.CBM_TEST_LOG!)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
