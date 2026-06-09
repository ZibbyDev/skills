/**
 * Linear integration — low-level API-wrapper skill.
 *
 * Linear exposes a single GraphQL endpoint (https://api.linear.app/graphql).
 * Auth is a static API key (or an OAuth bearer). Unlike Jira/GitHub — whose
 * OAuth tokens are minted by the Zibby backend and fetched via
 * resolveIntegrationToken() — Linear has no backend integration handler yet,
 * so this skill reads the key straight from the environment (LINEAR_API_KEY).
 * That matches the task spec ("Auth/config via env, same pattern as jira.js's
 * envKeys"). When a backend Linear OAuth handler + an INTEGRATIONS.LINEAR
 * constant land, swap linearFetch's auth header to resolveIntegrationToken
 * ('linear') and add `requiresIntegration: INTEGRATIONS.LINEAR` below — the
 * tool surface does not need to change.
 *
 * Linear auth header semantics (https://developers.linear.app/docs):
 *   - Personal API key:  Authorization: <key>            (NO "Bearer " prefix)
 *   - OAuth access token: Authorization: Bearer <token>
 * We pass the key verbatim. Power users who paste an OAuth token should
 * include the "Bearer " prefix themselves, or set LINEAR_OAUTH_TOKEN.
 *
 * Tracker quirks the neutral adapter must know (Linear-specific):
 *   - Workflow STATES are per-team, not global. A "state" is a WorkflowState
 *     node {id,name,type} scoped to a team. There is no Jira-style
 *     "transition" object — you update issue.stateId directly to ANY state
 *     in the same team. So "transition" == resolve target state-name -> the
 *     team's matching WorkflowState id -> issueUpdate(stateId). We do that
 *     resolution here with the same fuzzy matching jira.js uses.
 *   - state.type is one of: backlog | unstarted | started | completed |
 *     canceled | triage. Useful for mapping neutral statuses.
 *   - Linear has native ATTACHMENTS (attachmentLinkURL / attachmentCreate)
 *     which is the first-class way to link a PR to an issue. See
 *     linear_link_attachment below. The adapter's linkPullRequest should
 *     prefer it and fall back to linear_add_comment.
 */

import { INTEGRATIONS } from './integrations.js';

const LINEAR_GRAPHQL_URL = process.env.LINEAR_API_URL || 'https://api.linear.app/graphql';

/** Resolve the Linear auth header value from env. */
function resolveLinearAuth() {
  if (process.env.LINEAR_OAUTH_TOKEN) return `Bearer ${process.env.LINEAR_OAUTH_TOKEN}`;
  const key = process.env.LINEAR_API_KEY;
  if (!key) {
    throw new Error('Linear is not connected: set LINEAR_API_KEY (personal API key) or LINEAR_OAUTH_TOKEN.');
  }
  // Personal API keys go through verbatim (no "Bearer"). If a user pasted an
  // OAuth token into LINEAR_API_KEY with the prefix, respect it.
  return key;
}

/**
 * Low-level Linear GraphQL helper. POSTs { query, variables }, throws on
 * transport or GraphQL errors, returns the `data` object.
 *
 * Exported so a future linearAdapter (neutral tracker layer) can issue
 * queries this skill's tools don't cover without re-implementing auth.
 * Keep this the single auth chokepoint.
 *
 * @param {string} query GraphQL document
 * @param {object} [variables]
 * @returns {Promise<any>} the GraphQL `data` payload
 */
export async function linearFetch(query, variables = {}) {
  const res = await fetch(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Authorization': resolveLinearAuth(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Linear API ${res.status}: ${err.slice(0, 300)}`);
  }
  const json = await res.json().catch(() => null);
  if (!json) throw new Error('Linear API returned a non-JSON body');
  if (Array.isArray(json.errors) && json.errors.length) {
    const msg = json.errors.map(e => e?.message || String(e)).join('; ');
    throw new Error(`Linear GraphQL error: ${msg.slice(0, 300)}`);
  }
  return json.data;
}

// ---- fuzzy state matching (mirrors jira.js transition resolution) ----

function normalizeLabel(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()\-_:："'`]/g, '');
}

function diceSimilarity(a, b) {
  const x = normalizeLabel(a);
  const y = normalizeLabel(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length === 1 || y.length === 1) return x === y ? 1 : 0;
  const bigrams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      m.set(bg, (m.get(bg) || 0) + 1);
    }
    return m;
  };
  const ax = bigrams(x);
  const by = bigrams(y);
  let overlap = 0;
  let axCount = 0;
  let byCount = 0;
  for (const v of ax.values()) axCount += v;
  for (const v of by.values()) byCount += v;
  for (const [bg, countA] of ax.entries()) {
    overlap += Math.min(countA, by.get(bg) || 0);
  }
  return (2 * overlap) / Math.max(1, axCount + byCount);
}

/** Pick the best WorkflowState for a requested name within a team's states. */
function matchWorkflowState(states, target) {
  const all = Array.isArray(states) ? states : [];
  if (!all.length) return { state: null, strategy: 'no-states' };
  const want = normalizeLabel(target);
  if (!want) return { state: null, strategy: 'no-target' };
  const exact = all.find(s => normalizeLabel(s.name) === want);
  if (exact) return { state: exact, strategy: 'exact' };
  // type alias (e.g. "done"/"closed" -> a completed-type state)
  const typeAliases = {
    backlog: ['backlog'],
    unstarted: ['todo', 'unstarted', 'open'],
    started: ['inprogress', 'started', 'doing', 'wip'],
    completed: ['done', 'completed', 'closed', 'resolved', 'fixed'],
    canceled: ['canceled', 'cancelled', 'wontfix', "won'tfix"],
    triage: ['triage'],
  };
  for (const [type, aliases] of Object.entries(typeAliases)) {
    if (!aliases.some(a => normalizeLabel(a) === want)) continue;
    const byType = all.find(s => s.type === type);
    if (byType) return { state: byType, strategy: 'type-alias' };
  }
  const scored = all
    .map(s => ({ s, score: diceSimilarity(target, s.name) }))
    .sort((a, b) => b.score - a.score);
  if (scored[0] && scored[0].score >= 0.5) {
    return { state: scored[0].s, strategy: 'fuzzy' };
  }
  return { state: null, strategy: 'no-match' };
}

// ---- GraphQL documents ----

const ISSUE_CORE_FIELDS = `
  id
  identifier
  number
  title
  description
  url
  priority
  createdAt
  updatedAt
  state { id name type color }
  assignee { id name displayName email }
  labels { nodes { id name color } }
  team { id key name }
`;

export const linearSkill = {
  id: 'linear',
  serverName: 'linear',
  allowedTools: ['mcp__linear__*'],
  // Linear is an api-key (paste-token) integration. The backend connect
  // handler (backend/src/handlers/linear.js) stores the LINEAR_API_KEY and
  // the workflow-executor injects it into the run. Declaring this gates
  // deploy on a connected Linear integration (mirrored in
  // backend/src/services/skill-integrations.js → INTEGRATIONS.LINEAR).
  requiresIntegration: INTEGRATIONS.LINEAR,
  envKeys: ['LINEAR_API_KEY', 'LINEAR_OAUTH_TOKEN'],
  description: 'Linear — issues, comments, workflow states (GraphQL API key)',

  promptFragment: `## Linear (connected)
You have direct access to the user's Linear workspace (GraphQL API). Tools:

### Discovery
- linear_list_teams: List teams (id, key, name) — needed to scope states/issues
- linear_list_states: List a team's workflow states (id, name, type). Linear states are PER-TEAM; there is no global status list.
- linear_list_labels: List labels (optionally scoped to a team)

### Issues
- linear_list_issues: List/poll issues filtered by team / state / label / assignee / updatedAfter cursor (for polling candidates)
- linear_get_issue: Get one issue by identifier (e.g. ENG-123) or id — title, description, state, labels, assignee, url
- linear_get_comments: Get an issue's comments (newest first)
- linear_add_comment: Add a comment to an issue
- linear_update_state: Move an issue to a different workflow state. Pass the issue + a target state NAME; the tool resolves it to the team's matching state id (exact -> type-alias -> fuzzy). There is no "transition" in Linear — you just set the state.
- linear_link_attachment: Attach a URL (e.g. a GitHub PR) to an issue via Linear's native attachments. Use this for PR links; fall back to linear_add_comment if it fails.

### Notes
- Always resolve a team first when you need states or want to create/move issues by state name — states only make sense within their team.
- Issue identifier (ENG-123) and internal id (uuid) are both accepted by get/update tools.`,

  resolve() {
    const env = {};
    for (const key of this.envKeys) {
      if (process.env[key]) env[key] = process.env[key];
    }
    if (process.env.LINEAR_API_URL) env.LINEAR_API_URL = process.env.LINEAR_API_URL;
    // No bundled MCP server for Linear; tools are served via handleToolCall.
    // Returning the env lets a future MCP server pick the key up unchanged.
    return { command: null, args: [], env, description: this.description };
  },

  async handleToolCall(name, args) {
    try {
      switch (name) {
        case 'linear_list_teams': {
          const data = await linearFetch(`
            query Teams($first: Int) {
              teams(first: $first) {
                nodes { id key name description }
              }
            }
          `, { first: args?.limit || 50 });
          const teams = data?.teams?.nodes || [];
          return JSON.stringify({ count: teams.length, teams });
        }

        case 'linear_list_states': {
          const { teamId, teamKey } = args || {};
          // Resolve team if a key was given instead of an id.
          let resolvedTeamId = teamId;
          if (!resolvedTeamId && teamKey) {
            resolvedTeamId = await resolveTeamId(teamKey);
          }
          if (resolvedTeamId) {
            const data = await linearFetch(`
              query States($teamId: String!) {
                team(id: $teamId) {
                  id key name
                  states { nodes { id name type color position } }
                }
              }
            `, { teamId: resolvedTeamId });
            const team = data?.team;
            const states = (team?.states?.nodes || [])
              .slice()
              .sort((a, b) => (a.position || 0) - (b.position || 0));
            return JSON.stringify({ team: team ? { id: team.id, key: team.key, name: team.name } : null, count: states.length, states });
          }
          // No team -> return all workflow states across the workspace.
          const data = await linearFetch(`
            query AllStates($first: Int) {
              workflowStates(first: $first) {
                nodes { id name type color team { id key name } }
              }
            }
          `, { first: args?.limit || 200 });
          const states = data?.workflowStates?.nodes || [];
          return JSON.stringify({ scope: 'workspace', count: states.length, states });
        }

        case 'linear_list_labels': {
          const { teamId } = args || {};
          const data = await linearFetch(`
            query Labels($first: Int, $filter: IssueLabelFilter) {
              issueLabels(first: $first, filter: $filter) {
                nodes { id name color team { id key } }
              }
            }
          `, {
            first: args?.limit || 100,
            filter: teamId ? { team: { id: { eq: teamId } } } : undefined,
          });
          const labels = data?.issueLabels?.nodes || [];
          return JSON.stringify({ count: labels.length, labels });
        }

        case 'linear_list_issues': {
          // listCandidates: build an IssueFilter from the supplied criteria.
          const { teamId, teamKey, stateId, stateName, label, assigneeId, updatedAfter, limit } = args || {};
          const filter = {};
          let resolvedTeamId = teamId;
          if (!resolvedTeamId && teamKey) resolvedTeamId = await resolveTeamId(teamKey);
          if (resolvedTeamId) filter.team = { id: { eq: resolvedTeamId } };
          if (stateId) filter.state = { id: { eq: stateId } };
          else if (stateName) filter.state = { name: { eqIgnoreCase: stateName } };
          if (label) filter.labels = { name: { eqIgnoreCase: label } };
          if (assigneeId) filter.assignee = { id: { eq: assigneeId } };
          if (updatedAfter) filter.updatedAt = { gt: updatedAfter }; // ISO-8601 polling cursor
          const data = await linearFetch(`
            query Issues($first: Int, $filter: IssueFilter, $orderBy: PaginationOrderBy) {
              issues(first: $first, filter: $filter, orderBy: $orderBy) {
                nodes {
                  id identifier number title url priority createdAt updatedAt
                  state { id name type }
                  assignee { id displayName }
                  labels { nodes { name } }
                  team { id key }
                }
              }
            }
          `, {
            first: limit || 30,
            filter: Object.keys(filter).length ? filter : undefined,
            orderBy: 'updatedAt',
          });
          const issues = (data?.issues?.nodes || []).map(i => ({
            id: i.id,
            identifier: i.identifier,
            number: i.number,
            title: i.title,
            url: i.url,
            priority: i.priority,
            state: i.state?.name,
            stateType: i.state?.type,
            assignee: i.assignee?.displayName || null,
            labels: (i.labels?.nodes || []).map(l => l.name),
            team: i.team?.key,
            createdAt: i.createdAt,
            updatedAt: i.updatedAt,
          }));
          return JSON.stringify({ count: issues.length, issues });
        }

        case 'linear_get_issue': {
          // getTicket: accept identifier (ENG-123) or internal uuid.
          const id = args?.issueId || args?.identifier || args?.issueKey;
          if (!id) return JSON.stringify({ error: 'issueId or identifier is required' });
          const issue = await getIssueByIdOrIdentifier(id);
          if (!issue) return JSON.stringify({ error: `Issue not found: ${id}` });
          return JSON.stringify({
            id: issue.id,
            identifier: issue.identifier,
            number: issue.number,
            title: issue.title,
            description: issue.description || '',
            url: issue.url,
            priority: issue.priority,
            state: issue.state?.name,
            stateId: issue.state?.id,
            stateType: issue.state?.type,
            assignee: issue.assignee?.displayName || issue.assignee?.name || null,
            assigneeId: issue.assignee?.id || null,
            labels: (issue.labels?.nodes || []).map(l => l.name),
            team: issue.team ? { id: issue.team.id, key: issue.team.key, name: issue.team.name } : null,
            createdAt: issue.createdAt,
            updatedAt: issue.updatedAt,
          });
        }

        case 'linear_get_comments': {
          const id = args?.issueId || args?.identifier || args?.issueKey;
          if (!id) return JSON.stringify({ error: 'issueId or identifier is required' });
          const issue = await getIssueByIdOrIdentifier(id, `
            id identifier
            comments(first: ${Number(args?.limit) || 50}) {
              nodes { id body createdAt updatedAt user { id name displayName } }
            }
          `);
          if (!issue) return JSON.stringify({ error: `Issue not found: ${id}` });
          const comments = (issue.comments?.nodes || [])
            .map(c => ({
              id: c.id,
              author: c.user?.displayName || c.user?.name || 'Unknown',
              body: c.body || '',
              createdAt: c.createdAt,
              updatedAt: c.updatedAt,
            }))
            .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
          return JSON.stringify({ count: comments.length, issue: issue.identifier, comments });
        }

        case 'linear_add_comment': {
          const id = args?.issueId || args?.identifier || args?.issueKey;
          const body = args?.body;
          if (!id || !body) return JSON.stringify({ error: 'issueId/identifier and body are required' });
          const issue = await getIssueByIdOrIdentifier(id, 'id identifier');
          if (!issue) return JSON.stringify({ error: `Issue not found: ${id}` });
          const data = await linearFetch(`
            mutation AddComment($input: CommentCreateInput!) {
              commentCreate(input: $input) {
                success
                comment { id url createdAt }
              }
            }
          `, { input: { issueId: issue.id, body } });
          const result = data?.commentCreate;
          return JSON.stringify({ ok: !!result?.success, commentId: result?.comment?.id, url: result?.comment?.url });
        }

        case 'linear_update_state': {
          // transition: resolve target state NAME -> the issue's team's
          // matching WorkflowState id, then issueUpdate(stateId).
          const id = args?.issueId || args?.identifier || args?.issueKey;
          const { stateId, stateName, toStatus, status } = args || {};
          if (!id) return JSON.stringify({ error: 'issueId or identifier is required' });
          const issue = await getIssueByIdOrIdentifier(id, `
            id identifier
            state { id name type }
            team { id key states { nodes { id name type position } } }
          `);
          if (!issue) return JSON.stringify({ error: `Issue not found: ${id}` });

          let targetStateId = stateId;
          let resolution = stateId ? { strategy: 'explicit-id' } : null;
          if (!targetStateId) {
            const wanted = String(stateName || toStatus || status || '').trim();
            const states = (issue.team?.states?.nodes || [])
              .slice()
              .sort((a, b) => (a.position || 0) - (b.position || 0));
            if (!wanted) {
              return JSON.stringify({
                ok: false,
                error: 'stateId or stateName/toStatus is required',
                issue: issue.identifier,
                availableStates: states.map(s => ({ id: s.id, name: s.name, type: s.type })),
              });
            }
            const matched = matchWorkflowState(states, wanted);
            if (!matched.state) {
              return JSON.stringify({
                ok: false,
                error: `No workflow state matches "${wanted}" in team ${issue.team?.key}`,
                issue: issue.identifier,
                availableStates: states.map(s => ({ id: s.id, name: s.name, type: s.type })),
              });
            }
            targetStateId = matched.state.id;
            resolution = { strategy: matched.strategy, matchedName: matched.state.name };
          }

          const data = await linearFetch(`
            mutation MoveIssue($id: String!, $input: IssueUpdateInput!) {
              issueUpdate(id: $id, input: $input) {
                success
                issue { id identifier state { id name type } }
              }
            }
          `, { id: issue.id, input: { stateId: targetStateId } });
          const result = data?.issueUpdate;
          return JSON.stringify({
            ok: !!result?.success,
            issue: result?.issue?.identifier || issue.identifier,
            stateAfter: result?.issue?.state?.name || null,
            stateTypeAfter: result?.issue?.state?.type || null,
            resolution,
          });
        }

        case 'linear_link_attachment': {
          // linkPullRequest (native path): attach a URL to the issue.
          const id = args?.issueId || args?.identifier || args?.issueKey;
          const { url, title, subtitle } = args || {};
          if (!id || !url) return JSON.stringify({ error: 'issueId/identifier and url are required' });
          const issue = await getIssueByIdOrIdentifier(id, 'id identifier');
          if (!issue) return JSON.stringify({ error: `Issue not found: ${id}` });
          const data = await linearFetch(`
            mutation LinkAttachment($input: AttachmentCreateInput!) {
              attachmentCreate(input: $input) {
                success
                attachment { id url title }
              }
            }
          `, {
            input: {
              issueId: issue.id,
              url,
              title: title || url,
              subtitle: subtitle || undefined,
            },
          });
          const result = data?.attachmentCreate;
          return JSON.stringify({ ok: !!result?.success, attachmentId: result?.attachment?.id, url: result?.attachment?.url });
        }

        default:
          return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  },

  tools: [
    {
      name: 'linear_list_teams',
      description: 'List Linear teams (id, key, name). Needed to scope workflow states and issue queries.',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max teams (default: 50)' },
        },
      },
    },
    {
      name: 'linear_list_states',
      description: "List a team's workflow states (id, name, type: backlog|unstarted|started|completed|canceled|triage). Linear states are PER-TEAM. Omit team to list all states across the workspace.",
      input_schema: {
        type: 'object',
        properties: {
          teamId: { type: 'string', description: 'Team uuid' },
          teamKey: { type: 'string', description: 'Team key (e.g. ENG); resolved to an id if teamId omitted' },
          limit: { type: 'number', description: 'Max states when listing workspace-wide (default: 200)' },
        },
      },
    },
    {
      name: 'linear_list_labels',
      description: 'List issue labels, optionally scoped to a team.',
      input_schema: {
        type: 'object',
        properties: {
          teamId: { type: 'string', description: 'Optional team uuid to scope labels' },
          limit: { type: 'number', description: 'Max labels (default: 100)' },
        },
      },
    },
    {
      name: 'linear_list_issues',
      description: 'List/poll Linear issues filtered by team, state, label, assignee, and an updatedAfter cursor. Returns newest-updated first.',
      input_schema: {
        type: 'object',
        properties: {
          teamId: { type: 'string', description: 'Team uuid' },
          teamKey: { type: 'string', description: 'Team key (e.g. ENG); resolved if teamId omitted' },
          stateId: { type: 'string', description: 'Filter by workflow state uuid' },
          stateName: { type: 'string', description: 'Filter by state name (case-insensitive)' },
          label: { type: 'string', description: 'Filter by label name (case-insensitive)' },
          assigneeId: { type: 'string', description: 'Filter by assignee uuid' },
          updatedAfter: { type: 'string', description: 'ISO-8601 timestamp; only issues updated after this (polling cursor)' },
          limit: { type: 'number', description: 'Max issues (default: 30)' },
        },
      },
    },
    {
      name: 'linear_get_issue',
      description: 'Get a single Linear issue by identifier (e.g. ENG-123) or internal uuid — title, description, state, labels, assignee, url.',
      input_schema: {
        type: 'object',
        properties: {
          identifier: { type: 'string', description: 'Issue identifier, e.g. ENG-123' },
          issueId: { type: 'string', description: 'Internal issue uuid (alternative to identifier)' },
        },
      },
    },
    {
      name: 'linear_get_comments',
      description: 'Get comments on a Linear issue (newest first).',
      input_schema: {
        type: 'object',
        properties: {
          identifier: { type: 'string', description: 'Issue identifier, e.g. ENG-123' },
          issueId: { type: 'string', description: 'Internal issue uuid (alternative to identifier)' },
          limit: { type: 'number', description: 'Max comments (default: 50)' },
        },
      },
    },
    {
      name: 'linear_add_comment',
      description: 'Add a comment to a Linear issue (markdown supported).',
      input_schema: {
        type: 'object',
        properties: {
          identifier: { type: 'string', description: 'Issue identifier, e.g. ENG-123' },
          issueId: { type: 'string', description: 'Internal issue uuid (alternative to identifier)' },
          body: { type: 'string', description: 'Comment body (markdown)' },
        },
        required: ['body'],
      },
    },
    {
      name: 'linear_update_state',
      description: "Move a Linear issue to a different workflow state. Pass a state NAME (toStatus/stateName) and the tool resolves it to the issue's team's matching state id (exact -> type-alias -> fuzzy), or pass stateId directly. Linear has no transitions — this sets the state.",
      input_schema: {
        type: 'object',
        properties: {
          identifier: { type: 'string', description: 'Issue identifier, e.g. ENG-123' },
          issueId: { type: 'string', description: 'Internal issue uuid (alternative to identifier)' },
          stateId: { type: 'string', description: 'Target workflow state uuid (skips name resolution)' },
          stateName: { type: 'string', description: 'Target state name (e.g. "In Progress", "Done")' },
          toStatus: { type: 'string', description: 'Alias for stateName' },
        },
      },
    },
    {
      name: 'linear_link_attachment',
      description: 'Attach a URL (e.g. a GitHub PR) to a Linear issue via native attachments. Use this for PR links; fall back to linear_add_comment if it fails.',
      input_schema: {
        type: 'object',
        properties: {
          identifier: { type: 'string', description: 'Issue identifier, e.g. ENG-123' },
          issueId: { type: 'string', description: 'Internal issue uuid (alternative to identifier)' },
          url: { type: 'string', description: 'The URL to attach (e.g. a PR link)' },
          title: { type: 'string', description: 'Attachment title (defaults to the URL)' },
          subtitle: { type: 'string', description: 'Optional attachment subtitle' },
        },
        required: ['url'],
      },
    },
  ],
};

// ---- internal helpers (after the skill object; hoisted function decls) ----

/** Resolve a team key (ENG) to its uuid. Returns null if not found. */
async function resolveTeamId(teamKey) {
  const data = await linearFetch(`
    query TeamByKey($filter: TeamFilter) {
      teams(first: 1, filter: $filter) { nodes { id key } }
    }
  `, { filter: { key: { eq: teamKey } } });
  return data?.teams?.nodes?.[0]?.id || null;
}

/**
 * Fetch an issue by identifier (ENG-123) or internal uuid.
 * `selection` overrides the GraphQL field selection (defaults to core fields).
 */
async function getIssueByIdOrIdentifier(idOrIdentifier, selection = ISSUE_CORE_FIELDS) {
  const raw = String(idOrIdentifier).trim();
  // Identifier form: TEAMKEY-number (e.g. ENG-123)
  const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(raw);
  if (m) {
    const teamKey = m[1].toUpperCase();
    const number = Number(m[2]);
    const data = await linearFetch(`
      query IssueByIdentifier($filter: IssueFilter) {
        issues(first: 1, filter: $filter) {
          nodes { ${selection} }
        }
      }
    `, { filter: { number: { eq: number }, team: { key: { eq: teamKey } } } });
    return data?.issues?.nodes?.[0] || null;
  }
  // Internal uuid form.
  const data = await linearFetch(`
    query IssueById($id: String!) {
      issue(id: $id) { ${selection} }
    }
  `, { id: raw });
  return data?.issue || null;
}
