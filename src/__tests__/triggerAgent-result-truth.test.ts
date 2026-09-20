/**
 * trigger_agent — THE RESULT SAYS WHAT THE PLATFORM ANSWERED.
 *
 * ⛔ THE CLASS (live 2026-09-20, board-runner): a tool that reports success
 * before it has read what the platform said. `trigger_agent` is a fan-out
 * primitive — the model is told to call it per item, log a failure and move on
 * — so a 2xx it cannot find an execution id in, reported as "run started", is a
 * dispatch that silently never happened and is never retried.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { triggerAgentSkill } from '../triggerAgent.js';

const ENV_KEYS = ['PROJECT_ID', 'PROJECT_API_TOKEN', 'PROGRESS_API_URL', 'WORKFLOW_TYPE'];
const saved: Record<string, string | undefined> = {};

const call = async (args: any = { workflowType: 'dev' }) => JSON.parse(await triggerAgentSkill.handleToolCall('trigger_agent', args));

describe('trigger_agent never claims a run it cannot name', () => {
  let fetchMock: any;
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.PROJECT_ID = 'p-1';
    process.env.PROJECT_API_TOKEN = 'tok';
    process.env.PROGRESS_API_URL = 'https://api.test/executions';
  });
  afterEach(() => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    vi.unstubAllGlobals();
  });

  const answer = (body: string, status = 200) => {
    fetchMock = vi.fn(async () => new Response(body, { status }));
    vi.stubGlobal('fetch', fetchMock);
  };

  it('a 2xx with no execution id is a FAILURE result, carrying what the platform said', async () => {
    answer(JSON.stringify({ ok: true, message: 'accepted' }), 202);
    const out = await call();
    expect(out.ok).toBe(false);
    expect(out.workflowType).toBe('dev');
    expect(out.error).toMatch(/no execution id/);
    expect(out.error).toMatch(/202/);
    expect(out.detail).toContain('accepted');
    expect(out.note).toMatch(/Do NOT record this as dispatched/);
    // and it never pretends otherwise
    expect(out).not.toHaveProperty('executionId');
    expect(JSON.stringify(out)).not.toMatch(/run started/);
  });

  it('a 2xx whose body is not JSON at all is a failure result too, not a started run', async () => {
    answer('<html>504 from a gateway that answered 200</html>', 200);
    const out = await call();
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/gateway/);
  });

  it('a real execution id is still reported as started', async () => {
    answer(JSON.stringify({ executionId: 'e-9' }), 202);
    const out = await call();
    expect(out).toMatchObject({ ok: true, executionId: 'e-9', note: 'run started (fire-and-forget)' });
  });
});
