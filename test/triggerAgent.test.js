import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { triggerAgentSkill } from '../src/triggerAgent.js';

const ENV_KEYS = ['PROJECT_ID', 'PROJECT_API_TOKEN', 'WORKFLOW_TYPE', 'PROGRESS_API_URL', 'ZIBBY_ACCOUNT_API_URL'];
let saved;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.PROJECT_ID = 'proj_1';
  process.env.PROJECT_API_TOKEN = 'zby_tok';
  process.env.WORKFLOW_TYPE = 'sentry-triage';
  globalThis.fetch = vi.fn(async () => ({
    ok: true, status: 200, text: async () => JSON.stringify({ executionId: 'exec_9' }),
  }));
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.restoreAllMocks();
});

const call = (args) => triggerAgentSkill.handleToolCall('trigger_agent', args).then(JSON.parse);

describe('trigger_agent skill', () => {
  it('self-dispatches (no workflowType → own WORKFLOW_TYPE) and returns executionId', async () => {
    process.env.PROGRESS_API_URL = 'https://api-prod.zibby.app/executions';
    const out = await call({ input: { trigger: 'fix', issueId: '1' } });
    expect(out).toMatchObject({ ok: true, workflowType: 'sentry-triage', executionId: 'exec_9' });
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://api-prod.zibby.app/projects/proj_1/workflows/sentry-triage/trigger');
    expect(JSON.parse(opts.body)).toEqual({ input: { trigger: 'fix', issueId: '1' } });
    expect(opts.headers.authorization).toBe('Bearer zby_tok');
  });

  it('triggers a DIFFERENT workflow when workflowType is passed', async () => {
    process.env.PROGRESS_API_URL = 'https://api-prod.zibby.app/executions';
    await call({ workflowType: 'code-review', input: {} });
    expect(globalThis.fetch.mock.calls[0][0]).toContain('/workflows/code-review/trigger');
  });

  it('SELF-HOSTED: uses ZIBBY_ACCOUNT_API_URL when PROGRESS_API_URL is absent', async () => {
    process.env.ZIBBY_ACCOUNT_API_URL = 'http://control-plane:3001';
    await call({ input: {} });
    expect(globalThis.fetch.mock.calls[0][0]).toBe('http://control-plane:3001/projects/proj_1/workflows/sentry-triage/trigger');
  });

  it('graceful: missing token → ok:false, no throw', async () => {
    delete process.env.PROJECT_API_TOKEN;
    const out = await call({ input: {} });
    expect(out.ok).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('graceful: HTTP error → ok:false with detail', async () => {
    process.env.PROGRESS_API_URL = 'https://api-prod.zibby.app/executions';
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404, text: async () => JSON.stringify({ error: 'workflow not found' }) }));
    const out = await call({ workflowType: 'nope', input: {} });
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/not found/i);
  });

  it('graceful: unknown tool name → ok:false', async () => {
    const out = await triggerAgentSkill.handleToolCall('bogus', {}).then(JSON.parse);
    expect(out.ok).toBe(false);
  });

  it('exposes one MCP tool named trigger_agent', () => {
    expect(triggerAgentSkill.tools).toHaveLength(1);
    expect(triggerAgentSkill.tools[0].name).toBe('trigger_agent');
    expect(triggerAgentSkill.id).toBe('trigger-agent');
  });
});
