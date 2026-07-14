/**
 * db.mjs — embedded Postgres (PGlite) + pgvector store for the KB sidecar.
 *
 * One table, `chunks`, holds every chunk of every source across every knowledge
 * base. MULTI-TENANT ISOLATION is enforced in code: every read/write/delete is
 * scoped by `kb_id` and NEVER crosses a kb boundary. Data persists to
 * PGLITE_DATA_DIR so the brain survives a restart (the Stores-v2 S3/MinIO
 * snapshot round-trip that ships the data dir off-box is handled elsewhere).
 */

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { embed, EMBED_DIM, toVectorLiteral } from './embeddings.mjs';
import { chunkMarkdown } from './chunk.mjs';

const DATA_DIR = (process.env.PGLITE_DATA_DIR || '/data/brain').trim();

let dbPromise = null;

/** Lazily open (once) the PGlite instance and ensure schema + indexes. */
export async function getDb() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const db = new PGlite(DATA_DIR, { extensions: { vector } });
    await db.exec('CREATE EXTENSION IF NOT EXISTS vector;');
    await db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id        bigint generated always as identity primary key,
        kb_id     text not null,
        source_id text not null,
        chunk_ix  int  not null,
        content   text not null,
        embedding vector(${EMBED_DIM}) not null
      );
      CREATE INDEX IF NOT EXISTS chunks_kb_source_idx ON chunks (kb_id, source_id);
    `);
    await ensureVectorIndex(db);
    return db;
  })();
  return dbPromise;
}

/**
 * Create an ANN index for cosine search, degrading gracefully:
 * hnsw (best, pgvector ≥0.5) → ivfflat → none (plain seq scan still correct).
 * A missing ANN index only costs speed, never correctness.
 */
async function ensureVectorIndex(db) {
  const attempts = [
    "CREATE INDEX IF NOT EXISTS chunks_emb_hnsw ON chunks USING hnsw (embedding vector_cosine_ops)",
    "CREATE INDEX IF NOT EXISTS chunks_emb_ivf ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)",
  ];
  for (const sql of attempts) {
    try {
      await db.exec(sql);
      return sql.includes('hnsw') ? 'hnsw' : 'ivfflat';
    } catch {
      // try the next, less-demanding index type
    }
  }
  return 'none';
}

/**
 * Upsert one source: delete its existing chunks in this kb, then chunk + embed +
 * insert the new markdown. Returns { chunks } = number of chunks inserted.
 */
export async function upsertDoc(kbId, sourceId, markdown) {
  const db = await getDb();
  const pieces = chunkMarkdown(markdown);
  const vectors = await embed(pieces);

  return db.transaction(async (tx) => {
    await tx.query('DELETE FROM chunks WHERE kb_id = $1 AND source_id = $2', [kbId, sourceId]);
    for (let i = 0; i < pieces.length; i++) {
      // eslint-disable-next-line no-await-in-loop
      await tx.query(
        'INSERT INTO chunks (kb_id, source_id, chunk_ix, content, embedding) VALUES ($1, $2, $3, $4, $5)',
        [kbId, sourceId, i, pieces[i], toVectorLiteral(vectors[i])],
      );
    }
    return { chunks: pieces.length };
  });
}

/**
 * Delete sources within a kb. Returns { deleted } = how many of the requested
 * sourceIds actually had chunks removed (distinct source_ids), and { chunks }
 * the number of chunk rows removed.
 */
export async function deleteSources(kbId, sourceIds) {
  const db = await getDb();
  const ids = [...new Set((sourceIds || []).filter((s) => typeof s === 'string' && s.trim()))];
  if (ids.length === 0) return { deleted: 0, chunks: 0 };

  const present = await db.query(
    'SELECT count(DISTINCT source_id)::int AS n FROM chunks WHERE kb_id = $1 AND source_id = ANY($2)',
    [kbId, ids],
  );
  const res = await db.query(
    'DELETE FROM chunks WHERE kb_id = $1 AND source_id = ANY($2)',
    [kbId, ids],
  );
  return { deleted: present.rows[0]?.n || 0, chunks: res.affectedRows || 0 };
}

/**
 * Semantic search within one kb. Returns [{ sourceId, chunk, score }] ordered by
 * descending cosine similarity. score = 1 - cosine_distance, clamped to [0,1].
 */
export async function query(kbId, queryText, topK) {
  const db = await getDb();
  const k = Number.isInteger(topK) && topK > 0 ? Math.min(topK, 100) : 8;
  const [qvec] = await embed([queryText]);
  const lit = toVectorLiteral(qvec);
  const res = await db.query(
    `SELECT source_id, content, 1 - (embedding <=> $1) AS score
       FROM chunks
      WHERE kb_id = $2
      ORDER BY embedding <=> $1
      LIMIT $3`,
    [lit, kbId, k],
  );
  return res.rows.map((r) => ({
    sourceId: r.source_id,
    chunk: r.content,
    score: Math.max(0, Math.min(1, Number(r.score))),
  }));
}

/** Total chunk rows (diagnostics / health detail). */
export async function stats() {
  const db = await getDb();
  const r = await db.query('SELECT count(*)::int AS n FROM chunks');
  return { chunks: r.rows[0]?.n || 0 };
}
