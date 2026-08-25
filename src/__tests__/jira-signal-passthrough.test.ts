/**
 * `jiraFetch` accepts an OPTIONAL `signal` — the half that turns a caller's
 * WAIT into a real ABORT.
 * ============================================================================
 *
 * WHY. Node's global fetch has no default timeout and A HANG IS NOT A THROW, so
 * a Jira connection that is accepted and never answered parks whoever called
 * this forever. Callers that care already bound the WAIT from outside:
 * workflow-templates' `_shared/tracker.js jiraCall` races this promise against a
 * `BOARD_API_TIMEOUT_MS` deadline (539483e), with the limitation written into
 * that file in as many words — "it cannot ABORT, it can stop WAITING … Give
 * `jiraFetch` a `signal` passthrough one day and this becomes a real abort with
 * no change here." This is that day.
 *
 * THE CONTRACT, and every clause of it is a way this could go wrong:
 *   1. a signal, when passed, reaches `fetch` — otherwise the whole thing is
 *      decorative;
 *   2. an abort really does reject the call, in the caller's budget;
 *   3. an UNSIGNALLED call is bounded anyway, by the shared default;
 *   4. the retry must not fire under an aborted signal — `jiraFetch` calls
 *      `makeRequest` a SECOND time on a transient auth error, re-using the same
 *      spent signal, and the retry heuristic is PROSE-MATCHING ("token", "401")
 *      so a caller's own abort reason can trip it;
 *   5. the retry is otherwise untouched.
 *
 * ⚠️ CLAUSE 3 IS THE ONE THAT CHANGED, and this file is where the old promise
 * was written down, so this is where the change is accounted for. The
 * passthrough shipped (be41a28) with clause 3 reading "NOTHING CHANGES when no
 * signal is passed … there is deliberately NO default timeout invented here (a
 * shared library does not know its caller's budget, and guessing one is how a
 * legitimately slow bulk JQL starts failing in production)".
 *
 * #1124 closed that hole, and the reasoning that held it open is what changed:
 * there is now a place to put a budget that is not a number invented in
 * `jira.ts` — `lib/http-deadline.ts` declares budgets BY WHAT IS MOVING, once,
 * for every skill in the package. The slow bulk JQL is not a counter-example to
 * bounding; it is one of the KINDS ('job', 5 minutes, because a `/search` is
 * the far end COMPUTING). What did NOT change is the half that mattered: a
 * caller that passes a signal still gets THEIR abort, with their reason —
 * `fetchWithDeadline` COMPOSES the two signals rather than replacing one.
 *
 * The visible consequence, pinned below: `fetch` no longer receives the
 * caller's signal OBJECT, it receives a composed one that aborts when EITHER
 * fires. Identity was never the contract — "an abort really does abort" is.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const resolveIntegrationToken = vi.fn();
const clearTokenCache = vi.fn();
vi.mock('@zibby/core/backend-client.js', () => ({
  resolveIntegrationToken: (p: string) => resolveIntegrationToken(p),
  clearTokenCache: (p: string) => clearTokenCache(p),
}));

const { jiraFetch } = await import('../jira.js');

const JIRA_ENV = ['JIRA_API_TOKEN', 'JIRA_EMAIL', 'JIRA_BASE_URL', 'ATLASSIAN_INSTANCE_URL'];
// Budgets are clamped to a 1s floor, so a test can shrink one to fail in a
// second rather than parking the suite for the production default.
const BUDGET_ENV = ['SKILL_API_TIMEOUT_MS', 'SKILL_JOB_TIMEOUT_MS', 'SKILL_TRANSFER_TIMEOUT_MS'];
const ORIG: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of JIRA_ENV) { ORIG[k] = process.env[k]; delete process.env[k]; }
  for (const k of BUDGET_ENV) { ORIG[k] = process.env[k]; delete process.env[k]; }
  resolveIntegrationToken.mockReset();
  clearTokenCache.mockReset();
  resolveIntegrationToken.mockResolvedValue({ token: 'oauth_tok', cloudId: 'cloud-123' });
});

afterEach(() => {
  for (const k of JIRA_ENV) {
    if (ORIG[k] === undefined) delete process.env[k]; else process.env[k] = ORIG[k]!;
  }
  for (const k of BUDGET_ENV) {
    if (ORIG[k] === undefined) delete process.env[k]; else process.env[k] = ORIG[k]!;
  }
  vi.unstubAllGlobals();
});

/**
 * A Jira that answers ONLY when its caller stops waiting — with a signal it
 * rejects the way undici does; WITHOUT one it never settles, which is the
 * production bug reproduced. Deleting the passthrough turns these into hangs.
 */
function neverAnswers(opts: any) {
  return new Promise((_resolve, reject) => {
    const s = opts?.signal;
    if (!s) return; // unbounded — the bug
    const fire = () => reject(s.reason ?? Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
    if (s.aborted) fire();
    else s.addEventListener('abort', fire, { once: true });
  });
}

describe('the signal reaches fetch and really aborts', () => {
  it('forwards the caller’s abort to fetch — composed with the default deadline', async () => {
    const seen: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: any, opts: any = {}) => {
      seen.push(opts.signal);
      return { ok: true, status: 200, text: async () => '{"ok":true}' } as any;
    }));

    const ac = new AbortController();
    await jiraFetch('/rest/api/3/project', { signal: ac.signal });

    expect(seen).toHaveLength(1);
    // NOT the same object any more — the request rides a signal that aborts on
    // EITHER clock. Identity was never the contract; this is:
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[0].aborted).toBe(false);
    ac.abort(new Error('caller gave up'));
    expect(seen[0].aborted).toBe(true);
    expect(String((seen[0].reason as any)?.message)).toBe('caller gave up');
  });

  it('a request that never answers rejects on the caller’s deadline', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: any, opts: any) => neverAnswers(opts)));

    const t0 = Date.now();
    // Exactly the shape `_shared/tracker.js` uses for its board budget.
    await expect(jiraFetch('/rest/api/3/search/jql', { signal: AbortSignal.timeout(300) }))
      .rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it('the abort covers a request whose BODY stalls after the headers', async () => {
    // undici ties the response stream to the request's signal, so bounding the
    // headers alone would have left the second half of the hang open.
    vi.stubGlobal('fetch', vi.fn(async (_url: any, opts: any) => ({
      ok: true,
      status: 200,
      text: () => neverAnswers(opts),
    } as any)));

    await expect(jiraFetch('/rest/api/3/project', { signal: AbortSignal.timeout(300) }))
      .rejects.toThrow();
  });

  it('an aborted body read is NOT reported as a successful no-content write', async () => {
    /**
     * THE DEFECT THE TEST ABOVE FOUND, pinned separately because it is the one
     * way this change could have been WORSE than the hang it replaces.
     * `res.text().catch(() => '')` has always swallowed a failed body read, and
     * `''` is exactly how this helper spells 204 No Content — the answer a
     * successful `setLabels` or `transition` returns. Once a signal can abort
     * that read, swallowing it turns the caller's own deadline into "the write
     * succeeded", and the board records a change Jira never made. Silent, and
     * worse than a timeout.
     */
    vi.stubGlobal('fetch', vi.fn(async (_url: any, opts: any) => ({
      ok: true,
      status: 204,
      text: () => neverAnswers(opts),
    } as any)));

    const result = await jiraFetch('/rest/api/3/issue/KAN-1/transitions', {
      method: 'POST', body: { transition: { id: '31' } }, signal: AbortSignal.timeout(200),
    }).catch((e) => e);

    expect(result).toBeInstanceOf(Error);   // NOT `{}`
  });
});

describe('NO signal ⇒ the shared default deadline (every existing caller)', () => {
  it('leaves the request itself unchanged — same URL, same auth, plus a deadline', async () => {
    const seen: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, opts: any = {}) => {
      seen.push({ url: String(url), opts });
      return { ok: true, status: 200, text: async () => '{"key":"KAN-1"}' } as any;
    }));

    await expect(jiraFetch('/rest/api/3/issue/KAN-1')).resolves.toEqual({ key: 'KAN-1' });

    expect(seen[0].url).toBe('https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/issue/KAN-1');
    expect(seen[0].opts.headers.Authorization).toBe('Bearer oauth_tok');
    // The ONE difference from before #1124: it can no longer hang.
    expect(seen[0].opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('an unsignalled Jira that never answers now FAILS instead of parking the run', async () => {
    // This is the whole point. Every caller in the tree passes nothing, so
    // before #1124 this call had no bound at all and a stalled Atlassian
    // connection parked the tool call — and the run behind it — until the
    // container watchdog fired.
    process.env.SKILL_API_TIMEOUT_MS = '1000'; // the clamp floor, so the test is fast
    vi.stubGlobal('fetch', vi.fn((_url: any, opts: any) => neverAnswers(opts)));

    const t0 = Date.now();
    await expect(jiraFetch('/rest/api/3/project')).rejects.toThrow(
      /Jira GET \/rest\/api\/3\/project TIMED OUT after 1000ms against api\.atlassian\.com \(SKILL_API_TIMEOUT_MS\)/,
    );
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('a JQL search draws the LONGER budget — the far end is computing, not reading a row', async () => {
    // The objection that kept jiraFetch unbounded ("a legitimately slow bulk
    // JQL query") is answered by picking the right KIND, not by having none.
    process.env.SKILL_JOB_TIMEOUT_MS = '1000';
    vi.stubGlobal('fetch', vi.fn((_url: any, opts: any) => neverAnswers(opts)));
    await expect(jiraFetch('/rest/api/3/search/jql', { method: 'POST', body: { jql: 'project = KAN' } }))
      .rejects.toThrow(/TIMED OUT after 1000ms against api\.atlassian\.com \(SKILL_JOB_TIMEOUT_MS\)/);
  });

  it('an unsignalled body read that stalls is NOT reported as a successful no-content write', async () => {
    /**
     * THE OTHER HALF OF THE SAME DEFECT, and the reason the guard inside
     * `jiraFetch` had to stop asking `opts.signal?.aborted`. With no caller
     * signal that question is `undefined`, so OUR deadline firing mid-body-read
     * would have been swallowed into `''` — which is exactly how this helper
     * spells 204 No Content, the answer a successful `transition` returns. A
     * timed-out write would have read back as "the write succeeded".
     */
    process.env.SKILL_API_TIMEOUT_MS = '1000';
    vi.stubGlobal('fetch', vi.fn(async (_url: any, opts: any) => ({
      ok: true, status: 204, text: () => neverAnswers(opts),
    } as any)));

    const result = await jiraFetch('/rest/api/3/issue/KAN-1/transitions', {
      method: 'POST', body: { transition: { id: '31' } },
    }).catch((e) => e);

    expect(result).toBeInstanceOf(Error);   // NOT `{}`
  });
});

describe('the retry and the signal', () => {
  it('does NOT retry once the caller’s signal has aborted', async () => {
    // The heuristic below matches on PROSE. A caller aborting with its own
    // reason — `controller.abort(new Error('token refresh cancelled'))` — hits
    // `msg.includes('token')` and would be retried into a signal nobody is
    // listening to, costing a second `resolveJiraCredential()` round trip after
    // the caller has already given up.
    const fetchMock = vi.fn(async () => { throw new Error('token refresh cancelled'); });
    vi.stubGlobal('fetch', fetchMock);

    const ac = new AbortController();
    ac.abort(new Error('token refresh cancelled'));

    await expect(jiraFetch('/rest/api/3/project', { signal: ac.signal }))
      .rejects.toThrow('token refresh cancelled');

    // ZERO, not one. `fetchWithDeadline` refuses a spent caller signal BEFORE
    // it opens a socket, so the guard now bites one layer earlier than when
    // this test was written (it used to assert 1 — the first attempt went out
    // and only the RETRY was suppressed). Both satisfy the clause that matters:
    // once nobody is listening, we do not go back to Atlassian.
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(clearTokenCache).not.toHaveBeenCalled();
  });

  it('still retries a transient auth error when the signal is LIVE', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => ({ ok: false, status: 401, text: async () => 'bad token' }))
      .mockImplementationOnce(async () => ({ ok: true, status: 200, text: async () => '{"key":"KAN-2"}' }));
    vi.stubGlobal('fetch', fetchMock);

    const ac = new AbortController();
    await expect(jiraFetch('/rest/api/3/issue/KAN-2', { signal: ac.signal }))
      .resolves.toEqual({ key: 'KAN-2' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(clearTokenCache).toHaveBeenCalledWith('jira');
    // The retry rides its own FRESH deadline (a second attempt deserves a
    // second budget) that still aborts on the caller's clock.
    const retrySignal = fetchMock.mock.calls[1][1].signal;
    expect(retrySignal).toBeInstanceOf(AbortSignal);
    expect(retrySignal).not.toBe(fetchMock.mock.calls[0][1].signal);
    expect(retrySignal.aborted).toBe(false);
    ac.abort(new Error('caller gave up'));
    expect(retrySignal.aborted).toBe(true);
  });

  it('the unsignalled retry path is untouched', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => ({ ok: false, status: 403, text: async () => 'forbidden' }))
      .mockImplementationOnce(async () => ({ ok: true, status: 200, text: async () => '{"key":"KAN-3"}' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(jiraFetch('/rest/api/3/issue/KAN-3')).resolves.toEqual({ key: 'KAN-3' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a non-auth failure still throws without a retry', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(jiraFetch('/rest/api/3/project')).rejects.toThrow('Jira API 500: boom');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
