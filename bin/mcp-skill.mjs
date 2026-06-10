#!/usr/bin/env node
/**
 * Zibby Generic Skill MCP Server — standalone stdio MCP binary.
 *
 * Serves ANY hand-written multi-tool skill object (one that ships a
 * `tools[]` array of tool defs + a `handleToolCall(name, args)` switch)
 * over MCP stdio. Invoked as:
 *
 *   node bin/mcp-skill.mjs <relativeDistModule> <exportName>
 *
 * e.g. `node bin/mcp-skill.mjs ../dist/github.js githubSkill`. The
 * module path is resolved RELATIVE TO this file (bin/), so in a
 * published install it points at node_modules/@zibby/skills/dist/<mod>.js
 * — exactly how bin/mcp-sentry.mjs imports `../dist/sentry.js`.
 *
 * Why a standalone binary instead of @zibby/core's function-bridge:
 * the bridge needs the parent process's in-memory handler registry to
 * be visible to the child, but each Node process has its own module
 * instance map — the `register*` side-effect didn't reliably land in
 * the same registry the bridge later read from (cross-package vs
 * relative ESM URL resolution subtleties; see bin/mcp-sentry.mjs's
 * header). The bridge ALSO assumes the functionSkill() registry; these
 * github/gitlab skills are hand-written with a `handleToolCall` switch,
 * not that registry, so the bridge can't serve them at all. A
 * self-contained binary that imports the skill module fresh and
 * dispatches straight through `skill.handleToolCall` side-steps both.
 *
 * Auth: passes the inherited env straight through. The skill module's
 * own helpers (ghFetch / glFetch / resolveIntegrationToken) read
 * whatever env vars the spawning `resolve()` allow-listed.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, resolve as resolvePath } from 'path';

const [, , moduleArg, exportName] = process.argv;
if (!moduleArg || !exportName) {
  console.error('[mcp-skill] usage: mcp-skill.mjs <relativeDistModule> <exportName>');
  process.exit(2);
}

/**
 * Convert a single JSON-Schema property node to a Zod validator.
 * Permissive by design — `handleToolCall` does the real validation;
 * this exists so the MODEL sees the param name, type and description.
 */
function propToZod(prop = {}) {
  let zt;
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    // z.enum needs string literals; coerce everything to string for the
    // model-facing schema. Non-string enums are vanishingly rare here.
    zt = z.enum(prop.enum.map((v) => String(v)));
  } else {
    switch (prop.type) {
      case 'string':
        zt = z.string();
        break;
      case 'number':
      case 'integer':
        zt = z.number();
        break;
      case 'boolean':
        zt = z.boolean();
        break;
      case 'array':
        zt = z.array(z.any());
        break;
      case 'object':
        zt = z.record(z.any());
        break;
      default:
        zt = z.any();
    }
  }
  if (prop.description) zt = zt.describe(prop.description);
  return zt;
}

/**
 * Convert a JSON-Schema object (a tool's `input_schema`) into a Zod
 * RAW SHAPE — a plain object of validators — which is what
 * `McpServer.registerTool`'s `inputSchema` expects (NOT a full schema).
 * Required keys stay required; everything else becomes `.optional()`.
 * Returns `{}` for empty / property-less schemas.
 */
function jsonSchemaToZodShape(inputSchema = {}) {
  const props = inputSchema.properties || {};
  const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required : []);
  const shape = {};
  for (const [key, prop] of Object.entries(props)) {
    let zt = propToZod(prop);
    if (!required.has(key)) zt = zt.optional();
    shape[key] = zt;
  }
  return shape;
}

// Resolve the skill module relative to THIS file (bin/), then import it.
const here = dirname(fileURLToPath(import.meta.url));
const modulePath = resolvePath(here, moduleArg);
const mod = await import(pathToFileURL(modulePath).href);
const skill = mod[exportName];
if (!skill || !Array.isArray(skill.tools) || typeof skill.handleToolCall !== 'function') {
  console.error(`[mcp-skill] export "${exportName}" from ${moduleArg} is not a hand-written multi-tool skill (needs tools[] + handleToolCall)`);
  process.exit(2);
}

const server = new McpServer(
  { name: `zibby-${skill.id || exportName}`, version: '1.0.0' },
  { capabilities: { tools: {} } },
);

for (const tool of skill.tools) {
  if (!tool || !tool.name) continue;
  const config = {
    description: tool.description || tool.name,
    inputSchema: jsonSchemaToZodShape(tool.input_schema),
  };
  if (tool.title) config.title = tool.title;
  server.registerTool(tool.name, config, async (args = {}) => {
    try {
      const out = await skill.handleToolCall(tool.name, args);
      const text = typeof out === 'string' ? out : JSON.stringify(out);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);

// Diagnostic on stderr only — stdout is reserved for MCP JSON-RPC.
console.error(`[mcp-skill] connected (${skill.tools.length} tools from ${exportName})`);
