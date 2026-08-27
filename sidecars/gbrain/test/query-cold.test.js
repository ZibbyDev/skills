/**
 * A READ NEVER PROVISIONS (brain.js `query`).
 *
 * A brain that was never written has nothing to retrieve, so `query` on an
 * unknown kbId must answer `{results: []}` immediately — without running
 * `gbrain init`, which costs tens of seconds cold and blew MAGNUM's 10s
 * retrieval budget on its first tick after deploy. Proven by the filesystem:
 * after the call the brain directory still does not exist. The real gbrain
 * binary is never reached because nothing is created for it to run against.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'gbrain-query-cold-'));
process.env.GBRAIN_DATA_ROOT = root;
const { query } = await import('../brain.js');

test('query on a never-written brain returns empty and creates nothing', async (t) => {
  t.after(() => rm(root, { recursive: true, force: true }));
  const kbId = 'kb-never-written';
  const started = Date.now();
  const out = await query(kbId, 'anything', 3);
  assert.deepEqual(out.results, []);
  assert.ok(['vector', 'lexical'].includes(out.mode));
  assert.equal(out.stale, false);
  assert.ok(Date.now() - started < 2000, 'answered without a cold init');
  // Brain dirs are `kb-<sha>` under the data root, so "nothing was created"
  // is simply "the root is still empty".
  assert.deepEqual(await readdir(root), [], 'a read must not provision a brain');
});
