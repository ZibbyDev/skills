import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { codeScanSkill, SCANNERS, parseOxlint, parseSemgrep, buildSemgrepTargets } from '../src/code-scan.js';

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
    // oxlint + semgrep (wired), ruff + staticcheck (scaffold). Adding a tool = one entry.
    expect(SCANNERS.map((s) => s.id)).toEqual(['oxlint', 'semgrep', 'ruff', 'staticcheck']);
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
    // No repo oxlint config → apply Zibby's curated ruleset via --config.
    const a = ox.args(['a.ts'], { baseDir: '/no/such/repo/without/oxlint/config' });
    expect(a[0]).toBe('--format');
    expect(a[1]).toBe('json');
    expect(a).toContain('--config');
    expect(a[a.length - 1]).toBe('a.ts');
  });

  it('oxlint RESPECTS the repo\'s own oxlint config (no --config injected)', () => {
    const ox = SCANNERS.find((s) => s.id === 'oxlint');
    const dir = mkdtempSync(join(tmpdir(), 'oxown-'));
    try {
      writeFileSync(join(dir, '.oxlintrc.json'), '{}');
      const a = ox.args(['a.ts'], { baseDir: dir });
      expect(a).not.toContain('--config'); // repo owns its rules → we don't override
      expect(a).toEqual(['--format', 'json', 'a.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

// ── Semgrep (multi-language, OSS engine) ────────────────────────────────────────
// A fake `semgrep-core` that prints the EXACT bytes real semgrep-core 1.169.0 emits
// for `-json`: progress DOTS (".\n") then the JSON object. This is a trimmed capture
// of a REAL run (Java + Python fixtures) — enough to exercise detection + parsing
// without the ~250MB engine. The real engine + curated rules were verified manually
// (see the commit notes); the founder runs the actual binary vendoring.
const REAL_SEMGREP_JSON = JSON.stringify({
  version: '1.169.0',
  results: [
    {
      check_id: 'zibby-java-command-injection', path: 'src/Bad.java',
      start: { line: 3, col: 5, offset: 53 }, end: { line: 3, col: 33, offset: 81 },
      extra: { metavars: {}, engine_kind: 'OSS', is_ignored: false, message: 'Command execution (Runtime.exec / ProcessBuilder) — command injection risk.', validation_state: 'NO_VALIDATOR' },
    },
    {
      check_id: 'zibby-python-subprocess-shell', path: 'src/bad.py',
      start: { line: 2, col: 1, offset: 10 }, end: { line: 2, col: 34, offset: 43 },
      extra: { metavars: {}, engine_kind: 'OSS', is_ignored: false, message: 'subprocess call with shell=True — command injection risk.', validation_state: 'NO_VALIDATOR' },
    },
  ],
  errors: [], paths: { scanned: ['src/Bad.java', 'src/bad.py'] },
});
const FAKE_SEMGREP_CORE = `#!/bin/sh
printf '.\\n.\\n.\\n'
cat <<'JSON'
${REAL_SEMGREP_JSON}
JSON
`;

describe('parseSemgrep — real `semgrep-core -json` shape (leading progress dots)', () => {
  it('skips the leading dots and extracts file / line / rule / message', () => {
    const findings = parseSemgrep(`.\n.\n${REAL_SEMGREP_JSON}`);
    expect(findings).toHaveLength(2);
    // severity is recovered from OUR curated rule by check_id (semgrep-core omits it
    // per-result); the java command-injection rule is ERROR.
    expect(findings[0]).toEqual({
      file: 'src/Bad.java', line: 3, severity: 'error',
      rule: 'zibby-java-command-injection',
      message: 'Command execution (Runtime.exec / ProcessBuilder) — command injection risk.',
    });
    expect(findings[1].file).toBe('src/bad.py');
    expect(findings[1].rule).toBe('zibby-python-subprocess-shell');
  });

  it('maps an explicit extra.severity (ERROR→error), defaults to warning otherwise', () => {
    const withSev = parseSemgrep(JSON.stringify({
      results: [{ check_id: 'r', path: 'a.go', start: { line: 1 }, extra: { severity: 'ERROR', message: 'x' } }],
    }));
    expect(withSev[0].severity).toBe('error');
    const noSev = parseSemgrep(JSON.stringify({ results: [{ check_id: 'r', path: 'a.go', start: { line: 1 }, extra: { message: 'x' } }] }));
    expect(noSev[0].severity).toBe('warning');
  });

  it('returns [] on empty / unparseable / no-object output (best-effort)', () => {
    expect(parseSemgrep('')).toEqual([]);
    expect(parseSemgrep('.\n.\n')).toEqual([]); // dots but no JSON
    expect(parseSemgrep('not json')).toEqual([]);
    expect(parseSemgrep(JSON.stringify({ results: [] }))).toEqual([]);
  });
});

describe('buildSemgrepTargets — semgrep-core -targets ATD wire format', () => {
  it('emits ["Targets",[["CodeTarget",{path,analyzer,products}]]] per mapped file, JS/TS excluded', () => {
    const doc = buildSemgrepTargets(['src/Bad.java', 'app/svc.go', 'x/y.rb', 'ui/a.tsx', 'i.js']);
    expect(doc[0]).toBe('Targets');
    // .tsx/.js are NOT semgrep languages here (oxlint owns them) → dropped.
    expect(doc[1]).toHaveLength(3);
    const [cons, target] = doc[1][0];
    expect(cons).toBe('CodeTarget');
    expect(target).toEqual({
      path: { fpath: 'src/Bad.java', ppath: '/src/Bad.java' },
      analyzer: 'java', products: ['sast'],
    });
    expect(doc[1].map((t) => t[1].analyzer)).toEqual(['java', 'go', 'ruby']);
  });

  it('is defensive: non-array / garbage input yields an empty target list', () => {
    expect(buildSemgrepTargets(undefined)).toEqual(['Targets', []]);
    expect(buildSemgrepTargets(['', 42, null, 'no-ext'])).toEqual(['Targets', []]);
  });
});

describe('scan_code — semgrep detection + run + parse (fake semgrep-core)', () => {
  let sgrepo;
  beforeEach(() => {
    sgrepo = mkdtempSync(join(tmpdir(), 'zibby-sg-'));
    mkdirSync(join(sgrepo, 'src'), { recursive: true });
    writeFileSync(join(sgrepo, 'src', 'Bad.java'), 'public class Bad {}\n', 'utf8');
    writeFileSync(join(sgrepo, 'src', 'bad.py'), 'import os\n', 'utf8');
    writeFileSync(join(sgrepo, 'README.md'), '# docs\n', 'utf8'); // not a semgrep language
  });
  afterEach(() => { rmSync(sgrepo, { recursive: true, force: true }); delete process.env.SEMGREP_CORE_BIN; });

  it('detects a Java/Python repo, runs semgrep, returns parsed multi-language findings', async () => {
    process.env.SEMGREP_CORE_BIN = writeFakeBin(sgrepo, 'fake-semgrep-core.sh', FAKE_SEMGREP_CORE);
    const out = JSON.parse(await codeScanSkill.handleToolCall('scan_code', { dir: sgrepo }));
    expect(out.ok).toBe(true);
    const sg = out.scanners.find((s) => s.scanner === 'semgrep');
    expect(sg).toBeTruthy();
    expect(sg.filesScanned).toBe(2); // Bad.java + bad.py; README.md filtered by langs
    expect(sg.findings).toHaveLength(2);
    expect(sg.findings[0].rule).toBe('zibby-java-command-injection');
    // oxlint is NOT detected (no package.json) → semgrep is the only scanner here.
    expect(out.scanners.map((s) => s.scanner)).toEqual(['semgrep']);
  });

  it('scopes an explicit `files` list to semgrep languages (drops non-source files)', async () => {
    process.env.SEMGREP_CORE_BIN = writeFakeBin(sgrepo, 'fake-semgrep-core.sh', FAKE_SEMGREP_CORE);
    const out = JSON.parse(await codeScanSkill.handleToolCall('scan_code', {
      dir: sgrepo, files: ['src/Bad.java', 'README.md'],
    }));
    const sg = out.scanners.find((s) => s.scanner === 'semgrep');
    expect(sg.filesScanned).toBe(1); // README.md dropped
  });

  it('gracefully SKIPS semgrep when the engine binary is missing (ENOENT), never throws', async () => {
    process.env.SEMGREP_CORE_BIN = join(sgrepo, 'no-such-semgrep-core');
    const out = JSON.parse(await codeScanSkill.handleToolCall('scan_code', { dir: sgrepo }));
    expect(out.ok).toBe(true);
    const sg = out.scanners.find((s) => s.scanner === 'semgrep');
    expect(sg.skipped).toMatch(/binary not installed/);
    expect(sg.findings).toBeUndefined();
  });
});
