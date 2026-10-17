/**
 * A skill that declares an `intro` can be reached through the tool search: a
 * node that names it in `searchSkills` carries the intro in its prompt instead
 * of the skill's page (@zibby/agent-workflow skill-registry `skillPromptText`).
 * Two facts must then hold for EVERY such skill, and this suite holds them:
 *
 *   1. its tools really are behind the search — it never pins them in front of
 *      the model (`alwaysLoad: true` on the skill or on its resolved server);
 *   2. its page reaches the model with its tools — the generic skill server
 *      (bin/mcp-skill.mjs) lists each tool with the page after its own words.
 *
 * A/B: before the bin applied `withToolGuide`, test 2 fails (the served
 * description is the tool's own words only).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getAllSkills, skillFragmentText, skillIntro } from '@zibby/agent-workflow';
import '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', '..');
const withIntro = [...getAllSkills().values()].filter((s: any) => skillIntro(s));

describe('every skill that declares an intro', () => {
  it('exists (the artifact skill is one)', () => {
    expect(withIntro.map((s: any) => s.id)).toContain('artifact');
  });

  it.each(withIntro.map((s: any) => [s.id, s]))('%s: is never pinned in front of the model, and its intro is short and says where the tools are', (_id, skill: any) => {
    expect(skill.alwaysLoad).not.toBe(true);
    let resolved: any = null;
    try { resolved = typeof skill.resolve === 'function' ? skill.resolve({}) : null; } catch { resolved = null; }
    expect(resolved?.alwaysLoad).not.toBe(true);
    const page = skillFragmentText(skill);
    expect(page.length).toBeGreaterThan(0);
    expect(skillIntro(skill).length).toBeLessThan(page.length);
    expect(skillIntro(skill)).toMatch(/found with the tool search/);
  });
});

describe('the generic skill server serves the page with the tools', () => {
  const clients: Client[] = [];
  afterAll(async () => { for (const c of clients) await c.close().catch(() => {}); });

  it('artifact: each listed tool is its declared description, then the skill\'s page', async () => {
    const { artifactSkill } = await import('../artifact.js');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(pkg, 'bin', 'mcp-skill.mjs'), '../dist/artifact.js', 'artifactSkill'],
      env: { PATH: process.env.PATH || '' },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'intro-probe', version: '1.0.0' });
    clients.push(client);
    await client.connect(transport);
    const { tools } = await client.listTools();
    const page = skillFragmentText(artifactSkill).trim();
    expect(tools.map((t) => t.name).sort()).toEqual(artifactSkill.tools.map((t: any) => t.name).sort());
    for (const declared of artifactSkill.tools) {
      const listed = tools.find((t) => t.name === declared.name);
      expect(listed?.description).toBe(`${declared.description.trimEnd()}\n\n${page}`);
    }
  }, 30_000);
});
