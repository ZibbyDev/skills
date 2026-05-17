/**
 * Core Tools Skill
 *
 * Provides baseline local capabilities for the chat agent:
 * file read, directory listing, shell execution, and URL opening.
 *
 * These are the equivalent of what Cursor/Claude agents get natively.
 * All handlers run locally in the Node.js process — no MCP server needed.
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve, relative } from 'path';
import { execSync } from 'child_process';

const MAX_FILE_SIZE = 256 * 1024;
const MAX_OUTPUT = 64 * 1024;

export const coreToolsSkill = {
  id: 'core-tools',
  description: 'File read/write, directory listing, shell commands, open URLs, wait for async operations',
  envKeys: [],

  tools: [
    {
      name: 'read_file',
      description: 'Read the contents of a file. Returns the text content.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to cwd or absolute)' },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description: 'Write content to a file. Creates parent directories if needed.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to cwd or absolute)' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'list_directory',
      description: 'List files and directories in a path. Returns names with type indicators (/ for dirs).',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (relative to cwd or absolute). Defaults to cwd.' },
        },
      },
    },
    {
      name: 'run_command',
      description: 'Run a shell command and return its output. Use for grep, git, npm, etc.',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          cwd: { type: 'string', description: 'Working directory (optional, defaults to project root)' },
        },
        required: ['command'],
      },
    },
    {
      name: 'open_url',
      description: 'Open a URL in the user\'s default browser. Use for OAuth flows, documentation, integration setup pages.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open' },
        },
        required: ['url'],
      },
    },
    {
      name: 'wait',
      description: 'Wait for N seconds. Use this for async operations (tests, builds, deploys) — wait, then check status again.',
      input_schema: {
        type: 'object',
        properties: {
          seconds: { type: 'number', description: 'Seconds to wait (default: 5, max: 300)' },
          reason: { type: 'string', description: 'Why waiting (for logging/clarity)' },
        },
      },
    },
  ],

  async handleToolCall(name, args, context) {
    const cwd = context?.options?.workspace || process.cwd();

    try {
      switch (name) {
        case 'read_file': return handleReadFile(args, cwd);
        case 'write_file': return handleWriteFile(args, cwd);
        case 'list_directory': return handleListDir(args, cwd);
        case 'run_command': return handleRunCommand(args, cwd);
        case 'open_url': return handleOpenUrl(args);
        case 'wait': return await handleWait(args, context?.options?.signal);
        default: return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  },

  resolve() {
    return null;
  },
};

function resolvePath(filePath, cwd) {
  return resolve(cwd, filePath);
}

function handleReadFile(args, cwd) {
  const target = resolvePath(args.path, cwd);
  const stat = statSync(target);
  if (stat.size > MAX_FILE_SIZE) {
    return JSON.stringify({ error: `File too large (${(stat.size / 1024).toFixed(0)}KB). Max: ${MAX_FILE_SIZE / 1024}KB` });
  }
  const content = readFileSync(target, 'utf-8');
  return content;
}

function handleWriteFile(args, cwd) {
  const target = resolvePath(args.path, cwd);
  const dir = join(target, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, args.content, 'utf-8');
  return JSON.stringify({ ok: true, path: relative(cwd, target) });
}

function handleListDir(args, cwd) {
  const target = resolvePath(args.path || '.', cwd);
  const entries = readdirSync(target).map(name => {
    try {
      const isDir = statSync(join(target, name)).isDirectory();
      return isDir ? `${name}/` : name;
    } catch {
      return name;
    }
  });
  return entries.join('\n');
}

function handleRunCommand(args, cwd) {
  const workDir = args.cwd ? resolvePath(args.cwd, cwd) : cwd;
  const output = execSync(args.command, {
    cwd: workDir,
    encoding: 'utf-8',
    timeout: 30_000,
    maxBuffer: MAX_OUTPUT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return output || '(no output)';
}

function handleOpenUrl(args) {
  const { url } = args;
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return JSON.stringify({ error: 'Invalid URL — must start with http:// or https://' });
  }
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  try {
    execSync(`${cmd} "${url}"`, { stdio: 'ignore', timeout: 5000 });
    return JSON.stringify({ ok: true, opened: url });
  } catch {
    return JSON.stringify({ ok: false, error: `Could not open browser. Please visit: ${url}` });
  }
}

async function handleWait(args, signal) {
  const seconds = Math.min(Math.max(args.seconds || 5, 1), 300);
  const reason = args.reason || 'async operation';

  const pollMs = 500;
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      return JSON.stringify({ ok: true, waited: Math.round((seconds * 1000 - (deadline - Date.now())) / 1000), reason, interrupted: true });
    }
    await new Promise(r => setTimeout(r, Math.min(pollMs, deadline - Date.now())));
  }

  return JSON.stringify({ ok: true, waited: seconds, reason });
}
