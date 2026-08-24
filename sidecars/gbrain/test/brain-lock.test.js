/**
 * The per-brain single-writer lock (brain.js `withBrainLock`).
 *
 * These tests never touch a real brain, a real gbrain binary or a real store —
 * `fn` is a controllable deferred, so "wedged forever" is a promise nobody
 * resolves rather than a sleep, and every budget is passed per-call
 * (`acquireTimeoutMs`) instead of waited out. The only real timers are the
 * few-millisecond budgets that ARE the mechanism under test.
 *
 * The property that matters most is #2: a caller that gives up its turn must
 * never run its `fn`. PGLite is single-writer, so a timeout that let the
 * abandoned work run anyway would turn a hang into two writers on one file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { _internal } from '../brain.js';

const { withBrainLock, lockSnapshot, lockReport, LOCK_HOLD_WARN_MS } = _internal;

/** A promise plus its settle handles — the whole "controllable stub" here. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Yield long enough for pending timers/microtasks to run, without sequencing on it. */
const tick = (ms = 5) => new Promise((r) => { setTimeout(r, ms); });

let _n = 0;
/** A fresh brainDir per test so no test can inherit another's queue. */
const nextBrain = () => `/data/kb-test-${process.pid}-${_n++}`;

// ── 1. a wedged holder does not hang later callers past the budget ──────────

test('a waiter behind a wedged holder rejects within its acquire budget', async () => {
  const brain = nextBrain();
  const wedged = deferred();

  const holder = withBrainLock(brain, () => wedged.promise, { label: 'ingest' });
  holder.catch(() => {});           // never settles; keep node quiet

  const started = Date.now();
  await assert.rejects(
    withBrainLock(brain, async () => 'should never run', { label: 'query', acquireTimeoutMs: 40 }),
    (err) => {
      assert.equal(err.code, 'BRAIN_LOCK_ACQUIRE_TIMEOUT');
      return true;
    },
  );
  const waited = Date.now() - started;
  assert.ok(waited < 2_000, `waiter should give up promptly, waited ${waited}ms`);

  wedged.resolve('done');           // let the holder go so the chain drains
  await holder;
});

test('the rejection names the brain, the budget and the knob — and says it never ran', async () => {
  const brain = nextBrain();
  const wedged = deferred();
  const holder = withBrainLock(brain, () => wedged.promise, { label: 'ingest' });
  holder.catch(() => {});

  let err;
  try {
    await withBrainLock(brain, async () => 'nope', { label: 'query', acquireTimeoutMs: 30 });
  } catch (e) { err = e; }

  assert.ok(err, 'expected a rejection');
  assert.match(err.message, /WAITING FOR A TURN/, 'must read as a QUEUE timeout');
  assert.match(err.message, /QUEUE timeout, not an operation timeout/);
  assert.match(err.message, /never started and touched nothing/);
  assert.ok(err.message.includes(brain), 'must name the brain');
  assert.equal(err.brainDir, brain);
  assert.match(err.message, /30ms/, 'must name the budget it used');
  assert.match(err.message, /LOCK_ACQUIRE_TIMEOUT_MS/, 'must name the knob');
  assert.match(err.message, /busy with 'ingest'/, 'must name what is holding it');
  // Distinct from the OPERATION timeouts elsewhere in brain.js ("gbrain <x> timeout").
  assert.doesNotMatch(err.message, /gbrain \w+ timeout/);

  wedged.resolve(null);
  await holder;
});

// ── 2. THE SINGLE-WRITER GUARANTEE ─────────────────────────────────────────

test('an abandoned waiter NEVER runs its fn, even after the holder releases', async () => {
  const brain = nextBrain();
  const wedged = deferred();
  const holder = withBrainLock(brain, () => wedged.promise, { label: 'ingest' });
  holder.catch(() => {});

  let ran = false;
  await assert.rejects(withBrainLock(brain, async () => { ran = true; return 1; },
    { label: 'query', acquireTimeoutMs: 30 }));
  assert.equal(ran, false, 'must not have run while queued');

  // The holder finally lets go. The abandoned turn is SKIPPED, not deferred —
  // this is the difference between "bounded wait" and "two writers".
  wedged.resolve('done');
  assert.equal(await holder, 'done');
  await tick(20);
  assert.equal(ran, false, 'abandoned fn must never run, even once the lock frees');
});

test('an abandoned turn hands the lock straight to the next waiter', async () => {
  const brain = nextBrain();
  const wedged = deferred();
  const holder = withBrainLock(brain, () => wedged.promise, { label: 'ingest' });
  holder.catch(() => {});

  let abandonedRan = false;
  const abandoned = withBrainLock(brain, async () => { abandonedRan = true; },
    { label: 'query', acquireTimeoutMs: 30 });
  abandoned.catch(() => {});

  // Queued behind BOTH, with a budget generous enough to survive the wedge.
  const survivor = withBrainLock(brain, async () => 'survivor-ran',
    { label: 'delete', acquireTimeoutMs: 5_000 });

  await tick(60);                       // let the short budget lapse
  wedged.resolve('done');

  assert.equal(await survivor, 'survivor-ran');
  assert.equal(abandonedRan, false);
});

// ── 3. the budget bounds the WAIT, never the WORK ──────────────────────────

test('a normal operation is unaffected — even one that outlives the acquire budget', async () => {
  const brain = nextBrain();
  const slow = deferred();
  // Budget 20ms, work 80ms: the holder never waited, so the budget must not
  // apply to it. A design that timed the WORK would fail here.
  const p = withBrainLock(brain, () => slow.promise, { label: 'ingest', acquireTimeoutMs: 20 });
  setTimeout(() => slow.resolve('finished'), 80);
  assert.equal(await p, 'finished');
});

test('an uncontended fast operation resolves with its value and leaves no lock state', async () => {
  const brain = nextBrain();
  assert.equal(await withBrainLock(brain, async () => 42, { label: 'query' }), 42);
  assert.deepEqual(lockSnapshot(brain), {
    held: false, holder: null, heldMs: 0, queued: 0, longestWaitMs: 0, stuck: false,
  });
  assert.equal(lockReport().some((l) => l.brainDir === brain), false);
});

test('a rejecting operation releases the lock instead of poisoning the queue', async () => {
  const brain = nextBrain();
  await assert.rejects(
    withBrainLock(brain, async () => { throw new Error('boom'); }, { label: 'ingest' }),
    /boom/,
  );
  assert.equal(await withBrainLock(brain, async () => 'after', { label: 'query' }), 'after');
});

// ── 4. north-star #9: DIFFERENT tenants run in PARALLEL ────────────────────

test('a wedged brain does not block a DIFFERENT brain (a global lock would)', async () => {
  const wedgedBrain = nextBrain();
  const otherBrain = nextBrain();
  const wedged = deferred();

  const holder = withBrainLock(wedgedBrain, () => wedged.promise, { label: 'ingest' });
  holder.catch(() => {});

  // No budget raised, no waiting: the other tenant must run immediately.
  assert.equal(await withBrainLock(otherBrain, async () => 'B-ran', { label: 'query' }), 'B-ran');
  assert.equal(await withBrainLock(otherBrain, async () => 'B-again', { label: 'ingest' }), 'B-again');

  // And it is genuinely still wedged, i.e. the parallelism was not a fluke of
  // the first brain having already drained.
  assert.equal(lockSnapshot(wedgedBrain).held, true);

  wedged.resolve(null);
  await holder;
});

test('two brains run truly concurrently, not one-after-the-other', async () => {
  const a = nextBrain();
  const b = nextBrain();
  const aStarted = deferred();
  const aRelease = deferred();

  const pa = withBrainLock(a, () => { aStarted.resolve(); return aRelease.promise; }, { label: 'ingest' });
  await aStarted.promise;
  // A is mid-flight; B must complete WITHOUT A finishing first.
  assert.equal(await withBrainLock(b, async () => 'b', { label: 'ingest' }), 'b');
  aRelease.resolve('a');
  assert.equal(await pa, 'a');
});

// ── 5. the SAME brain still SERIALIZES ─────────────────────────────────────

test('the same brain serializes — no two operations overlap', async () => {
  const brain = nextBrain();
  let inFlight = 0;
  let maxInFlight = 0;
  const order = [];

  const op = (name) => withBrainLock(brain, async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    order.push(`${name}:start`);
    await tick(10);
    order.push(`${name}:end`);
    inFlight -= 1;
    return name;
  }, { label: name, acquireTimeoutMs: 5_000 });

  const results = await Promise.all([op('one'), op('two'), op('three')]);

  assert.equal(maxInFlight, 1, 'single-writer: exactly one op inside the lock at a time');
  assert.deepEqual(order, [
    'one:start', 'one:end', 'two:start', 'two:end', 'three:start', 'three:end',
  ], 'FIFO order preserved');
  assert.deepEqual(results, ['one', 'two', 'three']);
});

// ── 6. the stuck state is VISIBLE ──────────────────────────────────────────

test('lockSnapshot reports the holder, its age and the queue depth', async () => {
  const brain = nextBrain();
  const wedged = deferred();
  const holder = withBrainLock(brain, () => wedged.promise, { label: 'ingest' });
  holder.catch(() => {});

  const queued = [
    withBrainLock(brain, async () => 1, { label: 'query', acquireTimeoutMs: 5_000 }),
    withBrainLock(brain, async () => 2, { label: 'delete', acquireTimeoutMs: 5_000 }),
  ];
  queued.forEach((p) => p.catch(() => {}));
  await tick(10);

  const s = lockSnapshot(brain);
  assert.equal(s.held, true);
  assert.equal(s.holder, 'ingest', 'names the op that is holding, not just "held"');
  assert.equal(s.queued, 2, 'reports how many callers are stacked behind it');
  assert.ok(s.heldMs >= 0);
  assert.ok(s.longestWaitMs >= 0);
  assert.equal(s.stuck, false, 'not stuck yet — well inside the warn threshold');

  // `now` is an ARGUMENT, so "stuck" is provable without a five-minute wait.
  assert.equal(lockSnapshot(brain, Date.now() + LOCK_HOLD_WARN_MS + 1_000).stuck, true);

  const report = lockReport(Date.now() + LOCK_HOLD_WARN_MS + 1_000);
  const row = report.find((l) => l.brainDir === brain);
  assert.ok(row, 'a contended brain appears in lockReport');
  assert.equal(row.stuck, true);
  assert.equal(row.holder, 'ingest');

  wedged.resolve(null);
  await Promise.all(queued);
});

test('lockReport counts only contended brains, and clears once they drain', async () => {
  const brain = nextBrain();
  await withBrainLock(brain, async () => 'ok', { label: 'query' });
  assert.equal(lockReport().some((l) => l.brainDir === brain), false);
  assert.equal(lockReport().filter((l) => l.stuck).length >= 0, true);
});
