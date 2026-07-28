// Encrypted per-user token store backed by the Node BUILTIN `node:sqlite`
// (no native npm module — clean on alpine, arm64 + amd64).
//
// Replaces the old plaintext data/users.json. The PingCode access/refresh
// token columns are encrypted at rest with AES-256-GCM; the key comes from the
// REQUIRED env var TOKEN_STORE_KEY (32 bytes, hex or base64) and the process
// fails LOUD at boot when it is missing or the wrong size.
//
// Call surface is intentionally identical to the old JSON TokenStore so the
// rest of the app doesn't change:
//   await store.get(mcpToken)      → { access_token, refresh_token, ... } | null
//   await store.set(mcpToken, obj) → upsert the full slot object
//   await store.delete(mcpToken)
//
// One-time migration: if a legacy users.json sits next to the DB (or is
// pointed at by TOKEN_STORE_PATH), its slots are imported, the import is
// verified row-by-row, and the JSON (plus any users.json.tmp) is DELETED —
// no .bak: plaintext refresh tokens must not survive on the volume.

import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CIPHER_TAG = 'gcm1'; // format version prefix for the encrypted columns

export function loadTokenStoreKey(raw = process.env.TOKEN_STORE_KEY) {
  const s = (raw || '').trim();
  if (!s) {
    throw new Error(
      'TOKEN_STORE_KEY is required: 32 bytes as hex (64 chars) or base64. ' +
      'Generate one with:  openssl rand -hex 32',
    );
  }
  let key = null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) key = Buffer.from(s, 'hex');
  else key = Buffer.from(s, 'base64');
  if (!key || key.length !== 32) {
    throw new Error(
      `TOKEN_STORE_KEY must decode to exactly 32 bytes (got ${key ? key.length : 0}). ` +
      'Use hex (64 chars, `openssl rand -hex 32`) or base64 (`openssl rand -base64 32`).',
    );
  }
  return key;
}

// TOKEN_STORE_PATH kept backward compatible: a legacy `.../users.json` value
// maps to a sibling users.db and that json becomes the migration source.
export function resolveStorePaths(storePath) {
  const p = storePath || '/data/users.db';
  if (p.endsWith('.json')) {
    return { dbPath: path.join(path.dirname(p), 'users.db'), legacyJsonPath: p };
  }
  return { dbPath: p, legacyJsonPath: path.join(path.dirname(p), 'users.json') };
}

// Columns with first-class meaning; anything else a caller stores on a slot
// object round-trips through extra_json.
//
// `pingcode_app_id` is the second half of the slot's identity: a slot is keyed
// by (USER, APP), not by user alone. A PingCode token is an artifact of ONE
// OAuth client registration, so recording which app minted it is what lets the
// shared, multi-tenant store REFUSE to serve a token from app A to a request
// running under app B (see PingCodeOAuth.slotFor).
const KNOWN_FIELDS = new Set([
  'access_token', 'refresh_token', 'expires_at', 'granted_at', 'created_at',
  'pingcode_user_id', 'pingcode_app_id',
]);

export class TokenStore {
  #db;
  #key;

  constructor(storePath, { key } = {}) {
    this.#key = key || loadTokenStoreKey(); // throws loud when missing/short
    const { dbPath, legacyJsonPath } = resolveStorePaths(storePath);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        mcp_token          TEXT PRIMARY KEY,
        access_token_enc   TEXT,
        refresh_token_enc  TEXT,
        expires_at         INTEGER,
        granted_at         INTEGER,
        created_at         INTEGER,
        pingcode_user_id   TEXT,
        pingcode_app_id    TEXT,
        extra_json         TEXT
      );
    `);
    this.#ensureColumns();
    this.#migrateLegacyJson(legacyJsonPath);
  }

  // ── schema migration (additive + idempotent) ────────────────────
  // A store created before slots were keyed by (user, app) has no
  // `pingcode_app_id` column. Add it in place — additive, idempotent, and it
  // leaves every existing row's value NULL, which PingCodeOAuth.slotFor treats
  // as "legacy, stamp it with the app in force on first use". No data is
  // rewritten here and nothing is dropped.
  #ensureColumns() {
    const have = new Set(
      this.#db.prepare('PRAGMA table_info(users)').all().map((r) => r.name),
    );
    if (!have.has('pingcode_app_id')) {
      this.#db.exec('ALTER TABLE users ADD COLUMN pingcode_app_id TEXT');
      console.log('[token-store] migrated schema: added users.pingcode_app_id (slots are keyed by user × app)');
    }
  }

  // ── crypto ──────────────────────────────────────────────────────
  #encrypt(plain) {
    if (plain === undefined || plain === null || plain === '') return null;
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.#key, iv);
    const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return [
      CIPHER_TAG,
      iv.toString('base64'),
      c.getAuthTag().toString('base64'),
      ct.toString('base64'),
    ].join(':');
  }

  #decrypt(stored) {
    if (stored === undefined || stored === null) return null;
    const [tag, ivB64, authB64, ctB64] = String(stored).split(':');
    if (tag !== CIPHER_TAG || !ivB64 || !authB64 || !ctB64) {
      throw new Error('token-store: unrecognized ciphertext format in users.db');
    }
    const d = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(ivB64, 'base64'));
    d.setAuthTag(Buffer.from(authB64, 'base64'));
    try {
      return Buffer.concat([d.update(Buffer.from(ctB64, 'base64')), d.final()]).toString('utf8');
    } catch {
      throw new Error(
        'token-store: decryption failed — TOKEN_STORE_KEY does not match the key ' +
        'this store was encrypted with',
      );
    }
  }

  // ── sync core (node:sqlite is synchronous) ──────────────────────
  #upsert(mcpToken, tokens) {
    const t = tokens || {};
    const extra = {};
    for (const [k, v] of Object.entries(t)) {
      if (!KNOWN_FIELDS.has(k)) extra[k] = v;
    }
    this.#db.prepare(`
      INSERT OR REPLACE INTO users
        (mcp_token, access_token_enc, refresh_token_enc, expires_at, granted_at,
         created_at, pingcode_user_id, pingcode_app_id, extra_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      mcpToken,
      this.#encrypt(t.access_token),
      this.#encrypt(t.refresh_token),
      t.expires_at ?? null,
      t.granted_at ?? null,
      t.created_at ?? null,
      t.pingcode_user_id ?? null,
      t.pingcode_app_id ?? null,
      Object.keys(extra).length ? JSON.stringify(extra) : null,
    );
  }

  #row(mcpToken) {
    return this.#db.prepare('SELECT * FROM users WHERE mcp_token = ?').get(mcpToken) ?? null;
  }

  // ── public surface (same shape the old JSON store exposed) ──────
  async get(mcpToken) {
    const row = this.#row(mcpToken);
    if (!row) return null;
    const extra = row.extra_json ? JSON.parse(row.extra_json) : {};
    return {
      ...extra,
      access_token: this.#decrypt(row.access_token_enc),
      refresh_token: this.#decrypt(row.refresh_token_enc),
      expires_at: row.expires_at,
      granted_at: row.granted_at,
      created_at: row.created_at,
      pingcode_user_id: row.pingcode_user_id,
      pingcode_app_id: row.pingcode_app_id,
    };
  }

  async set(mcpToken, tokens) {
    this.#upsert(mcpToken, tokens);
  }

  async delete(mcpToken) {
    this.#db.prepare('DELETE FROM users WHERE mcp_token = ?').run(mcpToken);
  }

  // ── one-time users.json → users.db migration ────────────────────
  #migrateLegacyJson(jsonPath) {
    if (!jsonPath) return;
    let txt;
    try {
      txt = fs.readFileSync(jsonPath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return; // nothing to migrate
      throw e;
    }
    // A parse/import failure throws (boot fails loud) and the JSON is kept —
    // never delete data we could not verifiably import.
    const data = JSON.parse(txt);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`token-store: ${jsonPath} is not an object map — refusing to migrate`);
    }
    const entries = Object.entries(data);
    for (const [mcpToken, tokens] of entries) this.#upsert(mcpToken, tokens);
    let verified = 0;
    for (const [mcpToken] of entries) if (this.#row(mcpToken)) verified++;
    if (verified !== entries.length) {
      throw new Error(
        `token-store: migration verify failed (${verified}/${entries.length} rows) — keeping ${jsonPath}`,
      );
    }
    // DURABILITY GATE — must run BEFORE the JSON is unlinked.
    // The verify above read the rows back through the WAL, which proves they
    // are visible to THIS connection, not that they are in the database file.
    // In WAL mode the inserts live in `users.db-wal` until a checkpoint; a
    // power cut between the unlink and the next checkpoint would take the -wal
    // with it and lose slots we had just declared "migrated" — while the only
    // other copy had already been deleted. Force the WAL into the main file and
    // require proof it fully landed; anything else keeps the JSON.
    const ck = this.#db.prepare('PRAGMA wal_checkpoint(FULL)').get() || {};
    const { busy, log, checkpointed } = ck;
    if (busy !== 0 || typeof log !== 'number' || checkpointed !== log) {
      throw new Error(
        `token-store: WAL checkpoint did not fully land ` +
        `(busy=${busy}, log=${log}, checkpointed=${checkpointed}) — keeping ${jsonPath}. ` +
        'Restart with no other process holding the store open.',
      );
    }
    // Verified AND durable: remove the plaintext file AND any atomic-write
    // leftover. Deliberately NO .bak — plaintext refresh tokens must not
    // survive on the volume (it is never reaped).
    fs.rmSync(jsonPath);
    fs.rmSync(`${jsonPath}.tmp`, { force: true });
    console.log(
      `[token-store] migrated ${entries.length} slot(s) from ${jsonPath} into SQLite (encrypted); plaintext JSON deleted`,
    );
  }
}
