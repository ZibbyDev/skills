import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { codebaseMemorySkill } from '../codebaseMemory.js';
import { CODEBASE_MEMORY_TOOL_SCHEMA_VERSION } from '../codebaseMemoryTools.js';
import { entryFor } from '@zibby/bin-registry';

describe('codebase-memory exact-run one-shot worker', () => {
  it('declares every tool from the pinned binary and preserves stdout/stderr JSON results', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbm-worker-'));
    const bin = join(dir, 'fake-cbm');
    writeFileSync(bin, `#!/bin/sh
cat >/dev/null
if [ "$2" = "list_projects" ]; then
  printf '{"projects":[]}\\n'
  exit 0
fi
printf 'level=info msg=mem.init\\n' >&2
printf '{"error":"missing required argument: project"}\\n' >&2
exit 1
`);
    chmodSync(bin, 0o700);
    const oldBin = process.env.CBM_BIN;
    const oldCache = process.env.CBM_CACHE_DIR;
    process.env.CBM_BIN = bin;
    process.env.CBM_CACHE_DIR = join(dir, 'cache');
    try {
      const names = codebaseMemorySkill.tools.map((tool: { name: string }) => tool.name);
      expect(CODEBASE_MEMORY_TOOL_SCHEMA_VERSION).toBe(entryFor('codebase-memory')?.version);
      expect(names).toHaveLength(14);
      expect(codebaseMemorySkill.workspaceWorker.tools).toEqual(names);
      expect(names).toContain('search_graph');
      expect(names).toContain('index_repository');
      expect(codebaseMemorySkill.tools.find((tool: { name: string }) => tool.name === 'index_repository')
        .input_schema.required).toContain('repo_path');

      expect(codebaseMemorySkill.handleToolCall('list_projects', {})).toEqual({
        content: [{ type: 'text', text: '{"projects":[]}' }],
      });
      expect(codebaseMemorySkill.handleToolCall('index_status', {})).toEqual({
        content: [{ type: 'text', text: '{"error":"missing required argument: project"}' }],
        isError: true,
      });
      expect(codebaseMemorySkill.handleToolCall('not_in_binary', {}).isError).toBe(true);
    } finally {
      if (oldBin === undefined) delete process.env.CBM_BIN; else process.env.CBM_BIN = oldBin;
      if (oldCache === undefined) delete process.env.CBM_CACHE_DIR; else process.env.CBM_CACHE_DIR = oldCache;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
