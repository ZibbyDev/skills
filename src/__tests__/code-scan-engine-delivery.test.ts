/**
 * A DOWNLOAD failure must not look like a best-effort skip.
 *
 * `code-scan` is deliberately best-effort: a stack with no linter is skipped with
 * a note and the rest still run. Before this change a broken engine delivery took
 * that SAME path — it returned the bare name `semgrep-core`, spawn raised ENOENT,
 * and the result said "binary not installed", indistinguishable from "we never
 * had one". A code review would have lost every Java/Python/Go/Ruby/PHP finding
 * and reported a clean scan. These tests are the guard on that.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let repo: string;
/** A tiny Python repo — enough for the semgrep scanner's detect() to fire. */
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'code-scan-repo-'));
  writeFileSync(join(repo, 'app.py'), 'import subprocess\nsubprocess.run("ls", shell=True)\n');
});
afterEach(() => { rmSync(repo, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.resetModules(); });

async function scan() {
  const { codeScanSkill } = await import('../code-scan.js');
  return JSON.parse(await codeScanSkill.handleToolCall('scan_code', { dir: repo }));
}

test('a DELIVERY failure is named distinctly and lifted to a top-level `degraded` array', async () => {
  // Point the registry's URL at something that cannot be fetched: the engine was
  // expected to be there, and its delivery broke.
  vi.stubEnv('SEMGREP_BIN_SHA256', 'a'.repeat(64));
  vi.stubEnv('SEMGREP_BIN_URL', `file://${join(tmpdir(), 'no-such-artifact-zzz.tar.gz')}`);
  vi.stubEnv('BIN_CACHE_DIR', mkdtempSync(join(tmpdir(), 'bin-cache-')));

  const out = await scan();
  const semgrep = out.scanners.find((s: any) => s.scanner === 'semgrep');

  expect(semgrep.unavailable).toBe('semgrep unavailable: download failed');
  expect(semgrep.reason).toBe('download-failed');
  expect(semgrep.skipped).toBeUndefined();              // NOT the best-effort path
  expect(semgrep.findings).toBeUndefined();             // and NOT a clean result
  expect(out.degraded).toHaveLength(1);
  expect(out.degraded[0]).toContain('semgrep unavailable: download failed');
  expect(out.degraded[0]).toMatch(/NOT statically analysed/);
});

test('a sha256 MISMATCH is reported as its own reason, never as a missing binary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-'));
  writeFileSync(join(dir, 'semgrep-core'), '#!/bin/sh\nexit 0\n');
  mkdirSync(join(dir, 'libs'));
  writeFileSync(join(dir, 'libs', 'x'), 'x');
  const tar = join(dir, 'a.tar.gz');
  execFileSync('tar', ['czf', tar, '-C', dir, 'semgrep-core', 'libs']);

  vi.stubEnv('SEMGREP_BIN_SHA256', 'b'.repeat(64));     // a pin no artifact answers to
  vi.stubEnv('SEMGREP_BIN_URL', `file://${tar}`);
  vi.stubEnv('BIN_CACHE_DIR', mkdtempSync(join(tmpdir(), 'bin-cache-')));

  const out = await scan();
  const semgrep = out.scanners.find((s: any) => s.scanner === 'semgrep');
  expect(semgrep.reason).toBe('sha256-mismatch');
  expect(semgrep.unavailable).toBe('semgrep unavailable: sha256-mismatch');
  expect(out.degraded).toHaveLength(1);
  rmSync(dir, { recursive: true, force: true });
});

test('SEMGREP_CORE_BIN still short-circuits the whole delivery chain', async () => {
  // The documented escape hatch for an air-gapped box / a local build. It must
  // keep working, and it must NOT reach the network.
  const bin = join(mkdtempSync(join(tmpdir(), 'local-bin-')), 'semgrep-core');
  writeFileSync(bin, '#!/bin/sh\necho \'{"results":[],"errors":[]}\'\n');
  chmodSync(bin, 0o755);
  vi.stubEnv('SEMGREP_CORE_BIN', bin);
  vi.stubEnv('SEMGREP_BIN_URL', 'https://127.0.0.1:1/never-reached.tar.gz');

  const out = await scan();
  const semgrep = out.scanners.find((s: any) => s.scanner === 'semgrep');
  expect(semgrep.unavailable).toBeUndefined();
  expect(semgrep.findings).toEqual([]);
  expect(out.degraded).toBeUndefined();
});

test('an engine that was never going to be here stays a plain SKIP, not a degradation', async () => {
  // An unpinned platform is "not published", not "the download broke" — folding
  // the two together would cry wolf on every box the tool does not support.
  vi.stubEnv('SEMGREP_BIN_SHA256', '');
  vi.stubEnv('BIN_CACHE_DIR', mkdtempSync(join(tmpdir(), 'bin-cache-')));
  const out = await scan();
  const semgrep = out.scanners.find((s: any) => s.scanner === 'semgrep');
  expect(semgrep.unavailable).toBeUndefined();
  expect(semgrep.skipped).toMatch(/not-published/);
  expect(out.degraded).toBeUndefined();
});
