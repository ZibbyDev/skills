import { describe, expect, it } from 'vitest';
import { getAllSkills } from '../index';
import { SHARED_SKILL_MODULES } from '../sharedSkillModules';

describe('direct shared Worker modules', () => {
  it('matches every built-in generic MCP skill registration and resolve spec', () => {
    const expected = new Map<string, [string, string]>();
    for (const skill of getAllSkills().values()) {
      if (!skill?.tools?.length || typeof skill.handleToolCall !== 'function'
        || typeof skill.resolve !== 'function') continue;
      const spec = skill.resolve();
      if (!spec?.args?.[0]?.endsWith('/mcp-skill.mjs')) continue;
      const moduleName = spec.args[1]?.replace(/^\.\.\/dist\//, '');
      const exportName = spec.args[2];
      expected.set(skill.id, [moduleName, exportName]);
    }
    expect(Object.fromEntries(expected)).toEqual(SHARED_SKILL_MODULES);
  });
});
