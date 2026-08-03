/**
 * TRIPWIRE — the envKeys / backend-calling contract (CLAUDE.md TWO-PLACES RULE).
 *
 * Two places must agree: (1) whether a skill's CHILD-executed code can call
 * Zibby's own backend (resolveIntegrationToken / getAccountApiUrl — the cloud
 * auth path), and (2) the env its `resolve()` hands the spawned MCP child.
 * `resolve()`'s env IS the child's ENTIRE environment — a key it omits is
 * simply absent there, and the failure surfaces inside the child as a
 * misleading auth error ("No session token…"). This drifted THREE times
 * (github/gitlab 2026-07, lark/lark-docs 2026-08) before this test existed;
 * the goal is that the fourth omission fails HERE, before publish, not in a
 * user's chat.
 *
 * Mechanics — source scan + registry reflection:
 *   - SOURCE SCAN decides "backend-calling": the module either really imports
 *     '@zibby/core/backend-client' or locally reimplements the same client
 *     (reads process.env.ZIBBY_ACCOUNT_API_URL — the kvMemory/datasetStore/
 *     gbrain/artifact pattern). Comments can't trip it: the import check
 *     matches real import statements only.
 *   - REFLECTION asserts the EFFECTIVE child env: with the three session keys
 *     present in process.env, `skill.resolve()` must forward all of
 *     PROJECT_API_TOKEN + ZIBBY_ACCOUNT_API_URL + ZIBBY_ENV. This is asserted
 *     on resolve()'s returned env (the engine uses resolve() when present —
 *     agent-workflow tool-resolver.ts), NOT on the envKeys list alone, because
 *     half the skills forward the keys via an explicit list in resolve()
 *     (sentry/slack/discord/…) while envKeys stays the engine-fallback list.
 *     Skills with no resolve() but a raw `command` use the engine's
 *     envKeys-copy fallback, so for those envKeys itself must carry the keys.
 *   - In-process-only skills (no child spawned) are exempt: their code runs in
 *     the run process, which has the full env.
 *
 * PROBE VALIDITY (a negative means nothing until the probe is proven): the
 * scan must flag the known backend-calling skills — github, lark, larkDocs,
 * artifact — and each must PASS. If the detector or the bin resolution breaks,
 * these assertions fail loudly instead of the suite going silently vacuous.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withBackendSessionEnv } from '../backendSession';

const SESSION_KEYS = ['PROJECT_API_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_ENV'] as const;

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Real import of the shared backend client (not a comment mention). */
function importsBackendClient(text: string): boolean {
  return /^\s*import\s[^;]*?from\s+['"]@zibby\/core\/backend-client(\.js)?['"]/m.test(text);
}

/** Local reimplementation of the client (reads the account-API base itself). */
function reimplementsBackendClient(text: string): boolean {
  return /process\.env\.ZIBBY_ACCOUNT_API_URL/.test(text);
}

/** Every candidate skill source module (top level + trackers/), sans tests. */
function listSkillSources(): string[] {
  const top = readdirSync(srcDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => e.name);
  const trackers = readdirSync(join(srcDir, 'trackers'), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => join('trackers', e.name));
  return [...top, ...trackers].filter((f) => f !== 'index.ts');
}

/** Exported values that look like registered skill objects. */
function skillExports(mod: Record<string, any>): Array<[string, any]> {
  return Object.entries(mod).filter(([, v]) =>
    v && typeof v === 'object' && !Array.isArray(v)
    && typeof v.id === 'string'
    && (typeof v.resolve === 'function' || Array.isArray(v.tools) || Array.isArray(v.envKeys)));
}

/**
 * Call resolve() with the session keys guaranteed present, restoring the
 * pre-existing env afterwards (delete what we set; never reassign process.env).
 *
 * Resolution goes through withBackendSessionEnv — the SAME wrapper index.ts
 * applies at registration — so this asserts the EFFECTIVE child env the engine
 * sees (the platform path), not the raw module export. A skill that declares
 * `callsBackend: true` therefore satisfies the env contract by declaration
 * (the single-source contract this suite + the marker test below enforce); a
 * skill with hand-maintained allowlists keeps passing unchanged (the wrapper
 * only ADDS missing keys, existing values win).
 */
function resolveWithSessionEnv(skill: any) {
  skill = withBackendSessionEnv(skill);
  const placeholders: Record<string, string> = {
    PROJECT_API_TOKEN: 'contract-test-placeholder', // deliberately NOT credential-shaped (public repo)
    ZIBBY_ACCOUNT_API_URL: 'https://api.example.test',
    ZIBBY_ENV: 'prod',
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(placeholders)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return skill.resolve();
  } finally {
    for (const [k, prev] of Object.entries(saved)) {
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  }
}

const sources = listSkillSources();
const backendCalling = sources.filter((f) => {
  const text = readFileSync(join(srcDir, f), 'utf-8');
  return importsBackendClient(text) || reimplementsBackendClient(text);
});

describe('backend-calling skills forward the session env to their MCP child', () => {
  it('the source scan itself works (known positives are flagged)', () => {
    for (const name of ['github.ts', 'lark.ts', 'larkDocs.ts', 'artifact.ts', 'sentry.ts', 'slack.ts']) {
      expect(backendCalling, `${name} must be detected as backend-calling`).toContain(name);
    }
  });

  it.each(backendCalling)('%s', async (file) => {
    const mod = await import(`../${file.replace(/\.ts$/, '')}`);
    const skills = skillExports(mod);
    // A backend-calling module with no skill export is a pure helper
    // (reviewMemoryIo) — its callers' own skills carry the contract.
    for (const [exportName, skill] of skills) {
      if (typeof skill.resolve === 'function') {
        const resolved = resolveWithSessionEnv(skill);
        // No child spawned (in-process only / bin unresolvable-by-design) → exempt.
        if (!resolved || !resolved.command) continue;
        for (const key of SESSION_KEYS) {
          expect(
            resolved.env?.[key],
            `${file} ${exportName}: resolve() must forward ${key} to the MCP child ` +
            `(the child's env is ONLY what resolve() returns — its backend calls die without it)`,
          ).toBeTruthy();
        }
      } else if (skill.command) {
        // Engine fallback path (tool-resolver.ts): env is copied from envKeys.
        for (const key of SESSION_KEYS) {
          expect(
            skill.envKeys,
            `${file} ${exportName}: envKeys must list ${key} (engine copies ONLY envKeys for command-style skills)`,
          ).toContain(key);
        }
      }
      // Neither resolve() nor command → in-process only → full run env → exempt.
    }
  });

  it('known child-spawning positives actually spawn a child here (probe check)', () => {
    // If bin resolution regressed (e.g. bin/mcp-skill.mjs moved), the per-file
    // assertions above would silently skip — this pins that they cannot.
    const mods = [
      ['github.ts', 'githubSkill'],
      ['lark.ts', 'larkSkill'],
      ['larkDocs.ts', 'larkDocsSkill'],
      ['artifact.ts', 'artifactSkill'],
    ] as const;
    return Promise.all(mods.map(async ([file, exportName]) => {
      const mod = await import(`../${file.replace(/\.ts$/, '')}`);
      const resolved = resolveWithSessionEnv(mod[exportName]);
      expect(resolved?.command, `${file} ${exportName} must spawn an MCP child in this layout`).toBeTruthy();
    }));
  });

  it.each(backendCalling)('%s declares callsBackend on every skill export (the single-source marker)', async (file) => {
    // The MARKER is the single source of truth downstream (index.ts wraps at
    // registration; the self-host Copilot's turn-local-skills.js reflects it
    // off the registry to route the per-turn JWT). So whatever THIS suite's
    // source scan judges backend-calling MUST carry `callsBackend: true` — a
    // new backend-calling skill that forgets the one-line declaration fails
    // here, before publish. Helper modules with no skill export are exempt
    // (their callers' skills carry the contract).
    const mod = await import(`../${file.replace(/\.ts$/, '')}`);
    for (const [exportName, skill] of skillExports(mod)) {
      expect(
        skill.callsBackend,
        `${file} ${exportName}: backend-calling (per the source scan) but missing \`callsBackend: true\` — ` +
        'declare it on the skill object (backendSession.ts guarantees the child env from it)',
      ).toBe(true);
    }
  });

  it('gitlab (env-token-only today) keeps the session allowlist for the planned OAuth path', async () => {
    // gitlab does NOT call the backend today (pasted-token auth), so the scan
    // rightly skips it — but its envKeys deliberately carries the session keys
    // so the planned backend OAuth handler can land without re-tripping this
    // trap. Pin that intent (mcp-child-env.test.ts asserts the same pair).
    const { gitlabSkill } = await import('../gitlab');
    const resolved = resolveWithSessionEnv(gitlabSkill);
    expect(resolved?.command).toBeTruthy();
    for (const key of SESSION_KEYS) expect(resolved.env?.[key]).toBeTruthy();
  });
});
