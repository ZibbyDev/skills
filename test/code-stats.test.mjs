import { test } from 'vitest'; // was node:test — broken since the TS migration (../src/*.js no longer exists); vitest transforms the .ts import
import assert from 'node:assert/strict';
import {
  sizeBucket, fileExtension, extKind, commitFacts, globToRegExp, globHit, percentileRank, codeStatsSkill,
} from '../src/codeStats';

test('sizeBucket — fixed deterministic thresholds', () => {
  assert.equal(sizeBucket(2, 1), 'trivial');   // 3
  assert.equal(sizeBucket(20, 5), 'small');     // 25
  assert.equal(sizeBucket(100, 40), 'medium');  // 140
  assert.equal(sizeBucket(300, 200), 'large');  // 500
  assert.equal(sizeBucket(1000, 0), 'huge');
  assert.equal(sizeBucket(0, 0), 'trivial');
});

test('fileExtension — compound test/spec + dotless build files', () => {
  assert.equal(fileExtension('src/a.ts'), '.ts');
  assert.equal(fileExtension('src/a.test.ts'), '.test');
  assert.equal(fileExtension('x.spec.js'), '.spec');
  assert.equal(fileExtension('README.md'), '.md');
  assert.equal(fileExtension('Dockerfile'), 'dockerfile');
  assert.equal(fileExtension('LICENSE'), '');
  assert.equal(fileExtension('.gitignore'), ''); // leading-dot dotfile → no ext
});

test('extKind — work-kind classification', () => {
  assert.equal(extKind('.ts'), 'code');
  assert.equal(extKind('.test'), 'test');
  assert.equal(extKind('.md'), 'docs');
  assert.equal(extKind('.yml'), 'config');
  assert.equal(extKind('dockerfile'), 'config');
  assert.equal(extKind('.css'), 'style');
  assert.equal(extKind('.sql'), 'data');
  assert.equal(extKind('.xyz'), 'other');
});

test('commitFacts — deterministic aggregation, same input same output', () => {
  const files = [
    { path: 'src/payment/charge.ts', additions: 40, deletions: 5 },
    { path: 'src/payment/charge.test.ts', additions: 60, deletions: 0 },
    { path: 'README.md', additions: 2, deletions: 1 },
    { path: 'config/app.yml', additions: 1, deletions: 0 },
  ];
  const a = commitFacts(files);
  const b = commitFacts(files);
  assert.deepEqual(a, b); // reproducible
  assert.equal(a.filesChanged, 4);
  assert.equal(a.additions, 103);
  assert.equal(a.deletions, 6);
  assert.equal(a.sizeBucket, 'medium'); // 109
  assert.equal(a.kindCounts.code, 1);
  assert.equal(a.kindCounts.test, 1);
  assert.equal(a.kindCounts.docs, 1);
  assert.equal(a.kindCounts.config, 1);
  assert.equal(a.largestFile, 'src/payment/charge.test.ts'); // 60 changed
  assert.deepEqual(a.dirs, ['(root)', 'config', 'src']); // README.md has no slash → (root)
  assert.equal(a.filePaths.length, 4);
});

test('commitFacts — tolerates alt field names + empty', () => {
  const a = commitFacts([{ newPath: 'a.go', add: 3, del: 1 }]);
  assert.equal(a.filesChanged, 1);
  assert.equal(a.kindCounts.code, 1);
  assert.deepEqual(commitFacts([]).kindCounts, { code: 0, test: 0, docs: 0, config: 0, style: 0, data: 0, other: 0 });
  assert.equal(commitFacts(null).filesChanged, 0);
});

test('globToRegExp + globHit — ** any depth, * one segment', () => {
  assert.ok(globToRegExp('src/payment/**').test('src/payment/a/b/c.ts'));
  assert.ok(globToRegExp('src/payment/**').test('src/payment/charge.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts')); // * doesn't cross /
  assert.ok(globToRegExp('src/*.ts').test('src/a.ts'));

  const paths = ['src/payment/charge.ts', 'src/ui/button.tsx', 'auth/login.ts', 'README.md'];
  const h = globHit(paths, ['src/payment/**', 'auth/**']);
  assert.equal(h.total, 4);
  assert.equal(h.hits, 2);
  assert.equal(h.ratio, 0.5);
  assert.deepEqual(h.matched, ['src/payment/charge.ts', 'auth/login.ts']);
  assert.equal(globHit(paths, []).hits, 0); // no globs → no hits
});

test('percentileRank — cumulative at-or-below, reproducible', () => {
  const cohort = [10, 20, 30, 40, 50];
  assert.equal(percentileRank(cohort, 30), 60); // 3 of 5 ≤ 30
  assert.equal(percentileRank(cohort, 50), 100);
  assert.equal(percentileRank(cohort, 5), 0);
  assert.equal(percentileRank([], 5), null); // empty cohort → null, never a lie
  assert.equal(percentileRank(cohort, NaN), null);
});

test('skill handleToolCall — routes to pure fns, unknown tool errors', async () => {
  const facts = JSON.parse(await codeStatsSkill.handleToolCall('code_stats_commit_facts', {
    files: [{ path: 'a.ts', additions: 3, deletions: 0 }],
  }));
  assert.equal(facts.sizeBucket, 'trivial');
  const hit = JSON.parse(await codeStatsSkill.handleToolCall('code_stats_glob_hit', {
    paths: ['core/x.ts', 'ui/y.ts'], globs: ['core/**'],
  }));
  assert.equal(hit.hits, 1);
  const pct = JSON.parse(await codeStatsSkill.handleToolCall('code_stats_percentile', { values: [1, 2, 3], value: 2 }));
  assert.equal(pct.percentile, 66.7);
  const err = JSON.parse(await codeStatsSkill.handleToolCall('nope', {}));
  assert.ok(err.error);
});

test('skill shape — pure resolve (no env), 3 tools', () => {
  assert.equal(codeStatsSkill.id, 'code-stats');
  const r = codeStatsSkill.resolve();
  assert.deepEqual(r.env, {}); // pure: forwards NO env
  assert.equal(codeStatsSkill.tools.length, 3);
});
