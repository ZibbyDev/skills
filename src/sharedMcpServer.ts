/**
 * Shared, authenticated HTTP MCP serving for hand-written Zibby skills.
 *
 * The caller verifies the run token and derives both the skill and the tool
 * allowlist from the deployed graph before calling this module. The v2 SDK
 * creates a fresh MCP server per HTTP request; auth and run context travel
 * through its request-local authInfo rather than process.env.
 *
 * This is a separate entry point from bin/mcp-skill.mjs. The local stdio
 * fallback remains on the smaller v1 SDK until shared serving is proven.
 * This entry point requires Node 20+; the base package still supports Node 18.
 */

import { McpServer, createMcpHandler, fromJsonSchema } from '@modelcontextprotocol/server';
import type { JsonSchemaType } from '@modelcontextprotocol/server';

export { invokeSharedSkillWorker } from './sharedSkillInvoker.js';
export type { SharedSkillWorkerCall } from './sharedSkillInvoker.js';

export interface SharedSkillContext {
  executionId: string;
  projectId: string;
  workflowType?: string;
  apiBase?: string;
  bearerToken?: string;
  [key: string]: unknown;
}

export interface SharedSkillTool {
  name: string;
  title?: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface SharedSkill {
  id?: string;
  tools: SharedSkillTool[];
  handleToolCall?: (
    name: string,
    args: Record<string, unknown>,
    context: SharedSkillContext,
  ) => unknown | Promise<unknown>;
}

export interface SharedSkillRequest {
  serverName: string;
  request: Request;
  context: SharedSkillContext;
  allowedTools: readonly string[];
  skill: SharedSkill;
  /** Optional isolated dispatcher for handlers that still read process.env. */
  invokeTool?: (
    name: string, args: Record<string, unknown>, context: SharedSkillContext,
  ) => unknown | Promise<unknown>;
}

type VerifiedPayload = Omit<SharedSkillRequest, 'request'>;

const handler = createMcpHandler(({ authInfo }) => {
  const payload = authInfo?.extra?.zibbySharedSkill as VerifiedPayload | undefined;
  if (!payload) throw new Error('Missing verified Zibby run context');

  const { serverName, context, skill, invokeTool } = payload;
  const allowed = new Set(payload.allowedTools);
  const server = new McpServer(
    { name: `zibby-${skill.id || serverName}`, version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  for (const tool of skill.tools) {
    if (!tool?.name || !allowed.has(tool.name)) continue;
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description || tool.name,
      // Retain the skill's declared JSON Schema verbatim for tools/list.
      // The skill handler remains the source of semantic validation.
      inputSchema: fromJsonSchema((tool.input_schema || {
        type: 'object', properties: {},
      }) as JsonSchemaType),
    }, async (args = {}) => {
      try {
        const out = await (invokeTool
          ? invokeTool(tool.name, args as Record<string, unknown>, context)
          : skill.handleToolCall!(tool.name, args as Record<string, unknown>, context));
        const text = typeof out === 'string' ? out : JSON.stringify(out);
        return { content: [{ type: 'text' as const, text }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    });
  }
  return server;
}, { legacy: 'stateless' });

/** Return a streamable Web Response; the HTTP route must forward its body. */
export function handleSharedSkillRequest({
  serverName, request, context, allowedTools, skill, invokeTool,
}: SharedSkillRequest): Promise<Response> {
  if (!serverName || !context?.executionId || !context?.projectId
    || !skill || !Array.isArray(skill.tools)
    || (typeof skill.handleToolCall !== 'function' && typeof invokeTool !== 'function')
    || !Array.isArray(allowedTools)) {
    return Promise.resolve(new Response('Invalid shared skill request', { status: 400 }));
  }

  // Authentication is complete before entry. The SDK's per-request authInfo
  // is used solely as an isolation-safe carrier for the verified payload.
  return handler.fetch(request, {
    authInfo: {
      token: 'verified-by-zibby-run-auth',
      clientId: context.executionId,
      scopes: [],
      extra: {
        zibbySharedSkill: { serverName, context, allowedTools, skill, invokeTool },
      },
    },
  });
}
