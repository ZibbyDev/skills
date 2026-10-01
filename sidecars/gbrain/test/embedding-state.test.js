import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { embeddingState, withEmbedding } = await import('../brain.js');

test('a vector brain serves lexical search without a key; only missing vectors are stale', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gbrain-embedding-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const brain = join(root, 'brain');
  await mkdir(join(brain, 'adapter'), { recursive: true });

  await writeFile(join(brain, 'adapter', 'embedding.json'), JSON.stringify({ embeddings: true }));
  assert.deepEqual(await withEmbedding({ GBRAIN_NO_EMBEDDING: '1' }, () => embeddingState(brain)),
    { mode: 'lexical', stale: false });
  assert.deepEqual(await withEmbedding({ GBRAIN_NO_EMBEDDING: '0', GBRAIN_EMBEDDING: '1' }, () => embeddingState(brain)),
    { mode: 'vector', stale: false });

  await writeFile(join(brain, 'adapter', 'embedding.json'), JSON.stringify({ embeddings: false }));
  assert.deepEqual(await withEmbedding({ GBRAIN_NO_EMBEDDING: '0', GBRAIN_EMBEDDING: '1' }, () => embeddingState(brain)),
    { mode: 'lexical', stale: true });
});
