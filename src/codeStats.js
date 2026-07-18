/**
 * code-stats — a PURE, DETERMINISTIC code-statistics skill (zero LLM, zero
 * network, zero env). Same input → same output, ALWAYS. This is the
 * reproducible "骨架" beneath any semantic scoring: the numbers a performance
 * report cites that must survive being challenged (LinearB's one real
 * advantage is that its metadata metrics are reproducible — these match that
 * bar while adding per-file / per-path facts LinearB's metadata layer never
 * sees).
 *
 * Design contract:
 *   - EVERY tool is a pure function of its arguments. No fetch, no env, no
 *     clock, no randomness → byte-identical results on every run, unit-testable.
 *   - Distinct from code-scan (linters/scanners, which DO run a tool) — this
 *     only COUNTS/CLASSIFIES structured facts the caller already has (a
 *     commit's changed-file list, a column of numbers).
 *   - Used TWO ways (see engineering-insights): the collect node calls
 *     `commit_facts` per commit to persist deterministic raw facts (file paths,
 *     extension mix, size bucket) that would otherwise be thrown away; the
 *     report agent calls `glob_hit` / `percentile` ON-DEMAND to compute
 *     core-path coverage against the customer's own globs and to rank people
 *     within a cohort (percentiles are reproducible and cross-team comparable —
 *     the "universal" property a raw score lacks).
 */

import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve as resolvePath } from 'path';

function resolveSkillBin() {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

/* ─────────────────────────── pure helpers ─────────────────────────── */

// Size buckets by TOTAL lines changed (additions + deletions). Fixed
// thresholds → a commit always lands in the same bucket. Tuned to the
// commonly-cited "small change" boundaries.
const SIZE_BUCKETS = [
  { name: 'trivial', max: 5 },
  { name: 'small', max: 30 },
  { name: 'medium', max: 150 },
  { name: 'large', max: 600 },
  { name: 'huge', max: Infinity },
];

export function sizeBucket(added, deleted) {
  const total = (Number(added) || 0) + (Number(deleted) || 0);
  for (const b of SIZE_BUCKETS) if (total <= b.max) return b.name;
  return 'huge';
}

// Lowercased extension incl. a few compound ones that matter for work-type
// classification (a `.test.ts` is test work, not source). Returns '' for a
// path with no extension (a Dockerfile, Makefile → handled by name below).
export function fileExtension(path) {
  const p = String(path || '').toLowerCase();
  const base = p.split('/').pop() || '';
  // Compound test/spec markers first.
  const m = base.match(/\.(test|spec)\.[a-z0-9]+$/);
  if (m) return `.${m[1]}`; // '.test' / '.spec'
  const dot = base.lastIndexOf('.');
  if (dot <= 0) {
    // No extension → classify well-known dotless build files by name.
    if (/^(dockerfile|makefile|jenkinsfile|procfile|gemfile|rakefile)$/i.test(base)) return base.toLowerCase();
    return '';
  }
  return base.slice(dot); // '.js', '.ts', '.md', '.yml', …
}

// A coarse WORK-KIND for an extension — the deterministic backbone of the
// work-type composition chart (LLM tagging is the richer overlay, but this is
// reproducible). Buckets: code | test | docs | config | style | data | other.
const EXT_KIND = {
  code: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.swift', '.scala', '.m', '.dart', '.ex', '.exs', '.clj', '.sh', '.bash'],
  test: ['.test', '.spec'],
  docs: ['.md', '.mdx', '.rst', '.txt', '.adoc'],
  config: ['.json', '.yml', '.yaml', '.toml', '.ini', '.env', '.cfg', '.conf', '.lock', '.xml', '.properties', 'dockerfile', 'makefile', 'jenkinsfile', 'procfile', '.tf', '.gradle'],
  style: ['.css', '.scss', '.sass', '.less', '.styl'],
  data: ['.csv', '.tsv', '.sql', '.parquet', '.proto', '.graphql', '.gql'],
};
const EXT_TO_KIND = (() => {
  const m = {};
  for (const [kind, exts] of Object.entries(EXT_KIND)) for (const e of exts) m[e] = kind;
  return m;
})();

export function extKind(ext) {
  return EXT_TO_KIND[String(ext || '').toLowerCase()] || 'other';
}

/**
 * commit_facts — deterministic per-commit facts from its changed-file list.
 * `files` is [{ path|newPath|filename, additions?, deletions? }] (the shapes
 * gitlab_get_commit / github_get_commit already return). Pure.
 */
export function commitFacts(files, opts = {}) {
  const list = Array.isArray(files) ? files : [];
  const paths = [];
  const extCounts = {};
  const kindCounts = { code: 0, test: 0, docs: 0, config: 0, style: 0, data: 0, other: 0 };
  let totalAdd = 0;
  let totalDel = 0;
  let largest = { path: '', changed: -1 };
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const path = String(f.path || f.newPath || f.filename || f.new_path || '').trim();
    if (!path) continue;
    paths.push(path);
    const add = Number(f.additions ?? f.add ?? 0) || 0;
    const del = Number(f.deletions ?? f.del ?? 0) || 0;
    totalAdd += add; totalDel += del;
    const ext = fileExtension(path);
    extCounts[ext || '(none)'] = (extCounts[ext || '(none)'] || 0) + 1;
    kindCounts[extKind(ext)] += 1;
    const changed = add + del;
    if (changed > largest.changed) largest = { path, changed };
  }
  const addTop = Number(opts.additions);
  const delTop = Number(opts.deletions);
  const add = Number.isFinite(addTop) ? addTop : totalAdd;
  const del = Number.isFinite(delTop) ? delTop : totalDel;
  return {
    filesChanged: paths.length,
    filePaths: paths,
    extCounts,
    kindCounts,
    additions: add,
    deletions: del,
    sizeBucket: sizeBucket(add, del),
    largestFile: largest.path || null,
    // Top-level dirs touched (first path segment) — cheap hotspot signal.
    dirs: [...new Set(paths.map((p) => (p.includes('/') ? p.split('/')[0] : '(root)')))].sort(),
  };
}

/**
 * glob_hit — how many of `paths` match ANY of `globs`. Deterministic. Supports
 * `**` (any depth), `*` (one segment, no slash), `?` (one char). The customer's
 * own core-path globs (e.g. "src/payment/**") are passed at REPORT time — this
 * makes "who works in the core" a reproducible number, not an LLM guess.
 */
export function globToRegExp(glob) {
  let re = '';
  const g = String(glob || '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

export function globHit(paths, globs) {
  const ps = Array.isArray(paths) ? paths.map(String) : [];
  const res = (Array.isArray(globs) ? globs : []).filter(Boolean).map(globToRegExp);
  if (!res.length) return { total: ps.length, hits: 0, ratio: 0, matched: [] };
  const matched = ps.filter((p) => res.some((r) => r.test(p)));
  return {
    total: ps.length,
    hits: matched.length,
    ratio: ps.length ? Number((matched.length / ps.length).toFixed(4)) : 0,
    matched,
  };
}

/**
 * percentile — the reproducible, cross-team-comparable rank of `value` within
 * `values` (0-100, "% of the cohort at or below value"). Ties count at-or-below
 * (the standard cumulative rank). Empty cohort → null (undefined, not a lie).
 */
export function percentileRank(values, value) {
  const xs = (Array.isArray(values) ? values : []).map(Number).filter((n) => Number.isFinite(n));
  const v = Number(value);
  if (!xs.length || !Number.isFinite(v)) return null;
  const atOrBelow = xs.filter((x) => x <= v).length;
  return Number(((atOrBelow / xs.length) * 100).toFixed(1));
}

/* ─────────────────────────── the skill object ─────────────────────────── */

export const codeStatsSkill = {
  id: 'code-stats',
  serverName: 'code_stats',
  allowedTools: ['mcp__code_stats__*'],
  description: 'Deterministic code statistics — pure, reproducible facts from changed-file lists + numbers (extension/work-kind mix, size bucket, core-path glob coverage, percentile rank). Zero LLM, zero network.',

  promptFragment: `## Code Stats (DETERMINISTIC facts — pure, reproducible, zero-LLM)
These tools COMPUTE reproducible facts from data you already have. Use them so
your numbers are auditable and survive challenge (same input → same output).

Tools:
- code_stats_commit_facts: Given a commit's changed \`files\` list
  ([{path, additions, deletions}] — exactly what gitlab_get_commit /
  github_get_commit return), returns { filePaths, extCounts, kindCounts
  (code/test/docs/config/style/data/other), additions, deletions, sizeBucket,
  largestFile, dirs }. Call this for EVERY commit you meter and PERSIST the raw
  facts (filePaths as JSON, kindCounts, sizeBucket) — they're free now and let
  any later analysis run without re-fetching.
- code_stats_glob_hit: Given \`paths\` + \`globs\` (e.g. ["src/payment/**",
  "auth/**"]), returns { hits, ratio, matched }. Use at REPORT time to compute
  each person's CORE-PATH coverage against the caller's own core globs — a
  reproducible "works in the core vs the edges" number.
- code_stats_percentile: Given \`values\` (a cohort's numbers) + a \`value\`,
  returns the 0-100 percentile rank. Use to express every metric as a rank
  within the team (reproducible + comparable across teams), not a raw number.`,

  resolve() {
    // PURE skill: spawn the generic MCP server pointing at this module. It
    // needs NO env (no token, no network) — the tools are pure functions.
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env: {}, description: this.description };
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/codeStats.js', 'codeStatsSkill'],
      env: {},
      description: this.description,
      alwaysLoad: true,
    };
  },

  async handleToolCall(name, args) {
    try {
      switch (name) {
        case 'code_stats_commit_facts':
          return JSON.stringify(commitFacts(args?.files, { additions: args?.additions, deletions: args?.deletions }));
        case 'code_stats_glob_hit':
          return JSON.stringify(globHit(args?.paths, args?.globs));
        case 'code_stats_percentile':
          return JSON.stringify({ percentile: percentileRank(args?.values, args?.value) });
        default:
          return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  },

  tools: [
    {
      name: 'code_stats_commit_facts',
      description: 'Deterministic per-commit facts from its changed-file list. Pass files: [{path, additions, deletions}] (gitlab_get_commit / github_get_commit shape). Returns filePaths, extCounts, kindCounts (code/test/docs/config/style/data/other), additions, deletions, sizeBucket (trivial/small/medium/large/huge), largestFile, dirs. Pure — same input always same output.',
      input_schema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            description: 'Changed files. Each { path (or newPath/filename), additions?, deletions? }.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                additions: { type: 'number' },
                deletions: { type: 'number' },
              },
            },
          },
          additions: { type: 'number', description: 'Optional commit-level total additions override (else summed from files).' },
          deletions: { type: 'number', description: 'Optional commit-level total deletions override.' },
        },
        required: ['files'],
      },
    },
    {
      name: 'code_stats_glob_hit',
      description: 'How many of paths match ANY of globs (supports **, *, ?). Returns { total, hits, ratio, matched }. Use for reproducible core-path coverage against the caller\'s own core globs.',
      input_schema: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: 'File paths to test.' },
          globs: { type: 'array', items: { type: 'string' }, description: 'Glob patterns, e.g. ["src/payment/**", "auth/**"].' },
        },
        required: ['paths', 'globs'],
      },
    },
    {
      name: 'code_stats_percentile',
      description: 'The 0-100 percentile rank of value within values (cumulative "% at or below"). Reproducible + cross-team comparable. Empty cohort → null.',
      input_schema: {
        type: 'object',
        properties: {
          values: { type: 'array', items: { type: 'number' }, description: 'The cohort\'s numbers.' },
          value: { type: 'number', description: 'The value to rank.' },
        },
        required: ['values', 'value'],
      },
    },
  ],
};

export default codeStatsSkill;
