import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { chatMemorySkill, _resetInitCache } from '../src/chat-memory.js';

const DOLT_BIN = 'dolt';

function doltAvailable() {
  try {
    execFileSync(DOLT_BIN, ['version'], { encoding: 'utf-8', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const HAS_DOLT = doltAvailable();
const describeWithDolt = HAS_DOLT ? describe : describe.skip;

const TMP_ROOT = join(import.meta.dirname, '..', '.test-tmp-chat-memory');

function call(name, args, workspace) {
  return chatMemorySkill.handleToolCall(name, args, { options: { workspace } });
}

function parse(jsonStr) {
  return JSON.parse(jsonStr);
}

// ─── Pure unit tests (no Dolt needed) ────────────────────────────────────────

describe('chatMemorySkill structure', () => {
  it('has correct id', () => {
    expect(chatMemorySkill.id).toBe('chat-memory');
  });

  it('has all 6 tools defined', () => {
    const names = chatMemorySkill.tools.map(t => t.name);
    expect(names).toEqual([
      'memory_store',
      'memory_recall',
      'memory_brief',
      'memory_end_session',
      'task_log',
      'task_history',
    ]);
  });

  it('all tools have input_schema with type object', () => {
    for (const tool of chatMemorySkill.tools) {
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema.properties).toBeDefined();
    }
  });

  it('memory_store requires content and category', () => {
    const store = chatMemorySkill.tools.find(t => t.name === 'memory_store');
    expect(store.input_schema.required).toEqual(['content', 'category']);
  });

  it('memory_end_session requires summary', () => {
    const end = chatMemorySkill.tools.find(t => t.name === 'memory_end_session');
    expect(end.input_schema.required).toEqual(['summary']);
  });

  it('task_log requires title, type, status', () => {
    const log = chatMemorySkill.tools.find(t => t.name === 'task_log');
    expect(log.input_schema.required).toEqual(['title', 'type', 'status']);
  });

  it('promptFragment contains all tool names', () => {
    const frag = chatMemorySkill.promptFragment;
    expect(frag).toContain('memory_store');
    expect(frag).toContain('memory_recall');
    expect(frag).toContain('memory_brief');
    expect(frag).toContain('memory_end_session');
    expect(frag).toContain('task_log');
    expect(frag).toContain('task_history');
  });

  it('resolve returns null', () => {
    expect(chatMemorySkill.resolve()).toBeNull();
  });

  it('returns error for unknown tool', async () => {
    // This will fail on ensureTables if no dolt, but we still test the branch
    if (!HAS_DOLT) return;
    const tmpDir = join(TMP_ROOT, 'unknown-tool');
    mkdirSync(join(tmpDir, '.zibby/memory'), { recursive: true });
    execFileSync(DOLT_BIN, ['init', '--name', 'test', '--email', 'test@test.com'], { cwd: join(tmpDir, '.zibby/memory') });
    _resetInitCache();
    const res = parse(await call('bogus_tool', {}, tmpDir));
    expect(res.error).toContain('Unknown tool');
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─── Integration tests (require Dolt) ────────────────────────────────────────

describeWithDolt('chat-memory integration', () => {
  let workspace;

  beforeAll(() => {
    workspace = join(TMP_ROOT, `int-${Date.now()}`);
    mkdirSync(workspace, { recursive: true });
    _resetInitCache();
  });

  afterAll(() => {
    if (existsSync(TMP_ROOT)) {
      rmSync(TMP_ROOT, { recursive: true, force: true });
    }
  });

  // ── memory_store + memory_recall ──────────────────────────────────────────

  describe('memory_store', () => {
    it('stores a fact and returns ok', async () => {
      const res = parse(await call('memory_store', {
        content: 'Login page is at /auth/login',
        category: 'fact',
        source: 'test',
        ticketKey: 'SCRUM-100',
      }, workspace));

      expect(res.ok).toBe(true);
      expect(res.id).toBeTruthy();
      expect(res.category).toBe('fact');
      expect(res.stored).toContain('Login page');
    });

    it('stores a decision', async () => {
      const res = parse(await call('memory_store', {
        content: 'We chose React over Vue for the frontend',
        category: 'decision',
        source: 'user',
      }, workspace));

      expect(res.ok).toBe(true);
      expect(res.category).toBe('decision');
    });

    it('stores a URL', async () => {
      const res = parse(await call('memory_store', {
        content: 'http://localhost:3000/dashboard',
        category: 'url',
        ticketKey: 'SCRUM-100',
      }, workspace));

      expect(res.ok).toBe(true);
    });

    it('rejects missing content', async () => {
      const res = parse(await call('memory_store', { category: 'fact' }, workspace));
      expect(res.error).toBeTruthy();
    });

    it('rejects missing category', async () => {
      const res = parse(await call('memory_store', { content: 'hello' }, workspace));
      expect(res.error).toBeTruthy();
    });

    it('handles content with single quotes', async () => {
      const res = parse(await call('memory_store', {
        content: "It's important to check the user's profile",
        category: 'insight',
      }, workspace));

      expect(res.ok).toBe(true);
    });
  });

  describe('memory_recall', () => {
    it('recalls all memories (no filter)', async () => {
      const res = parse(await call('memory_recall', {}, workspace));
      expect(res.total).toBeGreaterThanOrEqual(3);
      expect(res.memories.length).toBeGreaterThanOrEqual(3);
    });

    it('recalls by keyword', async () => {
      const res = parse(await call('memory_recall', { query: 'Login page' }, workspace));
      expect(res.total).toBeGreaterThanOrEqual(1);
      expect(res.memories[0].content).toContain('Login page');
    });

    it('recalls by category', async () => {
      const res = parse(await call('memory_recall', { category: 'decision' }, workspace));
      expect(res.total).toBe(1);
      expect(res.memories[0].content).toContain('React over Vue');
    });

    it('recalls by ticket key', async () => {
      const res = parse(await call('memory_recall', { ticketKey: 'SCRUM-100' }, workspace));
      expect(res.total).toBe(2);
    });

    it('recalls with combined filters', async () => {
      const res = parse(await call('memory_recall', {
        category: 'fact',
        ticketKey: 'SCRUM-100',
      }, workspace));
      expect(res.total).toBe(1);
      expect(res.memories[0].content).toContain('Login page');
    });

    it('returns empty for non-matching query', async () => {
      const res = parse(await call('memory_recall', { query: 'xyzzynonexistent' }, workspace));
      expect(res.total).toBe(0);
    });

    it('respects limit', async () => {
      const res = parse(await call('memory_recall', { limit: 2 }, workspace));
      expect(res.memories.length).toBeLessThanOrEqual(2);
    });
  });

  // ── task_log + task_history ───────────────────────────────────────────────

  describe('task_log', () => {
    it('logs a passed test run', async () => {
      const res = parse(await call('task_log', {
        title: 'Login flow smoke test',
        type: 'test_run',
        status: 'passed',
        ticketKey: 'SCRUM-100',
        specPath: 'test-specs/scrum-100-login.txt',
        resultSummary: 'All 5 assertions passed',
      }, workspace));

      expect(res.ok).toBe(true);
      expect(res.id).toBeTruthy();
      expect(res.type).toBe('test_run');
      expect(res.status).toBe('passed');
    });

    it('logs a failed analysis', async () => {
      const res = parse(await call('task_log', {
        title: 'Analyze SCRUM-200 accessibility',
        type: 'analysis',
        status: 'failed',
        ticketKey: 'SCRUM-200',
        resultSummary: 'ARIA labels missing on 3 buttons',
      }, workspace));

      expect(res.ok).toBe(true);
    });

    it('logs a research task', async () => {
      const res = parse(await call('task_log', {
        title: 'Research auth patterns in codebase',
        type: 'research',
        status: 'passed',
      }, workspace));

      expect(res.ok).toBe(true);
    });

    it('rejects missing required fields', async () => {
      const res = parse(await call('task_log', { title: 'no type' }, workspace));
      expect(res.error).toBeTruthy();
    });
  });

  describe('task_history', () => {
    it('returns all tasks', async () => {
      const res = parse(await call('task_history', {}, workspace));
      expect(res.total).toBe(3);
    });

    it('filters by ticket', async () => {
      const res = parse(await call('task_history', { ticketKey: 'SCRUM-100' }, workspace));
      expect(res.total).toBe(1);
      expect(res.tasks[0].title).toContain('Login flow');
    });

    it('filters by type', async () => {
      const res = parse(await call('task_history', { type: 'test_run' }, workspace));
      expect(res.total).toBe(1);
    });

    it('filters by status', async () => {
      const res = parse(await call('task_history', { status: 'failed' }, workspace));
      expect(res.total).toBe(1);
      expect(res.tasks[0].title).toContain('accessibility');
    });

    it('returns empty for non-matching filter', async () => {
      const res = parse(await call('task_history', { ticketKey: 'NOPE-999' }, workspace));
      expect(res.total).toBe(0);
    });
  });

  // ── memory_end_session ────────────────────────────────────────────────────

  describe('memory_end_session', () => {
    it('saves a session summary', async () => {
      const res = parse(await call('memory_end_session', {
        summary: 'Tested login flow for SCRUM-100. All tests passed.',
        tickets: 'SCRUM-100,SCRUM-200',
        tasksRun: 3,
        tasksPassed: 2,
        tasksFailed: 1,
        keyFacts: 'Login page needs 2FA; Dashboard loads in <2s',
      }, workspace));

      expect(res.ok).toBe(true);
      expect(res.sessionId).toBeTruthy();
    });

    it('extracts keyFacts into memory entries', async () => {
      const res = parse(await call('memory_recall', { query: '2FA' }, workspace));
      expect(res.total).toBeGreaterThanOrEqual(1);
      expect(res.memories[0].content).toContain('2FA');
      expect(res.memories[0].source).toBe('session_summary');
    });

    it('decays old memory relevance', async () => {
      const firstRecall = parse(await call('memory_recall', { category: 'fact' }, workspace));
      const loginFact = firstRecall.memories.find(m => m.content.includes('Login page'));
      expect(Number(loginFact.relevance)).toBeLessThan(1.0);
    });

    it('rejects missing summary', async () => {
      const res = parse(await call('memory_end_session', {}, workspace));
      expect(res.error).toBeTruthy();
    });
  });

  // ── memory_brief ──────────────────────────────────────────────────────────

  describe('memory_brief', () => {
    it('returns sessions, memories, and task stats', async () => {
      const res = parse(await call('memory_brief', {}, workspace));

      expect(res.recentSessions).toBeDefined();
      expect(res.recentSessions.length).toBeGreaterThanOrEqual(1);
      expect(res.recentSessions[0].summary).toContain('SCRUM-100');

      expect(res.topMemories).toBeDefined();
      expect(res.topMemories.length).toBeGreaterThanOrEqual(1);

      expect(res.taskStats).toBeDefined();
    });

    it('filters by ticket key', async () => {
      const res = parse(await call('memory_brief', { ticketKey: 'SCRUM-100' }, workspace));
      expect(res.ticketFilter).toBe('SCRUM-100');
      for (const m of res.topMemories) {
        expect(m.content).toBeDefined();
      }
    });
  });

  // ── E2E: full lifecycle ───────────────────────────────────────────────────

  describe('end-to-end lifecycle', () => {
    let e2eWorkspace;

    beforeAll(() => {
      e2eWorkspace = join(TMP_ROOT, `e2e-${Date.now()}`);
      mkdirSync(e2eWorkspace, { recursive: true });
      _resetInitCache();
    });

    it('full workflow: store → log tasks → end session → recall in new session', async () => {
      // Step 1: Store initial context
      const s1 = parse(await call('memory_store', {
        content: 'App uses Next.js 14 with app router',
        category: 'context',
        source: 'codebase_analysis',
      }, e2eWorkspace));
      expect(s1.ok).toBe(true);

      const s2 = parse(await call('memory_store', {
        content: 'Staging env: https://staging.example.com',
        category: 'url',
        ticketKey: 'PROJ-50',
      }, e2eWorkspace));
      expect(s2.ok).toBe(true);

      const s3 = parse(await call('memory_store', {
        content: 'Test user: demo@example.com / testpass123',
        category: 'credential',
        ticketKey: 'PROJ-50',
      }, e2eWorkspace));
      expect(s3.ok).toBe(true);

      // Step 2: Log some tasks
      const t1 = parse(await call('task_log', {
        title: 'Smoke test login',
        type: 'test_run',
        status: 'passed',
        ticketKey: 'PROJ-50',
        specPath: 'specs/login.txt',
      }, e2eWorkspace));
      expect(t1.ok).toBe(true);

      const t2 = parse(await call('task_log', {
        title: 'Test cart checkout',
        type: 'test_run',
        status: 'failed',
        ticketKey: 'PROJ-51',
        resultSummary: 'Payment button not clickable on mobile',
      }, e2eWorkspace));
      expect(t2.ok).toBe(true);

      // Step 3: End session with key facts
      const endRes = parse(await call('memory_end_session', {
        summary: 'Ran 2 tests for PROJ-50 and PROJ-51. Login passed, checkout failed on mobile.',
        tickets: 'PROJ-50,PROJ-51',
        tasksRun: 2,
        tasksPassed: 1,
        tasksFailed: 1,
        keyFacts: 'Payment button broken on mobile viewport; Login flow works with test credentials',
      }, e2eWorkspace));
      expect(endRes.ok).toBe(true);

      // Step 4: Simulate new session — recall context
      const brief = parse(await call('memory_brief', {}, e2eWorkspace));
      expect(brief.recentSessions.length).toBe(1);
      expect(brief.recentSessions[0].summary).toContain('checkout failed');
      expect(brief.topMemories.length).toBeGreaterThanOrEqual(3);
      expect(brief.taskStats.length).toBeGreaterThanOrEqual(1);

      // Step 5: Recall specific ticket context
      const projRecall = parse(await call('memory_recall', { ticketKey: 'PROJ-50' }, e2eWorkspace));
      expect(projRecall.total).toBeGreaterThanOrEqual(2);
      const contents = projRecall.memories.map(m => m.content);
      expect(contents.some(c => c.includes('staging.example.com'))).toBe(true);
      expect(contents.some(c => c.includes('demo@example.com'))).toBe(true);

      // Step 6: Recall by keyword
      const mobileRecall = parse(await call('memory_recall', { query: 'mobile' }, e2eWorkspace));
      expect(mobileRecall.total).toBeGreaterThanOrEqual(1);
      expect(mobileRecall.memories[0].content).toContain('mobile');

      // Step 7: Task history
      const failedTasks = parse(await call('task_history', { status: 'failed' }, e2eWorkspace));
      expect(failedTasks.total).toBe(1);
      expect(failedTasks.tasks[0].result_summary).toContain('Payment button');

      // Step 8: Verify memory decay happened
      const allMems = parse(await call('memory_recall', {}, e2eWorkspace));
      const decayedMem = allMems.memories.find(m => m.content.includes('Next.js'));
      expect(Number(decayedMem.relevance)).toBeLessThan(1.0);
    });
  });
});
