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
 *   3. NOTHING CHANGES when no signal is passed — every caller in the tree
 *      today passes nothing, `signal: undefined` is identical to omitting the
 *      option, and there is deliberately NO default timeout invented here (a
 *      shared library does not know its caller's budget, and guessing one is
 *      how a legitimately slow bulk JQL starts failing in production);
 *   4. the retry must not fire under an aborted signal — `jiraFetch` calls
 *      `makeRequest` a SECOND time on a transient auth error, re-using the same
 *      spent signal, and the retry heuristic is PROSE-MATCHING ("token", "401")
 *      so a caller's own abort reason can trip it;
 *   5. the retry is otherwise untouched.
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
const ORIG: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of JIRA_ENV) { ORIG[k] = process.env[k]; delete process.env[k]; }
  resolveIntegrationToken.mockReset();
  clearTokenCache.mockReset();
  resolveIntegrationToken.mockResolvedValue({ token: 'oauth_tok', cloudId: 'cloud-123' });
});

afterEach(() => {
  for (const k of JIRA_ENV) {
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
  it('forwards the caller’s signal to fetch', async () => {
    const seen: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: any, opts: any = {}) => {
      seen.push(opts.signal);
      return { ok: true, status: 200, text: async () => '{"ok":true}' } as any;
    }));

    const ac = new AbortController();
    await jiraFetch('/rest/api/3/project', { signal: ac.signal });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(ac.signal); // the SAME signal object, not a copy
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

describe('NO signal ⇒ byte-for-byte today’s behaviour (every existing caller)', () => {
  it('passes signal: undefined, which is identical to omitting the option', async () => {
    const seen: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, opts: any = {}) => {
      seen.push({ url: String(url), opts });
      return { ok: true, status: 200, text: async () => '{"key":"KAN-1"}' } as any;
    }));

    await expect(jiraFetch('/rest/api/3/issue/KAN-1')).resolves.toEqual({ key: 'KAN-1' });

    expect(seen[0].opts.signal).toBeUndefined();
    expect('signal' in seen[0].opts).toBe(true); // present-but-undefined ≡ absent, to fetch
    // And the request itself is unchanged.
    expect(seen[0].url).toBe('https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/issue/KAN-1');
    expect(seen[0].opts.headers.Authorization).toBe('Bearer oauth_tok');
  });

  it('invents NO default timeout — an unsignalled call is bounded by nobody but its caller', async () => {
    // Deliberate: a shared library does not know its caller's budget. The board
    // tick's is 15s; an interactive MCP tool call's is not. Inventing one here
    // would silently start failing legitimately slow bulk queries.
    const seen: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: any, opts: any = {}) => {
      seen.push(opts.signal);
      return { ok: true, status: 200, text: async () => '{}' } as any;
    }));
    await jiraFetch('/rest/api/3/project');
    expect(seen[0]).toBeUndefined();
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    // The retry carries the SAME still-live signal — the caller's budget spans
    // the whole call, retry included.
    expect(fetchMock.mock.calls[1][1].signal).toBe(ac.signal);
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
