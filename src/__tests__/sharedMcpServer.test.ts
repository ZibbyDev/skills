import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleSharedSkillRequest, type SharedSkill } from '../sharedMcpServer';
import { triggerAgentSkill } from '../triggerAgent';

const schema = {
  type: 'object',
  properties: { message: { type: 'string', description: 'Message to echo' } },
  required: ['message'],
};

function request(method: string, id: number, params?: unknown): Request {
  return new Request('http://localhost/mcp/skills/example', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

async function result(response: Response): Promise<any> {
  const body = await response.text();
  expect(response.status).toBe(200);
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const event = body.split('\n').find((line) => line.startsWith('data: '));
    expect(event).toBeDefined();
    return JSON.parse(event!.slice(6));
  }
  return JSON.parse(body);
}

const skill: SharedSkill = {
  id: 'example',
  tools: [
    { name: 'echo', description: 'Echo one message', input_schema: schema },
    { name: 'secret', description: 'Not declared for this run', input_schema: schema },
  ],
  handleToolCall: async (name, args, context) =>
    `${name}:${context.executionId}:${args.message}`,
};

function serve({
  method, id, params, executionId = 'run-a', allowedTools = ['echo'],
}: {
  method: string;
  id: number;
  params?: unknown;
  executionId?: string;
  allowedTools?: string[];
}) {
  return handleSharedSkillRequest({
    serverName: 'example',
    request: request(method, id, params),
    context: { executionId, projectId: 'project-1' },
    allowedTools,
    skill,
  });
}

describe('shared MCP v2 server', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('negotiates with a legacy Codex MCP client and preserves declared tools', async () => {
    const init = await result(await serve({
      method: 'initialize', id: 1,
      params: {
        protocolVersion: '2025-03-26', capabilities: {},
        clientInfo: { name: 'test-client', version: '1' },
      },
    }));
    expect(init.result.serverInfo.name).toBe('zibby-example');

    const list = await result(await serve({ method: 'tools/list', id: 2 }));
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['echo']);
    expect(list.result.tools[0].inputSchema).toMatchObject(schema);
  });

  it('keeps run identity and tool allowlists isolated across concurrent calls', async () => {
    const [allowed, otherRun, denied] = await Promise.all([
      serve({ method: 'tools/call', id: 3,
        params: { name: 'echo', arguments: { message: 'hello' } } }),
      serve({ method: 'tools/call', id: 4, executionId: 'run-b',
        params: { name: 'echo', arguments: { message: 'world' } } }),
      serve({ method: 'tools/call', id: 5,
        params: { name: 'secret', arguments: { message: 'blocked' } } }),
    ]);
    expect((await result(allowed)).result.content[0].text).toBe('echo:run-a:hello');
    expect((await result(otherRun)).result.content[0].text).toBe('echo:run-b:world');
    const deniedResult = await result(denied);
    expect(deniedResult.result?.content?.[0]?.text || '').not.toContain('secret:run-a');
    expect(deniedResult.error || deniedResult.result?.isError).toBeTruthy();
  });

  it('rejects a request without verified run identity before SDK dispatch', async () => {
    const response = await handleSharedSkillRequest({
      serverName: 'example', request: request('tools/list', 6),
      context: { executionId: '', projectId: 'project-1' },
      allowedTools: ['echo'], skill,
    });
    expect(response.status).toBe(400);
  });

  it('serves the opted-in backend skill through v2 with explicit run credentials', async () => {
    const backend = vi.fn(async () => new Response(JSON.stringify({ executionId: 'child-1' })));
    vi.stubGlobal('fetch', backend);
    const response = await handleSharedSkillRequest({
      serverName: 'trigger',
      request: request('tools/call', 7, { name: 'trigger_agent', arguments: { input: { task: 'x' } } }),
      context: {
        executionId: 'parent-1', projectId: 'project-1', workflowType: 'worker',
        apiBase: 'https://platform.example', bearerToken: 'short-run-token',
      },
      allowedTools: ['trigger_agent'], skill: triggerAgentSkill,
    });
    const payload = await result(response);
    expect(JSON.parse(payload.result.content[0].text)).toMatchObject({
      ok: true, workflowType: 'worker', executionId: 'child-1',
    });
    expect(backend.mock.calls[0][0]).toBe('https://platform.example/projects/project-1/workflows/worker/trigger');
    expect(backend.mock.calls[0][1].headers.authorization).toBe('Bearer short-run-token');
  });
});
