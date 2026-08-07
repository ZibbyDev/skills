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

const {
  ingest, query, del, drop, stat, compact, health, sweepIdleBrains, withEmbedding, _internal,
} = await import('./brain.js');
// The HTTP layer is exercised too — the vacuum-mode vocabulary and the drop
// confirmation are contract, and a contract asserted only through the in-process
// function is a contract nobody checked. Importing does NOT start the listener
// (server.js guards on import.meta.main).
const { handleCompact, handleDrop } = await import('./server.js');

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

  // ── 8. compact — reclaim the disk a deleted doc still occupies ─────────────
  // A soft delete leaves chunks+vectors on disk and gbrain ships no VACUUM, so
  // without this a KB only ever grows. Both halves must run: purge (gbrain's
  // own cascade) then VACUUM FULL (ours, straight against the PGLite store).
  const absent = await compact('acct9:proj9:store_never_created');
  assert('compact on an absent brain is exists:false and mints nothing',
    absent.exists === false && !existsSync(_internal.brainDirFor('acct9:proj9:store_never_created')),
    JSON.stringify(absent));

  await ingest(KB, [
    { sourceId: 'doc-doomed-a', markdown: '# Doomed A\n\nContent that will be purged.' },
    { sourceId: 'doc-doomed-b', markdown: '# Doomed B\n\nMore content that will be purged.' },
  ]);
  await del(KB, ['doc-doomed-a', 'doc-doomed-b']);

  // Default window is gbrain's 72h, so a just-deleted page must NOT be purged:
  // compact must never destroy a delete the user could still undo.
  const safe = await compact(KB);
  assert('compact defaults to the 72h window and spares a fresh delete',
    safe.purgedCount === 0, JSON.stringify(safe));

  // Waiving the window purges them, and VACUUM must actually have run.
  // THREE, not two: `doc-temp` was soft-deleted back in step 5 and has been
  // sitting on disk ever since — chunks, vectors and all. That is precisely the
  // condition compact exists to clear, so the count asserts it gets swept too.
  const forced = await compact(KB, { olderThanHours: 0 });
  assert('compact olderThanHours:0 hard-purges every soft-deleted page',
    forced.purgedCount === 3, JSON.stringify(forced));
  assert('compact ran VACUUM (the half gbrain does not provide)',
    forced.vacuumed === true && forced.vacuumError === null,
    JSON.stringify({ vacuumed: forced.vacuumed, err: forced.vacuumError }));
  assert('compact defaults to the LIGHT pass — there is no heavy mode any more',
    forced.vacuumMode === 'light', JSON.stringify(forced.vacuumMode));

  // TRIPWIRE. 'full' (VACUUM FULL) was removed after it was measured making a
  // store BIGGER — a real 954 MB customer KB went to 1.1 GB on one click,
  // because PGLite's WAL pool only ratchets up and a full-table rewrite is
  // WAL-logged. It must stay gone, and it must fail LOUD rather than silently
  // resolving to something else: a caller that still asks for it (an older
  // control-plane, a saved script, a future refactor that "restores" the mode)
  // has to hit this, not quietly cost the operator another 32 MB.
  let fullRejected = false;
  try { await compact(KB, { olderThanHours: 0, vacuum: 'full' }); }
  catch (e) { fullRejected = /unknown vacuum mode/.test(String(e && e.message)); }
  assert("vacuum:'full' is REJECTED — VACUUM FULL grows a PGLite store, never shrinks it",
    fullRejected, 'compact accepted the removed full mode');

  // Nothing left to purge — the repeatable case. Must be a clean no-op, not an
  // error and not a phantom count.
  const nothing = await compact(KB, { olderThanHours: 0 });
  assert('compact with nothing deleted purges 0 and still succeeds',
    nothing.exists === true && nothing.purgedCount === 0 && nothing.vacuumError === null,
    JSON.stringify(nothing));

  // The store must survive being rewritten: still searchable, still writable,
  // and the purged pages must not resurface.
  const q8 = await query(KB, 'baking sourdough bread', 5);
  assert('brain is still searchable after a compact', q8.results.length > 0);
  assert('purged pages do not resurface after compact',
    !q8.results.some((r) => r.sourceId === 'doc-doomed-a' || r.sourceId === 'doc-doomed-b'),
    q8.results.map((r) => r.sourceId).join(','));
  const r9 = await ingest(KB, [{ sourceId: 'doc-post-vacuum',
    markdown: '# After\n\nWritten after the vacuum to prove writes still land.' }]);
  assert('brain still accepts writes after a compact', r9.upserted === 1, JSON.stringify(r9));

  // ── 8b. the `vacuum` weight ───────────────────────────────────────────────
  // 'light' is the only pass there is: it returns dead tuples to the free-space
  // map (so the next ingest REUSES them instead of extending the file) without
  // an exclusive lock or a second copy of the table. 'none' erases without
  // either. Nothing here shrinks the file — that is `drop` + re-ingest.
  await ingest(KB, [{ sourceId: 'doc-churn', markdown: '# Churn\n\nA document about churn and reuse.' }]);
  await del(KB, ['doc-churn']);

  const light = await compact(KB, { olderThanHours: 0, vacuum: 'light' });
  assert('vacuum:light runs the routine pass and reports it as light',
    light.vacuumMode === 'light' && light.vacuumed === true && light.vacuumError === null,
    JSON.stringify({ mode: light.vacuumMode, vacuumed: light.vacuumed, err: light.vacuumError }));
  assert('the light pass still hard-purges (the erase half is not what makes it heavy)',
    light.purgedCount === 1, JSON.stringify(light));
  const qL = await query(KB, 'baking sourdough bread', 5);
  assert('brain is still searchable after the light pass', qL.results.length > 0, `got ${qL.results.length}`);
  const rL = await ingest(KB, [{ sourceId: 'doc-post-light',
    markdown: '# Post light\n\nWritten after a routine maintenance pass.' }]);
  assert('brain still accepts writes after the light pass', rL.upserted === 1, JSON.stringify(rL));
  const qL2 = await query(KB, 'written after a routine maintenance pass', 5);
  assert('a doc ingested AFTER the light pass is retrievable',
    qL2.results.some((r) => r.sourceId === 'doc-post-light'),
    qL2.results.map((r) => r.sourceId).join(','));

  await ingest(KB, [{ sourceId: 'doc-none', markdown: '# None\n\nErased without any vacuum at all.' }]);
  await del(KB, ['doc-none']);
  const none = await compact(KB, { olderThanHours: 0, vacuum: 'none' });
  assert('vacuum:none purges but runs no vacuum',
    none.vacuumMode === 'none' && none.vacuumed === false && none.purgedCount === 1,
    JSON.stringify(none));

  // A FIXED vocabulary. An unknown weight must be REFUSED, never coerced — a
  // typo that silently runs the heavy rewrite on a 1 GB store is the failure.
  let modeErr = null;
  try { await compact(KB, { vacuum: 'FULL' }); } catch (e) { modeErr = String(e && e.message); }
  assert('an unknown vacuum mode is refused, not coerced',
    !!modeErr && /unknown vacuum mode/i.test(modeErr), String(modeErr));
  // …and refused BEFORE the destructive purge step (so a typo costs nothing).
  const stillThere = await compact(KB, { olderThanHours: 0, vacuum: 'none' });
  assert('a refused mode did not purge on its way out',
    stillThere.purgedCount === 0, JSON.stringify(stillThere));

  // ── 8c. the HTTP contract for the same vocabulary ─────────────────────────
  const httpBad = await handleCompact({ kbId: KB, vacuum: 'sorta' });
  assert('POST /compact rejects an unknown vacuum mode with 400',
    httpBad.status === 400 && /vacuum must be one of/.test(httpBad.body.error || ''),
    JSON.stringify(httpBad));
  const httpOk = await handleCompact({ kbId: KB, vacuum: 'light' });
  assert('POST /compact accepts the light mode and echoes it',
    httpOk.status === 200 && httpOk.body.ok === true && httpOk.body.vacuumMode === 'light',
    JSON.stringify(httpOk.body));
  const httpDefault = await handleCompact({ kbId: KB });
  assert('POST /compact with no vacuum field defaults to light',
    httpDefault.status === 200 && httpDefault.body.vacuumMode === 'light',
    JSON.stringify(httpDefault.body));
  // The HTTP half of the tripwire above. An older control-plane still sending
  // vacuum:'full' must get a 400 it can show, not a 200 that costs disk.
  const httpFull = await handleCompact({ kbId: KB, vacuum: 'full' });
  assert("POST /compact rejects the removed 'full' mode with 400",
    httpFull.status === 400 && /vacuum must be one of/.test(httpFull.body.error || ''),
    JSON.stringify(httpFull));

  // ── 8d. an EMPTY brain (exists, zero live documents) ──────────────────────
  // Distinct from an ABSENT one: there is a real store here, it just holds
  // nothing. Maintenance must work on it rather than erroring or reporting the
  // absent-brain shape.
  const EMPTY_KB = 'acct3:proj3:store_empty';
  await ingest(EMPTY_KB, [{ sourceId: 'only-doc', markdown: '# Only\n\nThe one and only document.' }]);
  await del(EMPTY_KB, ['only-doc']);
  const emptied = await compact(EMPTY_KB, { olderThanHours: 0 });
  assert('compact works on a brain whose last document was removed',
    emptied.exists === true && emptied.purgedCount === 1 && emptied.vacuumError === null,
    JSON.stringify(emptied));
  const emptyStat = await stat(EMPTY_KB);
  assert('an emptied-by-delete brain still EXISTS and reports 0 documents',
    emptyStat.exists === true && emptyStat.docs === 0, JSON.stringify(emptyStat));
  const emptyAgain = await compact(EMPTY_KB, { olderThanHours: 0, vacuum: 'light' });
  assert('a second pass over an empty brain is a clean no-op',
    emptyAgain.exists === true && emptyAgain.purgedCount === 0 && emptyAgain.vacuumError === null,
    JSON.stringify(emptyAgain));

  // ── 9. halfvec — narrow the vectors themselves (opt-in, one-way) ───────────
  // float32 -> float16 in place. No re-embedding: pgvector casts the stored
  // values, so this is the cheap half of a KB's footprint that a narrower
  // DIMENSION only buys by re-embedding everything.
  const noHalf = await compact(KB, { olderThanHours: 0 });
  assert('compact does NOT convert to halfvec unless asked',
    noHalf.halfvec === null, JSON.stringify(noHalf.halfvec));

  const conv = await compact(KB, { olderThanHours: 0, halfvec: true });
  assert('compact halfvec:true narrows the embedding column',
    conv.halfvec && conv.halfvec.converted === true && /^halfvec\(/.test(conv.halfvec.to || ''),
    JSON.stringify(conv.halfvec));
  // …and it converted FROM float32. This is the "existing brains are untouched"
  // half of the 2026-08-07 default: only a brain created WITH embeddings is born
  // halfvec, so this one — like every brain that predates the change — is still
  // vector(N) until its owner asks.
  assert('a brain not born halfvec is still float32 until explicitly converted',
    conv.halfvec && /^vector\(/.test(conv.halfvec.from || ''), JSON.stringify(conv.halfvec));
  assert('the HNSW index is rebuilt for halfvec (not left dropped)',
    conv.halfvec && conv.halfvec.indexesRebuilt >= 1, JSON.stringify(conv.halfvec));

  // Idempotent: a second pass must be a no-op, not an error — this runs inside
  // a repeatable maintenance action.
  const again = await compact(KB, { olderThanHours: 0, halfvec: true });
  assert('halfvec conversion is idempotent',
    again.halfvec && again.halfvec.converted === false && again.halfvec.reason === 'already halfvec',
    JSON.stringify(again.halfvec));

  // The store must still work end-to-end on the narrowed column.
  const q9 = await query(KB, 'baking sourdough bread', 5);
  assert('brain is still searchable after halfvec conversion', q9.results.length > 0,
    `got ${q9.results.length}`);
  const r10 = await ingest(KB, [{ sourceId: 'doc-post-halfvec',
    markdown: '# Post halfvec\n\nWritten after narrowing the vectors, must still index.' }]);
  assert('brain still accepts writes after halfvec conversion', r10.upserted === 1, JSON.stringify(r10));
  const q10 = await query(KB, 'written after narrowing the vectors', 5);
  assert('a doc ingested AFTER the conversion is retrievable',
    q10.results.some((r) => r.sourceId === 'doc-post-halfvec'),
    q10.results.map((r) => r.sourceId).join(','));

  // The routine pass must also work on a narrowed store — the two options are
  // independent, and a user who converted once still runs maintenance forever.
  const lightAfterHalf = await compact(KB, { olderThanHours: 0, vacuum: 'light' });
  assert('the light pass still works after the halfvec conversion',
    lightAfterHalf.vacuumMode === 'light' && lightAfterHalf.vacuumed === true
      && lightAfterHalf.vacuumError === null,
    JSON.stringify({ mode: lightAfterHalf.vacuumMode, err: lightAfterHalf.vacuumError }));

  // ── 9b. NEW brains are born halfvec (default since 2026-08-07) ─────────────
  // A vector-capable brain gets the narrow column at CREATION, while the table
  // is empty — so it never stores a float32 vector at all and nothing is ever
  // rewritten. Measured cost to retrieval: zero (see brain.js
  // `narrowNewBrainToHalfvec` for the numbers and the method).
  //
  // WHAT THIS CAN AND CANNOT ASSERT OFFLINE. This smoke has no embeddings API
  // key, and a vector-capable brain needs one twice over: `gbrain init` REFUSES
  // to create one without a provider ("No embedding provider configured",
  // exit 1), and `put_page` embeds INLINE, so a document ingested with a
  // placeholder key dies inside gbrain with an auth error. So these brains are
  // created with an EMPTY ingest — which runs `ensureBrain` (the code under
  // test) and nothing else — and the writes-into-a-halfvec-column half is
  // covered above, by section 9's post-conversion ingest + retrieval over the
  // identical column type. A REAL-key born-halfvec ingest+query was verified
  // out-of-band when the default landed; it is not reproducible offline.
  //
  // How the column is read back WITHOUT a second SQL helper: ask compact to
  // convert it. `already halfvec` IS the assertion — one code path, no parallel
  // reader that could drift from the one that does the work.
  //
  // GBRAIN_NO_EMBEDDING must be turned OFF in the same override — it is checked
  // FIRST in embeddingsEnabled(), so GBRAIN_EMBEDDING:'1' alone loses to the
  // process-level '1' this file sets and the brain comes out keyword-only.
  const VECTOR_MODE = {
    GBRAIN_EMBEDDING: '1',
    GBRAIN_NO_EMBEDDING: '0',
    OPENAI_API_KEY: 'sk-smoke-offline-placeholder-never-called',
    GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-small',
    GBRAIN_EMBEDDING_DIMENSIONS: '1536',
  };
  const BORN_KB = 'acct5:proj5:store_born_halfvec';
  await withEmbedding(VECTOR_MODE, () => ingest(BORN_KB, []));
  assert('a vector-capable brain is created on first use',
    (await stat(BORN_KB)).exists === true
      && existsSync(join(_internal.brainDirFor(BORN_KB), '.gbrain', 'brain.pglite')),
    JSON.stringify(await stat(BORN_KB)));

  const bornType = await compact(BORN_KB, { olderThanHours: 0, vacuum: 'none', halfvec: true });
  assert('a NEW vector-capable brain is born halfvec (nothing left to convert)',
    bornType.halfvec && bornType.halfvec.converted === false
      && bornType.halfvec.reason === 'already halfvec'
      && /^halfvec\(1536\)$/.test(bornType.halfvec.from || ''),
    JSON.stringify(bornType.halfvec));

  // A LEXICAL brain must NOT pay for this — it has no vectors to narrow, and
  // opening its store at creation would buy an unused DDL round-trip on every
  // keyword-only KB. Every other brain in this file is created that way and is
  // still float32 (asserted in section 9), which is the same guarantee.
  const LEX_KB = 'acct5:proj5:store_lexical';
  await ingest(LEX_KB, [{ sourceId: 'lex-1', markdown: '# Lexical\n\nNo embeddings here.' }]);
  const lexType = await compact(LEX_KB, { olderThanHours: 0, vacuum: 'none', halfvec: true });
  assert('a keyword-only brain is NOT narrowed at creation',
    lexType.halfvec && lexType.halfvec.converted === true
      && /^vector\(/.test(lexType.halfvec.from || ''),
    JSON.stringify(lexType.halfvec));

  // OPT-OUT. A box whose embedding provider emits true float32 and would rather
  // spend the bytes sets GBRAIN_NEW_BRAIN_HALFVEC=0 and gets the old behaviour.
  const OPTOUT_KB = 'acct5:proj5:store_optout';
  process.env.GBRAIN_NEW_BRAIN_HALFVEC = '0';
  try {
    await withEmbedding(VECTOR_MODE, () => ingest(OPTOUT_KB, []));
  } finally {
    delete process.env.GBRAIN_NEW_BRAIN_HALFVEC;
  }
  const optoutType = await compact(OPTOUT_KB, { olderThanHours: 0, vacuum: 'none', halfvec: true });
  assert('GBRAIN_NEW_BRAIN_HALFVEC=0 keeps a new brain float32',
    optoutType.halfvec && optoutType.halfvec.converted === true
      && /^vector\(1536\)$/.test(optoutType.halfvec.from || ''),
    JSON.stringify(optoutType.halfvec));

  // ── 10. EMPTY the knowledge base — every document goes, the store stays ────
  // The control-plane's "Empty knowledge base" is this engine op: erase the
  // brain and let the next use re-create it. Distinct from compact (which never
  // touches a live document) and from deleting the store (which also removes the
  // row the control-plane owns — there is no row down here to remove).
  const EMPTY_TARGET = 'acct4:proj4:store_wipe';
  await ingest(EMPTY_TARGET, [
    { sourceId: 'keep-a', markdown: '# Keep A\n\nA document about migrating a database schema.' },
    { sourceId: 'keep-b', markdown: '# Keep B\n\nA document about tuning a query planner.' },
  ]);
  const beforeWipe = await stat(EMPTY_TARGET);
  assert('the store to be emptied holds documents first',
    beforeWipe.exists === true && beforeWipe.docs === 2, JSON.stringify(beforeWipe));

  const wiped = await drop(EMPTY_TARGET);
  assert('empty reports it removed the brain', wiped.dropped === true, JSON.stringify(wiped));
  const afterWipe = await stat(EMPTY_TARGET);
  assert('an emptied store holds nothing and costs nothing',
    afterWipe.exists === false && afterWipe.sizeBytes === 0 && afterWipe.docs === 0,
    JSON.stringify(afterWipe));
  assert('emptying really removed the files (not just the bookkeeping)',
    !existsSync(_internal.brainDirFor(EMPTY_TARGET)), _internal.brainDirFor(EMPTY_TARGET));

  // The STORE survives: it is immediately usable again, and nothing from before
  // comes back with it.
  const qWiped = await query(EMPTY_TARGET, 'migrating a database schema', 5);
  assert('an emptied store answers queries with nothing (not an error)',
    qWiped.results.length === 0, qWiped.results.map((r) => r.sourceId).join(','));
  const rAfterWipe = await ingest(EMPTY_TARGET, [{ sourceId: 'fresh',
    markdown: '# Fresh\n\nIngested after the knowledge base was emptied.' }]);
  assert('an emptied store accepts writes again', rAfterWipe.upserted === 1, JSON.stringify(rAfterWipe));
  const qFresh = await query(EMPTY_TARGET, 'ingested after the knowledge base was emptied', 5);
  assert('a doc ingested AFTER emptying is retrievable',
    qFresh.results.some((r) => r.sourceId === 'fresh'),
    qFresh.results.map((r) => r.sourceId).join(','));
  assert('emptied documents do NOT resurface after a re-ingest',
    !qFresh.results.some((r) => r.sourceId === 'keep-a' || r.sourceId === 'keep-b'),
    qFresh.results.map((r) => r.sourceId).join(','));

  // Emptying a store that was never used must not MINT one (same rule stat and
  // compact follow) and must not fail.
  const NEVER = 'acct9:proj9:store_never_created';
  const wipeAbsent = await drop(NEVER);
  assert('emptying an absent brain is a no-op that mints nothing',
    wipeAbsent.dropped === false && !existsSync(_internal.brainDirFor(NEVER)),
    JSON.stringify(wipeAbsent));

  // Emptying is irreversible, so the HTTP surface demands an explicit confirm —
  // a bare POST must never erase a knowledge base.
  const noConfirm = await handleDrop({ kbId: EMPTY_TARGET });
  assert('POST /drop without confirm:true is refused',
    noConfirm.status === 400 && /confirm/.test(noConfirm.body.error || ''),
    JSON.stringify(noConfirm));
  const stillAlive = await stat(EMPTY_TARGET);
  assert('the refused empty left the store intact',
    stillAlive.exists === true && stillAlive.docs === 1, JSON.stringify(stillAlive));

  // Compact after emptying: the brain is gone, so there is nothing to reclaim —
  // and asking must not re-create it.
  const compactWiped = await compact(NEVER, { olderThanHours: 0 });
  assert('compact after emptying reports an absent brain and mints nothing',
    compactWiped.exists === false && !existsSync(_internal.brainDirFor(NEVER)),
    JSON.stringify(compactWiped));

  // ── 11. AUTOMATIC reclaim on idle — the incremental path, unattended ───────
  // The customer bug is "the store only ever grows". Nobody is going to press a
  // button every week, so the cheap half has to happen on its own. These
  // assertions are ordered so the NEGATIVE ones mean something: the sweep is
  // first PROVEN to fire, with the same call and the same arguments, before any
  // test claims it did not.
  const AUTO_KB = 'acct5:proj5:store_auto';
  const autoDir = _internal.brainDirFor(AUTO_KB);
  // Drive the brain past the idle threshold by ARGUMENT — no fake clock, no
  // reaching into internals, and no five-minute wait.
  const idleNow = () => Date.now() + _internal.SERVE_IDLE_MS + 1;

  await ingest(AUTO_KB, [
    { sourceId: 'auto-a', markdown: '# Auto A\n\nA document about scheduling background maintenance work.' },
    { sourceId: 'auto-b', markdown: '# Auto B\n\nA document about reclaiming storage automatically.' },
  ]);
  await del(AUTO_KB, ['auto-a']);

  // POSITIVE FIRST. Window 0 = "every soft delete is past its recovery window",
  // which is the only way to observe a purge without waiting 72 real hours.
  process.env.AUTO_RECLAIM_WINDOW_HOURS = '0';
  const fired = (await sweepIdleBrains(idleNow())).filter((r) => r.brainDir === autoDir)[0];
  assert('an idle sweep reclaims WITHOUT any operator call',
    !!fired && fired.action === 'reclaimed' && fired.purgedCount === 1,
    JSON.stringify(fired));
  assert('the automatic pass is the LIGHT one — never VACUUM FULL',
    !!fired && fired.vacuumMode === 'light', JSON.stringify(fired && fired.vacuumMode));
  const qAuto = await query(AUTO_KB, 'reclaiming storage automatically', 5);
  assert('the store is still searchable after an automatic sweep',
    qAuto.results.some((r) => r.sourceId === 'auto-b'),
    qAuto.results.map((r) => r.sourceId).join(','));

  // Nothing written since → nothing to do. The sweep must still RELEASE the
  // brain (idle reaping is its other job) but must not reopen it to vacuum.
  const clean = (await sweepIdleBrains(idleNow())).filter((r) => r.brainDir === autoDir)[0];
  assert('an idle sweep skips a brain nothing has written to',
    !!clean && clean.action === 'reaped' && clean.reason === 'unchanged',
    JSON.stringify(clean));

  // SPARED: a delete still inside the recovery window survives the sweep. The
  // sweep is known to fire (above), so this is a real negative.
  await ingest(AUTO_KB, [{ sourceId: 'auto-c', markdown: '# Auto C\n\nA document deleted only moments ago.' }]);
  await del(AUTO_KB, ['auto-c']);
  process.env.AUTO_RECLAIM_WINDOW_HOURS = '72';
  const spared = (await sweepIdleBrains(idleNow())).filter((r) => r.brainDir === autoDir)[0];
  assert('the automatic pass runs but SPARES a delete inside the recovery window',
    !!spared && spared.action === 'reclaimed' && spared.purgedCount === 0,
    JSON.stringify(spared));

  // OFF-SWITCH: with AUTO_RECLAIM=0 the same brain, dirty and idle, is only
  // reaped. Proven meaningful by the identical setup firing above.
  await ingest(AUTO_KB, [{ sourceId: 'auto-d', markdown: '# Auto D\n\nAnother document, about switches.' }]);
  await del(AUTO_KB, ['auto-d']);
  process.env.AUTO_RECLAIM_WINDOW_HOURS = '0';
  process.env.AUTO_RECLAIM = '0';
  const off = (await sweepIdleBrains(idleNow())).filter((r) => r.brainDir === autoDir)[0];
  assert('AUTO_RECLAIM=0 stops the automatic pass (reap only)',
    !!off && off.action === 'reaped' && off.reason === 'disabled', JSON.stringify(off));

  // …and the debt it declined to pay is still owed: switch back on, and the very
  // next sweep collects it. (This is also what proves the "off" case above was
  // the switch and not an empty queue.)
  //
  // TWO pages, not one — auto-d, which the disabled sweep declined, AND auto-c,
  // which the in-window sweep spared. That count is the strongest evidence in
  // this section: both negatives above really did leave data behind, exactly as
  // claimed, rather than passing because nothing was ever there to purge.
  delete process.env.AUTO_RECLAIM;
  await query(AUTO_KB, 'switches', 3);   // re-open the brain the reap released
  const backOn = (await sweepIdleBrains(idleNow())).filter((r) => r.brainDir === autoDir)[0];
  assert('re-enabling collects the debt BOTH negatives left behind',
    !!backOn && backOn.action === 'reclaimed' && backOn.purgedCount === 2,
    JSON.stringify(backOn));

  // A brain that is NOT idle is never touched — the sweep must not interrupt a
  // store somebody is using.
  await ingest(AUTO_KB, [{ sourceId: 'auto-e', markdown: '# Auto E\n\nA document in an actively used store.' }]);
  await del(AUTO_KB, ['auto-e']);
  const busy = (await sweepIdleBrains(Date.now())).filter((r) => r.brainDir === autoDir)[0];
  assert('a brain still in use is left completely alone', busy === undefined,
    JSON.stringify(busy));

  // An emptied/absent brain must never be resurrected by the sweep.
  const beforeDirs = existsSync(_internal.brainDirFor(NEVER));
  await sweepIdleBrains(idleNow());
  assert('the sweep never resurrects a brain that does not exist',
    beforeDirs === false && !existsSync(_internal.brainDirFor(NEVER)));
  delete process.env.AUTO_RECLAIM_WINDOW_HOURS;
} catch (e) {
  failed += 1;
  console.log(`FAIL  unexpected error — ${e?.stack || e}`);
} finally {
  console.log(`\n${passed} passed, ${failed} failed`);
  try { rmSync(DATA_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed > 0 ? 1 : 0);
}
