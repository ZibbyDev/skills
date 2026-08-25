/**
 * `lib/http-deadline.ts` — the behaviour the ~46 call sites depend on.
 * ============================================================================
 *
 * The companion source tripwire (`skills-http-doors-bounded.test.ts`) proves
 * every door GOES THROUGH this helper. This file proves the helper is worth
 * going through: that a hang becomes a throw, that the throw says what timed
 * out and against which host, that a NON-timeout error survives untouched, and
 * that a caller's own signal keeps its own identity.
 *
 * THE PROBE, and why it is mutation-sensitive: `neverAnswers` settles ONLY when
 * somebody stops waiting. With a signal it rejects the way undici does; without
 * one it never settles at all — the production bug, reproduced. Delete the
 * `signal` from the helper and these tests do not fail, they HANG, which is the
 * shape of the bug itself.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchWithDeadline,
  describeTimeout,
  isTimeoutError,
  timeoutMsFrom,
  timeoutMsForKind,
  hostOf,
  SKILL_API_TIMEOUT_MS,
  SKILL_TRANSFER_TIMEOUT_MS,
  SKILL_JOB_TIMEOUT_MS,
  TIMEOUT_FLOOR_MS,
  TIMEOUT_CEILING_MS,
} from '../lib/http-deadline.js';

const ENV_KEYS = ['SKILL_API_TIMEOUT_MS', 'SKILL_TRANSFER_TIMEOUT_MS', 'SKILL_JOB_TIMEOUT_MS'];
const ORIG: Record<string, any> = {};
for (const k of ENV_KEYS) ORIG[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function neverAnswers(init: any) {
  return new Promise((_resolve, reject) => {
    const s = init?.signal;
    if (!s) return; // unbounded — the bug
    const fire = () => reject(
      Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
    );
    if (s.aborted) fire();
    else s.addEventListener('abort', fire, { once: true });
  });
}

describe('the budgets', () => {
  it('are ordered by what is actually moving: a row read < a body < a computation', () => {
    expect(SKILL_API_TIMEOUT_MS).toBeLessThan(SKILL_TRANSFER_TIMEOUT_MS);
    expect(SKILL_TRANSFER_TIMEOUT_MS).toBeLessThan(SKILL_JOB_TIMEOUT_MS);
    // …and none of them can exceed the clamp that keeps "unbounded" unreachable.
    for (const ms of [SKILL_API_TIMEOUT_MS, SKILL_TRANSFER_TIMEOUT_MS, SKILL_JOB_TIMEOUT_MS]) {
      expect(ms).toBeGreaterThanOrEqual(TIMEOUT_FLOOR_MS);
      expect(ms).toBeLessThanOrEqual(TIMEOUT_CEILING_MS);
    }
  });

  it('CLAMP the env knob — no typo can restore "unbounded"', () => {
    // `0` is how most APIs spell "no timeout"; here it must be unreachable.
    for (const raw of ['0', '-5', '', '   ', 'soon', 'NaN', 'null']) {
      expect(timeoutMsFrom('K', 4242, { K: raw })).toBe(4242);
    }
    expect(timeoutMsFrom('K', 4242, { K: '99999999' })).toBe(TIMEOUT_CEILING_MS);
    expect(timeoutMsFrom('K', 4242, { K: '5' })).toBe(TIMEOUT_FLOOR_MS);
    expect(timeoutMsFrom('K', 4242, { K: '20000' })).toBe(20_000);
    expect(timeoutMsFrom('K', 4242, {})).toBe(4242);
  });

  it('resolve per kind, and an unknown kind falls back to api rather than to nothing', () => {
    expect(timeoutMsForKind('api', {})).toBe(SKILL_API_TIMEOUT_MS);
    expect(timeoutMsForKind('transfer', {})).toBe(SKILL_TRANSFER_TIMEOUT_MS);
    expect(timeoutMsForKind('job', {})).toBe(SKILL_JOB_TIMEOUT_MS);
    expect(timeoutMsForKind('nonsense' as any, {})).toBe(SKILL_API_TIMEOUT_MS);
    expect(timeoutMsForKind('api', { SKILL_API_TIMEOUT_MS: '7000' })).toBe(7000);
  });
});

describe('hostOf — the diagnostic that is not a leak', () => {
  it('names the host and NOTHING else', () => {
    // A presigned URL's signature lives in the query string, and a provider URL
    // carries ids the model will happily paste into a comment.
    expect(hostOf('https://s3.amazonaws.com/bucket/key.json?X-Amz-Signature=deadbeef'))
      .toBe('s3.amazonaws.com');
    expect(hostOf('https://api.github.com/repos/acme/secret-repo/pulls/7'))
      .toBe('api.github.com');
  });
  it('never throws on junk', () => {
    for (const junk of [undefined, null, '', 'not a url', 42, {}]) {
      expect(typeof hostOf(junk)).toBe('string');
    }
  });
});

describe('fetchWithDeadline', () => {
  it('turns a far end that never answers into a worded throw, inside the budget', async () => {
    process.env.SKILL_API_TIMEOUT_MS = '1000'; // the clamp floor — fail in a second, not in 30
    vi.stubGlobal('fetch', vi.fn((_u: any, init: any) => neverAnswers(init)));

    const t0 = Date.now();
    await expect(
      fetchWithDeadline('https://api.github.com/repos/a/b', {}, { kind: 'api', what: 'GitHub GET /repos/a/b' }),
    ).rejects.toThrow(
      'GitHub GET /repos/a/b TIMED OUT after 1000ms against api.github.com (SKILL_API_TIMEOUT_MS)',
    );
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('names the KIND that expired, so a transfer and a poll are told apart', async () => {
    process.env.SKILL_TRANSFER_TIMEOUT_MS = '1000';
    vi.stubGlobal('fetch', vi.fn((_u: any, init: any) => neverAnswers(init)));
    await expect(
      fetchWithDeadline('https://s3.example.com/o?sig=x', { method: 'PUT' }, { kind: 'transfer', what: 'artifact upload' }),
    ).rejects.toThrow('artifact upload TIMED OUT after 1000ms against s3.example.com (SKILL_TRANSFER_TIMEOUT_MS)');
  });

  it('passes the request through UNCHANGED apart from the signal', async () => {
    const spy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', spy);

    const res: any = await fetchWithDeadline(
      'https://api.example.com/x',
      { method: 'POST', headers: { Authorization: 'Bearer t' }, body: '{"a":1}' },
      { kind: 'api', what: 'probe' },
    );

    expect(res.status).toBe(200);
    const [url, init] = spy.mock.calls[0] as any;
    expect(url).toBe('https://api.example.com/x');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer t');
    expect(init.body).toBe('{"a":1}');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('gives every call a FRESH deadline — one slow call must not poison the next', async () => {
    const signals: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: any, init: any) => {
      signals.push(init.signal);
      return { ok: true, status: 200 };
    }));
    await fetchWithDeadline('https://a.example.com/1', {}, { what: 'one' });
    await fetchWithDeadline('https://a.example.com/2', {}, { what: 'two' });
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });

  it('rethrows a NON-timeout transport error as the SAME OBJECT', async () => {
    // Every provider module's `catch` and every `!res.ok` branch must keep its
    // existing wording; the only thing this helper adds is that the HANG throws.
    const original = new TypeError('fetch failed');
    vi.stubGlobal('fetch', vi.fn(async () => { throw original; }));
    const err = await fetchWithDeadline('https://x.example.com', {}, { what: 'probe' }).catch((e) => e);
    expect(err).toBe(original);
  });

  it("rethrows the CALLER's abort as theirs, not as our timeout", async () => {
    vi.stubGlobal('fetch', vi.fn((_u: any, init: any) => neverAnswers(init)));
    const ctrl = new AbortController();
    const reason = new Error('caller changed its mind');
    setTimeout(() => ctrl.abort(reason), 10);

    const err = await fetchWithDeadline(
      'https://slow.example.com', { signal: ctrl.signal }, { kind: 'job', what: 'long thing' },
    ).catch((e) => e);

    // Not reworded, not attributed to a budget that did not expire.
    expect(String(err?.message)).not.toContain('TIMED OUT');
  });

  it("refuses to open a socket under a caller signal that is ALREADY spent", async () => {
    // The retry lesson, generalised: a loop that re-enters after its deadline
    // fired must not get one more request out of us.
    const spy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', spy);
    const ctrl = new AbortController();
    ctrl.abort(new Error('already done'));

    await expect(
      fetchWithDeadline('https://x.example.com', { signal: ctrl.signal }, { what: 'probe' }),
    ).rejects.toThrow('already done');
    expect(spy).not.toHaveBeenCalled();
  });

  it('honours an explicit timeoutMs, still clamped', async () => {
    vi.stubGlobal('fetch', vi.fn((_u: any, init: any) => neverAnswers(init)));
    await expect(
      fetchWithDeadline('https://x.example.com', {}, { what: 'probe', timeoutMs: 5 }),
    ).rejects.toThrow(`after ${TIMEOUT_FLOOR_MS}ms`);
  });
});

describe('describeTimeout — the body half, in the same voice', () => {
  it('returns null for a non-timeout so the caller can rethrow the original', () => {
    expect(describeTimeout(new TypeError('fetch failed'), { what: 'x' })).toBeNull();
  });

  it('says it was the BODY, names the host and the knob', () => {
    const err = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    expect(describeTimeout(err, { what: 'Notion GET /pages/1', url: 'https://api.notion.com/v1/pages/1', kind: 'api', timeoutMs: 30000, body: true }))
      .toBe('Notion GET /pages/1 body read TIMED OUT after 30000ms against api.notion.com (SKILL_API_TIMEOUT_MS)');
  });

  it('treats both abort flavours as "we stopped waiting"', () => {
    expect(isTimeoutError({ name: 'TimeoutError' })).toBe(true);
    expect(isTimeoutError({ name: 'AbortError' })).toBe(true);
    expect(isTimeoutError(new TypeError('fetch failed'))).toBe(false);
    expect(isTimeoutError(undefined)).toBe(false);
  });
});
