/**
 * embeddings.mjs — text → vector.
 *
 * Two backends, selected by env:
 *   • REAL: an OpenAI-COMPATIBLE embeddings API (OpenAI, Azure, or any
 *     drop-in like a local text-embeddings-inference server). Batched.
 *   • FAKE: a deterministic, dependency-free hashing embedder used for
 *     offline boot + the smoke test. Lexically-overlapping text lands in the
 *     same hash buckets → higher cosine similarity, so nearest-neighbour
 *     ranking is meaningful WITHOUT any external API or API key.
 *
 * The active backend fixes EMBED_DIM (real=1536, fake=64) — the DB schema's
 * `vector(EMBED_DIM)` is derived from this single constant so they never drift.
 */

import { createHash } from 'node:crypto';

const FAKE_DIM = 64;
const REAL_DIM = Number(process.env.EMBED_DIM_REAL) || 1536; // text-embedding-3-small = 1536

const API_URL = (process.env.EMBEDDINGS_API_URL || 'https://api.openai.com/v1/embeddings').trim();
const API_KEY = (process.env.EMBEDDINGS_API_KEY || '').trim();
const MODEL = (process.env.EMBEDDINGS_MODEL || 'text-embedding-3-small').trim();

// Use the fake embedder when explicitly requested OR when no API key is set,
// so the sidecar always boots and works offline.
export const USE_FAKE = process.env.EMBEDDINGS_FAKE === '1' || !API_KEY;

/** Dimension of the ACTIVE embedder — drives the vector(N) column width. */
export const EMBED_DIM = USE_FAKE ? FAKE_DIM : REAL_DIM;

/** Split text into lowercase word tokens for the hashing embedder. */
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Deterministic hashing embedder (feature hashing / "hashing trick").
 * Each token is hashed to a bucket in [0, FAKE_DIM); its count accumulates
 * there. The vector is L2-normalized so cosine similarity is well-defined and
 * lexical overlap → high similarity. Fully deterministic (sha256-based).
 */
function fakeEmbed(text) {
  const v = new Array(FAKE_DIM).fill(0);
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    // Non-zero fallback so an all-empty doc still yields a valid unit vector
    // (avoids a divide-by-zero → NaN vector that pgvector rejects).
    v[0] = 1;
    return v;
  }
  for (const tok of tokens) {
    const h = createHash('sha256').update(tok).digest();
    const bucket = h.readUInt32BE(0) % FAKE_DIM;
    // Sign from a second byte so distinct tokens can partially cancel — spreads
    // vectors out a little instead of every count being strictly additive.
    const sign = (h[4] & 1) === 0 ? 1 : -1;
    v[bucket] += sign;
  }
  // L2 normalize
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < FAKE_DIM; i++) v[i] /= norm;
  return v;
}

/** Call the OpenAI-compatible embeddings API for a batch of inputs. */
async function realEmbedBatch(texts) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`embeddings API ${res.status}: ${detail.slice(0, 300)}`);
  }
  const json = await res.json();
  const data = Array.isArray(json?.data) ? json.data : [];
  if (data.length !== texts.length) {
    throw new Error(`embeddings API returned ${data.length} vectors for ${texts.length} inputs`);
  }
  // Preserve input order (OpenAI returns an `index` per item).
  const out = new Array(texts.length);
  for (const item of data) out[item.index] = item.embedding;
  return out;
}

const REAL_BATCH = 128;

/**
 * embed(texts[]) → Promise<number[][]> — one vector per input, order-preserving.
 * Uses the fake embedder when USE_FAKE, else batches the real API.
 */
export async function embed(texts) {
  const arr = Array.isArray(texts) ? texts : [texts];
  if (arr.length === 0) return [];
  if (USE_FAKE) return arr.map(fakeEmbed);

  const out = [];
  for (let i = 0; i < arr.length; i += REAL_BATCH) {
    const batch = arr.slice(i, i + REAL_BATCH);
    // eslint-disable-next-line no-await-in-loop
    const vecs = await realEmbedBatch(batch);
    out.push(...vecs);
  }
  return out;
}

/** pgvector literal for a numeric array: '[0.1,0.2,...]'. */
export function toVectorLiteral(vec) {
  return `[${vec.join(',')}]`;
}
