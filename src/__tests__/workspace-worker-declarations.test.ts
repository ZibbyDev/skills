/**
 * `workspaceWorker.tools` names the tools the shared platform must run INSIDE
 * the run's own workspace (selfhosted dispatch/run-skill-worker.js `call` mode;
 * backend handlers/shared-run-mcp.js) because they read or write the run's
 * files. The platform refuses a workspace call for a tool this list does not
 * name, and lists a skill's tools from `tools` — so a name here that is not one
 * of the skill's own tools can never be called, silently.
 *
 * 🔗 TWO-PLACES: this is the pair, asserted for every skill in the package.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const sources = readdirSync(srcDir).filter((f) => /\.ts$/.test(f) && !/\.d\.ts$/.test(f));

/** The skills whose files a run's tools touch — each must say which tools. */
const TOUCHES_THE_WORKSPACE = ['core-tools', 'code-scan', 'git', 'github', 'gitlab'];

describe('workspaceWorker declarations', () => {
  const found = new Map<string, any>();
  it('every tool a skill sends to the workspace is one of its own tools', async () => {
    for (const file of sources) {
      let mod: Record<string, any>;
      try { mod = await import(`../${file.replace(/\.ts$/, '')}`); } catch { continue; }
      for (const skill of Object.values(mod)) {
        if (!skill || typeof skill !== 'object' || typeof skill.id !== 'string' || !skill.workspaceWorker) continue;
        found.set(skill.id, skill);
        const declared = skill.workspaceWorker.tools;
        expect(Array.isArray(declared) && declared.length > 0, `${skill.id}: workspaceWorker.tools must be a non-empty list`).toBe(true);
        const own = (skill.tools || []).map((t: any) => t.name);
        for (const name of declared) expect(own, `${skill.id}: workspaceWorker names "${name}", which is not one of its tools`).toContain(name);
        expect(typeof skill.handleToolCall, `${skill.id}: a workspace tool needs a handler`).toBe('function');
      }
    }
    for (const id of TOUCHES_THE_WORKSPACE) expect([...found.keys()], `${id} works on the run's files and must declare workspaceWorker`).toContain(id);
  });
});
