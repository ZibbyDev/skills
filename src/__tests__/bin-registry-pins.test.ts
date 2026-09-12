/**
 * TRIPWIRE — the binary registry is a SECOND PLACE that must agree with a first.
 *
 * `packages/bin-semgrep/tool.config.mjs` is the INTENT (which upstream engine we
 * vendor); `packages/bin-semgrep/bin-versions.json` is the PUBLISH RECORD (which
 * bytes we shipped, and their sha256). A pin without an assert is a wish — so
 * this test fails loudly the moment the two drift, which is the exact shape of
 * "bump the engine, forget to re-publish, ship a declaration nothing answers to".
 *
 * The OTHER half of the assert — "the pinned sha matches the artifact the CDN
 * actually serves" — needs the network and lives in the publisher:
 *     node packages/scripts/publish-bin-artifact.mjs \
 *       --config packages/bin-semgrep/tool.config.mjs --verify-only
 * It runs automatically at publish time (the publisher records a pin ONLY after
 * re-hashing the live CDN object) and can be re-run at any time. This test asserts
 * that command exists and is wired, so the network half cannot be quietly dropped.
 */
import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const BIN_SEMGREP = dirname(require_.resolve('@zibby/bin-semgrep/package.json'));
const registry = JSON.parse(readFileSync(join(BIN_SEMGREP, 'bin-versions.json'), 'utf8'));
const toolConfig = (await import(/* @vite-ignore */ join(BIN_SEMGREP, 'tool.config.mjs'))).default;
const pkg = JSON.parse(readFileSync(join(BIN_SEMGREP, 'package.json'), 'utf8'));
const entry = registry[toolConfig.tool];

describe('bin-versions.json agrees with tool.config.mjs', () => {
  test('the registry declares the tool the vendor config vendors', () => {
    expect(entry, `bin-versions.json has no '${toolConfig.tool}' entry`).toBeTruthy();
  });

  test('version + binName match the vendor config exactly', () => {
    expect(entry.version).toBe(toolConfig.version);
    expect(entry.binName).toBe(toolConfig.binName);
  });

  test('every platform the vendor config builds has a declaration, and no extras exist', () => {
    const fromConfig = toolConfig.platforms.map((p: any) => `${p.os}-${p.cpu}`).sort();
    expect(Object.keys(entry.platforms).sort()).toEqual(fromConfig);
  });

  test('each pin is either an empty string (not published) or a real 64-hex sha256', () => {
    for (const [plat, pin] of Object.entries<any>(entry.platforms)) {
      expect(pin.sha256, `${plat}: sha256 must be '' or 64 hex chars, got ${JSON.stringify(pin.sha256)}`)
        .toMatch(/^([0-9a-f]{64})?$/);
    }
  });

  test('each tarball path follows the one artifact convention: <tool>/<version>/<platform>.tar.gz', () => {
    for (const [plat, pin] of Object.entries<any>(entry.platforms)) {
      expect(pin.tarball).toBe(`${toolConfig.tool}/${entry.version}/${plat}.tar.gz`);
    }
  });
});

describe('the engine cannot sneak back into the image', () => {
  test('@zibby/bin-semgrep declares NO dependency on a platform binary package', () => {
    // This is the whole 263 MB. `npm install -g @zibby/cli` resolves optional
    // deps too, so an optionalDependencies block here IS an image bake.
    const deps = {
      ...(pkg.dependencies || {}),
      ...(pkg.optionalDependencies || {}),
      ...(pkg.peerDependencies || {}),
    };
    expect(Object.keys(deps).filter((d) => d.startsWith('@zibby/bin-semgrep-'))).toEqual([]);
  });

  test('the registry + the fetch module ship in the npm tarball', () => {
    // A dispatcher published without bin-versions.json resolves nothing and
    // every scan fails closed — the files whitelist is load-bearing.
    expect(pkg.files).toContain('bin-versions.json');
    expect(pkg.files).toContain('src');
    expect(existsSync(join(BIN_SEMGREP, 'src', 'fetch-binary.js'))).toBe(true);
  });
});

describe('the network half of the assert is wired', () => {
  test('the publisher exposes --verify-only and the package scripts expose it', () => {
    const publisher = join(BIN_SEMGREP, '..', 'scripts', 'publish-bin-artifact.mjs');
    expect(existsSync(publisher)).toBe(true);
    expect(readFileSync(publisher, 'utf8')).toContain("--verify-only");
    expect(pkg.scripts['artifact:verify']).toContain('--verify-only');
  });

  test('the publisher records a pin only AFTER verifying the live CDN', () => {
    const src = readFileSync(join(BIN_SEMGREP, '..', 'scripts', 'publish-bin-artifact.mjs'), 'utf8');
    const verifyAt = src.indexOf('verifying from live CDN');
    const recordAt = src.indexOf('recordPin(config, p)');
    expect(verifyAt).toBeGreaterThan(-1);
    expect(recordAt).toBeGreaterThan(verifyAt);
  });
});
