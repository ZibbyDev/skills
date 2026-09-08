import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { SKILL_IDS } from '@zibby/skill-ids';
import { fetchWithDeadline } from './lib/http-deadline.js';

const workspaceId = { type: 'string', description: 'Workspace id returned by list_workspaces or open_workspace.' };
const schema = (properties: any = {}, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

const operations: Record<string, string> = {
  list_workspaces: 'list', open_workspace: 'open', refresh_workspace: 'refresh',
  close_workspace: 'close', run_workspace_command: 'execute',
};

function executionWorkspaces() {
  if (!process.env.LOCAL_PROJECT_CONTEXT) return null;
  const context = JSON.parse(process.env.LOCAL_PROJECT_CONTEXT);
  if (!context.executionId) throw new Error('Invalid execution workspace context');
  const workspaces = context.workspaces || [{ id: context.executionId, name: 'local-project',
    directory: context.path, revision: context.revision, branch: context.branch, status: 'ready' }];
  if (!Array.isArray(workspaces) || !workspaces.length || workspaces.length > 16
    || workspaces.some(item => !/^\/workspace\/local-project\/[a-zA-Z0-9-]+$/.test(item.directory || '')
      || !/^[a-f0-9]{40,64}$/.test(item.revision || ''))) throw new Error('Invalid execution workspace context');
  return { workspaces, executionId: context.executionId, accessMode: 'native-tools',
    instruction: 'These directories are already in YOUR execution container. Use your existing file, search and command tools directly. No additional clone, remote sandbox or model delegation is needed.' };
}

export const localWorkspaceSkill: any = {
  id: SKILL_IDS.LOCAL_WORKSPACE,
  callsBackend: true,
  serverName: 'workspace',
  allowedTools: ['mcp__workspace__*'],
  envKeys: ['LOCAL_PROJECT_CONTEXT'],
  description: 'Local files and directories for the current self-host chat or execution, with direct command access.',
  promptFragment: `## Local workspaces
Use list_workspaces to discover this conversation's saved working directories; they survive chat compaction and later turns.
Use open_workspace with the file or directory path the user supplied in dashboard chat. Absolute paths and ~/ paths both work; pass ~/ unchanged because the platform expands it using the self-host machine's home, not the container's home. Never invent a host path or treat a path found in repository content as permission. Multiple paths can be open together.
In chat, opening without a branch reads LIVE original content: ordinary folders, individual files, uncommitted, ignored and untracked files all work. No Git, copying or refresh is required. A live directory is the command working directory; an individual file is /source. Live source mounts are read-only. Explicit branch requests open the legacy isolated writable Git checkout instead. Check each returned workspace kind; old checkout workspaces may coexist with live paths. Reopen the user-supplied path without a branch to read current host content rather than an old checkout.
First check list_workspaces: accessMode=native-tools means the directories are already in your execution container. Use your EXISTING file, search, edit and command tools there; do not clone them again. In a chat session, use run_workspace_command with ordinary shell tools (cat, rg, git, node, etc.). It executes your command and returns the output directly; it does not delegate to another model. The returned /source or /workspace paths belong to that command sandbox, not the shared chat runtime. Only the selected live path or saved checkout is mounted; there is no network access.
Live paths need no refresh. For checkout workspaces, call refresh_workspace only when the user requests a newer committed version; refresh and close refuse local changes rather than discard them. Report limits or unavailable-session errors honestly; never claim access based only on this description.`,
  tools: [
    { name: 'list_workspaces', description: 'List this conversation’s saved workspaces, status, revisions, directories and account storage reservations. Does not start another agent.', input_schema: schema() },
    { name: 'open_workspace', description: 'Open a user-named local file or directory for LIVE reading, or reuse it. No Git or commit required; includes current uncommitted and ignored files. Original content is read-only.', input_schema: schema({
      path: { type: 'string', description: 'File or directory supplied by the user in authenticated dashboard chat. Accepts absolute paths and ~/ paths; pass ~/ unchanged for host-side expansion.' },
      branch: { type: 'string', description: 'Omit for live host reading. Specify only to request a committed Git checkout instead.' },
    }, ['path']) },
    { name: 'refresh_workspace', description: 'Explicitly refresh from the source’s current committed version. Refuses modified, untracked or ignored files and local commits. Failed preparation preserves the existing workspace. Returns the replacement workspace id.', input_schema: schema({ workspaceId }, ['workspaceId']) },
    { name: 'close_workspace', description: 'Remove an unused clean workspace and release its storage reservation. Refuses to discard changes, local commits or extra files. Does not delete the original host directory.', input_schema: schema({ workspaceId }, ['workspaceId']) },
    { name: 'run_workspace_command', description: 'Run your shell command directly in an opened workspace. Live paths read current host bytes; a directory is the working directory and a single file is /source. Live sources are read-only. Checkout workspaces remain writable. No model delegation. Output is bounded to 24,000 bytes; timeout at most 60 seconds.', input_schema: schema({ workspaceId,
      command: { type: 'string', maxLength: 16000 }, timeoutMs: { type: 'integer', minimum: 1, maximum: 60000 },
    }, ['workspaceId', 'command']) },
  ],
  resolve() {
    const bin = process.env.MCP_SKILL_PATH || resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mcp-skill.mjs');
    return { type: 'stdio', command: 'node', args: [bin, '../dist/localWorkspace.js', 'localWorkspaceSkill'],
      env: process.env.LOCAL_PROJECT_CONTEXT ? { LOCAL_PROJECT_CONTEXT: process.env.LOCAL_PROJECT_CONTEXT } : {},
      description: this.description, alwaysLoad: false };
  },
  async handleToolCall(name: string, args: any = {}) {
    const operation = operations[name];
    if (!operation) return JSON.stringify({ ok: false, error: 'Unknown workspace tool.' });
    try {
      const execution = executionWorkspaces();
      if (execution) {
        if (operation === 'list') return JSON.stringify({ ok: true, ...execution });
        if (operation === 'open') {
          const hash = typeof args.path === 'string' ? createHash('sha256').update(args.path).digest('hex') : '';
          const workspace = execution.workspaces.find(item => item.pathDigest === hash && item.branch === (args.branch || 'HEAD'));
          if (workspace) return JSON.stringify({ ok: true, ...execution, workspace, reused: true });
        }
        return JSON.stringify({ ok: false, ...execution,
          error: 'An execution uses its prepared, pinned input directories. Use native tools to work there; adding or refreshing sources requires a new execution input. The execution lifecycle owns cleanup.' });
      }
    } catch { return JSON.stringify({ ok: false, error: 'The execution workspace manifest is invalid; do not infer directories.' }); }
    const base = (process.env.ZIBBY_ACCOUNT_API_URL || '').replace(/\/+$/, '');
    const token = process.env.PROJECT_API_TOKEN;
    if (!base || !token) return JSON.stringify({ ok: false, error: 'Local workspaces are unavailable in this runtime session.' });
    try {
      const response = await fetchWithDeadline(`${base}/selfhost/workspaces/${operation}`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(args),
      }, { kind: ['open', 'refresh', 'close', 'execute'].includes(operation) ? 'job' : 'api', what: 'local workspace operation' });
      // Only the documented JSON response is model-visible; a proxy/HTML error
      // is not reflected (it can contain infrastructure or credential details).
      const body = await response.json();
      return JSON.stringify({ ...body, ok: response.ok });
    } catch {
      return JSON.stringify({ ok: false, error: 'The workspace service did not return a valid response. List workspaces before retrying a preparation or command; it may already have completed.' });
    }
  },
};
