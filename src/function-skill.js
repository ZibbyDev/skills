/**
 * Unified Skill Factory
 *
 * Function skill (one skill = one tool, flat):
 *
 *   import { skill } from '@zibby/skills';
 *
 *   export const add = skill('add', {
 *     description: 'Add two numbers',
 *     input: { a: 'number', b: 'number' },
 *     handler: async ({ a, b }) => ({ result: a + b })
 *   });
 *
 * MCP skill:
 *
 *   import { skill } from '@zibby/skills';
 *
 *   export const linear = skill('linear', {
 *     resolve() {
 *       if (!process.env.LINEAR_API_KEY) return null;
 *       return { command: 'npx', args: ['-y', '@linear/mcp-server'],
 *                env: { LINEAR_API_KEY: process.env.LINEAR_API_KEY } };
 *     }
 *   });
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { registerHandlers } from '@zibby/core/function-skill-registry.js';
import { registerSkill } from '@zibby/agent-workflow';

const _require = createRequire(import.meta.url);

/**
 * A tool exposed by a skill (Anthropic tool-definition shape).
 * @typedef {Object} SkillTool
 * @property {string} name — Tool name.
 * @property {string} [description] — Human-readable description.
 * @property {Object} [input_schema] — JSON Schema for the tool input.
 */

/**
 * A registered skill object. Returned by {@link skill} and consumed by
 * `registerSkill` / the workflow runtime.
 * @typedef {Object} Skill
 * @property {string} id — Unique skill identifier.
 * @property {'function'|'mcp'} type — Skill kind.
 * @property {string} serverName — MCP server name this skill registers under.
 * @property {string[]} allowedTools — Glob patterns of tools this skill grants.
 * @property {string} description — Human-readable description.
 * @property {string[]} envKeys — Env var names the skill reads at resolve time.
 * @property {SkillTool[]} tools — Tool definitions exposed by the skill.
 * @property {() => ({ command: string, args: string[], env?: Record<string,string> } | null)} resolve
 *   — Returns the MCP server launch config, or null when unavailable.
 * @property {string} [cursorKey] — Optional Cursor MCP registry key.
 * @property {string} [sessionEnvKey] — Optional env key carrying session info.
 */

/**
 * Function-skill input field: either a JSON-Schema type string
 * (e.g. `'number'`) or a partial JSON-Schema object with an optional
 * `required` flag (defaults to required).
 * @typedef {string | (Object & { required?: boolean })} SkillInputField
 */

/**
 * Configuration passed to {@link skill}.
 *
 * Provide `handler` for a function skill (one skill = one tool), or
 * `resolve` for an MCP skill.
 * @typedef {Object} SkillConfig
 * @property {string} [description] — Human-readable description.
 * @property {Record<string, SkillInputField>} [input] — Function-skill input schema.
 * @property {(args: any) => any} [handler] — Function-skill handler (makes it a function skill).
 * @property {() => ({ command: string, args: string[], env?: Record<string,string> } | null)} [resolve]
 *   — MCP-skill resolver (makes it an MCP skill).
 * @property {string} [serverName] — MCP server name (defaults to `id`).
 * @property {string[]} [allowedTools] — Allowed tool globs.
 * @property {string[]} [envKeys] — Env var names the skill reads.
 * @property {SkillTool[]} [tools] — Tool definitions (MCP skills).
 * @property {string} [cursorKey] — Optional Cursor MCP registry key.
 * @property {string} [sessionEnvKey] — Optional session env key.
 */

function resolveBridgePath() {
  try {
    return _require.resolve('@zibby/core/function-bridge.js');
  } catch {
    return null;
  }
}

const _selfUrl = import.meta.url;

function getCallerFile() {
  const original = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = (_, stack) => stack;
    const err = new Error();
    const stack = err.stack;
    for (let i = 2; i < stack.length; i++) {
      const file = stack[i].getFileName();
      if (file && file !== _selfUrl && !file.startsWith('node:')) {
        return file.startsWith('file://') ? fileURLToPath(file) : file;
      }
    }
    return null;
  } finally {
    Error.prepareStackTrace = original;
  }
}

function buildInputSchema(input) {
  if (!input || typeof input !== 'object') {
    return { type: 'object', properties: {}, required: [] };
  }
  const properties = {};
  const required = [];
  for (const [key, def] of Object.entries(input)) {
    if (typeof def === 'string') {
      properties[key] = { type: def };
      required.push(key);
    } else {
      const { required: isRequired, ...rest } = def;
      properties[key] = rest;
      if (isRequired !== false) required.push(key);
    }
  }
  return { type: 'object', properties, required };
}

function buildFunctionSkill(id, modulePath, config) {
  if (typeof config.handler !== 'function') {
    throw new Error(`Skill "${id}" must have a handler function`);
  }

  const handlers = { [id]: config.handler };
  const tools = [{
    name: id,
    description: config.description || '',
    input_schema: buildInputSchema(config.input),
  }];

  registerHandlers(id, handlers, tools);

  return {
    id,
    type: 'function',
    serverName: id,
    allowedTools: [`mcp__${id}__*`],
    description: config.description || `Function skill: ${id}`,
    envKeys: [],
    tools,
    resolve() {
      const bridge = resolveBridgePath();
      if (!bridge) return null;
      return { command: 'node', args: [bridge, modulePath, id] };
    },
  };
}

function buildMcpSkill(id, config) {
  return {
    id,
    type: 'mcp',
    serverName: config.serverName || id,
    allowedTools: config.allowedTools || [`mcp__${config.serverName || id}__*`],
    description: config.description || `MCP skill: ${id}`,
    envKeys: config.envKeys || [],
    tools: config.tools || [],
    resolve: config.resolve,
    ...(config.cursorKey && { cursorKey: config.cursorKey }),
    ...(config.sessionEnvKey && { sessionEnvKey: config.sessionEnvKey }),
  };
}

/**
 * Create and register a skill.
 *
 * Function skill:  skill(id, { description, input, handler })
 * MCP skill:       skill(id, { resolve(), serverName?, ... })
 *
 * @param {string} id — Unique skill identifier
 * @param {SkillConfig} config — Skill definition
 * @returns {Skill} A registered skill object
 */
export function skill(id, config) {
  let skillObj;

  if ('handler' in config) {
    if (typeof config.handler !== 'function') {
      throw new Error(`Skill "${id}" must have a handler function`);
    }
    const callerFile = getCallerFile();
    if (!callerFile) {
      throw new Error(`Could not resolve caller file for skill "${id}".`);
    }
    skillObj = buildFunctionSkill(id, callerFile, config);
  } else if (typeof config.resolve === 'function') {
    skillObj = buildMcpSkill(id, config);
  } else {
    throw new Error(
      `Skill "${id}" must have either a handler (function skill) or resolve (MCP skill).`
    );
  }

  registerSkill(skillObj);
  return skillObj;
}

export const functionSkill = skill;
