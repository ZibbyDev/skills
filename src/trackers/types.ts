/**
 * Neutral tracker types — the shared contract every tracker adapter implements.
 * ============================================================================
 *
 * This is the "neutrality payoff": a pipeline reads/writes ANY issue tracker
 * (Jira, Linear, GitHub Issues, Plane) through ONE interface, so a workflow
 * template never hard-codes a provider's REST shape.
 *
 * Design rule (from the build plan, "中立抽象最小版"):
 *   A field/method belongs in this contract IFF Jira AND GitHub AND Linear all
 *   have it AND the semantics line up. Provider-only data (Jira sprint /
 *   story-point, Linear cycle, GitHub milestone, Plane sequence_id) lives in
 *   `_raw` — never promoted to a top-level neutral field. Resisting that
 *   promotion is what keeps this from becoming "a Jira layer with a hat on".
 *
 * Field names are deliberately aligned to the OpenAI Symphony §4 domain model
 * (id / key / title / body / state / assignee / url) so a future Symphony
 * compatibility layer is additive, not a rewrite.
 *
 * STATE MODEL — the one piece of real cleverness:
 *   `state` is the RAW provider status name ("In Progress", "测试", "Done",
 *   "started"). It is what you WRITE BACK with — provider workflows reject made-
 *   up names, so the pipeline must echo the tracker's own vocabulary.
 *   `stateCategory` is the NORMALIZED bucket the pipeline BRANCHES on. Five
 *   buckets, no more:
 *     - 'todo'         not started yet (Jira `new`, Linear backlog/unstarted,
 *                      GitHub open w/o a progress label, Plane backlog/unstarted)
 *     - 'in_progress'  actively being worked (Jira `indeterminate`,
 *                      Linear started, Plane started, GitHub open w/ an
 *                      in-progress label)
 *     - 'done'         terminal/closed (Jira `done`, Linear completed/canceled,
 *                      Plane completed/cancelled, GitHub closed)
 *     - 'blocked'      explicitly blocked — NOT a native group in any provider;
 *                      only ever derived from a status NAME match
 *                      (blocked / on hold / waiting / stuck). Adapters surface
 *                      it best-effort; absence of 'blocked' is not a bug.
 *     - 'unknown'      could not classify (missing/unrecognized state)
 *   Keeping the pair separate is the whole trick: pipeline logic on the bucket,
 *   write-back on the raw name. Don't collapse them.
 */

/**
 * @typedef {'todo'|'in_progress'|'done'|'blocked'|'unknown'} StateCategory
 *   Normalized 5-bucket state. The pipeline branches on this; never on `state`.
 */

/**
 * A tracker ticket/issue projected onto the neutral model.
 *
 * @typedef {Object} NeutralTicket
 * @property {string} id
 *   Stable provider-internal id. Jira: issue id (numeric string). Linear: uuid.
 *   GitHub: issue number as a string. Plane: work-item uuid. Opaque — pass it
 *   back to the same adapter; do not parse it.
 * @property {string} key
 *   Human-facing reference. Jira: `PROJ-123`. Linear: `ENG-12`. GitHub:
 *   `owner/repo#123`. Plane: `PROJ-42` (or the uuid if the identifier is
 *   unknown). This is what shows up in PR titles / comments.
 * @property {string} title
 *   Short summary line (Symphony §4 `title`).
 * @property {string} body
 *   Full description as plain text / markdown (Symphony §4 `body`). ADF/HTML is
 *   flattened by the adapter; never raw ADF or raw HTML here.
 * @property {string|null} state
 *   RAW provider status NAME, exactly as the tracker spells it ("In Progress",
 *   "Done", "started", "测试"). Use this for write-back (transition). `null`
 *   when the provider/issue has no resolvable status.
 * @property {StateCategory} stateCategory
 *   Normalized bucket — what the pipeline branches on.
 * @property {string|null} assignee
 *   Single human-readable assignee (display name or login). `null` if
 *   unassigned. Multi-assignee providers (GitHub, Plane) collapse to the first;
 *   the full list, if any, lives in `_raw`.
 * @property {string|null} url
 *   Canonical web URL of the ticket, or `null` if the adapter can't derive one.
 * @property {Object} _raw
 *   Escape hatch — the untouched provider payload. Read provider-specific data
 *   (sprint, story points, cycle, milestone, sequence_id, labels…) from here.
 *   NEVER promote a `_raw` field to a top-level neutral field.
 */

/**
 * A single comment on a ticket, projected onto the neutral model.
 *
 * @typedef {Object} NeutralComment
 * @property {string} id            Provider comment id (opaque).
 * @property {string} author        Human-readable author (display name/login).
 * @property {string} body          Comment text as plain text / markdown
 *                                  (ADF/HTML flattened).
 * @property {string|null} createdAt ISO-8601 creation timestamp, if available.
 * @property {string|null} updatedAt ISO-8601 update timestamp, if available.
 * @property {Object} [_raw]        Untouched provider comment payload.
 */

/**
 * Options accepted by {@link TrackerAdapter.listCandidates}. Every field is
 * optional; what each provider honors differs (documented per adapter). The
 * shared minimum is "give me a bounded, newest-first slab of work to consider".
 *
 * @typedef {Object} ListCandidatesOptions
 * @property {string} [query]
 *   Provider-native query. Jira: a JQL string. GitHub: free-text issue search
 *   (or used with `labels`). Linear/Plane: ignored in favor of structured
 *   filters below. Adapters that can't honor it ignore it.
 * @property {string|string[]} [labels]  Restrict to issues carrying label(s).
 * @property {string} [state]            Provider state filter (raw name or, for
 *                                      GitHub, open|closed|all).
 * @property {string} [updatedAfter]     ISO-8601 polling cursor; only issues
 *                                      updated at/after this.
 * @property {number} [limit]            Max tickets to return (bounded).
 * @property {string} [cursor]           Opaque pagination cursor (Plane).
 * @property {Object} [ctx]              Provider scope/context (e.g. GitHub
 *                                      {owner, repo}; Plane {workspaceSlug,
 *                                      projectId}). Passed through verbatim.
 */

/**
 * The neutral tracker interface — the 6-method MINIMUM contract.
 *
 * Three READ methods + three WRITE methods + identity metadata. Each concrete
 * adapter (jira / linear / github / plane) implements exactly these. Anything a
 * single provider can do that the others can't does NOT get a 7th method — it
 * stays accessible only via that provider's own skill tools / the `_raw` hatch.
 *
 * @typedef {Object} TrackerAdapter
 * @property {string} id
 *   Provider id: 'jira' | 'linear' | 'github' | 'plane'.
 *
 * @property {(opts?: ListCandidatesOptions) => Promise<NeutralTicket[]>} listCandidates
 *   READ. Return a bounded, newest-first set of tickets to consider for work.
 *
 * @property {(key: string, ctx?: Object) => Promise<NeutralTicket|null>} getTicket
 *   READ. Fetch one ticket by its `key` (or id). `null` if not found.
 *
 * @property {(key: string, ctx?: Object) => Promise<NeutralComment[]>} getComments
 *   READ. Fetch the comment thread (newest first).
 *
 * @property {(key: string, body: string, ctx?: Object) => Promise<{ok: boolean, id?: string|null, error?: string}>} addComment
 *   WRITE. Add a comment. `body` is plain text / markdown; the adapter handles
 *   provider encoding (Jira ADF, Plane HTML).
 *
 * @property {(key: string, targetStateName: string, ctx?: Object) => Promise<{ok: boolean, stateAfter?: string|null, stateCategoryAfter?: StateCategory, error?: string}>} transition
 *   WRITE. Move the ticket to a target state, addressed by its RAW name
 *   (fuzzy-matched per provider). Jira performs a workflow transition; Linear /
 *   Plane PATCH the state directly; GitHub maps to open/close (+ a labels
 *   convention — see github-adapter). NOT every target name is reachable on
 *   every provider; the result carries `ok:false` + `error` when it isn't.
 *
 * @property {(key: string, prUrl: string, title?: string, ctx?: Object) => Promise<{ok: boolean, via?: string, error?: string}>} linkPullRequest
 *   WRITE. Associate a PR URL with the ticket. Native where possible (Jira
 *   remote-link, Linear attachment); a comment everywhere else. `via` reports
 *   which path was used ('remotelink' | 'attachment' | 'comment').
 */

// This module is JSDoc-only (types/interface doc). The named export below gives
// `import { TRACKER_STATE_CATEGORIES } from './types.js'` something concrete and
// lets adapters/tests share the canonical bucket list instead of re-spelling it.
/** @type {StateCategory[]} */
export const TRACKER_STATE_CATEGORIES = ['todo', 'in_progress', 'done', 'blocked', 'unknown'];
