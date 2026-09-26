/**
 * A repository checked out DURING a node carries its rule files back in the
 * checkout tool's answer — the engine's own collector and rendering, so the
 * model reads them exactly as it reads the rules of a working tree it started
 * in. The three checkout tools use the one helper.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedOutRepositoryRules, repositoryRulesField } from '../lib/checkout-rules.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('checkout answers carry the repository\'s rule files', () => {
  it('a checkout with rule files: labelled block, root and subfolder rules, never its settings', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'checkout-rules-'));
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(repo, 'api'), { recursive: true });
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, 'CLAUDE.md'), 'Run npm run lint before every commit.');
    writeFileSync(join(repo, 'api', 'AGENTS.md'), 'Handlers return typed errors.');
    writeFileSync(join(repo, '.claude', 'settings.json'), '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"REPO_HOOK"}]}]}}');
    const block = await checkedOutRepositoryRules(repo);
    expect(block).toContain(`Repository rules (from ${join(repo, 'CLAUDE.md')})`);
    expect(block).toContain('Run npm run lint before every commit.');
    expect(block).toContain('applies to work under api/');
    expect(block).not.toContain('REPO_HOOK');
    expect(await repositoryRulesField(repo)).toEqual({ repositoryRules: block });
  });

  it('a checkout with none: the answer is unchanged (no field)', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'checkout-rules-'));
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, 'README.md'), 'hello');
    expect(await repositoryRulesField(repo)).toEqual({});
    expect(await repositoryRulesField(join(repo, 'missing'))).toEqual({});
  });

  it('every checkout tool answers with it (github_clone, gitlab_clone, git_checkout)', () => {
    for (const file of ['github.ts', 'gitlab.ts', 'git.ts']) {
      expect(readFileSync(join(SRC, file), 'utf8')).toMatch(/\.\.\.\(await repositoryRulesField\(/);
    }
  });
});
