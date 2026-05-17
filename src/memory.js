/**
 * Memory Skill
 *
 * Provides test memory database tools via MCP (Dolt-backed).
 * The AI agent can query test history, selector stability, page model,
 * and navigation patterns from previous runs.
 *
 * Activated when SKILLS.MEMORY is included in node's skills array.
 * Throws clear errors if dolt or database not set up.
 */

import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';

const _require = createRequire(import.meta.url);

function resolveMemoryBin() {
  if (process.env.MCP_MEMORY_PATH) return process.env.MCP_MEMORY_PATH;
  try {
    return _require.resolve('@zibby/ui-memory/mcp-server');
  } catch {
    return null;
  }
}

export const memorySkill = {
  id: 'memory',
  serverName: 'memory',
  allowedTools: ['mcp__memory__*'],
  envKeys: [],
  description: 'Zibby Memory MCP Server (test history, selectors, page model)',

  async middleware() {
    try {
      const { createMemoryMiddleware } = await import('@zibby/ui-memory');
      return createMemoryMiddleware();
    } catch {
      return null;
    }
  },

  promptFragment: `BEFORE executing browser actions:
- Review any test memory/history above. Prefer selectors proven to work.
- If a previous run failed, avoid the same approach.
- After setup/login completes, navigate directly to the target page instead of clicking through menus.

DURING execution — when a selector fails and you switch to a fallback:
- Call memory_save_insight IMMEDIATELY with category: selector_tip
- Include: which stableId/selector failed, which fallback worked, and the page URL.

AFTER completing the test, you MUST call memory_save_insight at least once:
- Save any useful finding: reliable selectors, timing quirks, navigation patterns, workarounds.
- Category: selector_tip | timing | navigation | workaround | flaky | general
- Be specific — future runs will read your insights.`,

  resolve() {
    const bin = resolveMemoryBin();
    if (!bin) {
      throw new Error(
        '❌ Memory MCP server not found\n\n' +
        '  Install @zibby/ui-memory:\n' +
        '    npm install @zibby/ui-memory'
      );
    }

    const dbPath = join(process.cwd(), '.zibby', 'memory');
    if (!existsSync(join(dbPath, '.dolt'))) {
      throw new Error(
        '❌ Memory database not initialized\n\n' +
        '  Run:\n' +
        '    zibby init --mem'
      );
    }

    try {
      const raw = execFileSync('dolt', ['sql', '-q', 'SELECT COUNT(*) AS cnt FROM test_runs', '-r', 'json'], {
        cwd: dbPath, encoding: 'utf-8', timeout: 5_000,
      });
      const rows = JSON.parse(raw.trim()).rows || [];
      if (!rows[0] || rows[0].cnt === 0) {
        console.log('[memory] Database empty — memory tools activate after first completed run');
        return null;
      }
    } catch (err) {
      throw new Error(
        '❌ Dolt not found or memory database error\n\n' +
        '  Install Dolt:\n' +
        '    https://docs.dolthub.com/introduction/installation\n\n' +
        `  Error: ${err.message}`,
        { cause: err }
      );
    }

    return {
      command: 'node',
      args: [bin, '--db-path', dbPath],
      description: this.description,
    };
  },

  tools: [
    {
      name: 'memory_get_test_history',
      description: 'Query recent test runs with pass/fail results and timing',
      input_schema: {
        type: 'object',
        properties: {
          specPath: { type: 'string', description: 'Filter by spec path (substring match)' },
          limit: { type: 'number', description: 'Max results (default 10)' },
        },
      },
    },
    {
      name: 'memory_get_selectors',
      description: 'Query known selectors for a page with stability metrics',
      input_schema: {
        type: 'object',
        properties: {
          pageUrl: { type: 'string', description: 'Filter by page URL (substring match)' },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
      },
    },
    {
      name: 'memory_get_page_model',
      description: 'Query page structure — elements, roles, selectors',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Filter by page URL (substring match)' },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
      },
    },
    {
      name: 'memory_get_navigation',
      description: 'Query known page-to-page transitions',
      input_schema: {
        type: 'object',
        properties: {
          fromUrl: { type: 'string', description: 'Filter by source URL (substring match)' },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
      },
    },
    {
      name: 'memory_save_insight',
      description: 'Save a useful observation for future runs (selector tips, timing, workarounds)',
      input_schema: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['selector_tip', 'timing', 'navigation', 'workaround', 'flaky', 'general'], description: 'Type of insight' },
          content: { type: 'string', description: 'The insight text — be specific and actionable' },
          specPath: { type: 'string', description: 'Related spec path' },
          sessionId: { type: 'string', description: 'Current session ID' },
        },
        required: ['category', 'content'],
      },
    },
  ],
};
