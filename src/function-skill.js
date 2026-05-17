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
 * @param {Object} config — Skill definition
 * @returns {Object} A registered skill object
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
