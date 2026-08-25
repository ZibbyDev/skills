/**
 * Vikunja integration — low-level API-wrapper skill.
 *
 * WHY THIS EXISTS. `vikunja` was registered as an integration id long before
 * anything implemented it: the id gated a card in the UI, and the ONLY code that
 * ever talked to a board was `board-runner`'s own `lib/tracker.js`, calling REST
 * inline. That works, and it stays — a scheduled runner wants deterministic,
 * batched calls it can retry. But it meant the board was reachable by exactly
 * one template, doing exactly the five things that template's code spelled out.
 * No other agent could touch it, and nobody could say "move that card to Doing".
 *
 * This skill is the other half: the same board, handed to the MODEL as tools.
 * The two layers are deliberate and neither replaces the other —
 *   tracker.js  = deterministic, node-side, batch, retry-safe;
 *   this skill  = interactive, model-driven, one action at a time.
 *
 * SHAPE: `linear.ts`, not `jira.ts`. Jira spawns a separate MCP server package
 * (@zibby/mcp-jira); Vikunja needs no such thing — the tools live on this object
 * and the generic skill server (bin/mcp-skill.mjs) exposes them. One file.
 *
 * API FACTS ARE INHERITED, NOT REDISCOVERED. Every endpoint below was verified
 * live against a real Vikunja by the board-runner tracker (its header block
 * documents the traps). The ones that bite:
 *   • `GET /tasks/all` is HTTP 400 even bare — list PROJECT-scoped.
 *   • the `labels` filter takes the NUMERIC label id, never the title (a title
 *     400s with code 4019); resolve via `GET /labels?s=<title>`.
 *   • an empty label list comes back as JSON `null`, not `[]`.
 *   • a comment is `PUT /tasks/{id}/comments`, not POST.
 *   • MOVING A CARD IS NOT A FIELD WRITE. There is no task.status. A board
 *     column is a KANBAN BUCKET on a VIEW: resolve the project's kanban view,
 *     match the bucket by title, then POST the task into it. This is the single
 *     most surprising thing about the API and the reason `vikunja_move_task`
 *     exists as its own verb rather than as an argument to update.
 *   • `identifier` ('#1') is per-project, NOT globally unique — address tasks by
 *     their numeric id.
 *   • `description` is HTML when it was edited in the UI — strip tags on read.
 *
 * AUTH. `resolveIntegrationToken('vikunja')` returns BOTH halves — `{token,
 * instanceUrl}` — because a credential alone cannot address a board. Same
 * resolution order and the same error semantics as the tracker: a connected row
 * that somehow carries no instance says exactly that, rather than letting the
 * next call fail and blaming the token.
 */

import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve as resolvePath } from 'path';
import { INTEGRATIONS } from './integrations.js';
import { resolveIntegrationToken } from '@zibby/core/backend-client.js';
import { fetchWithDeadline } from './lib/http-deadline.js';

function resolveSkillBin(): string | null {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

/** `<origin>` with any trailing slash and any trailing `/api/v1` removed. */
function normalizeOrigin(raw: any): string {
  return String(raw || '').trim().replace(/\/+$/, '').replace(/\/api\/v1$/, '');
}

let _creds: { origin: string; token: string } | null = null;

/**
 * Resolve `{origin, token}` ONCE per process.
 *
 * Order mirrors board-runner/lib/tracker.js exactly, and that is not an
 * accident: two code paths that answer "which board, with whose token"
 * differently is the two-places bug. Connected integration first (the platform
 * chokepoint), the legacy env pair second (so a box that predates the
 * integration keeps working), and a connected-but-instanceless row gets its own
 * message instead of a downstream auth error.
 */
async function vkCreds(): Promise<{ origin: string; token: string }> {
  if (_creds) return _creds;

  const envOrigin = normalizeOrigin(process.env.VIKUNJA_URL);
  const envToken = (process.env.VIKUNJA_TOKEN || '').trim();

  try {
    const resolved: any = await resolveIntegrationToken('vikunja');
    const token = String(resolved?.token || '').trim();
    const origin = normalizeOrigin(resolved?.instanceUrl);
    if (token && origin) {
      _creds = { origin, token };
      return _creds;
    }
    if (token && !origin) {
      throw new Error(
        'The connected Vikunja integration has no instance URL — reconnect it in Integrations → Vikunja.',
      );
    }
  } catch (err: any) {
    // A resolution FAILURE is not the same as "not connected": fall through to
    // the env pair only when there is one, otherwise re-raise so the model sees
    // the real reason rather than a generic "no credentials".
    if (!(envOrigin && envToken)) throw err;
  }

  if (!(envOrigin && envToken)) {
    throw new Error(
      'No Vikunja credentials. Connect the board under Integrations → Vikunja (instance URL + an API token '
      + "minted in the board's Settings → API Tokens).",
    );
  }
  _creds = { origin: envOrigin, token: envToken };
  return _creds;
}

/** For tests: forget the memoized credentials. */
export function clearVikunjaCredsCache(): void { _creds = null; }

async function vkFetch(method: string, path: string, opts: { query?: any; body?: any } = {}): Promise<any> {
  const { origin, token } = await vkCreds();
  let url = `${origin}/api/v1${path}`;
  if (opts.query && Object.keys(opts.query).length) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  const res = await fetchWithDeadline(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  }, { kind: 'api', what: `Vikunja ${method} ${path}` });
  const text = await res.text();
  if (!res.ok) {
    // The URL carries no credential (the token rides in a header), so quoting
    // the path is safe and is the only way to make a 400 debuggable.
    throw new Error(`Vikunja ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

/** Vikunja stores UI-edited descriptions as HTML. Render them readable. */
export function vkPlainText(html: any): string {
  if (typeof html !== 'string' || !html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    // A paragraph break is a BLANK line — collapsing it to a single newline
    // runs separate thoughts together and makes a long ticket body unreadable.
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Vikunja priority is 0-5; accept the words a human (or a model) would use. */
export function vkPriority(p: any): number | null {
  if (p === undefined || p === null || p === '') return null;
  if (typeof p === 'number' && Number.isFinite(p)) return Math.max(0, Math.min(5, Math.round(p)));
  const word = String(p).trim().toLowerCase();
  const map: Record<string, number> = {
    unset: 0, none: 0,
    low: 1,
    medium: 2, normal: 2,
    high: 3,
    urgent: 4,
    now: 5, critical: 5, blocker: 5, do_now: 5, 'do now': 5,
  };
  return Object.prototype.hasOwnProperty.call(map, word) ? map[word] : null;
}

/** One task, reduced to what a model can act on. */
function vkNormalize(t: any, origin: string): any {
  if (!t) return null;
  return {
    id: String(t.id),
    identifier: t.identifier || null,
    projectId: t.project_id ?? null,
    title: t.title || '',
    description: vkPlainText(t.description),
    done: !!t.done,
    priority: t.priority ?? 0,
    labels: (Array.isArray(t.labels) ? t.labels : []).map((l: any) => l?.title).filter(Boolean),
    assignees: (Array.isArray(t.assignees) ? t.assignees : []).map((a: any) => a?.username).filter(Boolean),
    dueDate: t.due_date && !String(t.due_date).startsWith('0001-') ? t.due_date : null,
    url: origin ? `${origin}/tasks/${t.id}` : undefined,
  };
}

/**
 * Label TITLE → numeric id. Server-side search, never a full scan: the bare
 * list is paginated at 50, so scanning silently misses labels on a real board.
 * `create` is opt-in because a typo should not litter the board with labels.
 */
async function vkLabelId(title: string, { create = false } = {}): Promise<number | null> {
  const name = String(title || '').trim();
  if (!name) return null;
  const found = await vkFetch('GET', '/labels', { query: { s: name } });
  // An empty label list comes back as JSON null, not [].
  const hit = (Array.isArray(found) ? found : []).find(
    (l: any) => (l?.title || '').trim().toLowerCase() === name.toLowerCase(),
  );
  if (hit?.id) return hit.id;
  if (!create) return null;
  const made = await vkFetch('PUT', '/labels', { body: { title: name } });
  return made?.id ?? null;
}

/** The project's kanban view + its buckets — the thing "a column" actually is. */
async function vkKanban(projectId: string | number): Promise<{ viewId: number; buckets: any[] }> {
  const pid = encodeURIComponent(String(projectId));
  const views = await vkFetch('GET', `/projects/${pid}/views`);
  const kanban = (Array.isArray(views) ? views : []).find((v: any) => v?.view_kind === 'kanban');
  if (!kanban?.id) throw new Error(`Project ${projectId} has no kanban view — there are no columns to move between.`);
  const buckets = await vkFetch('GET', `/projects/${pid}/views/${kanban.id}/buckets`);
  return { viewId: kanban.id, buckets: Array.isArray(buckets) ? buckets : [] };
}

export const vikunjaSkill: any = {
  id: 'vikunja',
  serverName: 'vikunja',
  allowedTools: ['mcp__vikunja__*'],
  // Declaring this maps the skill to the OPTIONAL integration (see the backend's
  // OPTIONAL_INTEGRATION_MAP) — it surfaces a "Vikunja · Connect" row on any
  // agent that declares the skill, and never gates a deploy.
  requiresIntegration: INTEGRATIONS.VIKUNJA,
  // The credential comes from resolveIntegrationToken(), which on CLOUD calls
  // Zibby's own backend — so this child needs the session keys. `callsBackend`
  // is the ONE declaration that guarantees it: withBackendSessionEnv() adds
  // PROJECT_API_TOKEN / ZIBBY_ACCOUNT_API_URL / ZIBBY_ENV at registration. Do
  // NOT hand-list them here and drop the marker — hand-lists are exactly how
  // this broke three times (github, gitlab, lark twice).
  callsBackend: true,
  envKeys: ['VIKUNJA_URL', 'VIKUNJA_TOKEN'],
  description: 'Vikunja — kanban board: tasks, columns, labels, comments (API token)',

  promptFragment: `## Vikunja
You can operate the user's Vikunja board directly. Tools:

### Discovery
- vikunja_list_projects: List boards/projects (id, title). Everything else is project-scoped, so start here when you do not have an id.
- vikunja_list_buckets: List a project's kanban COLUMNS (bucket id + title). Call before moving a card so you use a real column name.
- vikunja_list_labels: List labels (id, title).

### Tasks
- vikunja_list_tasks: List a project's tasks, optionally filtered by label and/or done-state. Newest-updated first.
- vikunja_get_task: One task by numeric id — title, description, labels, assignees, column-independent fields.
- vikunja_create_task: Create a task in a project (title, description, priority, labels, due date).
- vikunja_update_task: Change title / description / priority / done on an existing task.
- vikunja_move_task: Move a card to a COLUMN by name. This is NOT a field on the task — a column is a kanban bucket, so this tool resolves the project's kanban view and puts the task in the matching bucket.
- vikunja_add_label / vikunja_remove_label: Attach or detach a label by title.
- vikunja_add_comment: Comment on a task.
- vikunja_assign: Assign a user to a task by username.

### Notes
- Address tasks by their NUMERIC id. The '#1' identifier shown in the UI is per-project and not unique.
- Descriptions may come back as plain text converted from HTML — that is expected.
- Priority accepts a number 0-5 or a word: low, medium, high, urgent, now.`,

  resolve() {
    const env: any = {};
    for (const key of this.envKeys) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env, description: this.description };
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/vikunja.js', 'vikunjaSkill'],
      env,
      description: this.description,
      alwaysLoad: true,
    };
  },

  async handleToolCall(name: string, args: any): Promise<string> {
    try {
      const a = args || {};
      switch (name) {
        case 'vikunja_list_projects': {
          const projects = await vkFetch('GET', '/projects');
          const list = (Array.isArray(projects) ? projects : []).map((p: any) => ({
            id: String(p.id), title: p.title || '', description: vkPlainText(p.description),
          }));
          return JSON.stringify({ count: list.length, projects: list });
        }

        case 'vikunja_list_buckets': {
          const { viewId, buckets } = await vkKanban(a.projectId);
          return JSON.stringify({
            viewId,
            count: buckets.length,
            buckets: buckets.map((b: any) => ({ id: b.id, title: b.title, taskCount: b.count ?? null })),
          });
        }

        case 'vikunja_list_labels': {
          const found = await vkFetch('GET', '/labels', { query: { s: a.search } });
          const list = (Array.isArray(found) ? found : []).map((l: any) => ({ id: l.id, title: l.title }));
          return JSON.stringify({ count: list.length, labels: list });
        }

        case 'vikunja_list_tasks': {
          const { origin } = await vkCreds();
          const clauses: string[] = [];
          if (a.label) {
            // The filter takes the NUMERIC id — a title 400s with code 4019.
            const id = await vkLabelId(a.label);
            if (!id) return JSON.stringify({ count: 0, tasks: [], note: `No label named "${a.label}" exists.` });
            clauses.push(`labels in ${id}`);
          }
          if (a.done === true || a.done === false) clauses.push(`done = ${a.done}`);
          const tasks = await vkFetch('GET', `/projects/${encodeURIComponent(String(a.projectId))}/tasks`, {
            query: {
              ...(clauses.length ? { filter: clauses.join(' && ') } : {}),
              sort_by: 'updated', order_by: 'desc',
              per_page: Math.min(Number(a.limit) || 25, 50),
            },
          });
          const list = (Array.isArray(tasks) ? tasks : []).map((t: any) => vkNormalize(t, origin));
          return JSON.stringify({ count: list.length, tasks: list });
        }

        case 'vikunja_get_task': {
          const { origin } = await vkCreds();
          const t = await vkFetch('GET', `/tasks/${encodeURIComponent(String(a.taskId))}`);
          return JSON.stringify({ task: vkNormalize(t, origin) });
        }

        case 'vikunja_create_task': {
          const { origin } = await vkCreds();
          const priority = vkPriority(a.priority);
          const created = await vkFetch('PUT', `/projects/${encodeURIComponent(String(a.projectId))}/tasks`, {
            body: {
              title: a.title,
              ...(a.description ? { description: a.description } : {}),
              ...(priority !== null ? { priority } : {}),
              ...(a.dueDate ? { due_date: a.dueDate } : {}),
            },
          });
          if (!created?.id) throw new Error('Vikunja created no task (no id in the response)');
          // Labels attach AFTER create (Vikunja has no labels-on-create).
          // Fail-soft: a label hiccup must not lose the task we just made.
          const labelErrors: string[] = [];
          for (const title of (Array.isArray(a.labels) ? a.labels : [])) {
            try {
              const id = await vkLabelId(title, { create: true });
              if (id) await vkFetch('PUT', `/tasks/${created.id}/labels`, { body: { label_id: id } });
            } catch (e: any) { labelErrors.push(`${title}: ${e?.message || e}`); }
          }
          const full = await vkFetch('GET', `/tasks/${created.id}`);
          return JSON.stringify({
            created: vkNormalize(full || created, origin),
            ...(labelErrors.length ? { labelErrors } : {}),
          });
        }

        case 'vikunja_update_task': {
          const { origin } = await vkCreds();
          const id = encodeURIComponent(String(a.taskId));
          const current = await vkFetch('GET', `/tasks/${id}`);
          if (!current?.id) throw new Error(`No task ${a.taskId}`);
          const priority = vkPriority(a.priority);
          // Vikunja's task POST replaces the record — send the current task back
          // with only the requested fields changed, or unmentioned fields reset.
          const updated = await vkFetch('POST', `/tasks/${id}`, {
            body: {
              ...current,
              ...(a.title !== undefined ? { title: a.title } : {}),
              ...(a.description !== undefined ? { description: a.description } : {}),
              ...(priority !== null ? { priority } : {}),
              ...(a.done !== undefined ? { done: !!a.done } : {}),
              ...(a.dueDate !== undefined ? { due_date: a.dueDate } : {}),
            },
          });
          return JSON.stringify({ updated: vkNormalize(updated, origin) });
        }

        case 'vikunja_move_task': {
          const t = await vkFetch('GET', `/tasks/${encodeURIComponent(String(a.taskId))}`);
          if (!t?.id) throw new Error(`No task ${a.taskId}`);
          const pid = a.projectId ?? t.project_id;
          const want = String(a.column || '').trim().toLowerCase();
          if (!want) throw new Error('No target column given.');
          const { viewId, buckets } = await vkKanban(pid);
          const bucket = buckets.find((b: any) => (b?.title || '').trim().toLowerCase() === want);
          if (!bucket?.id) {
            return JSON.stringify({
              moved: false,
              error: `No column named "${a.column}".`,
              availableColumns: buckets.map((b: any) => b.title),
            });
          }
          await vkFetch(
            'POST',
            `/projects/${encodeURIComponent(String(pid))}/views/${viewId}/buckets/${bucket.id}/tasks`,
            { body: { task_id: Number(t.id) } },
          );
          return JSON.stringify({ moved: true, taskId: String(t.id), column: bucket.title });
        }

        case 'vikunja_add_label': {
          const id = await vkLabelId(a.label, { create: a.create !== false });
          if (!id) return JSON.stringify({ ok: false, error: `No label named "${a.label}" and creating it was declined.` });
          await vkFetch('PUT', `/tasks/${encodeURIComponent(String(a.taskId))}/labels`, { body: { label_id: id } });
          return JSON.stringify({ ok: true, taskId: String(a.taskId), label: a.label });
        }

        case 'vikunja_remove_label': {
          const id = await vkLabelId(a.label);
          if (!id) return JSON.stringify({ ok: false, error: `No label named "${a.label}".` });
          await vkFetch('DELETE', `/tasks/${encodeURIComponent(String(a.taskId))}/labels/${id}`);
          return JSON.stringify({ ok: true, taskId: String(a.taskId), label: a.label });
        }

        case 'vikunja_add_comment': {
          const made = await vkFetch('PUT', `/tasks/${encodeURIComponent(String(a.taskId))}/comments`, {
            body: { comment: a.comment },
          });
          return JSON.stringify({ ok: true, commentId: made?.id ?? null });
        }

        case 'vikunja_assign': {
          const users = await vkFetch('GET', '/users', { query: { s: a.username } });
          const user = (Array.isArray(users) ? users : []).find(
            (u: any) => (u?.username || '').toLowerCase() === String(a.username || '').toLowerCase(),
          );
          if (!user?.id) return JSON.stringify({ ok: false, error: `No user "${a.username}".` });
          await vkFetch('PUT', `/tasks/${encodeURIComponent(String(a.taskId))}/assignees`, {
            body: { user_id: user.id },
          });
          return JSON.stringify({ ok: true, taskId: String(a.taskId), assignee: user.username });
        }

        default:
          return JSON.stringify({ error: `Unknown vikunja tool: ${name}` });
      }
    } catch (e: any) {
      return JSON.stringify({ error: e?.message || String(e) });
    }
  },

  tools: [
    {
      name: 'vikunja_list_projects',
      description: 'List Vikunja projects/boards (id, title). Everything else is project-scoped — start here when you do not already have a project id.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'vikunja_list_buckets',
      description: "List a project's kanban COLUMNS (bucket id + title). Call this before moving a card so you use a column that exists.",
      input_schema: {
        type: 'object',
        properties: { projectId: { type: 'string', description: 'Project id' } },
        required: ['projectId'],
      },
    },
    {
      name: 'vikunja_list_labels',
      description: 'List labels (id, title). Optionally narrow with a search string.',
      input_schema: {
        type: 'object',
        properties: { search: { type: 'string', description: 'Optional server-side search on the label title' } },
      },
    },
    {
      name: 'vikunja_list_tasks',
      description: "List a project's tasks, newest-updated first. Optionally filter by label title and/or done-state.",
      input_schema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project id' },
          label: { type: 'string', description: 'Only tasks carrying this label title' },
          done: { type: 'boolean', description: 'Filter on completion state' },
          limit: { type: 'number', description: 'Max tasks (default 25, max 50)' },
        },
        required: ['projectId'],
      },
    },
    {
      name: 'vikunja_get_task',
      description: 'Get one task by its NUMERIC id (the "#1" identifier shown in the UI is per-project and not unique).',
      input_schema: {
        type: 'object',
        properties: { taskId: { type: 'string', description: 'Numeric task id' } },
        required: ['taskId'],
      },
    },
    {
      name: 'vikunja_create_task',
      description: 'Create a task in a project. Labels are attached after creation and fail soft — the task survives a label error.',
      input_schema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project id' },
          title: { type: 'string', description: 'Task title' },
          description: { type: 'string', description: 'Task body' },
          priority: { type: 'string', description: 'A number 0-5 or a word: low, medium, high, urgent, now' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Label titles; created if missing' },
          dueDate: { type: 'string', description: 'RFC3339 timestamp' },
        },
        required: ['projectId', 'title'],
      },
    },
    {
      name: 'vikunja_update_task',
      description: 'Change a task\'s title, description, priority, due date, or done state. To move it to another COLUMN use vikunja_move_task — a column is not a field on the task.',
      input_schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Numeric task id' },
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'string', description: 'A number 0-5 or a word: low, medium, high, urgent, now' },
          done: { type: 'boolean' },
          dueDate: { type: 'string', description: 'RFC3339 timestamp' },
        },
        required: ['taskId'],
      },
    },
    {
      name: 'vikunja_move_task',
      description: 'Move a card to a kanban COLUMN by name (e.g. "Doing"). Vikunja has no task.status: a column is a bucket on the project\'s kanban view, so this resolves the view and puts the task in the matching bucket. Returns the available column names when the name does not match.',
      input_schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Numeric task id' },
          column: { type: 'string', description: 'Target column (bucket) title' },
          projectId: { type: 'string', description: "Optional; defaults to the task's own project" },
        },
        required: ['taskId', 'column'],
      },
    },
    {
      name: 'vikunja_add_label',
      description: 'Attach a label to a task by title. Creates the label when it does not exist (pass create=false to refuse instead).',
      input_schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Numeric task id' },
          label: { type: 'string', description: 'Label title' },
          create: { type: 'boolean', description: 'Create the label if missing (default true)' },
        },
        required: ['taskId', 'label'],
      },
    },
    {
      name: 'vikunja_remove_label',
      description: 'Detach a label from a task by title.',
      input_schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Numeric task id' },
          label: { type: 'string', description: 'Label title' },
        },
        required: ['taskId', 'label'],
      },
    },
    {
      name: 'vikunja_add_comment',
      description: 'Add a comment to a task.',
      input_schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Numeric task id' },
          comment: { type: 'string', description: 'Comment body' },
        },
        required: ['taskId', 'comment'],
      },
    },
    {
      name: 'vikunja_assign',
      description: 'Assign a user to a task by username.',
      input_schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Numeric task id' },
          username: { type: 'string', description: 'Vikunja username' },
        },
        required: ['taskId', 'username'],
      },
    },
  ],
};
