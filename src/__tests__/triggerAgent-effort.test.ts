/**
 * trigger_agent — per-run reasoning effort. The schema enum is DERIVED from the
 * engine's EFFORT_LEVELS (tripwire), a valid pick rides the trigger body as
 * `effort`, and an unknown pick is refused before any request.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EFFORT_LEVELS } from '@zibby/agent-workflow';
import { triggerAgentSkill } from '../triggerAgent.js';

const ENV_KEYS = ['PROJECT_ID', 'PROJECT_API_TOKEN', 'PROGRESS_API_URL', 'WORKFLOW_TYPE'];
const saved: Record<string, string | undefined> = {};

describe('trigger_agent effort', () => {
  let fetchMock: any;
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.PROJECT_ID = 'p-1';
    process.env.PROJECT_API_TOKEN = 'tok';
    process.env.PROGRESS_API_URL = 'https://api.test/executions';
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ executionId: 'e-1' }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    vi.unstubAllGlobals();
  });

  it('declares effort with exactly the engine enum, optional', () => {
    const schema = triggerAgentSkill.tools[0].input_schema;
    expect(schema.properties.effort.enum).toEqual([...EFFORT_LEVELS]);
    expect(schema.required).not.toContain('effort');
  });

  it('forwards a normalized effort in the trigger body', async () => {
    const out = JSON.parse(await triggerAgentSkill.handleToolCall('trigger_agent', { workflowType: 'dev', input: { a: 1 }, effort: ' High ' }));
    expect(out).toMatchObject({ ok: true, executionId: 'e-1', effort: 'high' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.test/projects/p-1/workflows/dev/trigger');
    expect(JSON.parse(init.body)).toEqual({ input: { a: 1 }, effort: 'high' });
  });

  it('omits effort when not given', async () => {
    await triggerAgentSkill.handleToolCall('trigger_agent', { workflowType: 'dev' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ input: {} });
  });

  it('refuses an unknown effort without triggering', async () => {
    const out = JSON.parse(await triggerAgentSkill.handleToolCall('trigger_agent', { workflowType: 'dev', effort: 'ultra' }));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/unknown effort/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
