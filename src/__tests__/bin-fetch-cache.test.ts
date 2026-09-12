/**
 * The on-demand binary delivery chain, end to end, offline.
 *
 * These are the tests that would FAIL without the stage-1 change (design doc
 * 2026-09-11): fetch → sha256 verify (fail closed) → atomic unpack → cache hit,
 * plus the two things that actually bite in production — a MISMATCHED artifact
 * and two runs racing the same cache entry.
 *
 * Everything runs against a `file://` artifact built in a temp dir, so the chain
 * is proven without the real S3 object existing. That is deliberate: the
 * mechanism must be testable before the artifact is published, or the first
 * proof it works would be a production run.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BinaryUnavailableError, ensureBinary, resolveDelivery, artifactPath } from '@zibby/bin-semgrep/fetch-binary';

let work: string;

/**
 * Build an artifact shaped EXACTLY like a real one: the binary at the tarball
 * ROOT with its sibling `libs/` next to it — the layout semgrep-core's
 * $ORIGIN/libs rpath requires. A tarball that unpacked to a wrapper directory
 * would verify fine and then fail to load, so the layout is part of the contract.
 */
function makeArtifact(name = 'tool', body = '#!/bin/sh\necho fake-engine 1.169.0\n') {
  const src = mkdtempSync(join(work, 'src-'));
  writeFileSync(join(src, name), body);
  chmodSync(join(src, name), 0o755);
  mkdirSync(join(src, 'libs'));
  writeFileSync(join(src, 'libs', 'libfake.so'), 'not-really-a-library');
  const tar = join(work, `${name}-${Math.random().toString(36).slice(2)}.tar.gz`);
  execFileSync('tar', ['czf', tar, '-C', src, name, 'libs'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const sha256 = createHash('sha256').update(readFileSync(tar)).digest('hex');
  return { tar, sha256, url: pathToFileURL(tar).href };
}

function registryFor(sha256: string, url: string) {
  return {
    tool: {
      version: '1.169.0',
      binName: 'tool',
      platforms: { 'test-plat': { sha256, tarball: artifactPath('tool', '1.169.0', 'test-plat'), bytes: 1 } },
    },
  };
}

beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'bin-fetch-test-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); delete process.env.TOOL_BIN_URL; });

describe('fetch → verify → unpack → cache', () => {
  test('a correctly pinned artifact is fetched, verified, unpacked with its sibling libs, and re-served from cache', async () => {
    const a = makeArtifact();
    process.env.TOOL_BIN_URL = a.url;
    const d = resolveDelivery(registryFor(a.sha256, a.url), 'tool', 'test-plat')!;
    expect(d.sha256).toBe(a.sha256);

    const root = join(work, 'cache');
    const phases: string[] = [];
    const p1 = await ensureBinary(d, { root, onEvent: (e: any) => phases.push(e.phase) });

    expect(existsSync(p1)).toBe(true);
    expect(readFileSync(p1, 'utf8')).toContain('fake-engine');
    // The rpath sibling MUST land next to the binary, not under a wrapper dir.
    expect(existsSync(join(p1, '..', 'libs', 'libfake.so'))).toBe(true);
    expect(phases).toEqual(['downloading', 'verifying', 'unpacking', 'ready']);
    // The sha is in the cache path, so a re-pin can never be served from a warm
    // cache entry built from the old bytes.
    expect(p1).toContain(a.sha256.slice(0, 12));

    // Second call = pure cache hit: no download phase at all.
    const phases2: string[] = [];
    const p2 = await ensureBinary(d, { root, onEvent: (e: any) => phases2.push(e.phase) });
    expect(p2).toBe(p1);
    expect(phases2).toEqual([]);
  });

  test('the unpacked binary is executable — the chain delivers something that RUNS, not just files', async () => {
    const a = makeArtifact();
    const d = resolveDelivery(registryFor(a.sha256, a.url), 'tool', 'test-plat')!;
    d.url = a.url;
    const p = await ensureBinary(d, { root: join(work, 'cache') });
    expect(execFileSync(p, { encoding: 'utf8' }).trim()).toBe('fake-engine 1.169.0');
  });
});

describe('fail closed', () => {
  test('a sha256 MISMATCH is rejected and NOTHING is left in the cache', async () => {
    const a = makeArtifact();
    const wrong = 'f'.repeat(64);
    const d = resolveDelivery(registryFor(wrong, a.url), 'tool', 'test-plat')!;
    d.url = a.url;
    const root = join(work, 'cache');

    await expect(ensureBinary(d, { root })).rejects.toThrow(/sha256 MISMATCH/);
    const err = await ensureBinary(d, { root }).catch((e) => e);
    expect(err).toBeInstanceOf(BinaryUnavailableError);
    expect(err.reason).toBe('sha256-mismatch');
    expect(err.isDeliveryFailure).toBe(true);
    // No cache entry, no staging dir, no partial download left behind.
    const leftovers = existsSync(join(root, 'tool', '1.169.0')) ? readdirSync(join(root, 'tool', '1.169.0')) : [];
    expect(leftovers).toEqual([]);
    expect(existsSync(join(root, '.tmp')) ? readdirSync(join(root, '.tmp')) : []).toEqual([]);
  });

  test('an EMPTY pin means NOT PUBLISHED — refuse loudly, never download unverified bytes', async () => {
    const a = makeArtifact();
    const d = resolveDelivery(registryFor('', a.url), 'tool', 'test-plat')!;
    d.url = a.url;
    const err = await ensureBinary(d, { root: join(work, 'cache') }).catch((e) => e);
    expect(err.reason).toBe('not-published');
    expect(err.message).toMatch(/has not been published yet/);
    // NOT a delivery failure — it never promised to be there in the first place.
    expect(err.isDeliveryFailure).toBe(false);
  });

  test('a truncated/garbage artifact fails on the sha, before anything is unpacked', async () => {
    const a = makeArtifact();
    const broken = join(work, 'broken.tar.gz');
    writeFileSync(broken, readFileSync(a.tar).subarray(0, 64));
    const d = resolveDelivery(registryFor(a.sha256, a.url), 'tool', 'test-plat')!;
    d.url = pathToFileURL(broken).href;
    const err = await ensureBinary(d, { root: join(work, 'cache') }).catch((e) => e);
    expect(err.reason).toBe('sha256-mismatch');
  });

  test('an unreachable artifact is a DELIVERY failure, distinct from "no artifact declared"', async () => {
    const a = makeArtifact();
    const d = resolveDelivery(registryFor(a.sha256, a.url), 'tool', 'test-plat')!;
    d.url = pathToFileURL(join(work, 'does-not-exist.tar.gz')).href;
    const err = await ensureBinary(d, { root: join(work, 'cache') }).catch((e) => e);
    expect(err.reason).toBe('download-failed');
    expect(err.isDeliveryFailure).toBe(true);

    const none = await ensureBinary(null as any, { root: join(work, 'cache') }).catch((e) => e);
    expect(none.reason).toBe('unsupported-platform');
    expect(none.isDeliveryFailure).toBe(false);
  });

  test('an archive that does not carry the declared binary is an unpack failure, not a silent success', async () => {
    const a = makeArtifact('something-else');
    const d = resolveDelivery(registryFor(a.sha256, a.url), 'tool', 'test-plat')!;
    d.url = a.url;
    const err = await ensureBinary(d, { root: join(work, 'cache') }).catch((e) => e);
    expect(err.reason).toBe('unpack-failed');
    expect(err.message).toMatch(/does not contain 'tool'/);
  });
});

describe('concurrency + partial state', () => {
  test('N callers racing the same entry all get the same path and the artifact is fetched ONCE', async () => {
    const a = makeArtifact();
    const d = resolveDelivery(registryFor(a.sha256, a.url), 'tool', 'test-plat')!;
    d.url = a.url;
    const root = join(work, 'cache');
    let downloads = 0;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => ensureBinary(d, {
        root,
        onEvent: (e: any) => { if (e.phase === 'downloading') downloads++; },
      })),
    );
    expect(new Set(results).size).toBe(1);
    expect(existsSync(results[0])).toBe(true);
    expect(downloads).toBe(1);
  });

  test('a stale lock from a killed process is reclaimed instead of wedging the box', async () => {
    const a = makeArtifact();
    const d = resolveDelivery(registryFor(a.sha256, a.url), 'tool', 'test-plat')!;
    d.url = a.url;
    const root = join(work, 'cache');
    const dest = join(root, 'tool', '1.169.0', `test-plat-${a.sha256.slice(0, 12)}`);
    mkdirSync(`${dest}.lock`, { recursive: true });   // a previous run died holding it
    process.env.BIN_LOCK_STALE_MS = '0';              // it is, by definition, stale
    process.env.BIN_LOCK_WAIT_MS = '2000';            // if reclaim regresses, FAIL fast
    try {
      const p = await ensureBinary(d, { root });
      expect(existsSync(p)).toBe(true);
      expect(existsSync(`${dest}.lock`)).toBe(false); // and the lock is released
    } finally { delete process.env.BIN_LOCK_STALE_MS; delete process.env.BIN_LOCK_WAIT_MS; }
  });

  test('a leftover half-extracted staging dir is never mistaken for a finished cache entry', async () => {
    const a = makeArtifact();
    const d = resolveDelivery(registryFor(a.sha256, a.url), 'tool', 'test-plat')!;
    d.url = a.url;
    const root = join(work, 'cache');
    const parent = join(root, 'tool', '1.169.0');
    mkdirSync(join(parent, `test-plat-${a.sha256.slice(0, 12)}.incoming-999`), { recursive: true });
    writeFileSync(join(parent, `test-plat-${a.sha256.slice(0, 12)}.incoming-999`, 'tool'), 'HALF WRITTEN');
    const p = await ensureBinary(d, { root });
    expect(readFileSync(p, 'utf8')).toContain('fake-engine');   // the real one, not the corpse
  });
});

describe('resolveDelivery — the declaration → URL mapping', () => {
  const registry = {
    semgrep: {
      version: '1.169.0',
      binName: 'semgrep-core',
      platforms: { 'linux-arm64': { sha256: 'a'.repeat(64), tarball: 'semgrep/1.169.0/linux-arm64.tar.gz' } },
    },
  };

  test('derives the CDN URL from the pinned tarball path', () => {
    const d = resolveDelivery(registry, 'semgrep', 'linux-arm64')!;
    expect(d.url).toBe('https://dl.zibby.app/bin/semgrep/1.169.0/linux-arm64.tar.gz');
    expect(d.binName).toBe('semgrep-core');
  });

  test('a platform with no declaration resolves to null — distinct from an unpinned one', () => {
    expect(resolveDelivery(registry, 'semgrep', 'win32-x64')).toBeNull();
    expect(resolveDelivery(registry, 'nope', 'linux-arm64')).toBeNull();
  });

  test('env overrides win, and an overridden VERSION re-derives the artifact path', () => {
    process.env.SEMGREP_BIN_VERSION = '1.170.0';
    try {
      const d = resolveDelivery(registry, 'semgrep', 'linux-arm64')!;
      expect(d.tarball).toBe('semgrep/1.170.0/linux-arm64.tar.gz');
      expect(d.url).toContain('/bin/semgrep/1.170.0/linux-arm64.tar.gz');
    } finally { delete process.env.SEMGREP_BIN_VERSION; }
  });
});
