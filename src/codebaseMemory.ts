/**
 * codebaseMemory.js — code-graph + semantic codebase memory skill, backed by
 * the DeusData/codebase-memory-mcp binary BAKED INTO the agent image.
 *
 * WHAT IT IS
 * ──────────
 * A hand-written stdio MCP skill (same shape as kvMemory.js) that points the
 * agent at the `codebase-memory-mcp` server binary already on the image PATH
 * (/usr/local/bin/codebase-memory-mcp — see agent-ops/Dockerfile and
 * backend/lib/docker/zibby-agent/Dockerfile, which fetch the v0.8.1 portable
 * static build at build time, sha256-verified, multi-arch). The server indexes
 * a checked-out repository into a code graph + embeddings (Apache-2.0 nomic
 * embeddings) and exposes architecture / search / trace tools over it.
 *
 * RELATIONSHIP TO THE BINARY (VERIFIED GROUND TRUTH for v0.8.1)
 * ─────────────────────────────────────────────────────────────
 *   - stdio MCP server  = the BARE binary, NO subcommand → command + args:[].
 *   - imperative one-shot = `codebase-memory-mcp cli <tool> '<json>'`.
 *     Indexing            = `cli index_repository '{"repo_path":"<absDir>"}'`.
 *   - DB / cache dir env  = CBM_CACHE_DIR (we point it at a writable workspace
 *     dir so a read-only / ephemeral HOME never wedges the server).
 *
 * WHY UNGATED (no integration token)
 * ──────────────────────────────────
 * Fully local — no API, no OAuth, no paste-token. It is therefore deliberately
 * LEFT OUT of backend/src/services/skill-integrations.js
 * (REQUIRED_/OPTIONAL_INTEGRATION_MAP). Leaving it out = ungated = correct.
 * The skill ACTIVATES ONLY when a node declares 'codebase-memory' in its
 * `skills` array — the registry never auto-loads it, so existing agents are
 * unaffected (this is what makes the integration additive). `alwaysLoad: true`
 * (matching every other skill) only means: once a node HAS declared it, its
 * MCP tools load eagerly rather than lazily — it does NOT make the skill
 * global.
 *
 * INDEX-AT-START HOOK
 * ───────────────────
 * invokeAgentOptions() runs ONCE per run (idempotent via a per-repo marker
 * file under CBM_CACHE_DIR) to index the checked-out repo with the imperative
 * `cli index_repository` path BEFORE the node's agent runs, so the graph/search
 * tools have data on the very first tool call. It is wrapped in try/catch and
 * NEVER throws — a failed index degrades to "tools return empty", not a crashed
 * run. The hook returns {} (it contributes no agent-visible options); its only
 * job is the side-effect of building the index.
 *
 * It only helps agents whose repo is ALREADY checked out when the node starts.
 * An agent that clones INSIDE its own run has nothing to index at hook time —
 * the hook then NO-OPS (see repoDirToIndex) and that agent must call
 * index_repository itself right after cloning. Do NOT "fix" the empty case by
 * falling back to the workspace root: that indexes the agent's own template
 * source, which is worse than no index at all.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { SKILL_META } from '@zibby/skill-ids';

/** Absolute path to the baked-in server binary (override for local dev/tests). */
function binPath() {
  return process.env.CBM_BIN || '/usr/local/bin/codebase-memory-mcp';
}

/**
 * The DB / cache dir for the indexed graph + embeddings. Prefer an explicit
 * CBM_CACHE_DIR; otherwise put it under the workspace so it survives across the
 * indexing hook and the running server within the same task, and is writable on
 * a read-only-HOME image. Falls back to /tmp.
 */
function cacheDir() {
  if (process.env.CBM_CACHE_DIR) return process.env.CBM_CACHE_DIR;
  const ws = process.env.WORKSPACE || process.env.ZIBBY_WORKSPACE;
  return ws ? join(ws, '.zibby', 'cbm-cache') : '/tmp/zibby-cbm-cache';
}

/**
 * Best-effort discovery of the repo dir to index. The git skill clones into
 * <workspace>/.zibby/repos/<repo>; if exactly one repo is checked out we index
 * it, else the whole repos root. Returns an absolute dir, or NULL when nothing
 * is checked out yet.
 *
 * NEVER falls back to the workspace ROOT. That fallback was actively harmful:
 * this hook runs BEFORE the node's agent, and an agent that clones INSIDE its
 * own run (the code-review templates call gitlab_clone/github_clone from the
 * gather agent) has an empty repos dir at hook time — so the fallback indexed
 * `/workspace`, which at that moment holds the AGENT'S OWN TEMPLATE SOURCE.
 * The graph then described the reviewer's own graph.mjs/nodes instead of the
 * repo under review, and the idempotency marker made that garbage index stick
 * for the rest of the run. Returning null instead means: no repo yet → skip
 * pre-indexing entirely and let whoever cloned it index the REAL path (the
 * code-review gather step calls index_repository right after the clone).
 */
function repoDirToIndex() {
  const ws = process.env.WORKSPACE || process.env.ZIBBY_WORKSPACE || '/workspace';
  const reposRoot = join(ws, '.zibby', 'repos');
  try {
    if (existsSync(reposRoot)) {
      const entries = readdirSync(reposRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(reposRoot, d.name));
      if (entries.length === 1) return entries[0];
      if (entries.length > 1) return reposRoot; // index the whole repos root
    }
  } catch { /* nothing checked out we can trust */ }
  return null;
}

/** Stable short hash of an absolute path, for the idempotency marker filename. */
function pathHash(p) {
  return createHash('sha256').update(p).digest('hex').slice(0, 16);
}

export const codebaseMemorySkill: any = {
  id: 'codebase-memory',
  serverName: 'codebase_memory',
  // Static toggle metadata by REFERENCE to the single source of truth
  // (@zibby/skill-ids SKILL_META). The engine's toggle gate (claude-strategy
  // isToggleableOff) reads `skill.meta.toggleable` off this — no hardcoded list.
  // See strategy/skills-platform-architecture.md (Phase 2).
  meta: SKILL_META['codebase-memory'],
  allowedTools: ['mcp__codebase_memory__*'],
  description:
    'Codebase memory — code-graph + semantic index over the checked-out repo (architecture, graph search, dependency trace, change detection)',

  promptFragment: `## Codebase Memory (code-graph + semantic index over THIS repo)
The checked-out repository is indexed into a queryable code graph + semantic
index. Reach for these instead of blindly grepping when you need structure,
relationships, or "where does X live / what depends on Y":
- get_architecture: high-level architecture / module map — START HERE to orient.
- search_graph: semantic-ish search over the code graph (symbols, files, concepts).
- query_graph: structured query against the graph schema (use get_graph_schema first).
- trace_path: trace a dependency / call path between two nodes (impact analysis).
- detect_changes: what changed vs the indexed baseline — scope your work.
- get_code_snippet / search_code: pull the exact code for a node / text match.
- index_status / list_projects: confirm the index is present before querying.
The repo is indexed for you at the start of the run; if a query comes back
empty, call index_status, and only re-index (index_repository) if needed.`,

  /**
   * stdio MCP server = the BARE binary with NO subcommand (verified for
   * v0.8.1). Never returns { command: null } — the binary is baked into the
   * image; if it's somehow absent the server simply fails to spawn and its
   * tools are unavailable, which does not crash the run.
   */
  resolve() {
    const dir = cacheDir();
    try { mkdirSync(dir, { recursive: true }); } catch { /* non-fatal */ }
    const env: any = { CBM_CACHE_DIR: dir };
    // Forward the workspace hint so the server resolves paths consistently.
    if (process.env.WORKSPACE) env.WORKSPACE = process.env.WORKSPACE;
    return {
      type: 'stdio',
      command: binPath(),
      args: [],
      env,
      description: this.description,
      // NO `alwaysLoad`: the SDK defers MCP tools behind ToolSearch by design and
      // ToolSearch reaches them — measured, see MCP_TOOL_LOADING.md.
    };
  },

  /**
   * Pre-run hook (graph.js calls this for every skill declared on the node,
   * before the agent runs). Index the checked-out repo ONCE per run with the
   * imperative `cli index_repository` path. Idempotent via a per-repo marker
   * under CBM_CACHE_DIR; fully wrapped so it NEVER throws into the run.
   * Returns {} — it contributes no agent-visible options.
   */
  invokeAgentOptions() {
    try {
      const repoDir = repoDirToIndex();
      if (!repoDir) return {};
      const dir = cacheDir();
      try { mkdirSync(dir, { recursive: true }); } catch { /* non-fatal */ }
      const marker = join(dir, `.cbm-indexed-${pathHash(repoDir)}`);
      if (existsSync(marker)) return {}; // already indexed this repo this run
      const bin = binPath();
      if (!existsSync(bin) && !process.env.CBM_BIN) return {}; // binary missing → skip silently
      const res = spawnSync(
        bin,
        ['cli', 'index_repository', JSON.stringify({ repo_path: repoDir })],
        {
          env: { ...process.env, CBM_CACHE_DIR: dir },
          encoding: 'utf-8',
          // Indexing is fast (verified) but cap it so a pathological repo can't
          // stall the run's first node. A timeout just leaves the index partial.
          timeout: 5 * 60 * 1000,
          maxBuffer: 32 * 1024 * 1024,
        },
      );
      // Write the marker regardless of exit status: a re-attempt next node
      // would hit the same outcome, and the server can still index_repository
      // on demand. We only avoid the duplicate work within this run.
      try { writeFileSync(marker, `${new Date().toISOString()} status=${res.status}\n`); } catch { /* non-fatal */ }
    } catch {
      // Never let indexing take down the run.
    }
    return {};
  },
};
