/**
 * list_running_agents says which project repositories each active run works in
 * (the platform's `repositories`, backend handlers/active-runs.js), so a member
 * sees a teammate in the same repository
 * (run_log/magnum/2026-10-27-joint-candidate-half-landed).
 * [A/B] before, compactRun's allowlist dropped the field.
 */
import { describe, it, expect } from 'vitest';
import { compactRun } from '../agentMessaging.js';

describe('a listed run keeps the repositories it works in', () => {
  it('passes the platform\'s repositories through', () => {
    const now = Date.parse('2026-10-27T01:00:00Z');
    const out = compactRun({ executionId: 'r1', workflowType: 'developer', ticketKey: '855', createdAt: '2026-10-27T00:30:00Z',
      updatedAt: '2026-10-27T00:59:00Z', repositories: ['12-selfhosted', '12-backend'] }, now);
    expect(out).toMatchObject({ workflowType: 'developer', ticketKey: '855', ageMinutes: 30, repositories: ['12-selfhosted', '12-backend'] });
  });
  it('a run with none listed carries no field', () => {
    expect(compactRun({ executionId: 'r2', createdAt: '2026-10-27T00:30:00Z' }, Date.parse('2026-10-27T01:00:00Z'))).not.toHaveProperty('repositories');
  });
});
