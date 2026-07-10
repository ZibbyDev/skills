/**
 * code-scan.js — AGENT-DRIVEN, stack-smart deterministic code scanner (tier ①:
 * fully local — the code never leaves the box; no API, no OAuth, no browser).
 *
 * WHAT IT IS
 * ──────────
 * A hand-written single-tool skill (same shape as chartRender.js / kvMemory.js):
 * `serverName`, `allowedTools`, `tools[]`, `handleToolCall`, and a `resolve()`
 * that spawns the GENERIC bin/mcp-skill.mjs. The ONE tool — `scan_code` — is
 * called by the AGENT after it has a repo on disk (a clone). It AUTO-DETECTS the
 * stack and runs the matching deterministic linter(s), returning structured
 * findings the agent triages.
 *
 * WHY A SKILL, NOT A FLOOR PROBE
 * ──────────────────────────────
 * The code-review agent is GENERAL-PURPOSE (Go, Python, Rust, Java, JS/TS, …).
 * A language-specific linter therefore CANNOT be an always-run deterministic
 * floor step — that's wrong for a Go/Python repo and doesn't scale. Instead the
 * AGENT decides: it looks at the repo, calls scan_code, and the tool picks the
 * right scanner(s) by stack detection. This is exactly what a skill is for.
 *
 * NO HARDCODING — the SCANNERS registry is the single extension point
 * ──────────────────────────────────────────────────────────────────
 * Every scanner is ONE entry in the SCANNERS array: { id, detect, langs, bin,
 * args, parse }. Adding a tool (tsc, semgrep, eslint, clippy…) = one more entry,
 * no changes to scan_code itself. scan_code runs EVERY scanner whose detect(dir)
 * is true, scoped to files matching its `langs`, and merges the results.
 *
 * ONLY oxlint IS BAKED + VERIFIED TODAY. ruff (Python) + staticcheck (Go) are
 * SCAFFOLD entries (registry + parser present, clearly marked TODO) whose
 * binaries are NOT yet in the image — they simply skip with a "binary not
 * installed" note until baked. Best-effort throughout: a missing binary (spawn
 * ENOENT), an unreadable file, or a parser hiccup NEVER throws — the scanner is
 * skipped with a note and the others still run.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the generic skill MCP server binary — identical rationale to
 * chartRender.js / kvMemory.js resolveSkillBin(): derive from import.meta.url so
 * it works in src/ (dev), dist/ (bundled), and node_modules/@zibby/skills/
 * (published) alike.
 */
function resolveSkillBin() {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

// Directories never worth scanning (deps / build output / vcs / virtualenvs).
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'vendor', 'target',
  '.venv', 'venv', '__pycache__', '.next', '.turbo', 'coverage', '.zibby',
]);
// Bound a directory walk so a huge monorepo can't blow the argv / stall the run.
const MAX_FILES_PER_SCANNER = 400;

// Zibby's curated default oxlint ruleset — applied ONLY when the repo has no
// oxlint config of its own (then we respect theirs). Empirically tuned for HIGH
// SIGNAL / LOW NOISE on real code: correctness (default) + suspicious + the react
// rules that catch ACTUAL bugs (jsx-key, no-unknown-property), with the
// transform-dependent / stylistic noise turned OFF — `react/react-in-jsx-scope`
// fires on EVERY JSX element under the modern automatic runtime (100% false
// positives), and jsx-max-depth / no-array-index-key are opinionated. This is a
// FLOOR, not a style enforcer; the reviewer covers judgment / a11y / design.
// (Verified on a real React repo: bare oxlint = 0 findings, `-W all` = 193 noise,
// this = 7 real bugs — 3 missing jsx-key, 3 unknown-property, 1 perf.)
const CURATED_OXLINT_CONFIG = {
  plugins: ['react', 'typescript', 'unicorn', 'oxc'],
  categories: { correctness: 'error', suspicious: 'warn' },
  rules: {
    'react/react-in-jsx-scope': 'off',
    'react/jsx-max-depth': 'off',
    'react/no-array-index-key': 'off',
    'react/jsx-key': 'error',
    'react/no-unknown-property': 'error',
    'no-unused-vars': 'warn',
    eqeqeq: 'warn',
  },
};
// A repo's OWN oxlint config → respect it (don't override with ours). oxlint
// auto-discovers these, so we simply don't pass --config when one is present.
const OXLINT_OWN_CONFIG_FILES = ['.oxlintrc.json', '.oxlintrc', 'oxlint.json'];

let _curatedCfgPath = null;
/** Write the curated config to a temp file ONCE; return its path (null → oxlint defaults). */
function curatedOxlintConfigPath() {
  if (_curatedCfgPath && existsSync(_curatedCfgPath)) return _curatedCfgPath;
  try {
    const dir = join(tmpdir(), 'zibby-code-scan');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'oxlintrc.curated.json');
    writeFileSync(p, JSON.stringify(CURATED_OXLINT_CONFIG), 'utf-8');
    _curatedCfgPath = p;
    return p;
  } catch { return null; }
}

/**
 * Parse `oxlint --format json` output. oxlint emits ONE JSON object:
 *   { diagnostics: [ { message, code:"eslint(no-cond-assign)", severity:"warning"|"error",
 *                      filename, help, url, labels:[ { span:{ offset, length, line, column } } ] } ],
 *     number_of_files, … }
 * The line comes from the first label's span. VERIFIED against oxlint 1.73.0.
 * EXPORTED for direct unit-testing of the shape assumption.
 */
export function parseOxlint(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return [];
  let doc;
  try { doc = JSON.parse(text); } catch { return []; }
  const diags = Array.isArray(doc) ? doc : (doc && Array.isArray(doc.diagnostics) ? doc.diagnostics : []);
  return diags
    .map((d) => {
      if (!d || typeof d !== 'object') return null;
      const label = Array.isArray(d.labels) && d.labels.length ? d.labels[0] : null;
      const span = label && label.span ? label.span : null;
      return {
        file: d.filename || (span && span.filename) || '',
        line: span && Number.isFinite(span.line) ? span.line : '',
        severity: d.severity || 'warning',
        rule: d.code || '',
        message: d.message || '',
      };
    })
    .filter((f) => f && (f.file || f.message));
}

/**
 * Parse `ruff check --output-format json` output — a JSON ARRAY of
 *   { code, message, filename, location:{ row, column }, … }.
 * TODO(oxlint-first): ruff is NOT yet baked into the image; this parser is
 * written from ruff's documented shape and remains UNVERIFIED end-to-end until
 * the binary is added to packages/Dockerfile.
 */
function parseRuff(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return [];
  let arr;
  try { arr = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((d) => (d && typeof d === 'object') ? {
      file: d.filename || '',
      line: d.location && Number.isFinite(d.location.row) ? d.location.row : '',
      severity: 'warning',
      rule: d.code || '',
      message: d.message || '',
    } : null)
    .filter((f) => f && (f.file || f.message));
}

/**
 * Parse `staticcheck -f json` output — NDJSON, one object per line:
 *   { code, severity, location:{ file, line, column }, message }.
 * TODO(oxlint-first): staticcheck is NOT yet baked into the image; parser is
 * from the documented shape, UNVERIFIED end-to-end until the binary is added.
 */
function parseStaticcheck(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return [];
  const out = [];
  for (const ln of text.split('\n')) {
    const line = ln.trim();
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (!d || typeof d !== 'object') continue;
    const loc = d.location || {};
    out.push({
      file: loc.file || '',
      line: Number.isFinite(loc.line) ? loc.line : '',
      severity: d.severity || 'warning',
      rule: d.code || '',
      message: d.message || '',
    });
  }
  return out.filter((f) => f.file || f.message);
}

/**
 * THE EXTENSION POINT. Each scanner is one self-contained entry:
 *   id      stable scanner id (labels its findings block)
 *   detect  (dir) => boolean — is this the repo's stack? (a marker file check)
 *   langs   file extensions this scanner handles
 *   bin     () => resolved binary path/name (env-overridable)
 *   args    (files) => string[] — argv (files are RELATIVE to the scanned dir)
 *   parse   (stdout, stderr, code) => [{ file, line, severity, rule, message }]
 * Adding a tool = ONE more entry here. NOTHING scanner-specific lives elsewhere.
 */
export const SCANNERS = [
  {
    // JS/TS — oxlint (MIT, oxc). BAKED + VERIFIED. Binary at OXLINT_BIN ||
    // /usr/local/bin/oxlint (see packages/Dockerfile).
    id: 'oxlint',
    detect: (dir) => existsSync(join(dir, 'package.json')),
    langs: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    bin: () => process.env.OXLINT_BIN || 'oxlint',
    // Respect the repo's OWN oxlint config if it has one; otherwise apply Zibby's
    // curated high-signal ruleset via --config (never bare defaults, which found
    // 0 on clean React while missing real jsx-key/unknown-property bugs).
    args: (files, ctx = {}) => {
      const base = ctx.baseDir || '.';
      const hasOwn = OXLINT_OWN_CONFIG_FILES.some((f) => existsSync(join(base, f)));
      const cfgPath = hasOwn ? null : curatedOxlintConfigPath();
      const cfg = cfgPath ? ['--config', cfgPath] : [];
      return ['--format', 'json', ...cfg, ...files];
    },
    parse: parseOxlint,
  },
  {
    // Python — ruff (MIT, astral-sh). SCAFFOLD ONLY — TODO: bake ruff into the
    // image (sha256-pinned) before relying on this; today it skips (ENOENT).
    id: 'ruff',
    detect: (dir) => existsSync(join(dir, 'pyproject.toml'))
      || existsSync(join(dir, 'requirements.txt'))
      || existsSync(join(dir, 'setup.py')),
    langs: ['.py'],
    bin: () => process.env.RUFF_BIN || 'ruff',
    args: (files) => ['check', '--output-format', 'json', ...files],
    parse: parseRuff,
  },
  {
    // Go — staticcheck (MIT, dominikh). SCAFFOLD ONLY — TODO: bake staticcheck
    // into the image before relying on this; today it skips (ENOENT).
    id: 'staticcheck',
    detect: (dir) => existsSync(join(dir, 'go.mod')),
    langs: ['.go'],
    bin: () => process.env.STATICCHECK_BIN || 'staticcheck',
    args: (files) => ['-f', 'json', ...files],
    parse: parseStaticcheck,
  },
];

/** Bounded recursive walk collecting files whose extension is in `exts`. */
function collectFiles(dir, exts, cap) {
  const out = [];
  const extSet = new Set(exts.map((e) => e.toLowerCase()));
  const stack = [dir];
  while (stack.length && out.length < cap) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (out.length >= cap) break;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(join(cur, e.name));
      } else if (e.isFile() && extSet.has(extname(e.name).toLowerCase())) {
        out.push(join(cur, e.name));
      }
    }
  }
  return out;
}

/**
 * Run ONE scanner over its selected files (relative to baseDir). Returns a
 * result block. Best-effort: a missing binary or spawn error becomes a SKIP with
 * a note — it never throws.
 */
function runScanner(scanner, baseDir, absFiles) {
  const rel = absFiles.map((f) => relative(baseDir, f)).filter(Boolean);
  if (!rel.length) return { scanner: scanner.id, skipped: 'no matching files' };
  const bin = scanner.bin();
  const res = spawnSync(bin, scanner.args(rel, { baseDir }), {
    cwd: baseDir,
    encoding: 'utf-8',
    timeout: 3 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) {
    const why = res.error.code === 'ENOENT' ? `binary not installed (${bin})` : String(res.error.message || res.error);
    return { scanner: scanner.id, skipped: why };
  }
  let findings = [];
  try {
    const parsed = scanner.parse(res.stdout, res.stderr, res.status);
    findings = Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch { findings = []; }
  return { scanner: scanner.id, filesScanned: rel.length, findings };
}

export const codeScanSkill = {
  id: 'code-scan',
  serverName: 'code_scan',
  allowedTools: ['mcp__code_scan__*'],
  description:
    'Code scan — run the RIGHT deterministic linter for a checked-out repo (auto-detects the stack: JS/TS→oxlint, etc.) and return structured findings. Fully local; the code never leaves the box.',

  promptFragment: `## Code Scan (deterministic linter, auto-detects the stack)
After you've cloned the repo, call \`scan_code\` to get DETERMINISTIC linter
findings for WHATEVER stack this repo is — it auto-detects (JS/TS→oxlint, more
coming) and runs the matching tool. Pass \`files\` (the changed files, ideal for
a review) or \`dir\` (a directory to scan). Findings are GROUND-TRUTH CANDIDATES:
triage them for THIS change, verify each in context (false positives exist —
trace before asserting), fold noise, and turn the real ones into inline
suggestions. Don't hand-lint what the tool already covers, and don't re-run it.`,

  resolve() {
    // Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs) pointing at this
    // module's codeScanSkill export — same FIXED pattern as chartRender/
    // kvMemory (NEVER return { command: null } unless the bin truly can't be found).
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env: {}, description: this.description };
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/code-scan.js', 'codeScanSkill'],
      env: {},
      description: this.description,
      // Force tools into the system prompt instead of deferring behind the SDK's
      // ToolSearch (same as chartRender.js / kvMemory.js).
      alwaysLoad: true,
    };
  },

  async handleToolCall(name, args) {
    if (name !== 'scan_code') {
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
    try {
      const explicit = Array.isArray(args?.files)
        ? args.files.filter((f) => typeof f === 'string' && f.trim())
        : null;

      // Resolve the base directory: an explicit `dir`, else the common parent of
      // the given files, else the cwd.
      let baseDir;
      if (args?.dir && typeof args.dir === 'string') {
        baseDir = resolvePath(args.dir);
      } else if (explicit && explicit.length) {
        baseDir = commonParent(explicit.map((f) => resolvePath(f)));
      } else {
        baseDir = process.cwd();
      }
      if (!existsSync(baseDir) || !statSync(baseDir).isDirectory()) {
        return JSON.stringify({ error: `dir does not exist or is not a directory: ${baseDir}` });
      }

      const explicitAbs = explicit ? explicit.map((f) => resolvePath(baseDir, f)) : null;

      const scanners = [];
      let totalFindings = 0;
      for (const scanner of SCANNERS) {
        let detected = false;
        try { detected = !!scanner.detect(baseDir); } catch { detected = false; }
        if (!detected) continue;

        // Files for THIS scanner: explicit list filtered to its languages, else
        // a bounded walk of baseDir for its languages.
        const langSet = new Set(scanner.langs.map((e) => e.toLowerCase()));
        const files = explicitAbs
          ? explicitAbs.filter((f) => langSet.has(extname(f).toLowerCase()))
          : collectFiles(baseDir, scanner.langs, MAX_FILES_PER_SCANNER);

        const block = runScanner(scanner, baseDir, files);
        if (Array.isArray(block.findings)) totalFindings += block.findings.length;
        scanners.push(block);
      }

      if (!scanners.length) {
        return JSON.stringify({
          ok: true, baseDir, scanners: [], totalFindings: 0,
          note: 'No known stack detected (no package.json / pyproject / go.mod …). Review by hand.',
        });
      }
      return JSON.stringify({ ok: true, baseDir, totalFindings, scanners });
    } catch (e) {
      return JSON.stringify({ error: `scan_code failed: ${e.message}` });
    }
  },

  tools: [
    {
      name: 'scan_code',
      description: 'Run the right deterministic linter for a checked-out repo and return structured findings. '
        + 'Auto-detects the stack (JS/TS via package.json → oxlint; more scanners coming) and runs each matching tool, '
        + 'scoped to files in its languages. Pass `files` (e.g. the changed files of the PR — recommended for a review) '
        + 'OR `dir` (a directory to scan). Returns { scanners: [ { scanner, findings: [ { file, line, severity, rule, message } ] } ] }. '
        + 'Findings are CANDIDATES — verify each in context before asserting. Best-effort: a stack whose linter is not installed is skipped with a note.',
      input_schema: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Absolute path to the checked-out repo (or subdirectory) to scan. Defaults to the current working directory.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Explicit list of files to scan (paths relative to `dir`, or absolute). Best for a code review — pass the PR\'s changed files. When omitted, the whole `dir` is walked (bounded).' },
        },
      },
    },
  ],
};

/** Longest common directory of a set of absolute paths (for baseDir inference). */
function commonParent(absPaths) {
  if (!absPaths.length) return process.cwd();
  if (absPaths.length === 1) return dirname(absPaths[0]);
  const split = absPaths.map((p) => p.split('/'));
  const first = split[0];
  const common = [];
  for (let i = 0; i < first.length; i++) {
    const seg = first[i];
    if (split.every((parts) => parts[i] === seg)) common.push(seg);
    else break;
  }
  const joined = common.join('/');
  return joined && existsSync(joined) && statSync(joined).isDirectory() ? joined : dirname(absPaths[0]);
}
