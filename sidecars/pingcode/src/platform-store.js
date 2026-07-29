// Token store backed by the PLATFORM's Stores-v2 `sqlite` store, not a private
// file in this container.
//
// WHY: a store is a first-class Zibby resource — it shows up on the Storage &
// Database page, the operator can see and manage it, and its lifecycle is the
// platform's problem rather than a docker volume nobody can see. gbrain's
// knowledge base works exactly this way; this makes the PingCode token store
// consistent with it instead of being the one lego that hides its data.
//
// WHAT THE STORE HOLDS: one row per authorized user. The credential COLUMNS are
// encrypted by this process before the write (AES-256-GCM, key from
// TOKEN_STORE_KEY, which stays in the sidecar's env and never enters the
// store). So the row is a durable, inspectable record while the values in it
// are not usable by anything that can read the table — which matters here
// because a store is readable through the platform's SQL viewer by design.
//
// PER-AGENT ISOLATION: the store id arrives per request (the declaring agent's
// `ZIBBY_STORE__oauth_tokens`), so two deployed PingCode agents get two
// different stores and never see each other's authorizations — the same shape
// as gbrain's per-kbId isolation.
//
// The call surface is byte-identical to the file-backed TokenStore
// (`get`/`set`/`delete`), so nothing upstream changes.

import { encryptValue, decryptValue } from './token-crypto.js';

const TABLE = 'oauth_tokens';

// One statement, run before first use. `IF NOT EXISTS` makes it idempotent, so
// there is no separate migration step to keep in sync.
const CREATE_SQL = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  mcp_token TEXT PRIMARY KEY,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  expires_at INTEGER,
  granted_at INTEGER,
  created_at INTEGER,
  pingcode_user_id TEXT,
  pingcode_app_id TEXT,
  extra_json TEXT
)`;

/**
 * A token store that talks to the control-plane datasets API.
 *
 * @param {Object} args
 * @param {string} args.apiBase   control-plane base url (e.g. http://control-plane:3001)
 * @param {string} args.apiToken  the PAT the sidecar authenticates with
 * @param {string} args.storeId   the store this agent owns (ZIBBY_STORE__oauth_tokens)
 * @param {Buffer} args.key       32-byte column-encryption key
 */
export class PlatformTokenStore {
  #apiBase; #apiToken; #storeId; #key; #ready;

  constructor({ apiBase, apiToken, storeId, key }) {
    if (!apiBase) throw new Error('PlatformTokenStore: apiBase is required');
    if (!apiToken) throw new Error('PlatformTokenStore: apiToken is required');
    if (!storeId) throw new Error('PlatformTokenStore: storeId is required (ZIBBY_STORE__oauth_tokens)');
    this.#apiBase = String(apiBase).replace(/\/+$/, '');
    this.#apiToken = apiToken;
    this.#storeId = storeId;
    this.#key = key;
    this.#ready = null;
  }

  async #sql(sql, params = []) {
    const res = await fetch(`${this.#apiBase}/datasets/stores/${encodeURIComponent(this.#storeId)}/sql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.#apiToken}` },
      body: JSON.stringify({ sql, params }),
    });
    if (!res.ok) {
      // Never echo the body verbatim — it can carry the row values back.
      throw new Error(`store sql failed: HTTP ${res.status}`);
    }
    const j = await res.json().catch(() => ({}));
    // The datasets API answers POSITIONALLY — `{columns:[name…], rows:[[v…]]}`.
    // Zip it back into objects here so callers read columns by NAME and a future
    // column added to the SELECT can't silently shift every value by one.
    const rows = Array.isArray(j.rows) ? j.rows : [];
    const cols = Array.isArray(j.columns) ? j.columns : [];
    if (!cols.length) return [];
    return rows.map((r) => (Array.isArray(r)
      ? Object.fromEntries(cols.map((c, i) => [c, r[i]]))
      : r));
  }

  // Create-if-absent, once per process. Awaited by every public call so a cold
  // start can't race a write against a missing table.
  #ensure() {
    if (!this.#ready) this.#ready = this.#sql(CREATE_SQL);
    return this.#ready;
  }

  #enc(v) { return v == null ? null : encryptValue(this.#key, String(v)); }
  #dec(v) { return v == null ? null : decryptValue(this.#key, String(v)); }

  async get(mcpToken) {
    await this.#ensure();
    const rows = await this.#sql(`SELECT * FROM ${TABLE} WHERE mcp_token = ?`, [mcpToken]);
    const row = rows[0];
    if (!row) return null;
    const extra = row.extra_json ? JSON.parse(row.extra_json) : {};
    return {
      ...extra,
      access_token: this.#dec(row.access_token_enc),
      refresh_token: this.#dec(row.refresh_token_enc),
      expires_at: row.expires_at,
      granted_at: row.granted_at,
      created_at: row.created_at,
      pingcode_user_id: row.pingcode_user_id,
      pingcode_app_id: row.pingcode_app_id,
    };
  }

  async set(mcpToken, tokens) {
    await this.#ensure();
    const t = tokens || {};
    // Unknown fields round-trip through extra_json, exactly like the file store,
    // so a future field added upstream is never silently dropped.
    const known = new Set([
      'access_token', 'refresh_token', 'expires_at', 'granted_at', 'created_at',
      'pingcode_user_id', 'pingcode_app_id',
    ]);
    const extra = Object.fromEntries(Object.entries(t).filter(([k]) => !known.has(k)));
    await this.#sql(
      `INSERT INTO ${TABLE}
         (mcp_token, access_token_enc, refresh_token_enc, expires_at, granted_at,
          created_at, pingcode_user_id, pingcode_app_id, extra_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mcp_token) DO UPDATE SET
         access_token_enc = excluded.access_token_enc,
         refresh_token_enc = excluded.refresh_token_enc,
         expires_at = excluded.expires_at,
         granted_at = excluded.granted_at,
         created_at = excluded.created_at,
         pingcode_user_id = excluded.pingcode_user_id,
         pingcode_app_id = excluded.pingcode_app_id,
         extra_json = excluded.extra_json`,
      [
        mcpToken,
        this.#enc(t.access_token),
        this.#enc(t.refresh_token),
        t.expires_at ?? null,
        t.granted_at ?? null,
        t.created_at ?? null,
        t.pingcode_user_id ?? null,
        t.pingcode_app_id ?? null,
        Object.keys(extra).length ? JSON.stringify(extra) : null,
      ],
    );
  }

  async delete(mcpToken) {
    await this.#ensure();
    await this.#sql(`DELETE FROM ${TABLE} WHERE mcp_token = ?`, [mcpToken]);
  }
}
