/**
 * Chat Memory Skill
 *
 * Persistent memory and task history for the chat agent, backed by Dolt.
 * Adds tables to the existing .zibby/memory/ database (open/closed — does
 * not modify existing test memory tables).
 *
 * Inspired by OpenClaw's 4-layer architecture:
 *   Layer 1: Session context (chat history — handled by chat.js)
 *   Layer 2: Facts & context (this skill — chat_memory table)
 *   Layer 3: Session summaries (this skill — chat_sessions table)
 *   Layer 4: Search (this skill — memory_recall with SQL LIKE)
 *
 * Also tracks task history for cross-session persistence.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { randomBytes } from 'crypto';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';

const DB_DIR = '.zibby/memory';
const DOLT_BIN = 'dolt';
const EXEC_OPTS = { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000 };
const DEFAULT_MEMORY_BACKEND = 'dolt';
const _mem0Clients = new Map();
const _projectBackendCache = new Map();
const _moduleRequire = createRequire(import.meta.url);

const genId = () => randomBytes(8).toString('hex');
const now = () => new Date().toISOString();

const CHAT_TABLES = [
  `CREATE TABLE IF NOT EXISTS chat_memory (
    id            VARCHAR(64)  PRIMARY KEY,
    memory_key    VARCHAR(160),
    category      VARCHAR(32)  NOT NULL,
    content       TEXT         NOT NULL,
    source        VARCHAR(64),
    ticket_key    VARCHAR(32),
    session_id    VARCHAR(64),
    tier          VARCHAR(16)  DEFAULT 'mid',
    relevance     FLOAT        DEFAULT 1.0,
    created_at    VARCHAR(32)  NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS chat_tasks (
    id            VARCHAR(64)  PRIMARY KEY,
    ticket_key    VARCHAR(32),
    type          VARCHAR(32)  NOT NULL,
    title         VARCHAR(512) NOT NULL,
    status        VARCHAR(32)  NOT NULL DEFAULT 'pending',
    spec_path     VARCHAR(512),
    session_id    VARCHAR(64),
    result_summary TEXT,
    created_at    VARCHAR(32)  NOT NULL,
    finished_at   VARCHAR(32)
  )`,

  `CREATE TABLE IF NOT EXISTS chat_sessions (
    session_id    VARCHAR(64)  PRIMARY KEY,
    summary       TEXT         NOT NULL,
    tickets       TEXT,
    tasks_run     INT          DEFAULT 0,
    tasks_passed  INT          DEFAULT 0,
    tasks_failed  INT          DEFAULT 0,
    key_facts     TEXT,
    created_at    VARCHAR(32)  NOT NULL
  )`,
];

const _initializedPaths = new Set();

function doltExec(dbPath, args) {
  return execFileSync(DOLT_BIN, args, { ...EXEC_OPTS, cwd: dbPath });
}

function doltQuery(dbPath, sql) {
  try {
    const raw = doltExec(dbPath, ['sql', '-q', sql, '-r', 'json']);
    const parsed = JSON.parse(raw.trim());
    return parsed.rows || [];
  } catch {
    return [];
  }
}

function doltWrite(dbPath, sql) {
  doltExec(dbPath, ['sql', '-q', sql]);
}

function ensureTables(dbPath) {
  if (_initializedPaths.has(dbPath)) return true;
  if (!existsSync(join(dbPath, '.dolt'))) {
    if (!doltAvailable()) return false;
    mkdirSync(dbPath, { recursive: true });
    doltExec(dbPath, ['init', '--name', 'Zibby Chat Memory', '--email', 'chat@zibby.app']);
  }
  const combined = `${CHAT_TABLES.join(';\n')};`;
  doltWrite(dbPath, combined);
  try {
    doltWrite(dbPath, `ALTER TABLE chat_memory ADD COLUMN tier VARCHAR(16) DEFAULT 'mid'`);
  } catch { /* column already exists */ }
  try {
    doltWrite(dbPath, `ALTER TABLE chat_memory ADD COLUMN memory_key VARCHAR(160)`);
  } catch { /* column already exists */ }
  _initializedPaths.add(dbPath);
  return true;
}

export function _resetInitCache() {
  _initializedPaths.clear();
}

function doltAvailable() {
  try {
    execFileSync(DOLT_BIN, ['version'], { ...EXEC_OPTS, timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function esc(str) {
  if (str == null) return 'NULL';
  return `'${String(str).replace(/'/g, "''")}'`;
}

function normalizeMemoryContent(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[\s_-]+/g, ' ')
    .replace(/[^\w\s"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tierRank(tier) {
  if (tier === 'long') return 3;
  if (tier === 'mid') return 2;
  if (tier === 'short') return 1;
  return 0;
}

function normalizeTierForCategory(tier, category) {
  const requestedTier = ['short', 'mid', 'long'].includes(tier) ? tier : 'mid';
  const durableCategories = new Set(['fact', 'decision', 'preference', 'credential', 'url', 'workaround']);
  if (durableCategories.has(String(category || '').toLowerCase()) && requestedTier === 'short') {
    return 'mid';
  }
  return requestedTier;
}

function dedupeMemories(rows) {
  const byIdentity = new Map();
  for (const row of rows || []) {
    const norm = normalizeMemoryContent(row.content);
    const key = row.memory_key ? `key:${row.memory_key}` : (norm ? `norm:${norm}` : '');
    if (!key) continue;
    const prev = byIdentity.get(key);
    if (!prev) {
      byIdentity.set(key, row);
      continue;
    }
    const prevRank = tierRank(prev.tier);
    const currRank = tierRank(row.tier);
    if (currRank > prevRank) {
      byIdentity.set(key, row);
      continue;
    }
    if (currRank === prevRank && Number(row.relevance || 0) > Number(prev.relevance || 0)) {
      byIdentity.set(key, row);
    }
  }
  return [...byIdentity.values()];
}

function truncateText(text, maxLen) {
  const value = String(text ?? '');
  if (value.length <= maxLen) return value;
  if (maxLen <= 1) return value.slice(0, maxLen);
  return `${value.slice(0, maxLen - 1)}…`;
}

function normalizeBriefByBackend(brief, backend) {
  const normalized = {
    recentSessions: Array.isArray(brief?.recentSessions) ? brief.recentSessions : [],
    topMemories: Array.isArray(brief?.topMemories) ? brief.topMemories : [],
    taskStats: Array.isArray(brief?.taskStats) ? brief.taskStats : [],
    ticketFilter: brief?.ticketFilter || null,
    backend: backend || String(brief?.backend || DEFAULT_MEMORY_BACKEND),
    error: brief?.error || null,
  };
  if (normalized.backend === 'mem0') {
    return { ...normalized, recentSessions: [], taskStats: [] };
  }
  return normalized;
}

function buildPromptContextFromBrief(brief) {
  const lines = [];
  if (brief.recentSessions?.length > 0) {
    lines.push('Recent sessions:');
    for (const s of brief.recentSessions.slice(0, 3)) {
      if (!s?.summary?.trim()) continue;
      lines.push(`- ${truncateText(s.summary, 150)}${s.tickets ? ` [${s.tickets}]` : ''}`);
    }
  }
  if (brief.topMemories?.length > 0) {
    lines.push('Known facts:');
    for (const m of brief.topMemories.slice(0, 10)) {
      const tier = m.tier === 'long' ? '★' : '·';
      lines.push(`${tier} [${m.category}] ${truncateText(m.content, 120)}`);
    }
  }
  if (lines.length === 0) return '';
  return `## Memory Context\n${lines.join('\n')}`;
}

function buildBriefDebugPreview(brief) {
  return {
    backend: brief.backend,
    recentSessions: brief.recentSessions.slice(0, 3).map(s => ({
      summary: truncateText(String(s?.summary || ''), 160),
      tickets: s?.tickets || null,
      created_at: s?.created_at || null,
    })),
    topMemories: brief.topMemories.slice(0, 8).map(m => ({
      category: m?.category || null,
      tier: m?.tier || null,
      content: truncateText(String(m?.content || ''), 140),
      source: m?.source || null,
    })),
    taskStats: brief.taskStats,
    error: brief.error || null,
  };
}

async function resolveMemoryBackend(cwd, context) {
  const envBackend = String(process.env.ZIBBY_MEMORY_BACKEND || '').trim().toLowerCase();
  if (envBackend === 'mem0' || envBackend === 'dolt') return envBackend;

  const fromOptions = String(context?.options?.memoryBackend || context?.options?.config?.memory?.backend || '').trim().toLowerCase();
  if (fromOptions === 'mem0' || fromOptions === 'dolt') return fromOptions;

  if (_projectBackendCache.has(cwd)) return _projectBackendCache.get(cwd);
  try {
    const configPath = join(cwd, '.zibby.config.mjs');
    if (existsSync(configPath)) {
      const mod = await import(pathToFileURL(configPath).href);
      const cfgBackend = String(mod?.default?.memory?.backend || '').trim().toLowerCase();
      if (cfgBackend === 'mem0' || cfgBackend === 'dolt') {
        _projectBackendCache.set(cwd, cfgBackend);
        return cfgBackend;
      }
    }
  } catch { /* fallback to default */ }
  _projectBackendCache.set(cwd, DEFAULT_MEMORY_BACKEND);
  return DEFAULT_MEMORY_BACKEND;
}

function resolveMem0UserId(cwd) {
  const explicit = String(process.env.ZIBBY_MEMORY_USER_ID || '').trim();
  if (explicit) return explicit;
  return `workspace:${basename(cwd || process.cwd())}`;
}

function resolveMem0Config() {
  const configuredBaseUrl = String(process.env.ZIBBY_MEM0_OPENAI_BASE_URL || '').trim();
  if (!configuredBaseUrl) return null;

  const configuredApiKey = String(
    process.env.ZIBBY_MEM0_API_KEY
    || process.env.ZIBBY_USER_TOKEN
    || process.env.OPENAI_API_KEY
    || ''
  ).trim();
  const llmModel = String(process.env.ZIBBY_MEM0_LLM_MODEL || 'gpt-4.1-mini').trim();
  const embedModel = String(process.env.ZIBBY_MEM0_EMBEDDER_MODEL || 'text-embedding-3-small').trim();
  const embeddingDims = Number(process.env.ZIBBY_MEM0_EMBEDDING_DIMS || 1536);

  return {
    llm: {
      provider: 'openai',
      config: {
        model: llmModel,
        baseURL: configuredBaseUrl,
        ...(configuredApiKey ? { apiKey: configuredApiKey } : {}),
      },
    },
    embedder: {
      provider: 'openai',
      config: {
        model: embedModel,
        embeddingDims,
        baseURL: configuredBaseUrl,
        ...(configuredApiKey ? { apiKey: configuredApiKey } : {}),
      },
    },
    vectorStore: {
      provider: 'memory',
      config: { dimension: embeddingDims },
    },
  };
}

async function getMem0Client(cwd) {
  const key = cwd || process.cwd();
  if (_mem0Clients.has(key)) return _mem0Clients.get(key);
  let mod;
  try {
    const workspaceRequire = createRequire(pathToFileURL(join(key, 'package.json')).href);
    const resolved = workspaceRequire.resolve('mem0ai/oss');
    mod = await import(pathToFileURL(resolved).href);
  } catch {
    try {
      const resolved = _moduleRequire.resolve('mem0ai/oss');
      mod = await import(pathToFileURL(resolved).href);
    } catch (e) {
      throw new Error(`Cannot find package 'mem0ai' for workspace "${key}". Install in that project: npm install mem0ai. (${e.message})`, { cause: e });
    }
  }
  const MemoryClass = mod?.Memory;
  if (!MemoryClass) throw new Error('mem0ai/oss does not export Memory');
  const config = resolveMem0Config();
  const client = config ? new MemoryClass(config) : new MemoryClass();
  _mem0Clients.set(key, client);
  return client;
}

function mapMem0ResultsToRows(raw, fallbackTier = 'mid') {
  const results = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.results)
      ? raw.results
      : [];
  return results.map(item => ({
    // Normalize tier by category so durable preferences/facts remain available in brief context.
    // Mem0 may retain legacy metadata where tier was stored as short.
    id: item?.id || genId(),
    memory_key: item?.metadata?.memoryKey || item?.metadata?.memory_key || null,
    category: item?.metadata?.category || 'fact',
    content: item?.memory || item?.content || '',
    source: item?.metadata?.source || 'mem0',
    ticket_key: item?.metadata?.ticketKey || item?.metadata?.ticket_key || null,
    tier: normalizeTierForCategory(item?.metadata?.tier || fallbackTier, item?.metadata?.category || 'fact'),
    relevance: Number(item?.score ?? item?.metadata?.relevance ?? 0.8),
    created_at: item?.created_at || item?.metadata?.created_at || now(),
  })).filter(r => String(r.content || '').trim().length > 0);
}

export const chatMemorySkill = {
  id: 'chat-memory',
  description: 'Persistent chat memory and task history (Dolt-backed)',
  envKeys: [],

  promptFragment: `## Chat Memory (persistent)
You have persistent memory across sessions. Use it to avoid losing context:
- **memory_store**: Save important facts, decisions, or context. Anything worth remembering.
- **memory_recall**: Search your memory by keyword or category. Use this at the START of conversations to recall relevant context.
- **memory_brief**: Get a compact summary of recent sessions and key facts. Load this when starting a new task to understand history.
- **memory_end_session**: Call when a task is complete. Summarizes what happened for future recall.
- **task_log**: Record a completed task (test run, analysis, etc.) for history.
- **task_history**: Query past tasks by ticket, status, or type.

### When to use memory
- At the START of a conversation: call memory_recall or memory_brief to load relevant context
- When you learn something important: call memory_store (e.g. "SCRUM-123 login page is at /auth/login")
- When a task finishes: call task_log to record it
- When the user's request is complete: call memory_end_session

### Categories for memory_store
fact, decision, context, insight, credential, url, error, workaround`,

  resolve() {
    return null;
  },

  async buildPromptContext(context, args = {}) {
    const cwd = context?.options?.workspace || process.cwd();
    const dbPath = join(cwd, DB_DIR);
    const backend = await resolveMemoryBackend(cwd, context);

    if (backend === 'dolt' && !ensureTables(dbPath)) {
      const error = 'Dolt not available. Install: brew install dolt (macOS) or see https://docs.dolthub.com/introduction/installation';
      return {
        backend,
        brief: normalizeBriefByBackend({ backend, error }, backend),
        promptContext: '',
        debugPreview: buildBriefDebugPreview(normalizeBriefByBackend({ backend, error }, backend)),
        error,
      };
    }

    try {
      const briefRaw = backend === 'mem0'
        ? await handleBriefMem0(args, dbPath, cwd)
        : handleBrief(args, dbPath);
      const parsed = JSON.parse(briefRaw || '{}');
      const brief = normalizeBriefByBackend({ ...parsed, backend }, backend);
      return {
        backend,
        brief,
        promptContext: buildPromptContextFromBrief(brief),
        debugPreview: buildBriefDebugPreview(brief),
        error: brief.error || null,
      };
    } catch (e) {
      const error = String(e?.message || e);
      const brief = normalizeBriefByBackend({ backend, error }, backend);
      return {
        backend,
        brief,
        promptContext: '',
        debugPreview: buildBriefDebugPreview(brief),
        error,
      };
    }
  },

  async handleToolCall(name, args, context) {
    const cwd = context?.options?.workspace || process.cwd();
    const dbPath = join(cwd, DB_DIR);
    const backend = await resolveMemoryBackend(cwd, context);
    const needsDolt = backend === 'dolt' || ['memory_end_session', 'task_log', 'task_history'].includes(name);
    if (needsDolt && !ensureTables(dbPath)) {
      return JSON.stringify({
        error: 'Dolt not available. Install: brew install dolt (macOS) or see https://docs.dolthub.com/introduction/installation',
      });
    }

    try {
      switch (name) {
        case 'memory_store':
          return backend === 'mem0'
            ? await handleStoreMem0(args, dbPath, cwd)
            : handleStore(args, dbPath);
        case 'memory_recall':
          return backend === 'mem0'
            ? await handleRecallMem0(args, dbPath, cwd)
            : handleRecall(args, dbPath);
        case 'memory_brief':
          return backend === 'mem0'
            ? await handleBriefMem0(args, dbPath, cwd)
            : handleBrief(args, dbPath);
        case 'memory_end_session': return handleEndSession(args, dbPath);
        case 'task_log': return handleTaskLog(args, dbPath);
        case 'task_history': return handleTaskHistory(args, dbPath);
        default: return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (e) {
      if (backend === 'mem0') {
        throw new Error(`mem0 throw: ${e.message}`, { cause: e });
      }
      return JSON.stringify({ error: e.message });
    }
  },

  tools: [
    {
      name: 'memory_store',
      description: 'Save a fact, decision, or context to persistent memory. Survives across sessions.',
      input_schema: {
        type: 'object',
        properties: {
          memoryKey: { type: 'string', description: 'Stable semantic identity key (e.g. user.jira.default_board)' },
          content: { type: 'string', description: 'The information to remember' },
          category: { type: 'string', enum: ['fact', 'decision', 'context', 'insight', 'preference', 'credential', 'url', 'error', 'workaround'], description: 'Category of memory' },
          tier: { type: 'string', enum: ['short', 'mid', 'long'], description: 'Memory tier: short (session/24h), mid (days/weeks), long (permanent)' },
          source: { type: 'string', description: 'Where this info came from (e.g. "jira", "github", "user", "test_run")' },
          ticketKey: { type: 'string', description: 'Related ticket key (optional)' },
        },
        required: ['content', 'category'],
      },
    },
    {
      name: 'memory_recall',
      description: 'Search persistent memory by keyword, category, ticket, or tier. Returns matching facts and context.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text (matches content)' },
          category: { type: 'string', description: 'Filter by category' },
          ticketKey: { type: 'string', description: 'Filter by ticket key' },
          tier: { type: 'string', enum: ['short', 'mid', 'long'], description: 'Filter by memory tier' },
          limit: { type: 'number', description: 'Max results (default: 20)' },
        },
      },
    },
    {
      name: 'memory_brief',
      description: 'Get a compact briefing: recent session summaries + top relevant facts. Call at the start of a conversation.',
      input_schema: {
        type: 'object',
        properties: {
          ticketKey: { type: 'string', description: 'Focus briefing on a specific ticket (optional)' },
        },
      },
    },
    {
      name: 'memory_end_session',
      description: 'End the current session and save a summary for future recall. Call when a task is complete.',
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'What happened in this session (1-3 sentences)' },
          tickets: { type: 'string', description: 'Comma-separated ticket keys covered' },
          tasksRun: { type: 'number', description: 'Number of tasks/tests run' },
          tasksPassed: { type: 'number', description: 'Number passed' },
          tasksFailed: { type: 'number', description: 'Number failed' },
          keyFacts: { type: 'string', description: 'Key facts worth remembering from this session (semicolon-separated)' },
        },
        required: ['summary'],
      },
    },
    {
      name: 'task_log',
      description: 'Record a completed task (test run, analysis, generation) to persistent history.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task description' },
          type: { type: 'string', enum: ['test_run', 'generate', 'analysis', 'research', 'other'], description: 'Task type' },
          status: { type: 'string', enum: ['passed', 'failed', 'cancelled', 'error'], description: 'Outcome' },
          ticketKey: { type: 'string', description: 'Related ticket key' },
          specPath: { type: 'string', description: 'Spec file path (if test run)' },
          resultSummary: { type: 'string', description: 'Brief result description' },
        },
        required: ['title', 'type', 'status'],
      },
    },
    {
      name: 'task_history',
      description: 'Query past tasks by ticket, status, or type. See what was done before.',
      input_schema: {
        type: 'object',
        properties: {
          ticketKey: { type: 'string', description: 'Filter by ticket key' },
          type: { type: 'string', description: 'Filter by task type' },
          status: { type: 'string', description: 'Filter by status' },
          limit: { type: 'number', description: 'Max results (default: 20)' },
        },
      },
    },
  ],
};

function handleStore(args, dbPath) {
  const { content, category, source, ticketKey, tier, memoryKey } = args;
  if (!content || !category) return JSON.stringify({ error: 'content and category are required' });

  const normalized = normalizeMemoryContent(content);
  if (!normalized) return JSON.stringify({ error: 'content is empty after normalization' });

  const memTier = normalizeTierForCategory(tier, category);
  const relevance = memTier === 'long' ? 1.0 : memTier === 'mid' ? 0.8 : 0.5;
  const key = String(memoryKey || '').trim().slice(0, 160);
  if (key) {
    const keyed = doltQuery(dbPath, `SELECT id, tier, relevance
      FROM chat_memory
      WHERE memory_key = ${esc(key)}
      ORDER BY created_at DESC
      LIMIT 1`);
    const existing = keyed[0];
    if (existing) {
      const existingTier = String(existing.tier || 'mid');
      const existingRelevance = Number(existing.relevance || 0);
      const nextTier = tierRank(memTier) > tierRank(existingTier) ? memTier : existingTier;
      const nextRelevance = Math.max(relevance, existingRelevance);
      doltWrite(dbPath, `UPDATE chat_memory
        SET content = ${esc(content)},
            category = ${esc(category)},
            source = ${esc(source)},
            ticket_key = ${esc(ticketKey)},
            tier = ${esc(nextTier)},
            relevance = ${nextRelevance},
            created_at = ${esc(now())}
        WHERE id = ${esc(existing.id)}`);
      try { doltExec(dbPath, ['add', '.']); doltExec(dbPath, ['commit', '-m', `memory upsert: ${category} — ${String(content).slice(0, 60)}`]); } catch { /* non-critical */ }
      return JSON.stringify({ ok: true, id: existing.id, category, tier: nextTier, memoryKey: key, upserted: true });
    }
  }

  const existing = doltQuery(dbPath, `SELECT id, content, tier, relevance
     FROM chat_memory
     WHERE category = ${esc(category)}
     ORDER BY created_at DESC
     LIMIT 200`);
  const duplicate = existing.find(m => normalizeMemoryContent(m.content) === normalized);

  if (duplicate) {
    const existingTier = String(duplicate.tier || 'mid');
    const existingRelevance = Number(duplicate.relevance || 0);
    const shouldPromoteTier = tierRank(memTier) > tierRank(existingTier);
    const shouldPromoteRelevance = relevance > existingRelevance;
    if (shouldPromoteTier || shouldPromoteRelevance) {
      doltWrite(dbPath, `UPDATE chat_memory
        SET tier = ${esc(shouldPromoteTier ? memTier : existingTier)},
            relevance = ${Math.max(relevance, existingRelevance)}
        WHERE id = ${esc(duplicate.id)}`);
      try { doltExec(dbPath, ['add', '.']); doltExec(dbPath, ['commit', '-m', `memory promote: ${category} — ${String(content).slice(0, 60)}`]); } catch { /* non-critical */ }
      return JSON.stringify({ ok: true, id: duplicate.id, category, tier: shouldPromoteTier ? memTier : existingTier, deduped: true, promoted: true });
    }
    return JSON.stringify({ ok: true, id: duplicate.id, category, tier: existingTier, deduped: true, promoted: false });
  }

  const id = genId();
  const sessionId = process.env.ZIBBY_CHAT_SESSION_ID || null;
  doltWrite(dbPath,
    `INSERT INTO chat_memory (id, memory_key, category, content, source, ticket_key, session_id, tier, relevance, created_at)
     VALUES (${esc(id)}, ${esc(key || null)}, ${esc(category)}, ${esc(content)}, ${esc(source)}, ${esc(ticketKey)}, ${esc(sessionId)}, ${esc(memTier)}, ${relevance}, ${esc(now())})`
  );

  try { doltExec(dbPath, ['add', '.']); doltExec(dbPath, ['commit', '-m', `memory: ${category} — ${content.slice(0, 60)}`]); } catch { /* non-critical */ }

  return JSON.stringify({ ok: true, id, category, tier: memTier, memoryKey: key || null, stored: content.slice(0, 100) });
}

async function handleStoreMem0(args, _dbPath, cwd) {
  const { content, category, source, ticketKey, tier, memoryKey } = args;
  if (!content || !category) return JSON.stringify({ error: 'content and category are required' });
  try {
    const client = await getMem0Client(cwd);
    const userId = resolveMem0UserId(cwd);
    const memTier = normalizeTierForCategory(tier, category);
    await client.add(
      [{ role: 'user', content: String(content) }],
      {
        userId,
        metadata: {
          memoryKey: memoryKey || null,
          category,
          tier: memTier,
          source: source || 'zibby-chat',
          ticketKey: ticketKey || null,
          created_at: now(),
        },
      }
    );
    return JSON.stringify({
      ok: true,
      backend: 'mem0',
      userId,
      category,
      tier: memTier,
      memoryKey: memoryKey || null,
      stored: String(content).slice(0, 100),
    });
  } catch (e) {
    throw new Error(`mem0 store failed: ${e.message}. If mem0 is not installed, run: npm install mem0ai`, { cause: e });
  }
}

function handleRecall(args, dbPath) {
  const { query, category, ticketKey, tier, limit = 20 } = args;

  const conditions = [];
  if (query) conditions.push(`content LIKE ${esc(`%${query}%`)}`);
  if (category) conditions.push(`category = ${esc(category)}`);
  if (ticketKey) conditions.push(`ticket_key = ${esc(ticketKey)}`);
  if (tier) conditions.push(`tier = ${esc(tier)}`);

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT id, memory_key, category, content, source, ticket_key, tier, relevance, created_at
               FROM chat_memory ${where}
               ORDER BY relevance DESC, created_at DESC
               LIMIT ${limit}`;

  const rows = doltQuery(dbPath, sql);
  return JSON.stringify({ total: rows.length, memories: rows });
}

async function handleRecallMem0(args, _dbPath, cwd) {
  const { query, category, ticketKey, tier, limit = 20 } = args;
  try {
    const client = await getMem0Client(cwd);
    const userId = resolveMem0UserId(cwd);
    let rows = [];
    if (query && String(query).trim()) {
      const result = await client.search(String(query), { userId, limit });
      rows = mapMem0ResultsToRows(result);
    } else {
      const all = await client.getAll({ userId, limit: Math.max(limit, 50) });
      rows = mapMem0ResultsToRows(all);
    }

    if (category) rows = rows.filter(r => r.category === category);
    if (ticketKey) rows = rows.filter(r => r.ticket_key === ticketKey);
    if (tier) rows = rows.filter(r => r.tier === tier);
    rows = rows.slice(0, limit);

    return JSON.stringify({ total: rows.length, memories: rows, backend: 'mem0' });
  } catch (e) {
    throw new Error(`mem0 recall failed: ${e.message}. If mem0 is not installed, run: npm install mem0ai`, { cause: e });
  }
}

function handleBrief(args, dbPath) {
  const { ticketKey } = args;

  expireShortTermMemories(dbPath);

  const sessionsSql = `SELECT session_id, summary, tickets, tasks_run, tasks_passed, tasks_failed, created_at
                       FROM chat_sessions ORDER BY created_at DESC LIMIT 5`;
  const sessions = doltQuery(dbPath, sessionsSql);

  const ticketFilter = ticketKey ? `AND ticket_key = ${esc(ticketKey)}` : '';
  const longMem = doltQuery(dbPath,
    `SELECT memory_key, category, content, source, tier, relevance, created_at FROM chat_memory
     WHERE tier = 'long' ${ticketFilter} ORDER BY relevance DESC, created_at DESC LIMIT 10`);
  const midMem = doltQuery(dbPath,
    `SELECT memory_key, category, content, source, tier, relevance, created_at FROM chat_memory
     WHERE tier = 'mid' ${ticketFilter} ORDER BY relevance DESC, created_at DESC LIMIT 8`);

  const tasksSql = `SELECT type, status, COUNT(*) as cnt FROM chat_tasks
                    GROUP BY type, status ORDER BY cnt DESC LIMIT 10`;
  const taskStats = doltQuery(dbPath, tasksSql);

  const deduped = dedupeMemories([...longMem, ...midMem]);

  return JSON.stringify({
    recentSessions: sessions,
    topMemories: deduped,
    taskStats,
    ticketFilter: ticketKey || null,
  });
}

async function handleBriefMem0(args, dbPath, cwd) {
  const { ticketKey } = args;
  // Mem0 adapter should not leak legacy Dolt session/task data into prompt context.
  // Keep memory briefing source-consistent when backend is mem0.
  const recallRaw = await handleRecallMem0({ limit: 80 }, dbPath, cwd);
  const parsed = JSON.parse(recallRaw || '{}');

  let mem = Array.isArray(parsed.memories) ? parsed.memories : [];
  if (ticketKey) mem = mem.filter(m => m.ticket_key === ticketKey);
  const scoreForBrief = (m) => {
    const created = Date.parse(String(m?.created_at || '')) || 0;
    const relevance = Number(m?.relevance || 0);
    return (relevance * 1_000_000_000_000) + created;
  };
  const byPriority = (a, b) => scoreForBrief(b) - scoreForBrief(a);
  const longMem = mem.filter(m => m.tier === 'long').sort(byPriority).slice(0, 10);
  const midMem = mem.filter(m => m.tier === 'mid').sort(byPriority).slice(0, 8);
  const deduped = dedupeMemories([...longMem, ...midMem]);

  return JSON.stringify({
    recentSessions: [],
    topMemories: deduped,
    taskStats: [],
    ticketFilter: ticketKey || null,
    backend: 'mem0',
  });
}

function handleEndSession(args, dbPath) {
  const { summary, tickets, tasksRun = 0, tasksPassed = 0, tasksFailed = 0, keyFacts } = args;
  if (!summary) return JSON.stringify({ error: 'summary is required' });

  const sessionId = process.env.ZIBBY_CHAT_SESSION_ID || `session_${genId()}`;

  doltWrite(dbPath,
    `INSERT INTO chat_sessions (session_id, summary, tickets, tasks_run, tasks_passed, tasks_failed, key_facts, created_at)
     VALUES (${esc(sessionId)}, ${esc(summary)}, ${esc(tickets)}, ${tasksRun}, ${tasksPassed}, ${tasksFailed}, ${esc(keyFacts)}, ${esc(now())})`
  );

  if (keyFacts) {
    for (const fact of keyFacts.split(';').map(f => f.trim()).filter(Boolean)) {
      handleStore({
        content: fact,
        category: 'fact',
        source: 'session_summary',
        tier: 'mid',
      }, dbPath);
    }
  }

  decayOldMemories(dbPath);

  try { doltExec(dbPath, ['add', '.']); doltExec(dbPath, ['commit', '-m', `session end: ${summary.slice(0, 60)}`]); } catch { /* non-critical */ }

  return JSON.stringify({ ok: true, sessionId, summary: summary.slice(0, 200) });
}

function handleTaskLog(args, dbPath) {
  const { title, type, status, ticketKey, specPath, resultSummary } = args;
  if (!title || !type || !status) return JSON.stringify({ error: 'title, type, and status are required' });

  const id = genId();
  const sessionId = process.env.ZIBBY_CHAT_SESSION_ID || null;

  doltWrite(dbPath,
    `INSERT INTO chat_tasks (id, ticket_key, type, title, status, spec_path, session_id, result_summary, created_at, finished_at)
     VALUES (${esc(id)}, ${esc(ticketKey)}, ${esc(type)}, ${esc(title)}, ${esc(status)}, ${esc(specPath)}, ${esc(sessionId)}, ${esc(resultSummary)}, ${esc(now())}, ${esc(now())})`
  );

  try { doltExec(dbPath, ['add', '.']); doltExec(dbPath, ['commit', '-m', `task: ${status} — ${title.slice(0, 60)}`]); } catch { /* non-critical */ }

  return JSON.stringify({ ok: true, id, title, type, status });
}

function handleTaskHistory(args, dbPath) {
  const { ticketKey, type, status, limit = 20 } = args;

  const conditions = [];
  if (ticketKey) conditions.push(`ticket_key = ${esc(ticketKey)}`);
  if (type) conditions.push(`type = ${esc(type)}`);
  if (status) conditions.push(`status = ${esc(status)}`);

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT id, ticket_key, type, title, status, spec_path, result_summary, created_at, finished_at
               FROM chat_tasks ${where}
               ORDER BY created_at DESC LIMIT ${limit}`;

  const rows = doltQuery(dbPath, sql);
  return JSON.stringify({ total: rows.length, tasks: rows });
}

function decayOldMemories(dbPath) {
  try {
    doltWrite(dbPath, `UPDATE chat_memory SET relevance = relevance * 0.98 WHERE tier = 'long' AND relevance > 0.5`);
    doltWrite(dbPath, `UPDATE chat_memory SET relevance = relevance * 0.90 WHERE tier = 'mid' AND relevance > 0.1`);
    doltWrite(dbPath, `UPDATE chat_memory SET relevance = relevance * 0.70 WHERE tier = 'short' AND relevance > 0.05`);
    doltWrite(dbPath, `DELETE FROM chat_memory WHERE relevance < 0.05`);
  } catch { /* non-critical */ }
}

function expireShortTermMemories(dbPath) {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    doltWrite(dbPath, `DELETE FROM chat_memory WHERE tier = 'short' AND created_at < ${esc(cutoff)}`);
  } catch { /* non-critical */ }
}
