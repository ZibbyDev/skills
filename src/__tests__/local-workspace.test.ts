import { afterEach, expect, test, vi } from 'vitest';
import { localWorkspaceSkill } from '../localWorkspace.js';
import { withBackendSessionEnv } from '../backendSession.js';
import { SKILL_IDS } from '@zibby/skill-ids';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
test.each(['/fixtures/notes.txt', '~/Notes/fixture.txt'])('chat opening passes %s unchanged without inventing a Git branch', async (path) => {
  vi.stubEnv('ZIBBY_ACCOUNT_API_URL', 'http://control-plane'); vi.stubEnv('PROJECT_API_TOKEN', 'private-test-token');
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ workspace: { kind: 'live', sourceType: 'file' } }) }));
  vi.stubGlobal('fetch', fetch);
  const result = JSON.parse(await localWorkspaceSkill.handleToolCall('open_workspace', { path }));
  expect(result.workspace.kind).toBe('live');
  expect(JSON.parse((fetch.mock.calls[0] as any)[1].body)).toEqual({ path });
  expect(localWorkspaceSkill.tools.find((t: any) => t.name === 'open_workspace').description).toContain('No Git or commit required');
});
test('execution manifest reuses native file tools and never calls a chat API or clones again', async () => {
  vi.stubEnv('LOCAL_PROJECT_CONTEXT', JSON.stringify({ executionId: 'execution', workspaces: [
    { id: 'one', directory: '/workspace/local-project/one', revision: 'a'.repeat(40), branch: 'HEAD' },
    { id: 'two', directory: '/workspace/local-project/two', revision: 'b'.repeat(40), branch: 'HEAD' },
  ] }));
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const result = JSON.parse(await localWorkspaceSkill.handleToolCall('list_workspaces'));
  expect(result.accessMode).toBe('native-tools'); expect(result.workspaces).toHaveLength(2);
  const command = JSON.parse(await localWorkspaceSkill.handleToolCall('run_workspace_command', { workspaceId: 'one', command: 'cat README.md' }));
  expect(command.ok).toBe(false); expect(command.instruction).toContain('existing file');
  expect(fetch).not.toHaveBeenCalled();
});
test('ordinary declared skill, backend-session env derived through the shared wrapper', () => {
  expect(localWorkspaceSkill.id).toBe(SKILL_IDS.LOCAL_WORKSPACE);
  const registered = withBackendSessionEnv(localWorkspaceSkill);
  expect(registered.envKeys).toEqual(expect.arrayContaining(['PROJECT_API_TOKEN', 'ZIBBY_ACCOUNT_API_URL']));
  expect(localWorkspaceSkill.tools.map((tool: any) => tool.name)).toEqual([
    'list_workspaces', 'open_workspace', 'refresh_workspace', 'close_workspace', 'run_workspace_command',
  ]);
  for (const tool of localWorkspaceSkill.tools) {
    expect(tool.input_schema.properties).not.toHaveProperty('threadKey');
    expect(tool.input_schema.properties).not.toHaveProperty('accountId');
  }
});
test('uses the current private session bearer and maps only documented operations', async () => {
  vi.stubEnv('ZIBBY_ACCOUNT_API_URL', 'http://control-plane:3001'); vi.stubEnv('PROJECT_API_TOKEN', 'private-test-token');
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ workspaces: [] }) }));
  vi.stubGlobal('fetch', fetch);
  expect(JSON.parse(await localWorkspaceSkill.handleToolCall('list_workspaces'))).toEqual({ ok: true, workspaces: [] });
  expect(fetch.mock.calls[0][0]).toBe('http://control-plane:3001/selfhost/workspaces/list');
  expect((fetch.mock.calls[0] as any)[1].headers.authorization).toBe('Bearer private-test-token');
  expect(JSON.parse(await localWorkspaceSkill.handleToolCall('begin')).ok).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
});
test('unavailable session and raw transport failures never leak credentials', async () => {
  vi.stubEnv('ZIBBY_ACCOUNT_API_URL', ''); vi.stubEnv('PROJECT_API_TOKEN', '');
  expect(JSON.parse(await localWorkspaceSkill.handleToolCall('list_workspaces')).ok).toBe(false);
  vi.stubEnv('ZIBBY_ACCOUNT_API_URL', 'http://control-plane'); vi.stubEnv('PROJECT_API_TOKEN', 'private-test-token');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Bearer private-test-token'); }));
  const response = await localWorkspaceSkill.handleToolCall('list_workspaces');
  expect(response).not.toContain('private-test-token'); expect(JSON.parse(response).ok).toBe(false);
});
