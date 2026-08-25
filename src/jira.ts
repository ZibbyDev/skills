import { createRequire } from 'module';
import { resolveIntegrationToken, clearTokenCache } from '@zibby/core/backend-client.js';
import { INTEGRATIONS } from './integrations.js';
import { fetchWithDeadline, isTimeoutError } from './lib/http-deadline.js';

const _require = createRequire(import.meta.url);

function resolveJiraBin() {
  if (process.env.MCP_JIRA_PATH) return process.env.MCP_JIRA_PATH;
  try { return _require.resolve('@zibby/mcp-jira/index.js'); } catch { return null; }
}

const BLOCK_TYPES = new Set([
  'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem',
  'blockquote', 'codeBlock', 'rule', 'table', 'tableRow', 'tableCell',
  'tableHeader', 'mediaSingle', 'panel',
]);

function applyMarks(text, marks) {
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

function adfToPlainText(nodes, depth = 0) {
  if (!Array.isArray(nodes)) return '';
  const parts = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      parts.push(applyMarks(node.text || '', node.marks));
      continue;
    }
    if (node.type === 'hardBreak') {
      parts.push('\n');
      continue;
    }
    if (node.type === 'rule') {
      parts.push('\n---\n');
      continue;
    }
    const inner = node.content ? adfToPlainText(node.content, depth + 1) : '';
    if (node.type === 'listItem') {
      parts.push(inner);
    } else if (node.type === 'bulletList') {
      const items = (node.content || []).map(li =>
        `- ${adfToPlainText(li.content || [], depth + 1).trim()}`
      );
      parts.push(`\n${items.join('\n')}\n`);
    } else if (node.type === 'orderedList') {
      const items = (node.content || []).map((li, i) =>
        `${i + 1}. ${adfToPlainText(li.content || [], depth + 1).trim()}`
      );
      parts.push(`\n${items.join('\n')}\n`);
    } else if (node.type === 'heading') {
      const level = node.attrs?.level || 2;
      parts.push(`\n\n${'#'.repeat(level)} ${inner.trim()}\n\n`);
    } else if (BLOCK_TYPES.has(node.type)) {
      parts.push(`\n\n${inner}\n`);
    } else {
      parts.push(inner);
    }
  }
  return parts.join('').replace(/\n{3,}/g, '\n\n');
}

function normalizeStatusLabel(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()\-_:："'`]/g, '');
}

function coreLabel(value) {
  return normalizeStatusLabel(value).replace(/[a-z0-9]+/g, '');
}

function diceSimilarity(a, b) {
  const x = normalizeStatusLabel(a);
  const y = normalizeStatusLabel(b);
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
    const countB = by.get(bg) || 0;
    overlap += Math.min(countA, countB);
  }
  return (2 * overlap) / Math.max(1, axCount + byCount);
}

function normalizeIssueTypeLabel(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()\-_:："'`]/g, '');
}

function chooseIssueType(requestedType, availableTypes = []) {
  const candidates = Array.isArray(availableTypes) ? availableTypes : [];
  if (candidates.length === 0) {
    return { requested: requestedType || null, resolved: null, strategy: 'none' };
  }

  const nonSubtask = candidates.filter(t => !t.subtask);
  const pool = nonSubtask.length > 0 ? nonSubtask : candidates;
  const requestedNorm = normalizeIssueTypeLabel(requestedType);

  if (requestedNorm) {
    const exact = pool.find(t => normalizeIssueTypeLabel(t.name) === requestedNorm);
    if (exact) return { requested: requestedType, resolved: exact, strategy: 'exact' };

    const aliases: any = {
      task: ['task', '任务', '事项', 'to do', 'todo'],
      story: ['story', '用户故事', '需求'],
      bug: ['bug', '缺陷', '问题'],
      improvement: ['improvement', '优化', '改进'],
      epic: ['epic', '史诗'],
    };

    for (const bucket of (Object.values(aliases) as any[][])) {
      if (!bucket.some(v => normalizeIssueTypeLabel(v) === requestedNorm)) continue;
      const aliasMatch = pool.find(t => bucket.some(v => normalizeIssueTypeLabel(v) === normalizeIssueTypeLabel(t.name)));
      if (aliasMatch) return { requested: requestedType, resolved: aliasMatch, strategy: 'alias' };
    }

    const scored = pool
      .map((t) => ({ t, score: diceSimilarity(requestedType, t.name) }))
      .sort((a, b) => b.score - a.score);
    if (scored[0] && scored[0].score >= 0.5) {
      return { requested: requestedType, resolved: scored[0].t, strategy: 'fuzzy' };
    }
  }

  const preferredOrder = ['task', 'story', 'bug', 'improvement', 'epic'];
  for (const pref of preferredOrder) {
    const match = pool.find(t => normalizeIssueTypeLabel(t.name) === pref);
    if (match) return { requested: requestedType || null, resolved: match, strategy: 'default-preferred' };
  }

  return { requested: requestedType || null, resolved: pool[0], strategy: 'default-first' };
}

async function listIssueTypesForProject(projectKey) {
  const q = `projectKeys=${encodeURIComponent(projectKey)}&expand=projects.issuetypes`;
  const data = await jiraFetch(`/rest/api/3/issue/createmeta?${q}`);
  const projects = Array.isArray(data?.projects) ? data.projects : [];
  const exact = projects.find(p => String(p?.key || '').toUpperCase() === String(projectKey || '').toUpperCase());
  const project = exact || projects[0] || null;
  const types = Array.isArray(project?.issuetypes) ? project.issuetypes : [];
  return types.map((t) => ({
    id: t.id,
    name: t.name,
    subtask: !!t.subtask,
    description: t.description || null,
  }));
}

async function listProjectSprints(projectKey, state) {
  if (!projectKey) throw new Error('projectKey is required');
  let sprintFilter = 'sprint is not EMPTY';
  if (state === 'active') sprintFilter = 'sprint in openSprints()';
  else if (state === 'closed') sprintFilter = 'sprint in closedSprints()';
  else if (state === 'future') sprintFilter = 'sprint in futureSprints()';
  const jql = `project = ${projectKey} AND ${sprintFilter} ORDER BY updated DESC`;
  const qs = `jql=${encodeURIComponent(jql)}&maxResults=100&fields=customfield_10020`;
  const data = await jiraFetch(`/rest/api/3/search/jql?${qs}`);
  const sprintMap = new Map();
  for (const issue of (data.issues || [])) {
    for (const s of (issue.fields?.customfield_10020 || [])) {
      if (s && !sprintMap.has(s.id)) {
        sprintMap.set(s.id, {
          id: s.id, name: s.name, state: s.state,
          boardId: s.boardId || null,
          startDate: s.startDate || null,
          endDate: s.endDate || null,
          goal: s.goal || null,
        });
      }
    }
  }
  return [...sprintMap.values()].sort((a, b) => {
    const order: any = { active: 0, future: 1, closed: 2 };
    const byState = (order[a.state] ?? 3) - (order[b.state] ?? 3);
    if (byState !== 0) return byState;
    return String(b.startDate || '').localeCompare(String(a.startDate || ''));
  });
}

function selectSprintFromCandidates(sprints, { sprintId, sprintName, target }: any = {}) {
  const all = Array.isArray(sprints) ? sprints : [];
  if (!all.length) return { sprint: null, selectedBy: 'none' };
  if (sprintId !== undefined && sprintId !== null && String(sprintId).trim() !== '') {
    const byId = all.find(s => String(s.id) === String(sprintId));
    return { sprint: byId || null, selectedBy: 'id' };
  }
  if (sprintName && String(sprintName).trim()) {
    const query = String(sprintName).trim();
    const exact = all.find(s => String(s.name || '').toLowerCase() === query.toLowerCase());
    if (exact) return { sprint: exact, selectedBy: 'name-exact' };
    const scored = all
      .map(s => ({ s, score: diceSimilarity(query, s.name || '') }))
      .sort((a, b) => b.score - a.score);
    if (scored[0] && scored[0].score >= 0.5) return { sprint: scored[0].s, selectedBy: 'name-fuzzy' };
    return { sprint: null, selectedBy: 'name-none' };
  }
  const mode = String(target || 'current').trim().toLowerCase();
  if (mode === 'active' || mode === 'current' || mode === 'latest') {
    return { sprint: all[0], selectedBy: mode };
  }
  return { sprint: all[0], selectedBy: 'default' };
}

function issueHasSprint(issueData, sprintId) {
  const raw = issueData?.fields?.customfield_10020;
  if (!Array.isArray(raw)) return false;
  return raw.some(s => String(s?.id) === String(sprintId));
}

async function verifyIssueSprintMembership({ issueKey, projectKey, sprintId, attempts = 3, delayMs = 450 }: any) {
  const traces = [];
  for (let i = 0; i < attempts; i++) {
    try {
      const verifyJql = `project = ${projectKey} AND key = ${issueKey} AND sprint = ${sprintId}`;
      const verifyQs = `jql=${encodeURIComponent(verifyJql)}&maxResults=1&fields=key,status`;
      const jqlRes = await jiraFetch(`/rest/api/3/search/jql?${verifyQs}`);
      const jqlOk = Number(jqlRes?.total || 0) > 0;
      if (jqlOk) {
        traces.push({ attempt: i + 1, jql: true, issueField: null });
        return { ok: true, method: 'jql', traces };
      }

      const issue = await jiraFetch(`/rest/api/3/issue/${issueKey}?fields=customfield_10020,status`);
      const issueFieldOk = issueHasSprint(issue, sprintId);
      traces.push({ attempt: i + 1, jql: false, issueField: issueFieldOk });
      if (issueFieldOk) {
        return { ok: true, method: 'issue_field', traces };
      }
    } catch (e) {
      traces.push({ attempt: i + 1, error: String(e?.message || e) });
    }
    if (i < attempts - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return { ok: false, method: 'none', traces };
}

async function moveIssueToSprint({ issueKey, projectKey, sprintId, sprintName, target }: any) {
  if (!issueKey) return { ok: false, error: 'issueKey is required' };
  let resolvedProjectKey = projectKey;
  if (!resolvedProjectKey) {
    const issue = await jiraFetch(`/rest/api/3/issue/${issueKey}?fields=project`);
    resolvedProjectKey = issue?.fields?.project?.key || null;
    if (!resolvedProjectKey) return { ok: false, error: `Could not resolve project for ${issueKey}` };
  }
  const sprints = await listProjectSprints(resolvedProjectKey, 'active');
  if (!sprints.length) {
    return { ok: false, error: `No assignable active sprint found for project ${resolvedProjectKey}` };
  }
  const { sprint: selected, selectedBy } = selectSprintFromCandidates(sprints, { sprintId, sprintName, target });
  if (!selected) {
    return {
      ok: false,
      error: `No matching sprint found in ${resolvedProjectKey}`,
      requested: { sprintId: sprintId ?? null, sprintName: sprintName ?? null, target: target ?? 'current' },
      availableSprints: sprints.map(s => ({ id: s.id, name: s.name, state: s.state })),
    };
  }
  await jiraFetch(`/rest/api/3/issue/${issueKey}`, {
    method: 'PUT',
    body: { fields: { customfield_10020: Number(selected.id) } },
  });
  const verification = await verifyIssueSprintMembership({
    issueKey,
    projectKey: resolvedProjectKey,
    sprintId: selected.id,
  });
  const inSprint = verification.ok;
  return {
    ok: inSprint,
    issueKey,
    projectKey: resolvedProjectKey,
    sprintId: selected.id,
    sprintName: selected.name,
    selectedBy,
    verifiedBy: verification.method,
    verified: inSprint,
    verificationTrace: verification.traces,
    warning: inSprint ? null : `Sprint assignment attempted but verification did not find ${issueKey} in sprint ${selected.id}`,
  };
}

/**
 * Resolve the Jira credential this process should use, normalized to ONE shape
 * the request layer can switch on. A Jira connection is either:
 *
 *   • `{ authType: 'oauth', accessToken, cloudId }` — the 3LO connection. The
 *     caller addresses `api.atlassian.com/ex/jira/<cloudId>` with a Bearer.
 *   • `{ authType: 'token', apiToken, email, baseUrl }` — a paste-token /
 *     self-host connection (backend `handlers/jira.js connectJiraToken`), or an
 *     operator's `.env`. The caller addresses the instance DIRECTLY and
 *     authenticates as HTTP Basic `email:apiToken`.
 *
 * TWO SOURCES, in this order:
 *
 *  1. The Basic-auth TRIO in the run env — `JIRA_API_TOKEN` + `JIRA_EMAIL` +
 *     `JIRA_BASE_URL`, which `workflow-executor` injects for an
 *     `authType:'token'` row (and the self-host docker dispatcher fills from the
 *     operator `.env` when the table set none). All THREE are required, so a
 *     half-set env can never shadow a working OAuth credential. This is the
 *     `SELF_HOST_ENV` bargain the github/gitlab skills already make: complete on
 *     its own, so no round-trip and the token never leaves the box.
 *  2. `resolveIntegrationToken('jira')` → the backend's `/jira/token`. It
 *     answers `{token, cloudId}` for OAuth and `{token, instanceUrl}` for a
 *     token row (VERIFIED on the founder's box, 2026-08-22). It carries no
 *     email, so the token branch reads that from the env alongside.
 *
 * The shape is chosen by WHAT THE CREDENTIAL CARRIES — never by an environment
 * check. On cloud, an OAuth row injects no `JIRA_*` trio and answers with a
 * `cloudId`, so the oauth branch is taken and the request is byte-identical to
 * what this file built before.
 */
export async function resolveJiraCredential() {
  const envToken = process.env.JIRA_API_TOKEN;
  const envEmail = process.env.JIRA_EMAIL;
  const envBase = process.env.JIRA_BASE_URL;
  if (envToken && envEmail && envBase) {
    return { authType: 'token', apiToken: envToken, email: envEmail, baseUrl: envBase };
  }

  const data: any = await resolveIntegrationToken('jira');
  if (data?.cloudId) {
    return { authType: 'oauth', accessToken: data.token, cloudId: data.cloudId };
  }
  // No cloudId ⇒ an API-token connection. `/jira/token` gives us the token and
  // the instance; the email is the one field it does not carry.
  return {
    authType: 'token',
    apiToken: data?.token,
    email: envEmail || data?.email || '',
    baseUrl: envBase || data?.instanceUrl || data?.baseUrl || process.env.ATLASSIAN_INSTANCE_URL || '',
  };
}

/**
 * A Jira REST request — `{ url, headers }` — as a PURE FUNCTION of the resolved
 * credential. The run-time twin of the backend's `handlers/jira.js jiraApiCall`,
 * deliberately the same shape so the two halves of one connection cannot drift.
 *
 * MEASURED against the founder's real instance (backend side, 2026-08-22):
 *   • `api.atlassian.com/ex/jira/undefined/rest/api/3/project` + Bearer → 404
 *   • `https://<instance>/rest/api/3/project` + Basic b64(email:apiToken) → 200
 *   • `https://<instance>/rest/api/3/project` + Bearer → 403
 * The third line is why the header is chosen by SHAPE and not shared: an
 * Atlassian API token is a Basic-auth PASSWORD, never a bearer. One header
 * cannot serve both.
 *
 * Both branches fail LOUD on a credential that cannot address an instance,
 * rather than composing `.../undefined/...` and letting Atlassian word the
 * error.
 */
export function jiraApiCall(cred: any, path: string, opts: any = {}) {
  const c = cred || {};
  const extra = {
    Accept: 'application/json',
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    ...opts.headers,
  };
  if (c.authType === 'token') {
    const base = String(c.baseUrl || c.instanceUrl || '').trim().replace(/\/+$/, '');
    const token = c.apiToken || c.accessToken || '';
    if (!base) throw new Error('Jira token connection has no base URL — reconnect Jira with its instance URL, or set JIRA_BASE_URL.');
    if (!c.email) throw new Error('Jira token connection has no account email — reconnect Jira with the account email, or set JIRA_EMAIL.');
    if (!token) throw new Error('Jira token connection has no API token — reconnect Jira, or set JIRA_API_TOKEN.');
    return {
      url: `${base}${path}`,
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${c.email}:${token}`).toString('base64'),
        ...extra,
      },
    };
  }
  if (typeof c.accessToken !== 'string' || !c.accessToken) {
    throw new Error(`Invalid jira token type: ${typeof c.accessToken}`);
  }
  if (!c.cloudId) {
    throw new Error('Invalid jira cloudId: missing');
  }
  return {
    url: `https://api.atlassian.com/ex/jira/${c.cloudId}${path}`,
    headers: {
      Authorization: `Bearer ${c.accessToken}`,
      ...extra,
    },
  };
}

/**
 * Low-level Jira REST helper. Resolves the credential via
 * `resolveJiraCredential()`, builds the request with `jiraApiCall()` (which
 * knows the two connection shapes), retries once on transient auth errors, and
 * returns parsed JSON (or `{ raw }` for non-JSON bodies).
 *
 * Exported so other templates (e.g. tracker-writeback, bug-autofix,
 * board-runner) can issue Jira REST calls the JIRA skill's MCP tools don't
 * cover. Keep this the single auth chokepoint; don't re-implement credential
 * resolution at call sites.
 *
 * ── `opts.signal`: OPTIONAL, and it is what turns a caller's WAIT into a real
 * ABORT ────────────────────────────────────────────────────────────────────
 * Node's global fetch has NO default timeout, and A HANG IS NOT A THROW, so an
 * Atlassian connection that is accepted and never answered parks whoever called
 * this forever. Callers that care already bound the WAIT from outside —
 * workflow-templates' `_shared/tracker.js jiraCall` races this promise against
 * a `BOARD_API_TIMEOUT_MS` deadline — but a race can only stop waiting; it
 * cannot close the socket, because the socket lives in here. Accepting a
 * `signal` is the missing half: the same deadline that ends the wait now also
 * ends the REQUEST.
 *
 * The signal covers the BODY read too — undici ties the response stream to the
 * request's signal — so a response whose headers arrive and whose body then
 * stalls is aborted on the same clock, which is the half a naive passthrough
 * would miss.
 *
 * ── AND NOW A DEFAULT UNDER IT (#1124) ─────────────────────────────────────
 * The passthrough shipped OPT-IN and inert, with no default timeout, on this
 * reasoning: "a shared library whose callers know their own budget … inventing
 * one for them is how a legitimately slow bulk JQL query starts failing in
 * production for a reason nobody asked for."
 *
 * That reasoning held while there was nowhere to put a budget that was not a
 * number invented in this file. It does not hold now: `lib/http-deadline.ts`
 * declares budgets BY WHAT IS MOVING, once, for every skill — and the slow bulk
 * JQL query is not a counter-example to bounding, it is one of the KINDS. A
 * `/search` is the far end COMPUTING, so it draws the `job` budget (5 min);
 * everything else here is a row read and draws `api` (30s). The knobs raise
 * either one without touching this file.
 *
 * What survived unchanged is the important half: EVERY CALLER TODAY PASSES
 * NOTHING, and a caller that does pass a signal still gets THEIR abort — their
 * reason, their error — because `fetchWithDeadline` COMPOSES the two rather
 * than replacing one with the other.
 *
 * @param {string} path  Jira REST path, e.g. `/rest/api/3/issue/PROJ-1`
 * @param {{ method?: string, body?: any, headers?: object, signal?: AbortSignal }} [opts]
 * @returns {Promise<any>} parsed JSON response body
 */
export async function jiraFetch(path, opts: any = {}) {
  const makeRequest = async () => {
    const cred = await resolveJiraCredential();
    const { url, headers } = jiraApiCall(cred, path, opts);
    const res = await fetchWithDeadline(url, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      // Absent ⇒ `undefined` ⇒ the deadline below is the only signal.
      signal: opts.signal,
    }, {
      // A JQL search is the far end COMPUTING over an issue corpus; every other
      // path here is a row read. See the budget note in lib/http-deadline.ts.
      kind: /\/search\b/.test(String(path)) ? 'job' : 'api',
      what: `Jira ${opts.method || 'GET'} ${path}`,
    });
    // ⚠️ AN ABORTED BODY READ IS NOT AN EMPTY BODY. Both reads below have
    // always swallowed their failure — which was harmless while nothing could
    // abort them, and is a FALSE SUCCESS the moment a signal can: `text()`
    // rejecting mid-stream would become `''`, and `''` is the legitimate
    // 204-No-Content answer this helper returns as `{}`. A caller's own
    // deadline firing during a label edit or a transition would then read back
    // as "the write succeeded", and the tracker would record a change Jira
    // never made. So an abort is rethrown and everything else keeps its
    // existing, deliberately forgiving behaviour.
    //
    // ⚠️ THE GUARD USED TO ASK `opts.signal?.aborted`, AND THAT STOPPED BEING
    // ENOUGH THE MOMENT THIS CALL GOT A DEFAULT DEADLINE. With no caller
    // signal, `opts.signal?.aborted` is `undefined` — so OUR OWN deadline
    // firing mid-body-read would have been swallowed into `''`, which is
    // exactly how this helper spells 204 No Content: a timed-out `transition`
    // would have read back as "the write succeeded". The question the guard
    // has to ask is about the ERROR ("did we stop waiting?"), never about
    // which clock happened to fire, so it now asks that instead.
    const readBody = () => res.text().catch((err) => {
      if (isTimeoutError(err) || opts.signal?.aborted) throw err;
      return '';
    });
    if (!res.ok) {
      const err = await readBody();
      throw new Error(`Jira API ${res.status}: ${err.slice(0, 300)}`);
    }
    const raw = await readBody();
    if (!raw || !raw.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return { raw };
    }
  };

  try {
    return await makeRequest();
  } catch (error) {
    // ⚠️ THE RETRY IS THE REASON THE PASSTHROUGH NEEDS A GUARD. `makeRequest`
    // is called a SECOND time on a transient auth error, and that second call
    // re-uses `opts.signal` — so once the caller's deadline has fired, a retry
    // is a request that can only abort again, and the only thing it can add is
    // another `resolveJiraCredential()` round trip AFTER the caller has already
    // stopped waiting. An aborted signal means "nobody is listening any more",
    // which is not a transient condition to recover from. Checked on the SIGNAL
    // rather than on the message, because the message heuristic below is prose-
    // matching: an abort reason a caller supplies itself
    // (`controller.abort(new Error('token refresh cancelled'))`) contains
    // "token" and would otherwise be retried into the void.
    if (opts.signal?.aborted) throw error;
    // Token endpoint / cache can intermittently return malformed auth payloads.
    // Clear and retry once to recover from transient auth state.
    const msg = String(error?.message || error || '').toLowerCase();
    const shouldRetry = msg.includes('token') || msg.includes('401') || msg.includes('403') || msg.includes('substring');
    if (!shouldRetry) throw error;
    clearTokenCache('jira');
    return makeRequest();
  }
}

export const jiraSkill: any = {
  id: 'jira',
  // Backend-calling: the MCP child talks to Zibby's own backend — the
  // session-env contract is guaranteed by backendSession.ts at registration
  // (declare ONCE here; see backend-session-env-contract.test.ts).
  callsBackend: true,
  serverName: 'jira',
  allowedTools: ['mcp__jira__*'],
  requiresIntegration: INTEGRATIONS.JIRA, // see sentrySkill.requiresIntegration for semantics
  envKeys: ['ATLASSIAN_ACCESS_TOKEN', 'ATLASSIAN_CLOUD_ID'],
  description: 'Zibby Jira MCP Server (OAuth Bearer)',

  promptFragment: `## Jira
You have direct access to the user's Jira. Use these tools proactively:

### Issue tools
- jira_search: Search issues with JQL (e.g. "project = PROJ AND status != Done ORDER BY updated DESC")
- jira_get_issue: Get full details of a ticket by key (e.g. PROJ-123)
- jira_list_statuses: List available Jira statuses (global or project-specific)
- jira_list_issue_types: List issue types allowed for issue creation in a project
- jira_create_issue: Create a new ticket (requires projectKey + summary)
- jira_get_comments: Get comments on a ticket (newest first) — use this to find testing steps, notes, etc.
- jira_add_comment: Add a comment to a ticket
- jira_edit_issue: Update fields (summary, labels, priority, story points)
- jira_transition_issue: Move a ticket to a different status (pass transitionId or toStatus)

### Project & sprint tools
- jira_list_projects: List all projects
- jira_list_sprints: List sprints for a project (filter by state: active/closed/future)
- jira_get_sprint_issues: Get all issues in a sprint — filter by status name (e.g. "进行中", "测试", "In Progress"). Returns status breakdown.
- jira_move_issue_to_sprint: Move an issue to a sprint (current/active/latest/by-id/by-name) and verify membership.

### Sprint membership updates
- To move an issue into a sprint, use jira_edit_issue with fields.customfield_10020 set to sprint numeric id.
- Example: jira_edit_issue({ issueKey: "PROJ-123", fields: { customfield_10020: 10 } })
- Always verify by calling jira_get_sprint_issues(sprintId, projectKey) and checking the issue key is present.
- For "create and place into current sprint" requests, use a generic atomic flow:
  - Prefer jira_create_issue with moveToSprint=true (optionally sprintId/sprintName/target)
  - Or create first, then use jira_move_issue_to_sprint
  - Always report verified sprint membership result (not just status transition)

### Search strategy (important!)
1. **Board/sprint first**: When the user asks about "my board", "testing tickets", or "what's in progress", ALWAYS use the sprint path: jira_list_sprints (state: active) → jira_get_sprint_issues. This finds ALL tickets regardless of age.
2. **Project-scoped search**: If you know the project key, use "project = KEY AND status != Done ORDER BY updated DESC" — no date filter needed when scoped to a project.
3. **Global search (last resort)**: Only use broad JQL like "created >= -365d" when you genuinely don't know the project. Never use -90d — it misses older tickets still in testing.
4. **Remember the board**: After finding the user's project/board, store it in memory (memory_store) so you go straight there next time.
5. **Status discovery**: NEVER use jira_search with guessed status keywords to determine whether a status exists. Use jira_list_statuses (project-scoped when possible) and/or jira_transition_issue(issueKey) without transitionId.

When the user asks about "my tickets" or "my board" and you know their project from memory, go directly to that project's active sprint.
When the user asks about projects or boards, call jira_list_projects.
When the user asks about sprints: jira_list_sprints → jira_get_sprint_issues.
When user asks to move ticket into a sprint, do NOT use status transition. Use jira_move_issue_to_sprint(issueKey, projectKey?, sprintId|sprintName|target) and report verified result.
When the user asks about testing steps, test cases, or wants to run tests for a ticket: call jira_get_comments — testing steps are typically written in the ticket's comments, not the description.
JQL must be bounded (Jira rejects unbounded queries). Use "project = KEY AND status != Done" for project queries. Use "created >= -365d ORDER BY updated DESC" for global queries.

### Transition workflow (MANDATORY)
When user asks to move/transition ticket status:
1. If user explicitly gives a target status (e.g. "move to 进行中", "move that in progress", "move to AI 验收"), call jira_transition_issue with issueKey + toStatus directly. Do NOT call list-only mode first.
2. If target is ambiguous or missing, call jira_transition_issue({ issueKey }) with no transitionId to list available transitions.
3. Pick the correct transition from returned list (match by "to" status name, not guesswork), then call jira_transition_issue with transitionId.
4. Call jira_get_issue(issueKey) to verify final status before claiming success.
5. If target wording differs (e.g. 已经验收 vs 已验收), try toStatus first; only ask user to confirm when no reasonable match exists.
6. IMPORTANT: When target is clear, complete transition + verification in SAME turn. Do NOT stop after listing options.`,

  resolve() {
    const bin = resolveJiraBin();
    if (!bin) return null;
    const env: any = {};
    for (const key of this.envKeys) {
      if (process.env[key]) env[key] = process.env[key];
    }
    if (process.env.ATLASSIAN_INSTANCE_URL) env.ATLASSIAN_INSTANCE_URL = process.env.ATLASSIAN_INSTANCE_URL;
    // Basic-auth (paste-token / self-host) Jira: the run env carries
    // JIRA_API_TOKEN / JIRA_EMAIL / JIRA_BASE_URL (workflow-executor injects them
    // when metadata.authType==='token'). Forward them into the MCP child's OWN
    // env HERE so the server is self-sufficient — the Claude Agent SDK's Bash
    // tool env is sanitized of JIRA_API_TOKEN (a hostile-input exfil guard), so
    // the child must receive it explicitly rather than by inheritance.
    for (const key of ['JIRA_API_TOKEN', 'JIRA_EMAIL', 'JIRA_BASE_URL']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return { command: 'node', args: [bin], env, description: this.description };
  },

  async handleToolCall(name, args) {
    try {
      switch (name) {
        case 'jira_list_projects': {
          const data = await jiraFetch('/rest/api/3/project');
          const projects = (Array.isArray(data) ? data : []).map(p => ({
            id: p.id, key: p.key, name: p.name, style: p.style,
          }));
          return JSON.stringify({ count: projects.length, projects });
        }
        case 'jira_list_statuses': {
          const { projectKey } = args || {};
          if (projectKey) {
            const data = await jiraFetch(`/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses`);
            const buckets = Array.isArray(data) ? data : [];
            const map = new Map();
            for (const bucket of buckets) {
              for (const st of (bucket.statuses || [])) {
                if (!st?.id) continue;
                if (!map.has(st.id)) {
                  map.set(st.id, {
                    id: st.id,
                    name: st.name,
                    category: st.statusCategory?.name || null,
                  });
                }
              }
            }
            const statuses = [...map.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
            return JSON.stringify({ scope: 'project', projectKey, count: statuses.length, statuses });
          }
          const data = await jiraFetch('/rest/api/3/status');
          const statuses = (Array.isArray(data) ? data : []).map((st) => ({
            id: st.id,
            name: st.name,
            category: st.statusCategory?.name || null,
          })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
          return JSON.stringify({ scope: 'global', count: statuses.length, statuses });
        }
        case 'jira_list_issue_types': {
          const { projectKey } = args || {};
          if (!projectKey) return JSON.stringify({ error: 'projectKey is required' });
          const issueTypes = await listIssueTypesForProject(projectKey);
          return JSON.stringify({ projectKey, count: issueTypes.length, issueTypes });
        }
        case 'jira_search': {
          let jql = args.jql || '';
          const max = args.maxResults || 20;
          const beforeOrderBy = jql.replace(/\s*ORDER\s+BY\s+.*/i, '').trim();
          if (!beforeOrderBy) {
            jql = `created >= -365d ${jql}`.trim();
          }
          const qs = `jql=${encodeURIComponent(jql)}&maxResults=${max}&fields=summary,status,assignee,priority,updated,issuetype,project`;
          const data = await jiraFetch(`/rest/api/3/search/jql?${qs}`);
          const issues = (data.issues || []).map(i => ({
            key: i.key,
            project: i.fields?.project?.key,
            summary: i.fields?.summary,
            status: i.fields?.status?.name,
            assignee: i.fields?.assignee?.displayName || 'Unassigned',
            priority: i.fields?.priority?.name,
            type: i.fields?.issuetype?.name,
          }));
          return JSON.stringify({ count: issues.length, issues });
        }
        case 'jira_get_issue': {
          const key = args.issueKey;
          if (!key) return JSON.stringify({ error: 'issueKey is required' });
          const data = await jiraFetch(`/rest/api/3/issue/${key}`);
          return JSON.stringify({
            key: data.key,
            project: data.fields?.project?.key,
            summary: data.fields?.summary,
            description: data.fields?.description,
            status: data.fields?.status?.name,
            assignee: data.fields?.assignee?.displayName || 'Unassigned',
            priority: data.fields?.priority?.name,
            type: data.fields?.issuetype?.name,
            labels: data.fields?.labels,
            created: data.fields?.created,
            updated: data.fields?.updated,
          });
        }
        case 'jira_create_issue': {
          const {
            projectKey,
            summary,
            issueType,
            description,
            priority,
            labels,
            assigneeId,
            moveToSprint,
            moveToActiveSprint,
            sprintId,
            sprintName,
            target,
          } = args;
          if (!projectKey || !summary) return JSON.stringify({ error: 'projectKey and summary are required' });
          let issueTypeSelection: any = { requested: issueType || null, resolved: null, strategy: 'none' };
          let availableIssueTypes = [];
          try {
            availableIssueTypes = await listIssueTypesForProject(projectKey);
            issueTypeSelection = chooseIssueType(issueType, availableIssueTypes);
          } catch {
            // Best effort only; creation can still work by name default.
          }
          const fields: any = {
            project: { key: projectKey },
            summary,
            issuetype: issueTypeSelection?.resolved?.id
              ? { id: issueTypeSelection.resolved.id }
              : { name: issueType || 'Task' },
          };
          if (description) {
            fields.description = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }] };
          }
          if (priority) fields.priority = { name: priority };
          if (labels?.length) fields.labels = labels;
          if (assigneeId) fields.assignee = { id: assigneeId };
          const data = await jiraFetch('/rest/api/3/issue', { method: 'POST', body: { fields } });
          const response: any = { ok: true, key: data.key, id: data.id, self: data.self };
          if (issueTypeSelection?.resolved) {
            response.issueType = issueTypeSelection.resolved.name;
            response.issueTypeResolution = issueTypeSelection.strategy;
            if (
              issueTypeSelection.strategy !== 'exact'
              && issueTypeSelection.requested
              && normalizeIssueTypeLabel(issueTypeSelection.requested) !== normalizeIssueTypeLabel(issueTypeSelection.resolved.name)
            ) {
              response.issueTypeWarning = `Requested "${issueTypeSelection.requested}" is not available in ${projectKey}; used "${issueTypeSelection.resolved.name}" instead.`;
            }
          }
          if (availableIssueTypes.length > 0) {
            response.availableIssueTypes = availableIssueTypes.map(t => t.name);
          }
          if (moveToSprint || moveToActiveSprint) {
            response.sprintMove = await moveIssueToSprint({
              issueKey: data.key,
              projectKey,
              sprintId,
              sprintName,
              target,
            });
          }
          return JSON.stringify(response);
        }
        case 'jira_list_sprints': {
          const { projectKey, state } = args;
          const sprints = await listProjectSprints(projectKey, state);
          return JSON.stringify({ count: sprints.length, sprints });
        }
        case 'jira_move_to_active_sprint': {
          // Backward-compatible alias; keep for existing chats/scripts.
          const { issueKey, projectKey, sprintId, sprintName, target } = args || {};
          const result = await moveIssueToSprint({
            issueKey, projectKey, sprintId, sprintName, target: target || 'current',
          });
          return JSON.stringify(result);
        }
        case 'jira_move_issue_to_sprint': {
          const { issueKey, projectKey, sprintId, sprintName, target } = args || {};
          const result = await moveIssueToSprint({
            issueKey, projectKey, sprintId, sprintName, target,
          });
          return JSON.stringify(result);
        }
        case 'jira_get_sprint_issues': {
          const { sprintName, sprintId, projectKey, status, maxResults } = args;
          if (!sprintName && !sprintId) return JSON.stringify({ error: 'sprintName or sprintId is required' });
          const max = maxResults || 50;
          const sprintClause = sprintId ? `sprint = ${sprintId}` : `sprint = "${sprintName}"`;
          const projClause = projectKey ? `project = ${projectKey} AND ` : '';
          const statusClause = status ? ` AND status = "${status}"` : '';
          const jql = `${projClause}${sprintClause}${statusClause} ORDER BY status ASC, priority DESC`;
          const qs = `jql=${encodeURIComponent(jql)}&maxResults=${max}&fields=summary,status,assignee,priority,issuetype,project`;
          const data = await jiraFetch(`/rest/api/3/search/jql?${qs}`);
          const issues = (data.issues || []).map(i => ({
            key: i.key,
            project: i.fields?.project?.key,
            summary: i.fields?.summary,
            status: i.fields?.status?.name,
            assignee: i.fields?.assignee?.displayName || 'Unassigned',
            priority: i.fields?.priority?.name,
            type: i.fields?.issuetype?.name,
          }));
          const statusCounts: any = {};
          for (const i of issues) statusCounts[i.status] = (statusCounts[i.status] || 0) + 1;
          return JSON.stringify({ count: issues.length, total: data.total || issues.length, statusCounts, issues });
        }
        case 'jira_get_comments': {
          const { issueKey, maxResults } = args;
          if (!issueKey) return JSON.stringify({ error: 'issueKey is required' });
          const max = maxResults || 50;
          const data = await jiraFetch(`/rest/api/3/issue/${issueKey}/comment?maxResults=${max}&orderBy=-created`);
          const comments = (data.comments || []).map(c => {
            let body = '';
            if (c.body?.content) {
              body = adfToPlainText(c.body.content);
            }
            return {
              id: c.id,
              author: c.author?.displayName || 'Unknown',
              body,
              created: c.created,
              updated: c.updated,
            };
          });
          return JSON.stringify({ count: comments.length, total: data.total || comments.length, comments });
        }
        case 'jira_add_comment': {
          const { issueKey, body: text } = args;
          if (!issueKey || !text) return JSON.stringify({ error: 'issueKey and body are required' });
          await jiraFetch(`/rest/api/3/issue/${issueKey}/comment`, {
            method: 'POST',
            body: {
              body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
            },
          });
          return JSON.stringify({ ok: true, issueKey });
        }
        case 'jira_edit_issue': {
          const { issueKey, fields } = args;
          if (!issueKey || !fields) return JSON.stringify({ error: 'issueKey and fields are required' });
          await jiraFetch(`/rest/api/3/issue/${issueKey}`, { method: 'PUT', body: { fields } });
          return JSON.stringify({ ok: true, issueKey });
        }
        case 'jira_transition_issue': {
          const { issueKey, transitionId, toStatus, statusName, status } = args;
          if (!issueKey) return JSON.stringify({ error: 'issueKey is required' });
          const targetStatus = String(toStatus || statusName || status || '').trim();

          if (!transitionId && !targetStatus) {
            const data = await jiraFetch(`/rest/api/3/issue/${issueKey}/transitions`);
            const transitions = (data.transitions || []).map(t => ({ id: t.id, name: t.name, to: t.to?.name }));
            return JSON.stringify({
              ok: false,
              error: 'transitionId or toStatus is required',
              issueKey,
              availableTransitions: transitions,
            });
          }

          let selectedTransitionId = transitionId;
          if (!selectedTransitionId) {
            const data = await jiraFetch(`/rest/api/3/issue/${issueKey}/transitions`);
            const transitions = (data.transitions || []);
            const normalizedTarget = normalizeStatusLabel(targetStatus);
            let matched = transitions.find((t) =>
              normalizeStatusLabel(t?.name || '') === normalizedTarget
              || normalizeStatusLabel(t?.to?.name || '') === normalizedTarget
            );
            if (!matched) {
              const targetCore = coreLabel(targetStatus);
              if (targetCore.length >= 2) {
                matched = transitions.find((t) => {
                  const nameCore = coreLabel(t?.name || '');
                  const toCore = coreLabel(t?.to?.name || '');
                  const nameOk = nameCore.length >= 2 && (nameCore.includes(targetCore) || targetCore.includes(nameCore));
                  const toOk = toCore.length >= 2 && (toCore.includes(targetCore) || targetCore.includes(toCore));
                  return nameOk || toOk;
                });
              }
            }
            if (!matched) {
              const scored = transitions
                .map((t) => {
                  const scoreName = diceSimilarity(targetStatus, t?.name || '');
                  const scoreTo = diceSimilarity(targetStatus, t?.to?.name || '');
                  return { t, score: Math.max(scoreName, scoreTo) };
                })
                .sort((a, b) => b.score - a.score);
              const best = scored[0];
              const second = scored[1];
              const clearlyBest = best
                && best.score >= 0.45
                && (!second || (best.score - second.score) >= 0.12);
              if (clearlyBest) matched = best.t;
            }
            if (!matched?.id) {
              return JSON.stringify({
                ok: false,
                error: `No transition matches target status: "${targetStatus}"`,
                issueKey,
                availableTransitions: transitions.map(t => ({ id: t.id, name: t.name, to: t.to?.name })),
              });
            }
            selectedTransitionId = matched.id;
          }

          await jiraFetch(`/rest/api/3/issue/${issueKey}/transitions`, {
            method: 'POST',
            body: { transition: { id: selectedTransitionId } },
          });

          const after = await jiraFetch(`/rest/api/3/issue/${issueKey}?fields=status`);
          return JSON.stringify({
            ok: true,
            issueKey,
            transitionId: selectedTransitionId,
            statusAfter: after?.fields?.status?.name || null,
          });
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
      name: 'jira_list_projects',
      description: 'List all Jira projects accessible to the user',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'jira_list_statuses',
      description: 'List Jira statuses. Use projectKey to get statuses applicable in that project workflow.',
      input_schema: {
        type: 'object',
        properties: {
          projectKey: { type: 'string', description: 'Optional project key (e.g. PROJ). If omitted, returns global status catalog.' },
        },
      },
    },
    {
      name: 'jira_list_issue_types',
      description: 'List issue types allowed for issue creation in the given project.',
      input_schema: {
        type: 'object',
        properties: {
          projectKey: { type: 'string', description: 'Project key, e.g. PROJ' },
        },
        required: ['projectKey'],
      },
    },
    {
      name: 'jira_search',
      description: 'Search Jira issues using JQL',
      input_schema: {
        type: 'object',
        properties: {
          jql: { type: 'string', description: 'JQL query string, e.g. "project = PROJ AND status = Open"' },
          maxResults: { type: 'number', description: 'Max results to return (default 20)' },
        },
        required: ['jql'],
      },
    },
    {
      name: 'jira_get_issue',
      description: 'Get details of a specific Jira issue',
      input_schema: {
        type: 'object',
        properties: { issueKey: { type: 'string', description: 'Issue key, e.g. PROJ-123' } },
        required: ['issueKey'],
      },
    },
    {
      name: 'jira_create_issue',
      description: 'Create a new Jira issue',
      input_schema: {
        type: 'object',
        properties: {
          projectKey: { type: 'string', description: 'Project key, e.g. PROJ' },
          summary: { type: 'string', description: 'Issue title/summary' },
          issueType: { type: 'string', description: 'Issue type (default: Task). Common: Task, Bug, Story, Epic' },
          description: { type: 'string', description: 'Issue description (plain text)' },
          priority: { type: 'string', description: 'Priority name, e.g. High, Medium, Low' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Array of label strings' },
          assigneeId: { type: 'string', description: 'Atlassian account ID to assign to' },
          moveToSprint: { type: 'boolean', description: 'If true, move created issue to a sprint and verify.' },
          moveToActiveSprint: { type: 'boolean', description: 'Backward-compatible alias for moveToSprint.' },
          sprintId: { type: 'number', description: 'Optional sprint id for placement.' },
          sprintName: { type: 'string', description: 'Optional sprint name for placement.' },
          target: { type: 'string', description: 'Placement target when sprintId/sprintName omitted: current|active|latest (default: current).' },
        },
        required: ['projectKey', 'summary'],
      },
    },
    {
      name: 'jira_list_sprints',
      description: 'List sprints for a Jira project (returns sprint names, IDs, states, dates)',
      input_schema: {
        type: 'object',
        properties: {
          projectKey: { type: 'string', description: 'Project key, e.g. PROJ' },
          state: { type: 'string', description: 'Filter: active, closed, future. Omit for all.' },
        },
        required: ['projectKey'],
      },
    },
    {
      name: 'jira_get_sprint_issues',
      description: 'Get all issues in a sprint, optionally filtered by status column name',
      input_schema: {
        type: 'object',
        properties: {
          sprintName: { type: 'string', description: 'Sprint name (from jira_list_sprints). Use this OR sprintId.' },
          sprintId: { type: 'number', description: 'Sprint ID (from jira_list_sprints). Use this OR sprintName.' },
          projectKey: { type: 'string', description: 'Project key to scope the search (optional)' },
          status: { type: 'string', description: 'Filter by status name (e.g. "进行中", "测试", "Done")' },
          maxResults: { type: 'number', description: 'Max issues to return (default 50)' },
        },
      },
    },
    {
      name: 'jira_move_to_active_sprint',
      description: 'Backward-compatible alias: move issue to sprint target and verify membership.',
      input_schema: {
        type: 'object',
        properties: {
          issueKey: { type: 'string', description: 'Issue key, e.g. PROJ-123' },
          projectKey: { type: 'string', description: 'Optional project key. If omitted, inferred from issue.' },
          sprintId: { type: 'number', description: 'Optional sprint id.' },
          sprintName: { type: 'string', description: 'Optional sprint name.' },
          target: { type: 'string', description: 'Target when sprintId/sprintName omitted: current|active|latest (default: current).' },
        },
        required: ['issueKey'],
      },
    },
    {
      name: 'jira_move_issue_to_sprint',
      description: 'Move an issue to a sprint by id/name/target and verify membership.',
      input_schema: {
        type: 'object',
        properties: {
          issueKey: { type: 'string', description: 'Issue key, e.g. PROJ-123' },
          projectKey: { type: 'string', description: 'Optional project key. If omitted, inferred from issue.' },
          sprintId: { type: 'number', description: 'Optional sprint id.' },
          sprintName: { type: 'string', description: 'Optional sprint name.' },
          target: { type: 'string', description: 'Target when sprintId/sprintName omitted: current|active|latest (default: current).' },
        },
        required: ['issueKey'],
      },
    },
    {
      name: 'jira_get_comments',
      description: 'Get comments on a Jira issue (newest first)',
      input_schema: {
        type: 'object',
        properties: {
          issueKey: { type: 'string', description: 'Issue key, e.g. PROJ-123' },
          maxResults: { type: 'number', description: 'Max comments to return (default 50)' },
        },
        required: ['issueKey'],
      },
    },
    {
      name: 'jira_add_comment',
      description: 'Add a comment to a Jira issue',
      input_schema: {
        type: 'object',
        properties: {
          issueKey: { type: 'string', description: 'Issue key, e.g. PROJ-123' },
          body: { type: 'string', description: 'Comment text (plain text)' },
        },
        required: ['issueKey', 'body'],
      },
    },
    {
      name: 'jira_edit_issue',
      description: 'Update fields on a Jira issue (summary, story points, labels, priority)',
      input_schema: {
        type: 'object',
        properties: {
          issueKey: { type: 'string', description: 'Issue key, e.g. PROJ-123' },
          fields: { type: 'object', description: 'Object of field names to values', additionalProperties: true },
        },
        required: ['issueKey', 'fields'],
      },
    },
    {
      name: 'jira_transition_issue',
      description: 'Move a Jira issue to a different status. Always pass toStatus when user gave a target; only pass issueKey alone when you explicitly need to list transitions.',
      input_schema: {
        type: 'object',
        properties: {
          issueKey: { type: 'string', description: 'Issue key, e.g. PROJ-123' },
          transitionId: { type: 'string', description: 'Transition ID to perform (optional if toStatus is provided)' },
          toStatus: { type: 'string', description: 'Target status/column name (e.g. "已经验收", "Done", "In Progress"). If provided, tool resolves matching transition automatically.' },
        },
        required: ['issueKey'],
      },
    },
  ],
};
