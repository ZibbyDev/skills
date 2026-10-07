/**
 * A brain stays WARM for its readers (brain.js `getServe`, `withServeReleased`,
 * `ingest`, `query`, `reclaim`), and every request says where its time went.
 *
 * Why this exists (2026-10-08): a manager agent writes to its knowledge base at
 * the end of every tick and reads it at the start of the next. Every write
 * stopped the long-lived `gbrain serve` for a CLI embed pass and left it down,
 * so every first read paid a 15–20 s Bun load + PGLite open inside a 10 s
 * retrieval budget — and each read also made a remote expansion-model call.
 *
 * The real gbrain is replaced by test/fixtures/fake-gbrain.mjs, which logs each
 * serve start, CLI call and tool call (with whether that process had a key).
 * Every assertion is about those process facts, not about timing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'gbrain-serve-warm-'));
const logFile = join(root, 'fake.log');
await writeFile(logFile, '');
process.env.GBRAIN_DATA_ROOT = join(root, 'data');
process.env.GBRAIN_BIN = join(here, 'fixtures', 'fake-gbrain.mjs');
process.env.FAKE_GBRAIN_LOG = logFile;
process.env.GBRAIN_NEW_BRAIN_HALFVEC = '0';
delete process.env.GBRAIN_SERVE_IDLE_MS;
delete process.env.OPENAI_API_KEY;

const {
  ingest, query, compact, drop, withEmbedding, _internal,
} = await import('../brain.js');

const KEYED = { OPENAI_API_KEY: 'sk-test-not-a-real-key', GBRAIN_EMBEDDING: '1' };

let n = 0;
const nextKb = () => `kb-serve-warm-${process.pid}-${n++}`;
const doc = (i) => ({ sourceId: `decision:${i}`, markdown: `# Decision ${i}\n\nSent ticket ${i} back to the developer.` });

/** The fake's event log, from line `from` on. */
async function events(from = 0) {
  return (await readFile(logFile, 'utf8')).split('\n').filter(Boolean).slice(from);
}
const count = (lines, re) => lines.filter((l) => re.test(l)).length;

/** console.log lines written while `fn` runs. */
async function captureLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { return { value: await fn(), lines }; } finally { console.log = orig; }
}

test.after(async () => { await rm(root, { recursive: true, force: true }); });

test('the first read after a write starts no serve — the write left the brain warm', async (t) => {
  const kb = nextKb();
  t.after(() => drop(kb));
  await withEmbedding(KEYED, () => ingest(kb, [doc(1)]));
  const mark = (await events()).length;
  const out = await withEmbedding(KEYED, () => query(kb, 'what did we decide', 3));
  assert.equal(out.results.length, 1);
  const after = await events(mark);
  assert.equal(count(after, /^serve-start /), 0,
    `the read had to start a serve after the write:\n${after.join('\n')}`);
});

test('a write never stops the serve once the brain\'s embedding debt is swept', async (t) => {
  const kb = nextKb();
  t.after(() => drop(kb));
  await withEmbedding(KEYED, () => ingest(kb, [doc(1)]));   // first write: one sweep
  const mark = (await events()).length;
  await withEmbedding(KEYED, () => ingest(kb, [doc(2)]));
  await withEmbedding(KEYED, () => ingest(kb, [doc(3)]));
  const after = await events(mark);
  assert.equal(count(after, /^cli embed/), 0, `later writes re-ran the CLI embed pass:\n${after.join('\n')}`);
  assert.equal(count(after, /^serve-start /), 0, `later writes restarted the serve:\n${after.join('\n')}`);
  // …and the pages were written on a serve that can embed them inline.
  assert.equal(count(after, /^tool \d+ put_page key=yes$/), 2);
});

test('a serve started without the request\'s embedding settings is restarted before it writes', async (t) => {
  const kb = nextKb();
  t.after(() => drop(kb));
  await withEmbedding(KEYED, () => ingest(kb, [doc(1)]));
  await drop(kb);                                   // fresh brain, no serve
  await withEmbedding(KEYED, () => ingest(kb, [doc(1)]));
  await query(kb, 'a read that carries no key', 3);  // keyless request: must NOT restart a keyed serve
  const mark = (await events()).length;
  await withEmbedding(KEYED, () => ingest(kb, [doc(2)]));
  const after = await events(mark);
  assert.equal(count(after, /^tool \d+ put_page key=no$/), 0, `a page was written on a serve with no key:\n${after.join('\n')}`);

  // Now the reverse: a serve that came up keyless, then a keyed write.
  const kb2 = nextKb();
  t.after(() => drop(kb2));
  await withEmbedding(KEYED, () => ingest(kb2, [doc(1)]));
  await drop(kb2);
  await withEmbedding({ GBRAIN_NO_EMBEDDING: '1' }, () => ingest(kb2, [doc(1)]));   // serve starts keyless
  const mark2 = (await events()).length;
  await withEmbedding(KEYED, () => ingest(kb2, [doc(2)]));
  const after2 = await events(mark2);
  assert.equal(count(after2, /^tool \d+ put_page key=yes$/), 1, `the keyed write did not reach a keyed serve:\n${after2.join('\n')}`);
});

test('a query does not ask gbrain to expand it unless the caller asks', async (t) => {
  const kb = nextKb();
  t.after(() => drop(kb));
  await withEmbedding(KEYED, () => ingest(kb, [doc(1)]));
  let mark = (await events()).length;
  await withEmbedding(KEYED, () => query(kb, 'ticket title', 3));
  assert.deepEqual((await events(mark)).filter((l) => / query /.test(l)).map((l) => l.replace(/^tool \d+ /, '')),
    ['query expand=false key=yes inflight=1']);
  mark = (await events()).length;
  await withEmbedding(KEYED, () => query(kb, 'ticket title', 3, { expand: true }));
  assert.deepEqual((await events(mark)).filter((l) => / query /.test(l)).map((l) => l.replace(/^tool \d+ /, '')),
    ['query expand=true key=yes inflight=1']);
});

test('an operator compact leaves a brain that was in use warm', async (t) => {
  const kb = nextKb();
  t.after(() => drop(kb));
  await withEmbedding(KEYED, () => ingest(kb, [doc(1)]));
  await compact(kb, { vacuum: 'none' });
  const mark = (await events()).length;
  await withEmbedding(KEYED, () => query(kb, 'after compact', 3));
  const after = await events(mark);
  assert.equal(count(after, /^serve-start /), 0, `the read after a compact had to start a serve:\n${after.join('\n')}`);
});

test('every request logs one line: op, lock wait, serve start, op time — and nothing identifying', async (t) => {
  const kb = nextKb();
  t.after(() => drop(kb));
  const w = await captureLogs(() => withEmbedding(KEYED, () => ingest(kb, [doc(1)])));
  const q = await captureLogs(() => withEmbedding(KEYED, () => query(kb, 'secret question text', 3)));
  const line = /^\[gbrain\] (\w+) kb-[0-9a-f]{8} ok lockWaitMs=\d+ serveStartMs=\d+ opMs=\d+/;
  const ingestLines = w.lines.filter((l) => line.test(l) && l.includes(' ingest '));
  const queryLines = q.lines.filter((l) => line.test(l));
  assert.equal(ingestLines.length, 1, w.lines.join('\n'));
  assert.equal(queryLines.length, 1, q.lines.join('\n'));
  assert.match(queryLines[0], / results=1 mode=vector expand=false$|expand=false .*results=1/);
  // The first write paid for starting the serve; the warm read paid nothing.
  assert.match(ingestLines[0], /serveStartMs=[1-9]\d*/);
  assert.match(queryLines[0], /serveStartMs=0 /);
  for (const l of [...ingestLines, ...queryLines]) {
    assert.ok(!l.includes(kb) && !l.includes('secret question') && !l.includes('sk-test'), `log line leaks: ${l}`);
  }
});

test('a brain stays warm across two visits of a 15-minute schedule by default', () => {
  assert.ok(_internal.SERVE_IDLE_MS >= 2 * 15 * 60_000,
    `idle window ${_internal.SERVE_IDLE_MS}ms — a reader on a 15-minute schedule meets a cold brain`);
});

test('reads of one brain overlap on its serve — eleven questions wait for the slowest, not the sum', async (t) => {
  const kb = nextKb();
  t.after(() => { delete process.env.FAKE_QUERY_DELAY_MS; return drop(kb); });
  process.env.FAKE_QUERY_DELAY_MS = '150';          // read by the serve this test starts
  await withEmbedding(KEYED, () => ingest(kb, [doc(1)]));
  const mark = (await events()).length;
  const titles = Array.from({ length: 11 }, (_, i) => `ticket ${i}`);
  await Promise.all(titles.map((q) => withEmbedding(KEYED, () => query(kb, q, 3))));
  const after = await events(mark);
  const peak = Math.max(...after.filter((l) => / query /.test(l)).map((l) => Number(/inflight=(\d+)/.exec(l)[1])));
  assert.ok(peak >= 4, `reads never overlapped (peak in flight ${peak}):\n${after.join('\n')}`);
});

test('a read still never runs while a write holds the brain', async (t) => {
  const kb = nextKb();
  t.after(() => { delete process.env.FAKE_PUT_PAGE_DELAY_MS; return drop(kb); });
  process.env.FAKE_PUT_PAGE_DELAY_MS = '200';
  await withEmbedding(KEYED, () => ingest(kb, [doc(1)]));
  const mark = (await events()).length;
  const write = withEmbedding(KEYED, () => ingest(kb, [doc(2)]));
  await new Promise((r) => { setTimeout(r, 20); });   // the write has the brain
  const read = withEmbedding(KEYED, () => query(kb, 'during the write', 3));
  await Promise.all([write, read]);
  const after = await events(mark);
  const putDone = after.findIndex((l) => /^done \d+ put_page$/.test(l));
  const queryAt = after.findIndex((l) => / query /.test(l));
  assert.ok(putDone >= 0 && queryAt > putDone, `the read reached the serve before the write finished:\n${after.join('\n')}`);
});
