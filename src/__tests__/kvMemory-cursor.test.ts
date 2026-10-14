/**
 * kv_recall_prefix can read past its first page. The platform pages a prefix listing at 25 rows and answers
 * `truncated` + `nextCursor`; until 2026-10-14 the tool took only `keyPrefix`, so an agent with more than 25 entries
 * under a prefix was told there were more and had no way to read them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const door = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../lib/http-deadline.js', () => ({ fetchWithDeadline: door.fetch }));

Object.assign(process.env, {
  PROJECT_API_TOKEN: 'contract-test-placeholder', // deliberately NOT credential-shaped (public repo)
  ZIBBY_ACCOUNT_API_URL: 'http://cp.local',
  WORKFLOW_TYPE: 'developer',
});
const { kvMemorySkill } = await import('../kvMemory.js');

describe('kv_recall_prefix — the page after the first is reachable', () => {
  let bodies: any[];
  beforeEach(() => {
    bodies = [];
    door.fetch.mockReset();
    door.fetch.mockImplementation(async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ count: 25, truncated: true, nextCursor: 'c2', memories: [] }) };
    });
  });
  it('declares cursor and passes the previous answer\'s nextCursor through', async () => {
    const tool = kvMemorySkill.tools.find((t: any) => t.name === 'kv_recall_prefix');
    expect(Object.keys(tool.input_schema.properties)).toEqual(['keyPrefix', 'cursor']);
    expect(tool.description).toMatch(/nextCursor/);
    const first = JSON.parse(await kvMemorySkill.handleToolCall('kv_recall_prefix', { keyPrefix: 'seen#' }));
    expect(first.nextCursor).toBe('c2');
    await kvMemorySkill.handleToolCall('kv_recall_prefix', { keyPrefix: 'seen#', cursor: first.nextCursor });
    expect(bodies[0]).toEqual({ op: 'recall-prefix', scopePrefix: 'developer:seen#' });
    expect(bodies[1]).toEqual({ op: 'recall-prefix', scopePrefix: 'developer:seen#', cursor: 'c2' });
  });
});
