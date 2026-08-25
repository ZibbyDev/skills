/**
 * Every skill's outbound HTTP door, bounded from ONE declaration.
 * ============================================================================
 *
 * WHY THIS FILE EXISTS. Node's global `fetch` has NO default timeout, and A
 * HANG IS NOT A THROW: a connection that is accepted and then never answered
 * is not an error any `catch` can see — it is a process that stops. Every
 * provider module in this package is already written for failure (a non-2xx
 * becomes a worded error the agent can read and route around), and NONE of
 * that code can run for the one failure mode that actually costs a run.
 *
 * MEASURED, not hypothetical: board-runner run 4b49371e (2026-08-24) sat 7m33s
 * inside the identical unbounded shape until the container watchdog killed it,
 * and a tick that had already done all of its work recorded nothing. The class
 * has since been closed one layer at a time — workflow-templates' `lib/kb.js`
 * (d7e3184), `lib/platform-api.js` (7a355cc), `_shared/tracker.js` (539483e),
 * `@zibby/core`'s `backend-client.js` (6677c77), `@zibby/agent-workflow`'s
 * dispatch path (1ef5cca), and the runner's own seven doors (d0d857a, d32ba9c).
 *
 * THIS IS THE LAST LAYER, and the widest: ~45 call sites across ~25 provider
 * modules. That width is exactly why it is a HELPER and not 45 hand-written
 * `AbortSignal.timeout(...)` calls. Forty-five copies of a clamp, a
 * `TimeoutError` check and a budget is the TWO-PLACES shape multiplied — a set
 * that must agree, with nothing to scream when it drifts. One declaration, N
 * consumers, and `__tests__/skills-http-doors-bounded.test.ts` reads the SOURCE
 * of every provider module so that call site #46 fails the suite the day it is
 * WRITTEN rather than the day it hangs somebody's run.
 *
 * ⚠️ A SKILL'S HANG IS CHEAPER THAN THE RUNNER'S, WHICH IS WHY IT WAS DEFERRED
 * AND WHY IT IS NOT FREE. The runner's doors bracket the whole run; a skill's
 * door costs "only" one tool call. But a tool call the model is waiting on is
 * a run that is waiting on it, and the container watchdog does not care which
 * layer stopped. The difference is the BUDGET, not whether there is one.
 */

/* ── THREE BUDGETS, SPLIT BY WHAT IS ACTUALLY MOVING ────────────────────────
 * The card that closed this class asked for "sensible per call kind, not one
 * global number — a clone or a large download is not a status poll." So the
 * kinds are named after WHAT VARIES in the call, because that is what decides
 * how long "healthy" can legitimately be:
 *
 * 'api'  — 30s. THE FAR END ANSWERS FROM A TABLE. A provider REST/GraphQL
 *   request (GitHub, GitLab, Slack, Lark, Notion, Linear, Jira, Sentry,
 *   Vikunja, Plane, Figma, HubSpot, Discord, LinkedIn, Google, OpenDesign,
 *   OpenAI/Anthropic/Cursor billing) or one of our own control-plane routes
 *   (artifacts, dataset stores, kv/review memory, integration status). A
 *   healthy call here is tens to hundreds of milliseconds; nothing in this
 *   class does real work on the far side.
 *
 *   Why 30s and not the runner's 15s: those calls all go through OUR API
 *   Gateway, whose 29s integration timeout meant 15s could never cut a
 *   legitimate request short. Most of these do not — they cross the public
 *   internet to a third party we do not operate, through whatever proxy the
 *   customer's egress imposes, and a p99 that is two orders of magnitude off
 *   p50 is ordinary out there. 30s keeps a legitimately slow provider working
 *   while still turning a HANG into a worded failure inside one tool call.
 *
 * 'transfer' — 120s. THE VARIABLE IS SIZE. A presigned S3 PUT/GET, a Lark
 *   media upload, a LinkedIn image PUT, a Notion file upload, a tarball
 *   download. Four times the budget because the honest answer scales with the
 *   body, and none of it is the far end thinking. Still bounded: a body that
 *   genuinely cannot move in two minutes is a problem the run should REPORT,
 *   not wait out.
 *
 * 'job' — 300s. THE FAR END MUST COMPUTE. Today: `dataset_query` and
 *   `dataset_sql`, which are an Athena scan / a SQLite engine pass behind the
 *   route, not a row read. This is the one kind where a multi-minute answer is
 *   CORRECT, so it gets the longest leash — and it is deliberately a separate
 *   name rather than "raise the api number", because raising 'api' would hand
 *   the same five minutes to a Slack `chat.postMessage`.
 *
 * FRESH PER CALL, never one deadline shared across a pass. Each call is an
 * INDEPENDENT statement, and every failure is reported separately. A shared
 * deadline would let one slow request fail every later one in the same tool
 * call — the difference between "listing comments timed out" and "the whole
 * review produced nothing". It also makes RETRY correct by construction: a
 * provider module that retries gets a full fresh budget per attempt, and can
 * never retry under a signal the CALLER has already spent — `fetchWithDeadline`
 * refuses before it opens a socket.
 *
 * Every knob is BRAND-NEUTRAL (the product may be renamed; a NEW identifier
 * must not bake in a brand) and CLAMPED to 1s..600s — so a typo, a stray minus
 * sign, an empty string, or a `0` (the value most APIs spell "no timeout")
 * cannot quietly restore the unbounded behaviour this file exists to remove.
 */
export const SKILL_API_TIMEOUT_MS = 30_000;
export const SKILL_TRANSFER_TIMEOUT_MS = 120_000;
export const SKILL_JOB_TIMEOUT_MS = 300_000;

export const TIMEOUT_FLOOR_MS = 1_000;
export const TIMEOUT_CEILING_MS = 600_000;

export type DoorKind = 'api' | 'transfer' | 'job';

const KINDS: Record<DoorKind, { knob: string; fallback: number }> = {
  api: { knob: 'SKILL_API_TIMEOUT_MS', fallback: SKILL_API_TIMEOUT_MS },
  transfer: { knob: 'SKILL_TRANSFER_TIMEOUT_MS', fallback: SKILL_TRANSFER_TIMEOUT_MS },
  job: { knob: 'SKILL_JOB_TIMEOUT_MS', fallback: SKILL_JOB_TIMEOUT_MS },
};

/**
 * Read a budget from the environment, or fall back. Clamped to
 * [TIMEOUT_FLOOR_MS, TIMEOUT_CEILING_MS]; anything unparseable or non-positive
 * (`0`, `-1`, `''`, `'soon'`) falls back rather than disabling the bound.
 */
export function timeoutMsFrom(knob: string, fallback: number, env: any = process.env): number {
  const n = Number(env?.[knob]);
  return Number.isFinite(n) && n > 0
    ? Math.min(TIMEOUT_CEILING_MS, Math.max(TIMEOUT_FLOOR_MS, Math.floor(n)))
    : fallback;
}

/** The effective budget for a call kind, after the env override and the clamp. */
export function timeoutMsForKind(kind: DoorKind = 'api', env: any = process.env): number {
  const k = KINDS[kind] || KINDS.api;
  return timeoutMsFrom(k.knob, k.fallback, env);
}

/**
 * `AbortSignal.timeout` aborts with a `TimeoutError` DOMException (undici
 * rejects the fetch — and any in-flight body read — with that same reason); a
 * caller-cancelled signal aborts with `AbortError`. Both mean "WE stopped
 * waiting"; NEITHER means "the far end said no", which is why every call site
 * has to branch on this before deciding whether to reword an error or rethrow
 * it UNCHANGED.
 */
export function isTimeoutError(err: any): boolean {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}

/**
 * The host a URL is aimed at, for the error message. Never the path, never the
 * query: a presigned S3 URL carries its signature in the query string and a
 * provider URL carries ids the model will happily paste into a comment, so a
 * timeout message that echoed the full URL would be a credential leak wearing
 * a diagnostic's clothes (invariant #4). The host is what a human needs in
 * order to tell "GitHub is down" from "our control plane is down" from "this
 * box has no egress", and it is all they need.
 */
export function hostOf(url: any): string {
  try {
    return new URL(String(url?.url ?? url)).host || 'unknown host';
  } catch {
    return 'unknown host';
  }
}

/* ── COMPOSING THE CALLER'S SIGNAL WITH OURS ────────────────────────────────
 * `AbortSignal.any` would be one line, and it is Node 20.3+. This package
 * declares `engines.node >= 18` and esbuild targets node18, which does NOT
 * polyfill runtime APIs — so `AbortSignal.any` here would be a TypeError on a
 * supported runtime, not a build error. Hence the hand-rolled composer.
 *
 * It matters that this is a COMPOSITION and not a replacement: `jiraFetch`
 * already takes a caller signal (be41a28) so a board tick can abort a call it
 * has stopped waiting for, and a caller who passes one must keep getting THEIR
 * abort — their reason, their error — rather than our reworded timeout.
 */
function linkSignals(theirs: AbortSignal | undefined, ours: AbortSignal): AbortSignal {
  if (!theirs) return ours;
  const ctrl = new AbortController();
  const abort = (reason: any) => { if (!ctrl.signal.aborted) ctrl.abort(reason); };
  const onTheirs = () => abort(theirs.reason);
  const onOurs = () => abort(ours.reason);

  /**
   * ⚠️ THE LINK MUST OUTLIVE THE REQUEST, and the first draft of this file
   * tore it down in a `finally` — which un-bounded the exact half the design
   * exists for. `fetch` resolves when the HEADERS arrive; the BODY is read
   * afterwards, on the same signal. A teardown at request-end therefore left
   * `res.json()` riding a signal that could no longer abort — a hang wearing a
   * 200, the shape hardest to notice. The already-shipped
   * `jira-signal-passthrough.test.ts` "BODY stalls after the headers" case
   * caught it, which is the whole argument for pinning a rule with a test.
   *
   * So the listeners are dropped on the FIRST abort instead, not on
   * completion. That is not a leak either: `ours` is an `AbortSignal.timeout`,
   * so it always fires eventually — the listener on the caller's (possibly
   * long-lived, possibly reused) signal is removed within one budget rather
   * than accumulating one entry per request forever.
   */
  ctrl.signal.addEventListener('abort', () => {
    theirs.removeEventListener('abort', onTheirs);
    ours.removeEventListener('abort', onOurs);
  }, { once: true });

  if (theirs.aborted) abort(theirs.reason);
  else if (ours.aborted) abort(ours.reason);
  else {
    theirs.addEventListener('abort', onTheirs, { once: true });
    ours.addEventListener('abort', onOurs, { once: true });
  }
  return ctrl.signal;
}

export interface DoorOptions {
  /** Which budget applies. Defaults to 'api'. */
  kind?: DoorKind;
  /**
   * What the caller was DOING, in the words a human reading a run log needs:
   * "GitHub GET /repos/x/y/pulls", "Lark media upload". CLAUDE.md's rule is
   * that error text must describe THIS failure, not a different era's — a bare
   * "fetch timed out" makes every one of ~45 doors look identical in a log.
   */
  what?: string;
  /** An explicit budget, for the rare call that is none of the three kinds. */
  timeoutMs?: number;
}

/**
 * THE ONE DOOR. A `fetch` that cannot hang, whose timeout says WHAT timed out
 * and AGAINST WHICH HOST, and which passes a caller's own `signal` straight
 * through.
 *
 * Deliberately a drop-in for `fetch(url, init)`: it returns the same `Response`
 * and rethrows every non-timeout error as the SAME OBJECT, so a provider
 * module's existing `!res.ok` handling, its status branches and its error
 * wording are all untouched. The only observable difference is that the hang
 * became a throw — which is precisely what every one of those `catch` blocks
 * was already written for and could never reach.
 *
 * ⚠️ THE SIGNAL COVERS THE BODY READ TOO, and that is load-bearing rather than
 * incidental: a response whose HEADERS arrive and whose BODY then stalls is the
 * same hang wearing a 200, and bounding only the first half would leave the
 * door open in the shape hardest to notice. undici rejects an in-flight
 * `res.json()` / `res.text()` with the request's abort reason, so callers get
 * the same `TimeoutError` — see `describeTimeout` for turning that half into
 * words at the call site.
 */
export async function fetchWithDeadline(
  url: any,
  init: any = {},
  opts: DoorOptions = {},
): Promise<Response> {
  const kind: DoorKind = opts.kind || 'api';
  const knob = (KINDS[kind] || KINDS.api).knob;
  const ms = opts.timeoutMs
    ? Math.min(TIMEOUT_CEILING_MS, Math.max(TIMEOUT_FLOOR_MS, Math.floor(opts.timeoutMs)))
    : timeoutMsForKind(kind);

  const theirs: AbortSignal | undefined = init?.signal;
  // A caller whose signal is ALREADY spent must not get one more request out of
  // us. This is the retry lesson from be41a28 generalised: a retry loop that
  // re-enters after its deadline fired would otherwise open a fresh socket the
  // caller has already stopped waiting for.
  if (theirs?.aborted) throw theirs.reason ?? new DOMException('This operation was aborted', 'AbortError');

  const ours = AbortSignal.timeout(ms);
  const signal = linkSignals(theirs, ours);

  try {
    return await fetch(url, { ...init, signal });
  } catch (err: any) {
    // OUR deadline fired → a worded failure naming the call and the host.
    // THEIR signal fired → their abort, rethrown untouched; it is not our
    // timeout and must not be described as one.
    if (ours.aborted && isTimeoutError(err)) {
      throw new Error(
        `${opts.what || 'request'} TIMED OUT after ${ms}ms against ${hostOf(url)} (${knob})`,
      );
    }
    throw err;
  }
}

/**
 * The BODY half, in words. `fetchWithDeadline` cannot wrap `res.json()` for the
 * caller — the caller decides whether it wants json, text, bytes or nothing —
 * so a module that reads a body under the same signal wraps the read in this to
 * get a message in the same voice:
 *
 *   catch (err) { throw new Error(describeTimeout(err, { what, url, kind, body: true })); }
 *
 * Returns `null` when the error is NOT a timeout, so the caller can rethrow the
 * original object unchanged rather than flattening a real transport error into
 * a string.
 */
export function describeTimeout(
  err: any,
  { what, url, kind = 'api', timeoutMs, body = false }: DoorOptions & { url?: any; body?: boolean },
): string | null {
  if (!isTimeoutError(err)) return null;
  const knob = (KINDS[kind] || KINDS.api).knob;
  const ms = timeoutMs || timeoutMsForKind(kind);
  return `${what || 'request'}${body ? ' body read' : ''} TIMED OUT after ${ms}ms against ${hostOf(url)} (${knob})`;
}
