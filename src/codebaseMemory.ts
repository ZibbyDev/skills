/**
 * codebaseMemory.js — code-graph + semantic codebase memory skill, backed by
 * a sha256-pinned DeusData/codebase-memory-mcp artifact delivered on demand.
 *
 * WHAT IT IS
 * ──────────
 * A hand-written stdio MCP skill (same shape as kvMemory.js) that points the
 * agent at the `codebase-memory-mcp` server binary materialized by the shared
 * @zibby/bin-registry mechanism when the skill is enabled. The server indexes
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
 * invokeAgentOptions() prepares the pinned artifact, then (idempotent via a
 * per-repo marker under CBM_CACHE_DIR) indexes the checked-out repo with the imperative
 * `cli index_repository` path BEFORE the node's agent runs. Delivery and index
 * failures are written to the run log and the graph is never claimed ready.
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
import { cachedToolPath, ensureTool } from '@zibby/bin-registry';

/** The current pin's private, verified binary (override for local dev/tests). */
function binPath() {
  return process.env.CBM_BIN || cachedToolPath('codebase-memory');
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
The checked-out repository can be indexed into a queryable code graph + semantic
index. Reach for these when available and you need structure,
relationships, or "where does X live / what depends on Y":
- get_architecture: high-level architecture / module map — START HERE to orient.
- search_graph: semantic-ish search over the code graph (symbols, files, concepts).
- query_graph: structured query against the graph schema (use get_graph_schema first).
- trace_path: trace a dependency / call path between two nodes (impact analysis).
- detect_changes: what changed vs the indexed baseline — scope your work.
- get_code_snippet / search_code: pull the exact code for a node / text match.
- index_status / list_projects: confirm the index is present before querying.
Indexing is attempted at the start of the run when a repo is already checked
out. If this run clones later, call index_repository on that clone. Always call
index_status before drawing conclusions; an empty query is never evidence of
no callers when the index is missing or partial. If the code-graph tools are
unavailable, continue with file reads and search and state that limitation.`,

  /**
   * stdio MCP server = the BARE binary with NO subcommand (verified for
   * v0.9.0). The graph's async preparation hook materializes the binary before
   * the strategy resolves MCP servers. A failed fetch removes the server rather
   * than pointing an MCP client at an absent executable.
   */
  resolve() {
    const bin = binPath();
    if (!bin || !existsSync(bin)) {
      return null;
    }
    const dir = cacheDir();
    try { mkdirSync(dir, { recursive: true }); } catch { /* non-fatal */ }
    const env: any = { CBM_CACHE_DIR: dir };
    // Forward the workspace hint so the server resolves paths consistently.
    if (process.env.WORKSPACE) env.WORKSPACE = process.env.WORKSPACE;
    return {
      type: 'stdio',
      command: bin,
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
  async invokeAgentOptions() {
    try {
      let bin = binPath();
      if (!bin) {
        try {
          bin = await ensureTool('codebase-memory', {
            onEvent: ({ phase, version }) => {
              if (phase === 'downloading') process.stderr.write(`[codebase-memory] downloading pinned v${version} artifact\n`);
              if (phase === 'shared-cache-hit') process.stderr.write(`[codebase-memory] verified shared v${version} archive\n`);
            },
          });
        } catch (error: any) {
          process.stderr.write(`[codebase-memory] binary unavailable (${error?.reason || 'unknown'}): ${error?.message || error}. `
            + 'Code-graph tools are unavailable; review with file reads and search.\n');
          return {};
        }
      }
      const repoDir = repoDirToIndex();
      if (!repoDir) return {};
      const dir = cacheDir();
      try { mkdirSync(dir, { recursive: true }); } catch { /* non-fatal */ }
      const marker = join(dir, `.cbm-indexed-${pathHash(repoDir)}`);
      if (existsSync(marker)) return {}; // already indexed this repo this run
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
      // A failed index is NOT a completed index. Leave it retryable and never
      // let later nodes read a success marker for a partial graph.
      if (!res.error && res.status === 0) {
        try { writeFileSync(marker, `${new Date().toISOString()} status=0\n`); } catch { /* non-fatal */ }
      }
      // SAY IT OUT LOUD WHEN IT DID NOT WORK. The hook contributes nothing the
      // model can see, so a failed index used to be invisible everywhere: the
      // prompt said the repo was indexed, every query came back empty, and
      // "nothing depends on Y" is what that reads as. The run log now names it,
      // and the prompt no longer asserts what this never verified.
      if (res.error || res.status !== 0) {
        const why = res.error ? String(res.error.message || res.error) : `exit ${res.status}${res.signal ? ` (${res.signal})` : ''}`;
        try {
          process.stderr.write(`[codebase-memory] indexing ${repoDir} did NOT succeed (${why}) — `
            + 'the code graph may be missing or partial; index_status/index_repository are the way back.\n');
        } catch { /* non-fatal */ }
      }
    } catch (error: any) {
      process.stderr.write(`[codebase-memory] preparation failed: ${error?.message || error}. `
        + 'Code-graph tools may be unavailable; use file reads and search.\n');
    }
    return {};
  },
};
