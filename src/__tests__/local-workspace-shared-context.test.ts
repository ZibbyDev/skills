import { afterEach, describe, expect, it, vi } from 'vitest';
import { localWorkspaceSkill } from '../localWorkspace.js';

describe('local workspace in the shared MCP process', () => {
  const executionId = '11111111-1111-4111-8111-111111111111';
  const localWorkspaceContext = { executionId, workspaces: [{ id: executionId,
    name: 'repo', directory: `/workspace/local-project/${executionId}`, revision: 'a'.repeat(40), branch: 'HEAD' }] };

  it('uses only the verified call context for an execution and keeps the native mount path', async () => {
    const answer = JSON.parse(await localWorkspaceSkill.handleToolCall('list_workspaces', {}, { executionId, localWorkspaceContext }));
    expect(answer).toMatchObject({ ok: true, executionId, accessMode: 'native-tools' });
    expect(answer.workspaces[0].directory).toBe(`/workspace/local-project/${executionId}`);
  });

  it('rejects a context for another execution', async () => {
    const answer = JSON.parse(await localWorkspaceSkill.handleToolCall('list_workspaces', {},
      { executionId: '22222222-2222-4222-8222-222222222222', localWorkspaceContext }));
    expect(answer).toMatchObject({ ok: false, error: 'The execution workspace manifest is invalid; do not infer directories.' });
  });
});

/**
 * The shared platform serves this skill in ITS OWN process for every run on the
 * box. That process holds the platform's credentials; a run's workspace command
 * must go out as the run, or not at all.
 */
describe('whose credentials a workspace operation uses', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; vi.unstubAllGlobals(); });
  /** A fetch that records the request and answers like the workspace service. */
  function recordedFetch() {
    const calls: Array<{ url: string; authorization: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any = {}) => {
      calls.push({ url: String(url), authorization: String(init.headers?.authorization || '') });
      return new Response(JSON.stringify({ workspaces: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    return calls;
  }
  const platformOwn = () => {
    process.env.ZIBBY_ACCOUNT_API_URL = 'http://platform-own.example';
    process.env.PROJECT_API_TOKEN = 'platform-own-token';
    delete process.env.LOCAL_PROJECT_CONTEXT;
  };

  it('served by the platform: the call goes out as the RUN, never as the serving process', async () => {
    platformOwn();
    const calls = recordedFetch();
    const answer = JSON.parse(await localWorkspaceSkill.handleToolCall('list_workspaces', {},
      { executionId: '11111111-1111-4111-8111-111111111111', apiBase: 'http://127.0.0.1:3001/', bearerToken: 'run-token', localWorkspaceContext: null }));
    expect(answer.ok).toBe(true);
    expect(calls).toEqual([{ url: 'http://127.0.0.1:3001/selfhost/workspaces/list', authorization: 'Bearer run-token' }]);
  });

  it('served by the platform with no run token: unavailable — the platform\'s own token is not a fallback', async () => {
    platformOwn();
    const calls = recordedFetch();
    const answer = JSON.parse(await localWorkspaceSkill.handleToolCall('open_workspace', { path: '/x' },
      { executionId: '11111111-1111-4111-8111-111111111111', apiBase: 'http://127.0.0.1:3001', bearerToken: undefined }));
    expect(answer).toMatchObject({ ok: false, error: 'Local workspaces are unavailable in this runtime session.' });
    expect(calls).toEqual([]);
  });

  it('served by the platform: a manifest in the serving process\'s env is not this run\'s', async () => {
    platformOwn();
    process.env.LOCAL_PROJECT_CONTEXT = JSON.stringify({ executionId: '99999999-9999-4999-8999-999999999999',
      workspaces: [{ id: '99999999-9999-4999-8999-999999999999', name: 'other', directory: '/workspace/local-project/other', revision: 'b'.repeat(40), branch: 'HEAD' }] });
    const calls = recordedFetch();
    const answer = JSON.parse(await localWorkspaceSkill.handleToolCall('list_workspaces', {},
      { executionId: '11111111-1111-4111-8111-111111111111', apiBase: 'http://127.0.0.1:3001', bearerToken: 'run-token' }));
    expect(JSON.stringify(answer)).not.toContain('other');
    expect(calls).toHaveLength(1);
  });

  it('in the run\'s own process (no platform context): the process env is the run, as before', async () => {
    process.env.ZIBBY_ACCOUNT_API_URL = 'http://control-plane:3001';
    process.env.PROJECT_API_TOKEN = 'run-own-token';
    delete process.env.LOCAL_PROJECT_CONTEXT;
    const calls = recordedFetch();
    await localWorkspaceSkill.handleToolCall('list_workspaces', {});
    expect(calls).toEqual([{ url: 'http://control-plane:3001/selfhost/workspaces/list', authorization: 'Bearer run-own-token' }]);
  });
});
