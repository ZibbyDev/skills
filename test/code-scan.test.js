import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { codeScanSkill, SCANNERS, parseOxlint } from '../src/code-scan.js';

// code-scan is the AGENT-DRIVEN, stack-smart deterministic linter skill. It
// auto-detects the repo stack via the SCANNERS registry and runs the matching
// tool. These tests use a FAKE oxlint (a shell script emitting canned oxlint
// JSON) so nothing real needs installing, and assert: the tool shape, stack
// detection (package.json → oxlint), language-scoped file selection, graceful
// skip when the binary is absent (ENOENT), and the oxlint JSON parser.

let repo;

// A fake `oxlint` that prints the exact `oxlint --format json` shape (oxlint
// 1.73.0), regardless of args — enough to exercise detection + parsing.
const FAKE_OXLINT = `#!/bin/sh
cat <<'JSON'
{ "diagnostics": [
  {"message":"'x' is assigned a value but never used.","code":"eslint(no-unused-vars)","severity":"warning","filename":"src/a.ts","labels":[{"span":{"offset":9,"length":1,"line":2,"column":7}}]},
  {"message":"Unexpected debugger statement.","code":"eslint(no-debugger)","severity":"error","filename":"src/a.ts","labels":[{"span":{"offset":40,"length":8,"line":4,"column":3}}]}
], "number_of_files": 1 }
JSON
`;

function writeFakeBin(dir, name, script) {
  const p = join(dir, name);
  writeFileSync(p, script, 'utf8');
  chmodSync(p, 0o755);
  return p;
}

describe('code-scan skill — shape + registry', () => {
  it('exposes exactly the scan_code tool with the documented input schema', () => {
    expect(codeScanSkill.id).toBe('code-scan');
    expect(codeScanSkill.serverName).toBe('code_scan');
    expect(codeScanSkill.tools.map((t) => t.name)).toEqual(['scan_code']);
    const schema = codeScanSkill.tools[0].input_schema;
    expect(schema.properties).toHaveProperty('dir');
    expect(schema.properties).toHaveProperty('files');
  });

  it('the SCANNERS registry is the single extension point (one entry per tool)', () => {
    // oxlint (baked), ruff + staticcheck (scaffold). Adding a tool = one entry.
    expect(SCANNERS.map((s) => s.id)).toEqual(['oxlint', 'ruff', 'staticcheck']);
    for (const s of SCANNERS) {
      expect(typeof s.detect).toBe('function');
      expect(Array.isArray(s.langs)).toBe(true);
      expect(typeof s.bin).toBe('function');
      expect(typeof s.args).toBe('function');
      expect(typeof s.parse).toBe('function');
    }
    // The oxlint entry detects a JS/TS repo and covers the JS/TS extensions.
    const ox = SCANNERS.find((s) => s.id === 'oxlint');
    expect(ox.langs).toContain('.ts');
    expect(ox.args(['a.ts'])).toEqual(['--format', 'json', 'a.ts']);
  });
});

describe('scan_code — detection + run + parse (fake oxlint)', () => {
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'zibby-codescan-'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.ts'), 'const x = 1;\ndebugger;\n', 'utf8');
    writeFileSync(join(repo, 'src', 'notes.md'), '# docs\n', 'utf8'); // not a JS/TS file
    writeFileSync(join(repo, 'package.json'), '{"name":"demo"}', 'utf8'); // → oxlint detected
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); delete process.env.OXLINT_BIN; });

  it('detects the JS/TS stack via package.json, runs oxlint, and returns parsed findings', async () => {
    process.env.OXLINT_BIN = writeFakeBin(repo, 'fake-oxlint.sh', FAKE_OXLINT);
    const out = JSON.parse(await codeScanSkill.handleToolCall('scan_code', { dir: repo }));
    expect(out.ok).toBe(true);
    const ox = out.scanners.find((s) => s.scanner === 'oxlint');
    expect(ox).toBeTruthy();
    // Only the .ts file is in scope (the .md is filtered out by langs).
    expect(ox.filesScanned).toBe(1);
    expect(ox.findings).toHaveLength(2);
    expect(ox.findings[0]).toEqual({
      file: 'src/a.ts', line: 2, severity: 'warning', rule: 'eslint(no-unused-vars)',
      message: "'x' is assigned a value but never used.",
    });
    expect(out.totalFindings).toBe(2);
    // ruff/staticcheck don't detect (no pyproject/go.mod) → not in the results.
    expect(out.scanners.map((s) => s.scanner)).toEqual(['oxlint']);
  });

  it('accepts an explicit `files` list, scoped to the scanner languages', async () => {
    process.env.OXLINT_BIN = writeFakeBin(repo, 'fake-oxlint.sh', FAKE_OXLINT);
    const out = JSON.parse(await codeScanSkill.handleToolCall('scan_code', {
      dir: repo, files: ['src/a.ts', 'src/notes.md'],
    }));
    const ox = out.scanners.find((s) => s.scanner === 'oxlint');
    expect(ox.filesScanned).toBe(1); // notes.md dropped (not a JS/TS extension)
  });

  it('gracefully SKIPS a scanner whose binary is missing (ENOENT), never throws', async () => {
    process.env.OXLINT_BIN = join(repo, 'no-such-oxlint-binary');
    const out = JSON.parse(await codeScanSkill.handleToolCall('scan_code', { dir: repo }));
    expect(out.ok).toBe(true);
    const ox = out.scanners.find((s) => s.scanner === 'oxlint');
    expect(ox.skipped).toMatch(/binary not installed/);
    expect(ox.findings).toBeUndefined();
  });

  it('returns a clean note when no known stack is detected', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'zibby-bare-'));
    try {
      const out = JSON.parse(await codeScanSkill.handleToolCall('scan_code', { dir: bare }));
      expect(out.ok).toBe(true);
      expect(out.scanners).toEqual([]);
      expect(out.note).toMatch(/No known stack/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('rejects an unknown tool name', async () => {
    const out = JSON.parse(await codeScanSkill.handleToolCall('nope', {}));
    expect(out.error).toMatch(/Unknown tool/);
  });
});

describe('parseOxlint — real `oxlint --format json` shape', () => {
  it('extracts file / line / severity / rule / message per diagnostic', () => {
    const findings = parseOxlint(JSON.stringify({
      diagnostics: [{
        message: 'Expected a conditional expression and instead saw an assignment',
        code: 'eslint(no-cond-assign)', severity: 'warning', filename: 'bad.js',
        labels: [{ span: { offset: 38, length: 1, line: 3, column: 9 } }],
      }],
    }));
    expect(findings).toEqual([{
      file: 'bad.js', line: 3, severity: 'warning', rule: 'eslint(no-cond-assign)',
      message: 'Expected a conditional expression and instead saw an assignment',
    }]);
  });

  it('returns [] on empty / unparseable output (best-effort)', () => {
    expect(parseOxlint('')).toEqual([]);
    expect(parseOxlint('not json')).toEqual([]);
    expect(parseOxlint(JSON.stringify({ diagnostics: [] }))).toEqual([]);
  });
});
