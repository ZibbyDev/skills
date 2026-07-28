// Encrypted token store: crypto round-trip, tamper detection, key handling,
// and the users.json → users.db migration (including the durability gate that
// must run before the plaintext JSON is deleted).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { TokenStore, loadTokenStoreKey, resolveStorePaths } from '../src/token-store.js';

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcstore-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── key loading ───────────────────────────────────────────────────
test('loadTokenStoreKey accepts hex and base64, rejects missing/short', () => {
  const raw = randomBytes(32);
  assert.deepEqual(loadTokenStoreKey(raw.toString('hex')), raw);
  assert.deepEqual(loadTokenStoreKey(raw.toString('base64')), raw);
  assert.throws(() => loadTokenStoreKey(''), /TOKEN_STORE_KEY is required/);
  assert.throws(() => loadTokenStoreKey(undefined), /TOKEN_STORE_KEY is required/);
  assert.throws(() => loadTokenStoreKey(randomBytes(16).toString('hex')), /exactly 32 bytes/);
});

test('resolveStorePaths maps a legacy users.json to a sibling users.db', () => {
  assert.deepEqual(resolveStorePaths('/data/users.json'), {
    dbPath: '/data/users.db', legacyJsonPath: '/data/users.json',
  });
  assert.deepEqual(resolveStorePaths('/data/users.db'), {
    dbPath: '/data/users.db', legacyJsonPath: '/data/users.json',
  });
});

// ── crypto ────────────────────────────────────────────────────────
test('encrypt/decrypt round-trips a slot, including unknown fields', async (t) => {
  const dir = tmpdir(t);
  const store = new TokenStore(path.join(dir, 'users.db'), { key: KEY });
  const slot = {
    access_token: 'at-secret',
    refresh_token: 'rt-secret',
    expires_at: 123, granted_at: 456, created_at: 789,
    pingcode_user_id: 'user-alice',
    some_future_field: { nested: true }, another: 'x',
  };
  await store.set('mcp_a', slot);
  assert.deepEqual(await store.get('mcp_a'), slot);
  assert.equal(await store.get('mcp_missing'), null);

  await store.delete('mcp_a');
  assert.equal(await store.get('mcp_a'), null);
});

test('tokens are NOT stored in plaintext on disk', async (t) => {
  const dir = tmpdir(t);
  const dbPath = path.join(dir, 'users.db');
  const store = new TokenStore(dbPath, { key: KEY });
  await store.set('mcp_a', { access_token: 'at-secret', refresh_token: 'rt-secret' });
  // Force the WAL into the main file so we scan everything that exists.
  new DatabaseSync(dbPath).prepare('PRAGMA wal_checkpoint(FULL)').get();
  const onDisk = fs.readdirSync(dir)
    .map((f) => fs.readFileSync(path.join(dir, f)))
    .map((b) => b.toString('latin1')).join('');
  assert.ok(!onDisk.includes('at-secret'), 'access token absent from disk');
  assert.ok(!onDisk.includes('rt-secret'), 'refresh token absent from disk');
});

test('a WRONG key cannot read the store', async (t) => {
  const dir = tmpdir(t);
  const dbPath = path.join(dir, 'users.db');
  await new TokenStore(dbPath, { key: KEY }).set('mcp_a', { access_token: 'at', refresh_token: 'rt' });
  const wrong = new TokenStore(dbPath, { key: OTHER_KEY });
  await assert.rejects(() => wrong.get('mcp_a'), /decryption failed/);
});

test('TAMPERED ciphertext throws instead of returning garbage', async (t) => {
  const dir = tmpdir(t);
  const dbPath = path.join(dir, 'users.db');
  const store = new TokenStore(dbPath, { key: KEY });
  await store.set('mcp_a', { access_token: 'at', refresh_token: 'rt' });

  // Flip a byte inside the base64 ciphertext (GCM auth tag must catch it).
  const raw = new DatabaseSync(dbPath);
  const cur = raw.prepare('SELECT access_token_enc FROM users WHERE mcp_token = ?').get('mcp_a');
  const parts = cur.access_token_enc.split(':');
  const ct = Buffer.from(parts[3], 'base64');
  ct[0] ^= 0xff;
  parts[3] = ct.toString('base64');
  raw.prepare('UPDATE users SET access_token_enc = ? WHERE mcp_token = ?').run(parts.join(':'), 'mcp_a');
  raw.close();

  await assert.rejects(() => store.get('mcp_a'), /decryption failed/);

  // A structurally unrecognisable value is rejected too, not silently ignored.
  const raw2 = new DatabaseSync(dbPath);
  raw2.prepare('UPDATE users SET access_token_enc = ? WHERE mcp_token = ?').run('plaintext!', 'mcp_a');
  raw2.close();
  await assert.rejects(() => store.get('mcp_a'), /unrecognized ciphertext format/);
});

// ── migration ─────────────────────────────────────────────────────
test('migration imports users.json, deletes it, and preserves unknown fields', async (t) => {
  const dir = tmpdir(t);
  const jsonPath = path.join(dir, 'users.json');
  const legacy = {
    mcp_one: {
      access_token: 'at1', refresh_token: 'rt1',
      expires_at: 111, granted_at: 222, created_at: 333,
      pingcode_user_id: 'user-alice',
      legacy_extra: 'keep me', nested: { a: 1 },
    },
    mcp_two: { access_token: 'at2', refresh_token: 'rt2' },
  };
  fs.writeFileSync(jsonPath, JSON.stringify(legacy));
  fs.writeFileSync(`${jsonPath}.tmp`, '{}'); // atomic-write leftover

  const store = new TokenStore(jsonPath, { key: KEY });   // legacy path form

  assert.ok(!fs.existsSync(jsonPath), 'plaintext users.json deleted');
  assert.ok(!fs.existsSync(`${jsonPath}.tmp`), 'leftover .tmp deleted');
  assert.ok(!fs.existsSync(`${jsonPath}.bak`), 'no plaintext .bak left behind');
  assert.ok(fs.existsSync(path.join(dir, 'users.db')), 'sibling users.db created');

  assert.deepEqual(await store.get('mcp_one'), legacy.mcp_one);
  assert.deepEqual(await store.get('mcp_two'), {
    ...legacy.mcp_two,
    expires_at: null, granted_at: null, created_at: null, pingcode_user_id: null,
  });
});

test('migrated rows are CHECKPOINTED into the db file before the JSON is deleted', async (t) => {
  // FIX 2: the verify read goes through the WAL, so it proves visibility, not
  // durability. Deleting the only other copy while the rows live solely in the
  // -wal loses them to a power cut. Assert the rows are readable from the main
  // database file with the -wal/-shm removed.
  const dir = tmpdir(t);
  const jsonPath = path.join(dir, 'users.json');
  const dbPath = path.join(dir, 'users.db');
  fs.writeFileSync(jsonPath, JSON.stringify({ mcp_one: { access_token: 'at1', refresh_token: 'rt1' } }));

  new TokenStore(jsonPath, { key: KEY }); // migrates + checkpoints + deletes json
  assert.ok(!fs.existsSync(jsonPath));

  // Simulate a crash: drop the WAL sidecars entirely, then reopen.
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });

  const reopened = new TokenStore(dbPath, { key: KEY });
  const slot = await reopened.get('mcp_one');
  assert.equal(slot?.access_token, 'at1', 'migrated slot survived losing the WAL');
});

test('a malformed users.json is NOT deleted — boot fails loud instead', async (t) => {
  const dir = tmpdir(t);
  const jsonPath = path.join(dir, 'users.json');
  fs.writeFileSync(jsonPath, '["not", "a", "map"]');
  assert.throws(() => new TokenStore(jsonPath, { key: KEY }), /refusing to migrate/);
  assert.ok(fs.existsSync(jsonPath), 'data we could not import is kept');
});

test('no users.json is a no-op', async (t) => {
  const dir = tmpdir(t);
  const store = new TokenStore(path.join(dir, 'users.db'), { key: KEY });
  assert.equal(await store.get('anything'), null);
});
