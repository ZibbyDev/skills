/**
 * smoke.mjs — end-to-end proof the sidecar is driving REAL GBrain.
 *
 * Runs the full ingest → query → upsert → delete → isolation cycle through
 * ./brain.js, which shells out to the vendored `gbrain` CLI. Each kbId becomes
 * a real GBrain PGLite brain on disk under a fresh temp data root.
 *
 * Forces GBRAIN_NO_EMBEDDING=1 so it runs fully offline: GBrain still ingests,
 * indexes, and answers via its keyword/BM25 hybrid arm (semantic/vector ranking
 * needs an embeddings API key — see README). Prints PASS/FAIL per assertion and
 * exits non-zero on any failure.
 *
 * Run (inside the image, or anywhere `gbrain` is on PATH + Bun is installed):
 *   GBRAIN_NO_EMBEDDING=1 bun smoke.mjs
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated temp data root + deterministic offline mode BEFORE importing brain.js.
process.env.GBRAIN_NO_EMBEDDING = '1';
const DATA_ROOT = mkdtempSync(join(tmpdir(), 'gbrain-smoke-'));
process.env.GBRAIN_DATA_ROOT = DATA_ROOT;

const { ingest, query, del, health, _internal } = await import('./brain.js');

let passed = 0;
let failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed += 1; console.log(`PASS  ${name}`); }
  else { failed += 1; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
}

try {
  const KB = 'acct1:proj1:store_alpha';
  const OTHER_KB = 'acct2:proj2:store_beta';

  await health();
  assert('gbrain binary is runnable (health)', true);

  // ── 1. Ingest 3 docs on distinct topics ────────────────────────────────────
  const r1 = await ingest(KB, [
    { sourceId: 'doc-cooking', markdown:
      '# Sourdough Bread\n\nMix flour water and salt with a sourdough starter. '
      + 'Let the dough ferment overnight, then bake the loaf in a hot oven until '
      + 'the crust is golden. Baking bread is about patience and temperature.' },
    { sourceId: 'doc-space', markdown:
      '# Mars Rovers\n\nNASA rovers explore the surface of Mars, drilling rock '
      + 'samples and photographing craters on the red planet.' },
    { sourceId: 'doc-finance', markdown:
      '# Compound Interest\n\nInterest compounds when earnings are reinvested, so '
      + 'a savings account grows exponentially over time.' },
  ]);
  assert('ingest upserted 3 docs', r1.upserted === 3, JSON.stringify(r1));
  assert('ingest produced chunks (real GBrain chunking)', r1.chunks >= 3, JSON.stringify(r1));

  // A real GBrain brain (PGLite database) exists on disk for this kbId.
  const brainDir = _internal.brainDirFor(KB);
  assert('real GBrain PGLite brain created on disk',
    existsSync(join(brainDir, '.gbrain', 'brain.pglite')),
    join(brainDir, '.gbrain', 'brain.pglite'));

  // ── 2. Query ranks the right doc ───────────────────────────────────────────
  const q1 = await query(KB, 'how do I bake a golden loaf of sourdough bread', 3);
  assert('query returns results', q1.results.length > 0, `got ${q1.results.length}`);
  assert('cooking query ranks doc-cooking #1',
    q1.results[0]?.sourceId === 'doc-cooking',
    `top=${q1.results[0]?.sourceId} score=${q1.results[0]?.score}`);
  assert('result carries chunk text + numeric score',
    typeof q1.results[0]?.chunk === 'string' && q1.results[0].chunk.length > 0
      && typeof q1.results[0]?.score === 'number',
    JSON.stringify(q1.results[0]));

  const q2 = await query(KB, 'exploring the red planet Mars with a rover', 3);
  assert('space query ranks doc-space #1',
    q2.results[0]?.sourceId === 'doc-space',
    `top=${q2.results[0]?.sourceId}`);

  // ── 3. Upsert one sourceId — must REPLACE content, not duplicate ────────────
  const r2 = await ingest(KB, [{ sourceId: 'doc-cooking', markdown:
    '# Sourdough Bread (revised)\n\nA shorter note about baking sourdough bread.' }]);
  assert('re-ingest reports 1 upsert', r2.upserted === 1, JSON.stringify(r2));
  const q3 = await query(KB, 'baking sourdough bread', 5);
  assert('after upsert doc-cooking still top for cooking query',
    q3.results[0]?.sourceId === 'doc-cooking', `top=${q3.results[0]?.sourceId}`);
  const stillHasOldText = q3.results.some(
    (r) => r.sourceId === 'doc-cooking' && /golden|overnight|ferment/i.test(r.chunk));
  assert('old chunk text is gone after upsert', !stillHasOldText,
    stillHasOldText ? 'stale chunk still present' : '');

  // ── 4. Delete a sourceId — must vanish from query results ───────────────────
  const d1 = await del(KB, ['doc-space']);
  assert('delete reports 1 source removed', d1.deleted === 1, JSON.stringify(d1));
  const q4 = await query(KB, 'exploring the red planet Mars with a rover', 5);
  assert('deleted source no longer in query results',
    !q4.results.some((r) => r.sourceId === 'doc-space'),
    q4.results.map((r) => r.sourceId).join(','));
  const d2 = await del(KB, ['nope-not-here']);
  assert('delete of an absent source removes 0', d2.deleted === 0, JSON.stringify(d2));

  // ── 5. deleted:true via /ingest doc shape ───────────────────────────────────
  await ingest(KB, [{ sourceId: 'doc-temp', markdown: '# Temp\n\nTemporary doc.' }]);
  const r3 = await ingest(KB, [{ sourceId: 'doc-temp', deleted: true }]);
  assert('ingest deleted:true removes the source', r3.deleted === 1, JSON.stringify(r3));

  // ── 6. Re-ingest a previously deleted sourceId comes back live (upsert) ─────
  await ingest(KB, [{ sourceId: 'doc-space', markdown:
    '# Mars Rovers Again\n\nThe rover returns to explore Mars craters.' }]);
  const q5 = await query(KB, 'rover exploring Mars craters', 5);
  assert('re-ingest of a deleted sourceId is queryable again',
    q5.results.some((r) => r.sourceId === 'doc-space'),
    q5.results.map((r) => r.sourceId).join(','));

  // ── 7. kbId isolation — a different brain sees nothing of KB's docs ─────────
  const q6 = await query(OTHER_KB, 'baking sourdough bread', 5);
  assert('cross-kb query returns no results (tenant isolation)',
    q6.results.length === 0, `got ${q6.results.length} from ${OTHER_KB}`);
  await ingest(OTHER_KB, [{ sourceId: 'doc-beta',
    markdown: '# Beta\n\nUnrelated content in another knowledge base entirely.' }]);
  const q7 = await query(KB, 'unrelated content another knowledge base', 5);
  assert('other-kb ingest does not leak into this kb',
    !q7.results.some((r) => r.sourceId === 'doc-beta'),
    q7.results.map((r) => r.sourceId).join(','));
} catch (e) {
  failed += 1;
  console.log(`FAIL  unexpected error — ${e?.stack || e}`);
} finally {
  console.log(`\n${passed} passed, ${failed} failed`);
  try { rmSync(DATA_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed > 0 ? 1 : 0);
}
