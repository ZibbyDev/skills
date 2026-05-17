import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, unlinkSync, createWriteStream, statSync } from 'fs';
import { resolve, join } from 'path';
import { resolveMaxParallelRuns } from '@zibby/core/utils/parallel-config.js';
import { zibbyScratchSpecsDir } from '@zibby/core/constants/zibby-scratch.js';

const SESSIONS_DIR = 'sessions';
const OUTPUT_BASE = '.zibby/output';
const streamNodeProgress = process.env.ZIBBY_RUNNER_NODE_PROGRESS === '1';
const streamRunnerStatus = process.env.ZIBBY_RUNNER_STATUS_STREAM === '1';
const streamSpawnLogs = process.env.ZIBBY_RUNNER_SPAWN_LOGS === '1';

const activeRuns = new Map();
const pendingQueue = [];
let runCounter = 0;
let lastSpawnTime = 0;
const SPAWN_STAGGER_MS = 3000;

function genRunId() {
  return `run_${++runCounter}_${Date.now().toString(36)}`;
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex -- strip ANSI escape sequences from subprocess output
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function emitStatus(label, symbol, message) {
  if (!streamRunnerStatus) return;
  const line = `\n  ${symbol} [${label}] ${message}\n`;
  try { process.stderr.write(line); } catch {}
}

function killAllRuns() {
  pendingQueue.length = 0;
  for (const [, run] of activeRuns) {
    if (run.status === 'queued') run.status = 'cancelled';
    if (run.status === 'running' && run._child) {
      try { run._child.kill('SIGTERM'); } catch {}
    }
  }
}

process.on('exit', killAllRuns);
process.on('SIGINT', () => { killAllRuns(); process.exit(0); });
process.on('SIGTERM', () => { killAllRuns(); process.exit(0); });

export const testRunnerSkill = {
  id: 'runner',
  description: 'Run zibby test workflows from chat (parallel supported)',
  envKeys: [],

  promptFragment: `## Test Runner
You can run zibby test workflows directly from chat:

**CRITICAL: When user asks to test a ticket:**
1. Load the issue with your tracker tools (whatever is connected)
2. Check comments/description for test steps
3. IF steps found → Use inline format: run_test({ spec: "inline:<steps>", ticketKey: "KEY" })
4. IF NO steps AND local codebase → Use run_generate
5. Tell the user tests are running — they can ask for progress anytime

**Jira-shaped \`spec\` (e.g. SCRUM-408):** If the **jira** skill is active, the runner loads that issue (description + comments) and runs it as an inline spec. Otherwise use \`inline:\`+steps or a file path. Prefer explicit \`inline:\` when you want full control.

Tools:
- **run_test**: spec = file path, inline:+steps, or Jira KEY-123 (auto-loads issue when jira skill is on).
- **run_status**: Instant progress check (runId or "all")
- **run_generate**: Generate specs from codebase. ONLY use if NO steps in ticket AND local codebase exists.
- **run_artifacts**: Read test results/logs after completion
- **run_diagnose**: Diagnose failures
- **run_cancel**: Kill running test
- **list_specs**: List spec files

### MANDATORY: When User Asks to Test a Ticket

1. **ALWAYS load ticket first** using Jira/issue tools (jira_get_issue, jira_get_comments)
2. **Check comments AND description** for test steps
3. **If steps found** → IMMEDIATELY call run_test with inline format: run_test({ spec: "inline:Navigate to...\\nClick...\\nVerify...", ticketKey: "SCRUM-123" })
4. **DO NOT say "can't run"** until you've ACTUALLY fetched the ticket and confirmed NO steps exist
5. **If NO steps found** → Ask user to add steps OR use run_generate (only if local codebase)

### DECISION TREE: When User Says "Test This Ticket"

**STEP 1: Get full issue/ticket information**
ALWAYS use your connected issue tools to load the item and discussion (full description/body + comments). Tool names differ by integration (e.g. Jira vs GitHub vs Linear)—use what you have.

**STEP 2: Check if testing steps exist**
Look for testing steps in:
- Comments (most common)
- Description field
- Keywords like "test steps", "testing steps", numbered lists (1. 2. 3.)

IF testing steps found:
  → GOTO Workflow A (Use Existing Steps)
ELSE:
  → GOTO Workflow B (Generate from Codebase)

### Workflow A: Use Existing Steps (NO CODEBASE NEEDED)
**MANDATORY when ticket has test steps in comments/description**

CRITICAL: If you see test steps in the ticket, DO NOT call run_generate. Use inline format instead.

Steps:
1. Extract steps from ticket (comments or description)
2. Format as inline spec: "inline:" + steps text
3. Call run_test({ spec: "inline:...", ticketKey: "SCRUM-123" })
4. Tell the user tests are running
5. Use run_status when they ask for progress

Example: If ticket SCRUM-408 comment has test steps, call: run_test({ spec: "inline:Navigate to URL\\nVerify checkboxes\\nCheck first\\nUncheck second", ticketKey: "SCRUM-408" })

### Workflow B: Generate from Codebase (REQUIRES CODEBASE)
**ONLY use when ALL these are true:**
- ❌ NO testing steps in ticket comments/description
- ✅ Local codebase exists (not external URL like heroku)
- ✅ Ticket describes NEW functionality to test

**STOP AND USE WORKFLOW A IF:**
  - Testing steps exist in ticket → NEVER call run_generate, use inline format
  - Ticket mentions external app (heroku, cloud, demo sites) → Use inline with URL
  - No local codebase → Ask user for steps

**BEFORE calling run_generate, ask yourself:**
  - Did I check ALL comments? (not just description)
  - Are there ANY step lists (numbered, bulleted)?
  - Does ticket mention external URLs?
  - If YES to any: DO NOT call run_generate!

**If checks pass:**
1. Call run_generate({ ticket: "SCRUM-123" })
   - Spawns Claude/Cursor with file access
   - Explores codebase (1-3 minutes)
   - Returns generated spec file paths
2. For EACH file: run_test({ spec: "test-specs/...", ticketKey: "SCRUM-123" })
3. Tell the user tests are running

### Example Decision Process
(Illustration uses Jira-shaped keys/tools; substitute your session's issue integration.)

**User:** "Test SCRUM-408"

Step-by-step:
1. jira_get_issue({ issueKey: "SCRUM-408" }) - get summary, description
2. jira_get_comments({ issueKey: "SCRUM-408" }) - get comments
3. Check: Comment has "Testing steps: 1. Go to /checkboxes 2. Verify..."
4. Decision: Steps exist → Use Workflow A
5. run_test({ 
     spec: "inline:Navigate to https://the-internet.herokuapp.com/checkboxes, verify two checkboxes, check first, uncheck second, verify states",
     ticketKey: "SCRUM-408"
   })

**User:** "Test SCRUM-999 (new feature)"

Step-by-step:
1. jira_get_issue({ issueKey: "SCRUM-999" })
2. jira_get_comments({ issueKey: "SCRUM-999" })
3. Check: No testing steps found in ticket
4. Check: Codebase exists (package.json, src/ in current dir)
5. Decision: No steps + codebase → Use Workflow B
6. run_generate({ ticket: "SCRUM-999" })
7. Wait for spec files...
8. run_test for each file
9. Tell the user tests are running

### After Starting Runs
- run_test starts async work — tell the user tests are running.
- Use run_status to check progress when asked.
- To poll for completion, use the general wait tool (e.g. wait 20s) then run_status. Repeat until done.
- If any run failed/error/cancelled and user asks "why", call run_diagnose.

⚠️ NEVER AUTO-CANCEL RUNS:
- Tests take 1-5 minutes to complete. A "running" status is NORMAL — it does NOT mean stuck.
- NEVER call run_cancel unless the USER explicitly asks you to cancel/stop.
- If a run is still "running" after polling, just TELL the user it's still in progress and WAIT.
- The workflow has multiple nodes (preflight → execute_live → generate_script). Each takes time. This is expected.
- DO NOT interpret "running" as "stuck". DO NOT cancel on your own.

### Parallelism
- Each test CASE should be its own run_test call
- Runs auto-queue past parallel.maxConcurrentRuns in .zibby.config.mjs (default 8; caps Studio Mission Control lanes too)
- If agent is Cursor and you see "Security process exited with code: 45", avoid parallel launch for that batch; run tests sequentially (one run_test + wait, then next).

### Artifacts
Each run generates:
- result.json: Pass/fail verdict
- recording.webm: Video of session
- events.json: All browser events
- raw_stream_output.txt: Agent log

Use run_artifacts({ runId, type }) and run_diagnose({ runId }) to inspect and explain failures.`,

  resolve() {
    return null;
  },

  async handleToolCall(name, args, context) {
    const cwd = context?.options?.workspace || process.cwd();

    try {
      switch (name) {
        case 'run_generate': return await handleRunGenerate(args, cwd);
        case 'run_test': return await handleRunTest(args, cwd, context);
        case 'run_status': return handleRunStatus(args);
        case 'run_cancel': return handleRunCancel(args);
        case 'run_artifacts': return handleRunArtifacts(args, cwd);
        case 'run_diagnose': return handleRunDiagnose(args, cwd);
        case 'list_specs': return handleListSpecs(args, cwd);
        default: return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  },

  tools: [
    {
      name: 'run_generate',
      description: 'Generate specs from codebase. CRITICAL: DO NOT USE if ticket has test steps in comments. Only use when: (1) NO steps in ticket AND (2) local codebase exists (not external URLs). For tickets with steps, use run_test with inline format.',
      input_schema: {
        type: 'object',
        properties: {
          ticket: { type: 'string', description: 'Jira ticket key (e.g. SCRUM-123). Auto-fetches ticket details.' },
          description: { type: 'string', description: 'Ticket description text (use if no Jira key available)' },
          input: { type: 'string', description: 'Path to a file containing ticket/requirements text' },
          repo: { type: 'string', description: 'Path to the codebase (default: current directory)' },
          agent: { type: 'string', description: 'Optional agent override (cursor, gemini, claude, codex, assistant). Omit to use configured agent.' },
          output: { type: 'string', description: 'Output directory for spec files (default: test-specs)' },
        },
      },
    },
    {
      name: 'run_test',
      description: `Start a test (async, returns runId). spec = file path, or inline:+steps, or a Jira-shaped issue key (e.g. PROJ-123): when Jira is connected, the runner loads that issue's description+comments into an inline spec. After starting, tell the user and let them ask for progress via run_status.`,
      input_schema: {
        type: 'object',
        properties: {
          spec: { type: 'string', description: 'Workspace file path; or inline:+steps; or Jira issue key (KEY-123) to auto-fetch from Jira when the jira skill is active.' },
          ticketKey: { type: 'string', description: 'Optional label (e.g. SCRUM-123). If spec is an issue key, this defaults to that key.' },
          agent: { type: 'string', description: 'Optional agent override (cursor, gemini, claude, codex, assistant). Omit to use configured agent.' },
          headless: { type: 'boolean', description: 'Run browser headless (default false)' },
          workflow: { type: 'string', description: 'Workflow override (e.g. quick-smoke)' },
        },
        required: ['spec'],
      },
    },
    {
      name: 'run_status',
      description: 'Instant progress check — returns immediately. Use this whenever user asks about test progress. ALWAYS use runId="all".',
      input_schema: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'Use "all" to see all runs in this session (recommended). Or a specific run ID if known.' },
        },
        required: ['runId'],
      },
    },
    {
      name: 'run_cancel',
      description: 'Cancel/kill a running test. ONLY use when the USER explicitly asks to cancel or stop a run. NEVER auto-cancel — tests take 1-5 minutes and "running" is normal. Use runId="all" to cancel all active runs.',
      input_schema: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'Run ID to cancel, or "all" to cancel all active runs' },
        },
        required: ['runId'],
      },
    },
    {
      name: 'run_artifacts',
      description: 'Read artifacts from a test run session. Can list files, read results/events/logs, or search across all sessions.',
      input_schema: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'Run ID from run_test. Omit to search across all sessions.' },
          type: {
            type: 'string',
            enum: ['list', 'result', 'events', 'log', 'search'],
            description: 'What to retrieve: "list" = all files in session, "result" = result.json, "events" = events.json, "log" = raw output tail, "search" = search text across sessions',
          },
          node: { type: 'string', description: 'Node name to read from (e.g. "execute_live", "generate_script"). Default: "execute_live"' },
          query: { type: 'string', description: 'Search text (only for type="search"). Searches across all session logs/events.' },
          tail: { type: 'number', description: 'Number of characters from end of log to return (default: 3000)' },
        },
        required: ['type'],
      },
    },
    {
      name: 'run_diagnose',
      description: 'Diagnose one or all runs, especially failed ones. Uses run logs + known error patterns and returns likely root cause with suggested next action.',
      input_schema: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'Run ID from run_test, or "all" (default) to diagnose all known runs' },
          tail: { type: 'number', description: 'Characters of run log tail to inspect (default: 2000)' },
        },
      },
    },
    {
      name: 'list_specs',
      description: 'List available test spec files in the project',
      input_schema: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: 'Directory to scan (default: "test-specs")' },
        },
      },
    },
  ],
};

function runningCount() {
  let n = 0;
  for (const [, r] of activeRuns) { if (r.status === 'running') n++; }
  return n;
}

function drainQueue() {
  while (pendingQueue.length > 0) {
    const max = resolveMaxParallelRuns(pendingQueue[0]?.context?.options?.config);
    if (runningCount() >= max) break;
    const { args, cwd, context } = pendingQueue.shift();
    spawnRun(args, cwd, context);
  }
}

async function handleRunGenerate(args, cwd) {
  const { ticket, description, input, repo, agent, output } = args;

  const cliArgs = ['generate'];
  if (ticket) cliArgs.push('--ticket', ticket);
  if (description) cliArgs.push('--description', description);
  if (input) cliArgs.push('--input', input);
  if (repo) cliArgs.push('--repo', repo);
  if (output) cliArgs.push('--output', output);

  // Validate agent - only use if it's a recognized agent type
  const VALID_AGENTS = ['assistant', 'cursor', 'claude', 'codex', 'gemini'];
  const requestedAgent = agent || process.env.AGENT_TYPE;
  const agentType = requestedAgent && VALID_AGENTS.includes(requestedAgent) ? requestedAgent : null;
  if (agentType) cliArgs.push('--agent', agentType);

  const label = ticket || 'generate';
  emitStatus(label, '\u{1f9ea}', 'Starting test spec generation (real agent with codebase access)...');

  return new Promise((res) => {
    if (streamSpawnLogs) {
      console.error(
        `[zibby:spawn] skill=run_generate parentPid=${process.pid} → child zibby ${cliArgs.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')} cwd=${cwd}`,
      );
    }
    const child = spawn('zibby', cliArgs, {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    let _stdout = '';
    let stderr = '';

    child.stdout.on('data', d => {
      const text = d.toString();
      _stdout += text;
      for (const line of text.split('\n')) {
        const trimmed = stripAnsi(line).trim();
        if (trimmed.startsWith('✅')) emitStatus(label, '\u2705', trimmed.slice(2).trim());
        else if (trimmed.startsWith('✓')) emitStatus(label, '\u2714', trimmed.slice(2).trim());
      }
    });
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (code !== 0) {
        emitStatus(label, '\u274c', `Generation failed (exit ${code})`);
        res(JSON.stringify({
          error: `zibby generate failed with exit code ${code}`,
          stderr: stderr.slice(-1000),
        }));
        return;
      }

      const specDir = resolve(cwd, output || 'test-specs');
      let files = [];
      try {
        const prefix = ticket ? ticket.toLowerCase().replace(/[^a-z0-9]+/g, '-') : '';
        files = readdirSync(specDir)
          .filter(f => f.endsWith('.txt') && (!prefix || f.startsWith(prefix)))
          .map(f => join(specDir, f));
      } catch { /* dir might not exist */ }

      emitStatus(label, '\u2705', `Generated ${files.length} test spec files`);
      res(JSON.stringify({
        success: true,
        ticketKey: ticket || null,
        specFiles: files.map(f => f.replace(`${cwd}/`, '')),
        total: files.length,
        message: `Generated ${files.length} specs. Now call run_test for each file.`,
      }));
    });

    child.on('error', (err) => {
      emitStatus(label, '\u274c', `Spawn error: ${err.message}`);
      res(JSON.stringify({ error: err.message }));
    });
  });
}

const JIRA_INLINE_SPEC_MAX_CHARS = 100_000;
const ISSUE_KEY_LIKE = /^[A-Z][A-Z0-9]+-\d+$/;

const ADF_BLOCK_TYPES = new Set([
  'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem',
  'blockquote', 'codeBlock', 'rule', 'table', 'tableRow', 'tableCell',
  'tableHeader', 'mediaSingle', 'panel',
]);

function applyAdfMarks(text, marks) {
  if (!marks || !marks.length) return text;
  let out = text;
  for (const m of marks) {
    if (m.type === 'strong') out = `**${out}**`;
    else if (m.type === 'em') out = `_${out}_`;
    else if (m.type === 'code') out = `\`${out}\``;
    else if (m.type === 'strike') out = `~~${out}~~`;
    else if (m.type === 'link' && m.attrs?.href) out = `[${out}](${m.attrs.href})`;
  }
  return out;
}

function adfNodesToPlain(nodes, depth = 0) {
  if (!Array.isArray(nodes)) return '';
  const parts = [];
  for (const n of nodes) {
    if (n.type === 'text') { parts.push(applyAdfMarks(n.text || '', n.marks)); continue; }
    if (n.type === 'hardBreak') { parts.push('\n'); continue; }
    if (n.type === 'rule') { parts.push('\n---\n'); continue; }
    const inner = n.content ? adfNodesToPlain(n.content, depth + 1) : '';
    if (n.type === 'listItem') {
      parts.push(inner);
    } else if (n.type === 'bulletList') {
      const items = (n.content || []).map(li =>
        `- ${adfNodesToPlain(li.content || [], depth + 1).trim()}`
      );
      parts.push(`\n${items.join('\n')}\n`);
    } else if (n.type === 'orderedList') {
      const items = (n.content || []).map((li, i) =>
        `${i + 1}. ${adfNodesToPlain(li.content || [], depth + 1).trim()}`
      );
      parts.push(`\n${items.join('\n')}\n`);
    } else if (n.type === 'heading') {
      const level = n.attrs?.level || 2;
      parts.push(`\n\n${'#'.repeat(level)} ${inner.trim()}\n\n`);
    } else if (ADF_BLOCK_TYPES.has(n.type)) {
      parts.push(`\n\n${inner}\n`);
    } else {
      parts.push(inner);
    }
  }
  return parts.join('').replace(/\n{3,}/g, '\n\n');
}

function jiraDescriptionToPlain(desc) {
  if (desc == null || desc === '') return '';
  if (typeof desc === 'string') return desc.trim();
  if (typeof desc === 'object' && Array.isArray(desc.content)) {
    return adfNodesToPlain(desc.content).trim();
  }
  return '';
}

/**
 * When spec is a Jira-shaped key, load issue + comments via the jira skill and build inline spec.
 * Returns null if Jira is unavailable or the fetch fails.
 */
async function tryExpandJiraIssueKeyToInlineSpec(issueKey) {
  const { getSkill } = await import('@zibby/agent-workflow');
  const jira = getSkill('jira');
  if (!jira || typeof jira.handleToolCall !== 'function') return null;
  try {
    const issueRaw = await jira.handleToolCall('jira_get_issue', { issueKey });
    const issue = JSON.parse(issueRaw);
    if (issue?.error) return null;

    const commentsRaw = await jira.handleToolCall('jira_get_comments', { issueKey, maxResults: 50 });
    const commentsData = JSON.parse(commentsRaw);
    if (commentsData?.error) return null;

    const desc = jiraDescriptionToPlain(issue.description);
    const parts = [];
    if (desc) parts.push(desc);

    const comments = Array.isArray(commentsData.comments) ? commentsData.comments : [];
    if (comments.length > 0) {
      const text = comments
        .map((c) => String(c.body || '').trim())
        .filter(Boolean)
        .join('\n\n');
      if (text) parts.push(text);
    }

    let body = parts.join('\n\n').trim();
    if (!body) return null;
    if (body.length > JIRA_INLINE_SPEC_MAX_CHARS) {
      body = `${body.slice(0, JIRA_INLINE_SPEC_MAX_CHARS)}\n\n...[truncated]`;
    }
    return { inlineSpec: `inline:${body}`, issueKey };
  } catch {
    return null;
  }
}

function annotateRunTestJson(jsonStr, extra) {
  try {
    const o = JSON.parse(jsonStr);
    return JSON.stringify({ ...o, ...extra });
  } catch {
    return jsonStr;
  }
}

async function handleRunTest(args, cwd, context) {
  const workingArgs = { ...args };
  let specValue = String(workingArgs.spec ?? '').trim();
  if (!specValue) return JSON.stringify({ error: 'spec is required' });

  let resolvedFromJiraIssue = null;
  if (ISSUE_KEY_LIKE.test(specValue) && !specValue.startsWith('inline:')) {
    const expanded = await tryExpandJiraIssueKeyToInlineSpec(specValue);
    if (expanded) {
      specValue = expanded.inlineSpec;
      workingArgs.spec = specValue;
      if (!String(workingArgs.ticketKey || '').trim()) workingArgs.ticketKey = expanded.issueKey;
      resolvedFromJiraIssue = expanded.issueKey;
    }
  }

  const ticketKey = String(workingArgs.ticketKey || '').trim();

  if (ticketKey) {
    for (const [existingRunId, existingRun] of activeRuns.entries()) {
      if (existingRun?.ticketKey !== ticketKey) continue;
      if (existingRun?.status !== 'running' && existingRun?.status !== 'queued') continue;
      return JSON.stringify({
        runId: existingRunId,
        ticketKey,
        status: existingRun.status,
        reused: true,
        message: `A run for ${ticketKey} is already ${existingRun.status}. Reusing existing run instead of starting a duplicate.`,
      });
    }
  }

  if (!specValue.startsWith('inline:')) {
    const specPath = resolve(cwd, specValue);
    if (!existsSync(specPath)) {
      if (ISSUE_KEY_LIKE.test(specValue)) {
        return JSON.stringify({
          error: `Invalid run_test spec: "${specValue}" is an issue id, not a spec.`,
          reason: 'Jira auto-load was attempted but did not return usable text, or Jira is not configured.',
          doNext: [
            'Confirm the jira skill is active and authenticated.',
            'Or call tracker tools yourself, then run_test with spec: "inline:" + steps.',
          ],
          validExample: { spec: 'inline:1. Open https://example.com … 2. Verify …', ticketKey: specValue },
          invalidExample: { spec: specValue, ticketKey: specValue },
        });
      }
      return JSON.stringify({
        error: `Test spec not found: ${specValue}`,
        hint: 'If this should be issue steps, load the issue with your tracker tools first, then run_test with spec: "inline:" + steps. Otherwise use a real file path.',
      });
    }
  }

  const max = resolveMaxParallelRuns(context?.options?.config);

  if (runningCount() >= max) {
    const runId = genRunId();
    const label = workingArgs.ticketKey || runId;
    const run = {
      runId,
      spec: workingArgs.ticketKey ? `${workingArgs.ticketKey}: ${workingArgs.spec}` : workingArgs.spec,
      ticketKey: workingArgs.ticketKey || null,
      status: 'queued',
      startTime: Date.now(),
      exitCode: null,
      output: '',
      error: '',
    };
    activeRuns.set(runId, run);
    pendingQueue.push({ args: { ...workingArgs, _queuedRunId: runId }, cwd, context });
    emitStatus(label, '\u23f3', `Queued (${runningCount()}/${max} running, ${pendingQueue.length} queued)`);

    const base = {
      runId,
      spec: run.spec,
      ticketKey: run.ticketKey,
      status: 'queued',
      message: `Queued — will start when a slot opens (max ${max} concurrent).`,
    };
    if (resolvedFromJiraIssue) {
      base.resolvedFromJiraIssue = resolvedFromJiraIssue;
      base.message += ` (spec built from Jira ${resolvedFromJiraIssue})`;
    }
    return JSON.stringify(base);
  }

  const sinceLastSpawn = Date.now() - lastSpawnTime;
  if (sinceLastSpawn < SPAWN_STAGGER_MS && lastSpawnTime > 0) {
    await new Promise(r => setTimeout(r, SPAWN_STAGGER_MS - sinceLastSpawn));
  }
  lastSpawnTime = Date.now();

  const out = spawnRun(workingArgs, cwd, context);
  if (!resolvedFromJiraIssue) return out;
  return annotateRunTestJson(out, {
    resolvedFromJiraIssue,
    message: `Spec was loaded from Jira issue ${resolvedFromJiraIssue} (description + comments).`,
  });
}

function spawnRun(args, cwd, _context) {
  const { spec, ticketKey, agent, headless, workflow, _queuedRunId } = args;
  const runId = _queuedRunId || genRunId();
  let specPath = spec;
  let isInline = false;

  if (spec.startsWith('inline:')) {
    isInline = true;
    const tmpDir = zibbyScratchSpecsDir(cwd);
    mkdirSync(tmpDir, { recursive: true });
    specPath = join(tmpDir, `${runId}.txt`);
    writeFileSync(specPath, spec.slice('inline:'.length).trim(), 'utf-8');
  }

  const logsDir = resolve(cwd, '.zibby', 'output', 'runs');
  mkdirSync(logsDir, { recursive: true });
  const logPath = join(logsDir, `${runId}.log`);
  const logStream = createWriteStream(logPath, { flags: 'a' });

  const VALID_AGENTS = ['assistant', 'cursor', 'claude', 'codex', 'gemini'];
  const validAgent = (agent && VALID_AGENTS.includes(agent)) ? agent : null;

  const cliArgs = ['test', specPath];
  if (validAgent) cliArgs.push('--agent', validAgent);
  if (headless) cliArgs.push('--headless');
  if (workflow) cliArgs.push('--workflow', workflow);

  if (streamSpawnLogs) {
    console.error(
      `[zibby:spawn] skill=run_test parentPid=${process.pid} → child zibby ${cliArgs.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')} cwd=${cwd}`,
    );
  }

  const child = spawn('zibby', cliArgs, {
    cwd,
    env: { ...process.env, ZIBBY_WORKFLOW_GRAPH_LOG_MARKERS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  const run = {
    runId,
    spec: ticketKey ? `${ticketKey}: ${spec}` : spec,
    ticketKey: ticketKey || null,
    specPath,
    logPath,
    isInline,
    pid: child.pid,
    status: 'running',
    output: '',
    error: '',
    startTime: Date.now(),
    exitCode: null,
    currentNode: null,
    completedNodes: [],
  };

  const label = ticketKey || runId;
  let lineBuf = '';

  function processLine(raw) {
    const line = stripAnsi(raw).trim();
    if (!line) return;

    // Parse machine-readable workflow graph markers (emitted by timeline.js)
    if (line.startsWith('__WORKFLOW_GRAPH_LOG__')) {
      try {
        const payload = JSON.parse(line.slice('__WORKFLOW_GRAPH_LOG__'.length));
        if (payload.phase === 'node_begin') {
          run.currentNode = payload.node;
        } else if (payload.phase === 'node_end') {
          if (payload.node && !run.completedNodes.includes(payload.node)) {
            run.completedNodes.push(payload.node);
          }
          if (run.currentNode === payload.node) run.currentNode = null;
        }
      } catch {}
      return;
    }

    const sessionMatch = line.match(/Session\s+(\S+)/);
    if (sessionMatch && !run.sessionId) {
      run.sessionId = sessionMatch[1];
      run.sessionPath = resolve(cwd, OUTPUT_BASE, SESSIONS_DIR, run.sessionId);
    }
    if (line.startsWith('\u250c ') || line.startsWith('┌ ')) {
      const node = line.slice(2).trim();
      run.currentNode = node;
      if (streamNodeProgress) emitStatus(label, '\u25b6', `${node}`);
    } else if (line.startsWith('\u2514 ') || line.startsWith('└ ')) {
      const rest = line.slice(2).trim();
      if (rest.startsWith('done')) {
        if (run.currentNode && !run.completedNodes.includes(run.currentNode)) {
          run.completedNodes.push(run.currentNode);
        }
        if (streamNodeProgress) emitStatus(label, '\u2714', `${run.currentNode || 'node'} done ${rest.replace('done', '').trim()}`);
        run.currentNode = null;
      } else if (rest.startsWith('failed')) {
        if (streamNodeProgress) emitStatus(label, '\u2718', `${run.currentNode || 'node'} failed ${rest.replace('failed', '').trim()}`);
        run.currentNode = null;
      }
    } else if (line.includes('Workflow completed')) {
      run.currentNode = null;
      if (streamNodeProgress) emitStatus(label, '\u2714', `Workflow completed (${formatElapsed(Date.now() - run.startTime)})`);
    }
  }

  function onData(d) {
    const text = d.toString();
    run.output += text;
    logStream.write(text);
    if (run.output.length > 50000) run.output = run.output.slice(-30000);
    lineBuf += text;
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop();
    for (const ln of lines) processLine(ln);
  }

  child.stdout.on('data', onData);
  child.stderr.on('data', (d) => {
    const text = d.toString();
    run.error += text;
    logStream.write(text);
    if (run.error.length > 20000) run.error = run.error.slice(-10000);
  });
  child.on('close', (code) => {
    run.status = code === 0 ? 'passed' : 'failed';
    run.exitCode = code;
    run.endTime = Date.now();
    if (lineBuf) processLine(lineBuf);
    logStream.end();
    const elapsed = formatElapsed(Date.now() - run.startTime);
    if (code === 0) {
      emitStatus(label, '\u2705', `Passed (${elapsed})`);
    } else {
      emitStatus(label, '\u274c', `Failed (${elapsed})`);
    }
    if (run.isInline) { try { unlinkSync(run.specPath); } catch {} }
    drainQueue();
  });
  child.on('error', (err) => {
    run.status = 'error';
    run.error += `\nSpawn error: ${err.message}`;
    emitStatus(label, '\u274c', `Spawn error: ${err.message}`);
    logStream.end();
    drainQueue();
  });

  // Keep the same object reference in the registry so status/exit updates
  // from child event handlers are visible to run_status.
  run._child = child;
  activeRuns.set(runId, run);

  return JSON.stringify({
    runId,
    spec: run.spec,
    ticketKey: run.ticketKey,
    status: 'running',
    pid: child.pid,
    logFile: logPath,
  });
}

function buildRunProgress(run) {
  const elapsed = Math.round(((run.endTime || Date.now()) - run.startTime) / 1000);
  const completed = run.completedNodes || [];
  const current = run.currentNode || null;

  if (run.status !== 'running') {
    return { elapsed, stage: run.status, completedNodes: completed, currentNode: null };
  }

  let summary;
  if (current) {
    summary = `Actively executing node "${current}"`;
    if (completed.length) summary += ` (completed: ${completed.join(', ')})`;
  } else if (completed.length) {
    summary = `Between nodes (completed: ${completed.join(', ')})`;
  } else {
    summary = 'Starting up (initializing workflow)';
  }
  summary += `. Elapsed: ${elapsed}s. This is normal progress — do not cancel.`;

  return { elapsed, stage: 'running', currentNode: current, completedNodes: completed, progress: summary };
}

function handleRunStatus(args) {
  const { runId } = args;
  if (!runId) return JSON.stringify({ error: 'runId is required' });

  if (runId === 'all') {
    const runs = [...activeRuns.entries()].map(([id, r]) => {
      const progress = buildRunProgress(r);
      const entry = {
        runId: id,
        spec: r.spec,
        ticketKey: r.ticketKey,
        status: r.status,
        elapsed: progress.elapsed,
        exitCode: r.exitCode,
        sessionId: r.sessionId || null,
      };
      if (r.status === 'running') {
        entry.currentNode = progress.currentNode;
        entry.completedNodes = progress.completedNodes;
        entry.progress = progress.progress;
      } else {
        entry.outputTail = r.output.slice(-500);
      }
      return entry;
    });
    const running = runs.filter(r => r.status === 'running').length;
    const passed = runs.filter(r => r.status === 'passed').length;
    const failed = runs.filter(r => r.status === 'failed').length;
    const result = { total: runs.length, running, passed, failed, runs };
    if (running > 0) result._hint = 'All running tests are progressing normally through their workflow nodes. Do NOT cancel, diagnose, or interpret as stuck. Just tell the user they are still running.';
    return JSON.stringify(result);
  }

  const run = activeRuns.get(runId);
  if (!run) return JSON.stringify({ error: `Run not found: ${runId}` });

  const progress = buildRunProgress(run);
  const result = {
    runId,
    spec: run.spec,
    ticketKey: run.ticketKey,
    status: run.status,
    elapsed: progress.elapsed,
    exitCode: run.exitCode,
    sessionId: run.sessionId || null,
  };
  if (run.status === 'running') {
    result.currentNode = progress.currentNode;
    result.completedNodes = progress.completedNodes;
    result.progress = progress.progress;
  } else {
    result.outputTail = run.output.slice(-1000);
    result.errorTail = run.error.slice(-500);
  }
  if (run.status === 'running') result._hint = 'This run is actively progressing. Do NOT cancel, diagnose, or assume stuck. Just tell the user it is still running.';
  return JSON.stringify(result);
}

function cancelSingleRun(runId, run) {
  if (run.status === 'queued') {
    const idx = pendingQueue.findIndex(q => q.args._queuedRunId === runId);
    if (idx >= 0) pendingQueue.splice(idx, 1);
    run.status = 'cancelled';
    run.endTime = Date.now();
    return { ok: true, runId, status: 'cancelled' };
  }

  if (run.status !== 'running') return { ok: false, runId, error: `Run is not active (status: ${run.status})` };

  try {
    run._child.kill('SIGTERM');
    run.status = 'cancelled';
    run.endTime = Date.now();
    return { ok: true, runId, status: 'cancelled' };
  } catch (e) {
    return { ok: false, runId, error: `Failed to cancel: ${e.message}` };
  }
}

function handleRunCancel(args) {
  const { runId } = args;
  if (!runId) return JSON.stringify({ error: 'runId is required' });

  if (runId === 'all') {
    const results = [];
    for (const [id, run] of activeRuns.entries()) {
      if (run.status === 'running' || run.status === 'queued') {
        results.push(cancelSingleRun(id, run));
      }
    }
    if (results.length === 0) return JSON.stringify({ ok: true, message: 'No active runs to cancel' });
    return JSON.stringify({ ok: true, cancelled: results.length, results });
  }

  const run = activeRuns.get(runId);
  if (!run) return JSON.stringify({ error: `Run not found: ${runId}` });

  return JSON.stringify(cancelSingleRun(runId, run));
}

function findSessionPath(runId, cwd) {
  const run = activeRuns.get(runId);
  if (run?.sessionPath && existsSync(run.sessionPath)) return run.sessionPath;
  if (run?.sessionId) {
    const p = resolve(cwd, OUTPUT_BASE, SESSIONS_DIR, run.sessionId);
    if (existsSync(p)) return p;
  }
  return null;
}

function listDirRecursive(dir, prefix = '') {
  const entries = [];
  if (!existsSync(dir)) return entries;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      entries.push(...listDirRecursive(join(dir, entry.name), rel));
    } else {
      const st = statSync(join(dir, entry.name));
      entries.push({ path: rel, size: st.size });
    }
  }
  return entries;
}

function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return null;
  try { return JSON.parse(readFileSync(filePath, 'utf-8')); } catch { return null; }
}

function readFileTail(filePath, tail = 2000) {
  if (!filePath || !existsSync(filePath)) return '';
  try {
    const content = readFileSync(filePath, 'utf-8');
    return content.slice(-Math.max(200, Number(tail) || 2000));
  } catch {
    return '';
  }
}

function diagnoseFromSignals({ run, logTail, errorTail }) {
  const text = `${logTail || ''}\n${errorTail || ''}`;
  const lowered = text.toLowerCase();

  const base = {
    runId: run?.runId || null,
    status: run?.status || null,
    exitCode: run?.exitCode ?? null,
    likelyCause: 'Unknown failure',
    confidence: 'low',
    nextStep: 'Call run_artifacts({ runId, type: "log" }) with larger tail and inspect full logs.',
  };

  if (run?.status === 'running' || run?.status === 'queued') {
    return {
      ...base,
      likelyCause: 'Run is still active; no terminal failure to diagnose yet.',
      confidence: 'high',
      nextStep: 'Call run_status({ runId: "all" }) to check progress.',
    };
  }

  if (lowered.includes('test spec not found')) {
    return {
      ...base,
      likelyCause: 'Invalid spec input: run_test received a non-existent spec path.',
      confidence: 'high',
      nextStep: 'Use spec as inline:... or a real file path from list_specs. For ticket keys, fetch steps first via Jira then build inline spec.',
    };
  }

  if (lowered.includes('unknown command') && lowered.includes("'run'")) {
    return {
      ...base,
      likelyCause: 'CLI command mismatch (`zibby run` unsupported in current CLI).',
      confidence: 'high',
      nextStep: 'Use `zibby test ...` spawn path (runner should already do this).',
    };
  }

  if (lowered.includes('missing openai_api_key') || lowered.includes("didn't provide an api key") || lowered.includes('401')) {
    return {
      ...base,
      likelyCause: 'Provider authentication/config issue (API key/proxy auth missing or rejected).',
      confidence: 'medium',
      nextStep: 'Verify proxy/token env and auth mode, then retry once configuration is valid.',
    };
  }

  if (lowered.includes('spawn error') || lowered.includes('enoent')) {
    return {
      ...base,
      likelyCause: 'Failed to spawn CLI process (binary/path/environment issue).',
      confidence: 'medium',
      nextStep: 'Confirm `zibby` is installed and available in PATH for the chat process.',
    };
  }

  if (lowered.includes('security command failed') || lowered.includes('security process exited with code: 45') || lowered.includes('password not found for account')) {
    return {
      ...base,
      likelyCause: 'Cursor agent keychain/auth failed during preflight (often transient, more common under parallel starts).',
      confidence: 'high',
      nextStep: 'Retry failed ticket sequentially (not parallel), or run with a different agent via run_test({ ..., agent: "codex" }).',
    };
  }

  return base;
}

function handleRunArtifacts(args, cwd) {
  const { runId, type, node = 'execute_live', query, tail = 3000 } = args;

  if (type === 'search') {
    if (!query) return JSON.stringify({ error: 'query is required for type="search"' });
    const sessionsDir = resolve(cwd, OUTPUT_BASE, SESSIONS_DIR);
    if (!existsSync(sessionsDir)) return JSON.stringify({ matches: [], message: 'No sessions found' });

    const matches = [];
    const q = query.toLowerCase();
    for (const d of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const sessionPath = join(sessionsDir, d.name);
      const searchTargets = [
        { file: 'execute_live/result.json', label: 'result' },
        { file: 'execute_live/events.json', label: 'events' },
        { file: 'execute_live/raw_stream_output.txt', label: 'log' },
        { file: 'generate_script/raw_stream_output.txt', label: 'script_log' },
        { file: 'title.txt', label: 'title' },
      ];
      for (const { file, label } of searchTargets) {
        const fp = join(sessionPath, file);
        if (!existsSync(fp)) continue;
        try {
          const content = readFileSync(fp, 'utf-8');
          if (content.toLowerCase().includes(q)) {
            const idx = content.toLowerCase().indexOf(q);
            const start = Math.max(0, idx - 100);
            const end = Math.min(content.length, idx + query.length + 100);
            matches.push({
              sessionId: d.name,
              artifact: label,
              snippet: content.slice(start, end),
            });
          }
        } catch { /* skip unreadable */ }
      }
      if (matches.length >= 20) break;
    }
    return JSON.stringify({ query, matches, total: matches.length });
  }

  if (!runId) return JSON.stringify({ error: 'runId is required for this type' });

  if (type === 'log') {
    const run = activeRuns.get(runId);
    const runLogTail = readFileTail(run?.logPath, tail);
    if (runLogTail) {
      return JSON.stringify({
        runId,
        source: 'run-log',
        totalLength: runLogTail.length,
        tail: runLogTail,
      });
    }
  }

  const sessionPath = findSessionPath(runId, cwd);
  if (!sessionPath) {
    return JSON.stringify({ error: `No session found for run ${runId}. The run may still be starting.` });
  }

  switch (type) {
    case 'list': {
      const files = listDirRecursive(sessionPath);
      return JSON.stringify({ sessionId: sessionPath.split('/').pop(), files, total: files.length });
    }
    case 'result': {
      const data = readJsonSafe(join(sessionPath, node, 'result.json'));
      if (!data) return JSON.stringify({ error: `No result.json found in ${node}` });
      return JSON.stringify({ sessionId: sessionPath.split('/').pop(), node, result: data });
    }
    case 'events': {
      const data = readJsonSafe(join(sessionPath, node, 'events.json'));
      if (!data) return JSON.stringify({ error: `No events.json found in ${node}` });
      const events = Array.isArray(data) ? data : (data.events || []);
      return JSON.stringify({
        sessionId: sessionPath.split('/').pop(),
        node,
        totalEvents: events.length,
        events: events.slice(-50),
      });
    }
    case 'log': {
      const logPath = join(sessionPath, node, 'raw_stream_output.txt');
      if (!existsSync(logPath)) return JSON.stringify({ error: `No log found in ${node}` });
      const content = readFileSync(logPath, 'utf-8');
      return JSON.stringify({
        sessionId: sessionPath.split('/').pop(),
        node,
        totalLength: content.length,
        tail: content.slice(-tail),
      });
    }
    default:
      return JSON.stringify({ error: `Unknown artifact type: ${type}. Use: list, result, events, log, search` });
  }
}

function handleRunDiagnose(args, _cwd) {
  const runIdArg = String(args?.runId || 'all');
  const tail = Number(args?.tail || 2000);
  const runIds = runIdArg === 'all' ? [...activeRuns.keys()] : [runIdArg];
  if (runIds.length === 0) {
    return JSON.stringify({ error: 'No runs available to diagnose. Call run_test first.' });
  }

  const diagnoses = runIds.map((runId) => {
    const run = activeRuns.get(runId);
    if (!run) return { runId, error: `Run not found: ${runId}` };
    const logTail = readFileTail(run.logPath, tail);
    const errorTail = String(run.error || '').slice(-Math.max(200, tail));
    const diagnosis = diagnoseFromSignals({ run, logTail, errorTail });
    return {
      ...diagnosis,
      ticketKey: run.ticketKey || null,
      spec: run.spec,
      logTail,
      errorTail,
    };
  });

  const failed = diagnoses.filter(d => d.status === 'failed' || d.status === 'error');
  const running = diagnoses.filter(d => d.status === 'running' || d.status === 'queued');
  return JSON.stringify({
    total: diagnoses.length,
    failed: failed.length,
    active: running.length,
    diagnoses,
  });
}

function handleListSpecs(args, cwd) {
  const directory = args?.directory || 'test-specs';
  const dir = resolve(cwd, directory);
  if (!existsSync(dir)) return JSON.stringify({ specs: [], directory, message: `Directory not found: ${directory}` });

  try {
    const files = [];
    function walk(d, prefix) {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(join(d, entry.name), rel);
        else if (entry.name.endsWith('.txt') || entry.name.endsWith('.md')) files.push(rel);
      }
    }
    walk(dir, '');
    return JSON.stringify({ specs: files.map(f => `${directory}/${f}`), total: files.length, directory });
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}
