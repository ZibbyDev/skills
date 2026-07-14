/**
 * smoke.mjs — end-to-end proof the sidecar engine is REAL.
 *
 * Runs the full ingest → query → re-ingest(upsert) → delete → isolation cycle
 * against a fresh temp PGlite data dir using the deterministic fake embedder
 * (EMBEDDINGS_FAKE=1 — no external API). Prints PASS/FAIL per assertion and
 * exits non-zero on any failure.
 *
 * Run:  EMBEDDINGS_FAKE=1 npm run smoke
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Force the fake embedder + an isolated temp data dir BEFORE importing db.mjs
// (which reads these at module load).
process.env.EMBEDDINGS_FAKE = '1';
const DATA_DIR = mkdtempSync(join(tmpdir(), 'gbrain-smoke-'));
process.env.PGLITE_DATA_DIR = DATA_DIR;

const { upsertDoc, deleteSources, query } = await import('./db.mjs');
const { getDb } = await import('./db.mjs');

let passed = 0;
let failed = 0;
function assert(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

async function chunkCount(kbId, sourceId) {
  const db = await getDb();
  const r = await db.query(
    'SELECT count(*)::int AS n FROM chunks WHERE kb_id = $1 AND source_id = $2',
    [kbId, sourceId],
  );
  return r.rows[0]?.n || 0;
}

try {
  const KB = 'kb-alpha';
  const OTHER_KB = 'kb-beta';

  // ── 1. Ingest 3 docs on distinct topics ────────────────────────────────────
  await upsertDoc(KB, 'doc-cooking',
    '# Sourdough Bread\n\nMix flour water and salt with a sourdough starter. '
    + 'Let the dough ferment overnight, then bake the loaf in a hot oven until '
    + 'the crust is golden. Baking bread is about patience and temperature.');
  await upsertDoc(KB, 'doc-space',
    '# Mars Rovers\n\nNASA rovers explore the surface of Mars, drilling rock '
    + 'samples and photographing craters. The rover uses solar panels and a '
    + 'nuclear battery to survive the cold Martian night on the red planet.');
  await upsertDoc(KB, 'doc-finance',
    '# Compound Interest\n\nInterest compounds when earnings are reinvested, so '
    + 'a savings account grows exponentially over time. The annual percentage '
    + 'yield reflects compounding frequency on your invested principal.');

  const q1 = await query(KB, 'how do I bake a golden loaf of bread with sourdough', 3);
  assert('ingest returned searchable results', q1.length > 0, `got ${q1.length} results`);
  assert('cooking query ranks doc-cooking #1',
    q1[0]?.sourceId === 'doc-cooking',
    `top=${q1[0]?.sourceId} score=${q1[0]?.score?.toFixed(3)}`);
  assert('top score is a similarity in [0,1]',
    typeof q1[0]?.score === 'number' && q1[0].score >= 0 && q1[0].score <= 1,
    `score=${q1[0]?.score}`);

  const q2 = await query(KB, 'exploring the red planet Mars with a rover', 3);
  assert('space query ranks doc-space #1',
    q2[0]?.sourceId === 'doc-space',
    `top=${q2[0]?.sourceId} score=${q2[0]?.score?.toFixed(3)}`);

  // ── 2. Re-ingest one sourceId (upsert) — must REPLACE, not duplicate ────────
  const before = await chunkCount(KB, 'doc-cooking');
  await upsertDoc(KB, 'doc-cooking',
    '# Sourdough Bread (revised)\n\nA shorter note about baking sourdough bread.');
  const after = await chunkCount(KB, 'doc-cooking');
  assert('re-ingest REPLACES chunks (no duplication)',
    after > 0 && after <= before,
    `before=${before} after=${after}`);
  // The new content should still be the top hit for a cooking query, and the OLD
  // "golden crust / ferment overnight" text should be gone (replaced).
  const q3 = await query(KB, 'baking sourdough bread', 5);
  assert('after upsert doc-cooking still top for cooking query',
    q3[0]?.sourceId === 'doc-cooking', `top=${q3[0]?.sourceId}`);
  const stillHasOldText = q3.some((r) => r.sourceId === 'doc-cooking' && /golden|overnight/i.test(r.chunk));
  assert('old chunk text is gone after upsert', !stillHasOldText,
    stillHasOldText ? 'stale chunk still present' : '');

  // ── 3. Delete a sourceId — must vanish from query results ───────────────────
  const del = await deleteSources(KB, ['doc-space']);
  assert('delete reports 1 source removed', del.deleted === 1, `deleted=${del.deleted}`);
  const q4 = await query(KB, 'exploring the red planet Mars with a rover', 5);
  const spaceStillThere = q4.some((r) => r.sourceId === 'doc-space');
  assert('deleted source no longer in query results', !spaceStillThere,
    spaceStillThere ? 'doc-space still returned' : '');
  assert('delete of an absent source removes 0',
    (await deleteSources(KB, ['nope-not-here'])).deleted === 0, 'expected 0');

  // ── 4. KB isolation — querying a DIFFERENT kb returns nothing ───────────────
  const q5 = await query(OTHER_KB, 'baking sourdough bread', 5);
  assert('cross-kb query returns no results (tenant isolation)',
    q5.length === 0, `got ${q5.length} results from ${OTHER_KB}`);
  // And ingesting into OTHER_KB must not leak into KB.
  await upsertDoc(OTHER_KB, 'doc-beta', '# Beta\n\nSome unrelated content in another knowledge base.');
  const q6 = await query(KB, 'unrelated content in another knowledge base', 5);
  const leaked = q6.some((r) => r.sourceId === 'doc-beta');
  assert('other-kb ingest does not leak into this kb', !leaked,
    leaked ? 'doc-beta leaked into KB' : '');

  // ── 5. Ingest DELETE flag path (via the doc {deleted:true} shape) ───────────
  // (mirrors what /ingest does for a doc with deleted:true)
  await upsertDoc(KB, 'doc-temp', '# Temp\n\nTemporary doc that will be removed.');
  const gone = await deleteSources(KB, ['doc-temp']);
  assert('deleted:true-style removal works', gone.deleted === 1, `deleted=${gone.deleted}`);
} catch (e) {
  failed += 1;
  console.log(`FAIL  unexpected error — ${e?.stack || e}`);
} finally {
  console.log(`\n${passed} passed, ${failed} failed`);
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed > 0 ? 1 : 0);
}
