/**
 * TWO-PLACES TRIPWIRE — the repository-selection rule.
 *
 * The rule is canonical in @zibby/core (src/utils/repo-access.js). The skills
 * carry a byte-identical copy (src/lib/repo-access.js), bundled into each skill,
 * so a tool process can check a repository whatever @zibby/core it resolves.
 * A copy that drifts would enforce a different boundary than the clone/push
 * path — so this fails on any difference. Skipped only where the sibling core
 * checkout is absent (a bare skills checkout).
 */
import { describe, test, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const COPY = here('../lib/repo-access.js');
const CANONICAL = here('../../../core/src/utils/repo-access.js');

describe('skills/src/lib/repo-access.js', () => {
  test('is byte-identical to @zibby/core src/utils/repo-access.js', () => {
    if (!existsSync(CANONICAL)) return;
    expect(
      readFileSync(COPY, 'utf8'),
      'Drifted from the canonical rule. Edit packages/core/src/utils/repo-access.js, then:\n'
      + '  cp packages/core/src/utils/repo-access.js packages/skills/src/lib/repo-access.js',
    ).toBe(readFileSync(CANONICAL, 'utf8'));
  });

  test('every repository-touching skill imports the bundled copy, never a core subpath', () => {
    for (const f of ['github.ts', 'gitlab.ts', 'git.ts']) {
      const src = readFileSync(here(`../${f}`), 'utf8');
      expect([f, src.includes("from './lib/repo-access.js'")]).toEqual([f, true]);
      expect([f, src.includes('@zibby/core/utils/repo-access')]).toEqual([f, false]);
    }
  });
});
