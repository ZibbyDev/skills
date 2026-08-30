/**
 * TRIPWIRE — a skill with tools MUST actually serve them (CLAUDE.md TWO-PLACES).
 *
 * THE INCIDENT (2026-08-30). jira's `resolve()` spawned `@zibby/mcp-jira` — a
 * package that does not exist in this monorepo and has never been published. So
 * `require.resolve` threw, `resolve()` returned `null`, and a null resolve is
 * silent everywhere: the strategy registers no MCP server and the model gets
 * ZERO `jira_*` tools. Every log line still read healthy — the integration was
 * connected, the skill was in the turn's set, `skillsUsed=10` — and the Copilot
 * told the user, correctly, that it could not search Jira issues while Settings
 * said "Jira · Connected".
 *
 * WHY THE EXISTING TRIPWIRE MISSED IT. backend-session-env-contract.test.ts
 * exempts a skill whose resolve() yields no command ("in-process only / bin
 * unresolvable-by-design"). That exemption cannot tell a skill that MEANS to run
 * in-process from one whose bin is simply gone — and jira had been the second
 * kind on every machine since the TypeScript migration. A negative result was
 * taken as a pass.
 *
 * THE RULE THIS PINS. If a skill declares a model-facing `tools[]` AND a
 * `resolve()`, then resolve() must return a SPAWNABLE server. A skill that
 * genuinely runs in-process (no child, full run env) declares that by being
 * recorded in IN_PROCESS below, with the reason — so "serves nothing" is always
 * a written decision, never an accident of a missing file.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function listSkillSources(): string[] {
  const top = readdirSync(srcDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => e.name);
  const trackers = readdirSync(join(srcDir, 'trackers'), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => join('trackers', e.name));
  return [...top, ...trackers].filter((f) => f !== 'index.ts');
}

function skillExports(mod: Record<string, any>): Array<[string, any]> {
  return Object.entries(mod).filter(([, v]) =>
    v && typeof v === 'object' && !Array.isArray(v)
    && typeof v.id === 'string'
    && Array.isArray(v.tools) && v.tools.length > 0
    && typeof v.resolve === 'function');
}

/**
 * Skills that deliberately serve their tools IN-PROCESS — no MCP child, so the
 * handler runs in the run process with the full env. Each entry is a decision
 * with a reason, and the list is a SNAPSHOT: adding one turns this suite red
 * until the reason is written down, which is the whole point.
 */
const IN_PROCESS = new Map<string, string>([
  ['chat-memory', 'in-process store; the functionSkill registry dispatches it'],
  ['chat_notify', 'aliases slack/lark handlers in-process, spawns nothing of its own'],
  ['core-tools', 'run_command / open_url / wait must run in the RUN process, not a child'],
  ['git', 'clones into the run workspace — a child process would clone somewhere else'],
  ['git-write', 'writes the run workspace, same reason as git'],
  ['memory', 'SOFT-GATED on the memory backend being present (see its resolve())'],
  ['runner', 'test-runner drives the run\'s own browser session'],
  ['skill-installer', 'mutates the run\'s live skill set — meaningless from a child'],
  ['workflow-builder', 'reads/writes the run workspace\'s graph files'],
]);

/*
 * WHAT "IN-PROCESS" COSTS, said once. A skill in that list is reachable ONLY by
 * a strategy that dispatches `handleToolCall` in the run process (the
 * `assistant` strategy). An MCP-served strategy — the Claude SDK, i.e. the
 * Copilot — sees none of its tools. That is a real limitation of those nine,
 * accepted because each genuinely needs the run process; it is NOT a licence to
 * park a provider skill here. A provider skill talks to an HTTP API and has no
 * reason to care which process it runs in, so it belongs on bin/mcp-skill.mjs.
 */

const sources = listSkillSources();

describe('a skill that declares tools serves them', () => {
  it.each(sources)('%s', async (file) => {
    const mod = await import(`../${file.replace(/\.ts$/, '')}`);
    for (const [exportName, skill] of skillExports(mod)) {
      const resolved = skill.resolve();
      if (IN_PROCESS.has(skill.id)) {
        expect(
          resolved?.command,
          `${file} ${exportName}: recorded as in-process (${IN_PROCESS.get(skill.id)}) but now spawns a child — ` +
          'remove it from IN_PROCESS',
        ).toBeFalsy();
        continue;
      }
      expect(
        resolved && resolved.command,
        `${file} ${exportName} (${skill.id}): declares ${skill.tools.length} tool(s) but resolve() serves none ` +
        '(null / no command). An MCP-served strategy — the Copilot — will show the model ZERO of them, silently, ' +
        'while every log line still reads connected. Either point resolve() at a bin that EXISTS ' +
        '(bin/mcp-skill.mjs serves any handleToolCall skill) or record the skill in IN_PROCESS with the reason.',
      ).toBeTruthy();
    }
  });
});
