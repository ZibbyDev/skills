import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { sentrySkill } from '../sentry';
import { handleSharedSkillRequest } from '../sharedMcpServer';

type Tool = { name: string; title?: string; description?: string; inputSchema: any };
type Rpc = { id?: number; result?: { tools?: Tool[] }; error?: unknown };

function listedTools(reply: Rpc) {
  expect(reply.error).toBeUndefined();
  return reply.result?.tools || [];
}

function shapeOf(tool: Tool) {
  const schema = tool.inputSchema;
  return { name: tool.name, title: tool.title, description: tool.description,
    properties: Object.fromEntries(Object.entries(schema.properties || {})
    .map(([name, value]: [string, any]) => [name, { type: value.type, description: value.description }])),
  required: [...(schema.required || [])].sort() };
}

async function stdioTools(): Promise<Tool[]> {
  const spec = sentrySkill.resolve();
  expect(spec?.command).toBe('node');
  const child = spawn(process.execPath, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...spec.env } });
  let buffer = '';
  const pending = new Map<number, (rpc: Rpc) => void>();
  child.stdout.on('data', (bytes) => {
    buffer += bytes.toString();
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const rpc = JSON.parse(line) as Rpc; if (rpc.id != null) pending.get(rpc.id)?.(rpc); }
      catch { /* stdout may carry an incomplete/non-RPC line */ }
    }
  });
  const request = (id: number, method: string, params: unknown = {}) => new Promise<Rpc>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Sentry stdio ${method} timed out`)), 10_000);
    pending.set(id, (rpc) => { clearTimeout(timer); pending.delete(id); resolve(rpc); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'schema-tripwire', version: '1' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return listedTools(await request(2, 'tools/list'));
  } finally {
    child.kill();
  }
}

async function sharedTools(): Promise<Tool[]> {
  const request = new Request('http://localhost/mcp/skills/sentry', { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }) });
  const response = await handleSharedSkillRequest({ serverName: 'sentry', request,
    context: { executionId: 'run-1', projectId: 'project-1' },
    allowedTools: sentrySkill.tools.map((tool: any) => tool.name), skill: sentrySkill });
  expect(response.status).toBe(200);
  const body = await response.text();
  const rpc = response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(body.match(/^data: (.+)$/m)![1]) : JSON.parse(body);
  return listedTools(rpc);
}

describe('Sentry MCP declaration parity', () => {
  it('serves the same five declared schemas through stdio and shared HTTP', async () => {
    expect(sentrySkill.tools).toBe(sentrySkill.toolsForAssistant);
    const declared = sentrySkill.tools.map((tool: any) => ({ name: tool.name, title: tool.title,
      description: tool.description, inputSchema: tool.input_schema }));
    expect(declared).toHaveLength(5);
    const [stdio, shared] = await Promise.all([stdioTools(), sharedTools()]);
    expect(stdio.map(shapeOf)).toEqual(declared.map(shapeOf));
    expect(shared.map(shapeOf)).toEqual(declared.map(shapeOf));
  }, 15_000);

  it('dispatches an authorized Sentry tool through the shared adapter with run context', async () => {
    const invokeTool = vi.fn(async (name, args, context) =>
      JSON.stringify({ name, args, executionId: context.executionId }));
    const request = new Request('http://localhost/mcp/skills/sentry', { method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'sentry_get_issue', arguments: { issueId: 'ISSUE-1' } } }) });
    const response = await handleSharedSkillRequest({ serverName: 'sentry', request,
      context: { executionId: 'run-1', projectId: 'project-1' },
      allowedTools: ['sentry_get_issue'], skill: sentrySkill, invokeTool });
    expect(response.status).toBe(200);
    const body = await response.text();
    const rpc = response.headers.get('content-type')?.includes('text/event-stream')
      ? JSON.parse(body.match(/^data: (.+)$/m)![1]) : JSON.parse(body);
    expect(JSON.parse(rpc.result.content[0].text)).toEqual({
      name: 'sentry_get_issue', args: { issueId: 'ISSUE-1' }, executionId: 'run-1',
    });
    expect(invokeTool).toHaveBeenCalledOnce();
  });

  it('keeps self-host Sentry credentials in the exact-run one-shot env allowlist', () => {
    for (const key of ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_URL', 'ZIBBY_SELF_HOST']) {
      expect(sentrySkill.envKeys).toContain(key);
    }
  });
});
