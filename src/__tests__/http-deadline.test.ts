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
  timeoutMsForTransfer,
  TRANSFER_FLOOR_BYTES_PER_SECOND,
  uploadWithDeadline,
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

describe('timeoutMsForTransfer — a transfer\'s budget grows with its size', () => {
  it('small bodies keep the flat transfer budget', () => {
    expect(timeoutMsForTransfer(1024, {})).toBe(SKILL_TRANSFER_TIMEOUT_MS);
    expect(timeoutMsForTransfer(0, {})).toBe(SKILL_TRANSFER_TIMEOUT_MS);
  });
  it('a multi-GB body gets what it needs at the floor rate, up to the ceiling', () => {
    const gib = 1024 ** 3;
    expect(timeoutMsForTransfer(2 * gib, {})).toBe(Math.ceil((2 * gib / TRANSFER_FLOOR_BYTES_PER_SECOND) * 1000));
    expect(timeoutMsForTransfer(2 * gib, {})).toBeGreaterThan(SKILL_TRANSFER_TIMEOUT_MS);
    expect(timeoutMsForTransfer(5 * gib, {})).toBeLessThanOrEqual(TIMEOUT_CEILING_MS);
    expect(timeoutMsForTransfer(50 * gib, {})).toBe(TIMEOUT_CEILING_MS);
  });
  it('an unknown size gets the ceiling; the env override still raises the floor budget', () => {
    expect(timeoutMsForTransfer(undefined, {})).toBe(TIMEOUT_CEILING_MS);
    expect(timeoutMsForTransfer(null, {})).toBe(TIMEOUT_CEILING_MS);
    expect(timeoutMsForTransfer(1024, { SKILL_TRANSFER_TIMEOUT_MS: '300000' })).toBe(300_000);
  });
});

describe('uploadWithDeadline — a streamed body goes at the socket\'s pace, bounded', () => {
  const http = require('node:http');
  const { Readable } = require('node:stream');

  /** A source that makes 64 KiB chunks only when asked, counting what it made. */
  function countingSource(total) {
    const src = { made: 0 };
    src.stream = new Readable({
      read() {
        if (src.made >= total) { this.push(null); return; }
        const n = Math.min(64 * 1024, total - src.made);
        src.made += n;
        this.push(Buffer.alloc(n, 1));
      },
    });
    return src;
  }

  it('does not read the source ahead of a receiver that is not reading (the whole point of this door)', async () => {
    const total = 64 * 1024 * 1024;
    let release;
    const gate = new Promise((r) => { release = r; });
    const server = http.createServer(async (req, res) => {
      await gate; // the receiver stalls before reading a byte
      let n = 0;
      for await (const c of req) n += c.length;
      res.end(String(n));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const src = countingSource(total);
      const done = uploadWithDeadline(`http://127.0.0.1:${server.address().port}/`, {
        headers: { 'Content-Length': String(total) }, body: src.stream,
      }, { what: 'test upload', timeoutMs: 30_000 });
      await new Promise((r) => setTimeout(r, 400));
      // Socket buffers + stream high-water marks only — a few MiB, never the file.
      expect(src.made).toBeLessThan(16 * 1024 * 1024);
      release();
      const res = await done;
      expect(res).toMatchObject({ ok: true, status: 200 });
      expect(await res.text()).toBe(String(total));
    } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
  });

  it('a receiver that never answers becomes a worded timeout naming the call and the host', async () => {
    const server = http.createServer(() => { /* never reads, never answers */ });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const host = `127.0.0.1:${server.address().port}`;
    try {
      const src = countingSource(1024);
      await expect(uploadWithDeadline(`http://${host}/x?sig=secret`, { headers: { 'Content-Length': '1024' }, body: src.stream }, { what: 'test upload', timeoutMs: 1000 }))
        .rejects.toThrow(`test upload TIMED OUT after 1000ms against ${host} (SKILL_TRANSFER_TIMEOUT_MS)`);
      expect(src.stream.destroyed).toBe(true);
    } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
  });

  it('an answer before the body is sent stops the upload and is the result', async () => {
    const server = http.createServer((req, res) => { res.writeHead(507); res.end('disk full'); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const total = 256 * 1024 * 1024;
      const src = countingSource(total);
      const res = await uploadWithDeadline(`http://127.0.0.1:${server.address().port}/`, { headers: { 'Content-Length': String(total) }, body: src.stream }, { what: 'test upload', timeoutMs: 30_000 });
      expect(res).toMatchObject({ ok: false, status: 507 });
      expect(await res.text()).toBe('disk full');
      expect(src.made).toBeLessThan(total);
    } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
  });
});
