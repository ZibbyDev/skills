/**
 * datasetStore.js — durable, queryable structured-artifact store skill.
 *
 * WHAT IT IS
 * ──────────
 * A hand-written multi-tool skill (same shape as kvMemory.js / reviewMemory.js /
 * github.js): `serverName`, `allowedTools`, `tools[]`, `handleToolCall`, and a
 * `resolve()` that spawns the GENERIC bin/mcp-skill.mjs. Unlike kv-memory (a
 * key→value MEMORY for picking up where a prior run left off), this is a durable
 * STRUCTURED-RECORD store: an agent appends arbitrary JSON records to a named
 * store and later runs SQL-style queries/aggregations over them — e.g. to
 * accumulate metrics across runs and produce a report.
 *
 * STORES v2 — NAME-BASED RESOLUTION (the shared contract)
 * ────────────────────────────────────────────────────────
 * Stores are auto-provisioned at DEPLOY and resolved at runtime BY NAME via env:
 *   - The run carries one `ZIBBY_STORE__<name> = <storeId>` per bound store.
 *   - The agent reads the injected "AVAILABLE STORES" prompt catalog (name +
 *     description), picks one, and passes the chosen logical `name` to the tool.
 *   - This name→storeId env map is BOTH the allowlist AND the resolver: the
 *     agent can only ever write to a declared/bound name (anti-fragmentation).
 *
 * BACKEND (already built — NO change here)
 * ─────────────────────────────────────────
 * Two routes on the SAME base URL kv-memory uses (getAccountApiUrl(), prod
 * https://api-prod.zibby.app), authed with the SAME Bearer project token
 * (getSessionToken()):
 *   - POST {base}/datasets/stores/{storeId}/append  body { record, agent }
 *       → { ok, id, ts }
 *   - POST {base}/datasets/stores/{storeId}/query   body { select?, where?,
 *       groupBy?, orderBy?, limit?, since?, until?, agent? }
 *       → { ok, rowCount, columns, rows }
 * Plus the per-type data routes on the same base: /sql (sqlite stores) and
 * /put /get /list /delete (file stores — blob storage by relative path).
 * The `storeId` lives in the URL path. Tenancy (account + project) is enforced
 * SERVER-SIDE from the Bearer token — the skill NEVER sends account/project.
 *
 * AUTOMATIC PER-AGENT TAGGING
 * ────────────────────────────
 * Appends default `agent` to the writing agent's namespace (WORKFLOW_TYPE,
 * falling back to the literal 'agent'), so records are auto-tagged with who
 * wrote them and `query`'s optional `agent` filter can scope to one writer.
 *
 * AUTH — identical to kvMemory.js / reviewMemory.js
 * ──────────────────────────────────────────────────
 * Calls ZIBBY'S OWN backend with PROJECT_API_TOKEN (Bearer) against
 * ZIBBY_ACCOUNT_API_URL (default api-prod.zibby.app). Mirrors
 * @zibby/core/backend-client.js getSessionToken()/getAccountApiUrl() rather than
 * importing a non-existent helper, so the auth model stays identical.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the generic skill MCP server binary — identical rationale to
 * kvMemory.js resolveSkillBin(): derive from import.meta.url so it works in
 * src/ (dev), dist/ (bundled), and node_modules/@zibby/skills/ (published).
 */
function resolveSkillBin() {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

/**
 * The run's backend credential. Mirrors @zibby/core/backend-client.js
 * getSessionToken(): prefer the Fargate-injected PROJECT_API_TOKEN, then the
 * dev ZIBBY_USER_TOKEN, then the local CLI session.
 */
function getSessionToken() {
  if (process.env.PROJECT_API_TOKEN) return process.env.PROJECT_API_TOKEN;
  if (process.env.ZIBBY_USER_TOKEN) return process.env.ZIBBY_USER_TOKEN;
  try {
    const p = join(homedir(), '.zibby', 'config.json');
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8')).sessionToken || null;
  } catch {
    return null;
  }
}

/**
 * Account API base URL. Mirrors backend-client.js getAccountApiUrl():
 * explicit ZIBBY_ACCOUNT_API_URL (dev/local → ngrok) wins; otherwise default
 * to the live prod host.
 */
function getAccountApiUrl() {
  if (process.env.ZIBBY_ACCOUNT_API_URL) return process.env.ZIBBY_ACCOUNT_API_URL.replace(/\/$/, '');
  const env = process.env.ZIBBY_ENV || 'prod';
  if (env === 'local') return 'http://localhost:3001';
  return process.env.ZIBBY_PROD_ACCOUNT_API_URL || 'https://api-prod.zibby.app';
}

/**
 * The per-agent namespace. WORKFLOW_TYPE is injected into every Fargate run;
 * fall back to the literal 'agent' so the skill never crashes outside a run.
 * Trimmed; an empty/whitespace-only value also falls back.
 */
function agentNamespace() {
  const wt = typeof process.env.WORKFLOW_TYPE === 'string' ? process.env.WORKFLOW_TYPE.trim() : '';
  return wt || 'agent';
}

/**
 * The run's bound-store map, derived from the `ZIBBY_STORE__<name>=<storeId>`
 * env injected at deploy/dispatch (one var per store the node declared). The
 * returned `{ <name>: <storeId> }` is BOTH the allowlist AND the resolver:
 *   - keys are the logical store NAMES the agent sees in "AVAILABLE STORES";
 *   - values are the opaque storeIds the backend addresses.
 * Empty values are skipped (an unbound placeholder must not become writable).
 * Pure, so handleToolCall can fast-fail BEFORE any network call.
 */
function storeMap() {
  const map: any = {};
  for (const [key, value] of Object.entries(process.env)) {
    const m = /^ZIBBY_STORE__(.+)$/.exec(key);
    if (!m) continue;
    const id = typeof value === 'string' ? value.trim() : '';
    if (!id) continue;
    map[m[1]] = id;
  }
  return map;
}

/**
 * Resolve a logical store NAME to its backend storeId against the bound map.
 * Returns `{ storeId, name }` on success or `{ error }` (a clear, agent-facing
 * message) — never throws. This is the anti-fragmentation guard: an agent can
 * ONLY ever address a store that was declared at deploy and bound into env.
 *   - name omitted + exactly one bound store → default to it
 *   - name omitted + multiple                → error, list the names to choose
 *   - name omitted + zero bound stores       → error, nothing to write to
 *   - name given but not bound               → error, list the available names
 */
// Stores the agent CREATES at runtime via `ensure_store` (name→storeId), merged
// into resolution so sqlite_exec/query/dataset tools can address them by name in
// the same run — WITHOUT any deploy-time ZIBBY_STORE__ declaration. ensure_store
// is idempotent, so re-ensuring the same name next run returns the same store.
const ensuredStores: any = {};

// Test-only: reset the per-process ensured-store cache between cases (in prod
// each Fargate run is a fresh process, so this is naturally clean per run).
export function __clearEnsuredStores() {
  for (const k of Object.keys(ensuredStores)) delete ensuredStores[k];
}

function resolveStore(store) {
  const map: any = { ...storeMap(), ...ensuredStores };
  const names = Object.keys(map);
  const requested = typeof store === 'string' ? store.trim() : '';
  if (!requested) {
    if (names.length === 1) return { storeId: map[names[0]], name: names[0] };
    if (names.length === 0) return { error: 'no stores bound to this agent' };
    return { error: `multiple stores are bound; pass \`store\` (one of: ${names.join(', ')})` };
  }
  if (!Object.prototype.hasOwnProperty.call(map, requested)) {
    return { error: `unknown store '${requested}'; available: ${names.join(', ')}` };
  }
  return { storeId: map[requested], name: requested };
}

/**
 * POST {base}/datasets/stores/{storeId}/{action} with `payload`. Addresses the
 * live store backend by the storeId resolved from a bound store name
 * (resolveStore). Tenancy is derived server-side from the Bearer token (the
 * skill never sends account/project). Throws a descriptive error on a non-2xx
 * so handleToolCall surfaces it.
 */
/**
 * POST {base}/datasets/stores/ensure — agent-driven, idempotent-by-name store
 * creation (scoped private to this agent via namespace = WORKFLOW_TYPE). Returns
 * { storeId, ... }. Tenancy is server-derived from the Bearer token.
 */
async function ensureStoreFetch(payload) {
  const session = getSessionToken();
  if (!session) {
    throw new Error('No backend credential (PROJECT_API_TOKEN). Stores are only available inside a Zibby run.');
  }
  const res = await fetch(`${getAccountApiUrl()}/datasets/stores/ensure`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ensure_store failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function storeFetch(storeId, action, payload) {
  const session = getSessionToken();
  if (!session) {
    throw new Error('No backend credential (PROJECT_API_TOKEN). Dataset store is only available inside a Zibby run.');
  }
  const url = `${getAccountApiUrl()}/datasets/stores/${encodeURIComponent(storeId)}/${action}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Store ${action} failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

// ── large-file (presigned direct-to-S3) path ─────────────────────────────────
// The base64-in-JSON put/get above caps at 4 MiB of RAW bytes (MAX_FILE_BYTES) —
// content travels inside the JSON body through the cloud Lambda proxy whose hard
// payload ceiling is 6 MB. The STORAGE (S3/MinIO) holds up to 5 TB/object, so
// that 4 MiB is a TRANSPORT limit, not a storage one. For bigger files we mint a
// short-lived presigned S3 URL (put-url/get-url) and transfer the object
// DIRECTLY to/from the store, bypassing the JSON/Lambda envelope entirely. The
// server derives the tenant-scoped S3 key from the resolved storeId + validated
// path, so a presigned URL can only ever touch THIS tenant's file. On self-host
// the backend signs against S3_PUBLIC_ENDPOINT so the URL is reachable outside
// the docker network; on cloud it's a normal S3 presign. Transparent to the
// agent — file_put/file_get just no longer fail at 4 MiB.

// Cut over to the presigned path above this many RAW bytes. Kept safely under
// the 4 MiB base64 cap (a bit of JSON-envelope headroom) so a base64 put never
// 413s: files ≤ this keep the byte-identical base64 path, larger ones go direct.
const LARGE_FILE_THRESHOLD = Math.floor(3.5 * 1024 * 1024); // 3.5 MiB

/**
 * Upload raw bytes to a file store via a presigned PUT (direct to S3/MinIO).
 * Requests a put-url (server-derived tenant key), then PUTs the bytes with the
 * EXACT Content-Type the server signed (SigV4 covers that header). Returns a
 * result shaped like the small-file put ({ ok, path, size, contentType }).
 */
async function putViaPresign(storeId, path, bytes, contentType) {
  const meta: any = await storeFetch(storeId, 'put-url', { path, contentType });
  if (!meta?.url) throw new Error('put-url did not return an upload URL');
  const res = await fetch(meta.url, {
    method: meta.method || 'PUT',
    headers: meta.headers || { 'Content-Type': contentType },
    body: bytes,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`direct upload failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return {
    ok: true,
    path: meta.path || path,
    size: bytes.length,
    contentType: meta.contentType || contentType,
    via: 'presign',
  };
}

/**
 * Download a file store object via a presigned GET (direct from S3/MinIO).
 * Used as the fallback when the inline base64 get hits the 4 MiB read cap (413).
 * Returns the raw bytes + the object's Content-Type.
 */
async function getViaPresign(storeId, path) {
  const meta: any = await storeFetch(storeId, 'get-url', { path });
  if (!meta?.url) throw new Error('get-url did not return a download URL');
  const res = await fetch(meta.url, { method: meta.method || 'GET' });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`direct download failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const ab = await res.arrayBuffer();
  return { buf: Buffer.from(ab), contentType: res.headers.get('content-type') || 'application/octet-stream' };
}

export const datasetStoreSkill: any = {
  id: 'dataset-store',
  // Backend-calling: the MCP child talks to Zibby's own backend — the
  // session-env contract is guaranteed by backendSession.ts at registration
  // (declare ONCE here; see backend-session-env-contract.test.ts).
  callsBackend: true,
  serverName: 'dataset_store',
  allowedTools: ['mcp__dataset_store__*'],
  description: 'Dataset store — a durable, queryable store for structured JSON records; append rows now, run SQL-style aggregations/reports later',

  promptFragment: `## Dataset Store (durable, queryable structured-record store)
You have one or more durable stores for STRUCTURED records that survive across
your stateless runs. Unlike key-value memory (for picking up where you left
off), this is for accumulating DATA you want to QUERY and AGGREGATE later — e.g.
per-run metrics, processed items, findings — and turn into a report.

Your bound stores are listed in the "AVAILABLE STORES" block below (each with a
name + description). Pick one BY DESCRIPTION and pass its \`store\` NAME (e.g.
"scorecards") to the tools — NOT an id. If exactly one store is bound you may
omit \`store\` and it defaults to that one. You can ONLY write to a bound store
name; any other name is rejected. Each appended record is an arbitrary JSON
object, auto-tagged with YOUR agent type so you can later filter to your writes.

There are THREE kinds of bound store (shown as TYPE in AVAILABLE STORES):
• dataset — append-only structured records you QUERY/AGGREGATE later (analytics).
• sqlite  — a real, MUTABLE relational database (a SQLite file per store): CREATE
  TABLE on the fly, INSERT/UPDATE/DELETE, SELECT. Schema + data persist across
  runs. Use this when you need to UPDATE rows / track changing state (e.g. a
  queue with a status column), not just append.
• file    — arbitrary FILE/BLOB storage addressed by relative path: stash raw
  JSON dumps, CSVs, images, snapshots as-is and fetch them back in later runs.
  Use this when the data is a document/blob, not rows.

You can also CREATE your own store on demand (no deploy needed) with
ensure_store — e.g. an agent that needs a private sqlite DB to track drafts/
state creates it at the start of the run and reuses it every run.

Tools:
- ensure_store: Create/reuse a store ON DEMAND for this agent (idempotent by
  name). Use when you need a store not bound at deploy. Then use its name with
  the tools below.
- dataset_append: (dataset stores) Append ONE structured JSON \`record\`.
- dataset_query: (dataset stores) SQL-style select/aggregate over appended records.
- sqlite_exec: (sqlite stores) Run SQL that CHANGES data — CREATE TABLE / INSERT /
  UPDATE / DELETE (one or more statements). Idempotent DDL: use CREATE TABLE IF
  NOT EXISTS. Returns { rowsModified, wrote }.
- sqlite_query: (sqlite stores) Run a SELECT (optionally with \`params\` for safe
  binding). Returns { columns, rows }. Read-only — never changes data.
- file_put: (file stores) Write/overwrite ONE file at a relative path (text or
  base64 binary). Large files are supported — they upload directly to storage,
  no size limit you need to worry about.
- file_get: (file stores) Read a file back (text returned as text, binary as
  base64). Large files download directly from storage; the content still comes
  back inline.
- file_list: (file stores) List stored files (optionally by path prefix).
- file_delete: (file stores) Delete ONE file by path.
Pick the tool that matches the store's TYPE; using a dataset tool on a sqlite
store (or a file tool on either, etc.) is rejected.`,

  resolve() {
    // Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs) pointing at this
    // module's datasetStoreSkill export — same FIXED pattern as kvMemory/
    // reviewMemory/github (NEVER return { command: null }). The module arg
    // resolves relative to bin/ at runtime → ../dist/datasetStore.js in a
    // published install.
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env: {}, description: this.description };
    // Forward the backend-auth env + WORKFLOW_TYPE the spawned MCP process needs
    // (the skill's fetch + namespace helpers read these). resolve() runs in the
    // agent process where the workflow-executor has set them.
    const env: any = {};
    for (const key of [
      'PROJECT_API_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_ENV', 'ZIBBY_PROD_ACCOUNT_API_URL', 'ZIBBY_USER_TOKEN',
      // The namespace source. Forwarded only when set; absent → 'agent' fallback.
      'WORKFLOW_TYPE',
    ]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    // Forward EVERY bound-store mapping (ZIBBY_STORE__<name>=<storeId>) so the
    // spawned MCP process can resolve store names → ids. A node without `stores`
    // has none → the map is empty → the tools report "no stores bound".
    for (const key of Object.keys(process.env)) {
      if (/^ZIBBY_STORE__.+$/.test(key) && process.env[key]) env[key] = process.env[key];
    }
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/datasetStore.js', 'datasetStoreSkill'],
      env,
      description: this.description,
      // Opt-in capability: a node requests it via skills:[...]. Unlike
      // kv-memory (alwaysLoad), this is NOT auto-loaded — only nodes that
      // declare it get its tools.
      alwaysLoad: false,
    };
  },

  async handleToolCall(name, args) {
    try {
      switch (name) {
        case 'dataset_append': {
          if (args?.record == null || typeof args.record !== 'object' || Array.isArray(args.record)) {
            return JSON.stringify({ error: 'record is required (a JSON object)' });
          }
          // Resolve the logical store NAME → storeId via the bound env map. The
          // map is the allowlist: an unbound name is rejected BEFORE any call.
          const target = resolveStore(args?.store);
          if (target.error) return JSON.stringify({ error: target.error });
          const agent = typeof args?.agent === 'string' && args.agent.trim() ? args.agent.trim() : agentNamespace();
          const payload: any = { record: args.record, agent };
          // `description` is informational (the store already exists from
          // deploy) — accepted + passed through when present, never required.
          if (typeof args?.description === 'string' && args.description.trim()) {
            payload.description = args.description.trim();
          }
          const data = await storeFetch(target.storeId, 'append', payload);
          return JSON.stringify({ ...data, store: target.name, storeId: target.storeId });
        }

        case 'dataset_query': {
          const target = resolveStore(args?.store);
          if (target.error) return JSON.stringify({ error: target.error });
          // Pass the DSL straight through; the backend validates it. Only
          // forward keys that were actually provided.
          const payload: any = {};
          for (const key of ['select', 'where', 'groupBy', 'orderBy', 'limit', 'since', 'until', 'agent']) {
            if (args?.[key] != null) payload[key] = args[key];
          }
          const data = await storeFetch(target.storeId, 'query', payload);
          return JSON.stringify({ ...data, store: target.name, storeId: target.storeId });
        }

        case 'ensure_store': {
          // Create (or reuse) a store ON DEMAND for this agent. Idempotent by
          // name + this agent's namespace, so the SAME store comes back across
          // runs. Caches name→storeId so subsequent tool calls resolve it.
          const name = typeof args?.name === 'string' ? args.name.trim() : '';
          if (!name) return JSON.stringify({ error: 'name is required' });
          const type = (typeof args?.type === 'string' && args.type.trim()) ? args.type.trim().toLowerCase() : 'sqlite';
          const description = typeof args?.description === 'string' ? args.description.trim() : '';
          const data = await ensureStoreFetch({ name, type, description, namespace: agentNamespace() });
          if (data?.storeId) ensuredStores[name] = data.storeId;
          return JSON.stringify({ ...data, store: name });
        }

        case 'file_put': {
          const target = resolveStore(args?.store);
          if (target.error) return JSON.stringify({ error: target.error });
          if (typeof args?.path !== 'string' || !args.path.trim()) {
            return JSON.stringify({ error: 'path is required (a relative file path like "reports/2026-07.json")' });
          }
          const hasText = typeof args?.content === 'string';
          const hasB64 = typeof args?.contentBase64 === 'string' && args.contentBase64.length > 0;
          if (!hasText && !hasB64) {
            return JSON.stringify({ error: 'content (text) or contentBase64 (base64 bytes) is required' });
          }
          const putPath = args.path.trim();
          const explicitCt = (typeof args?.contentType === 'string' && args.contentType.trim()) ? args.contentType.trim() : '';
          // Size the raw payload: files over LARGE_FILE_THRESHOLD go via a
          // presigned PUT DIRECTLY to S3/MinIO (no 4 MiB envelope cap); smaller
          // ones keep the byte-identical base64-in-JSON request below.
          const bytes = hasText
            ? Buffer.from(args.content, 'utf8')
            : Buffer.from(String(args.contentBase64).replace(/\s+/g, ''), 'base64');
          if (bytes.length > LARGE_FILE_THRESHOLD) {
            const contentType = explicitCt || (hasText ? 'text/plain; charset=utf-8' : 'application/octet-stream');
            const data = await putViaPresign(target.storeId, putPath, bytes, contentType);
            return JSON.stringify({ ...data, store: target.name, storeId: target.storeId });
          }
          const payload: any = { path: putPath };
          if (hasText) payload.content = args.content; else payload.contentBase64 = args.contentBase64;
          if (explicitCt) payload.contentType = explicitCt;
          const data = await storeFetch(target.storeId, 'put', payload);
          return JSON.stringify({ ...data, store: target.name, storeId: target.storeId });
        }

        case 'file_get': {
          const target = resolveStore(args?.store);
          if (target.error) return JSON.stringify({ error: target.error });
          if (typeof args?.path !== 'string' || !args.path.trim()) {
            return JSON.stringify({ error: 'path is required' });
          }
          const getPath = args.path.trim();
          // Try the inline base64 path first (byte-identical for small files). If
          // the object exceeds the 4 MiB read cap the backend returns 413 — fall
          // back to a presigned GET and download the bytes DIRECTLY. Either way
          // the agent gets the content inline (file_get never fails at 4 MiB now).
          let data: any;
          try {
            data = await storeFetch(target.storeId, 'get', { path: getPath });
          } catch (getErr: any) {
            if (!/failed \(413\)/.test(getErr?.message || '')) throw getErr;
            const dl = await getViaPresign(target.storeId, getPath);
            data = {
              path: getPath, size: dl.buf.length, contentType: dl.contentType,
              lastModified: null, contentBase64: dl.buf.toString('base64'),
            };
          }
          // Ergonomics: valid UTF-8 that round-trips is returned as TEXT
          // (`content`); anything else stays base64 (`contentBase64`) with an
          // `encoding` marker so the agent knows what it got.
          const out: any = {
            ok: true, store: target.name, storeId: target.storeId,
            path: data.path, size: data.size, contentType: data.contentType, lastModified: data.lastModified,
          };
          const buf = Buffer.from(data.contentBase64 || '', 'base64');
          const text = buf.toString('utf8');
          if (Buffer.compare(Buffer.from(text, 'utf8'), buf) === 0 && !text.includes('\u0000')) {
            out.content = text; out.encoding = 'utf8';
          } else {
            out.contentBase64 = data.contentBase64; out.encoding = 'base64';
          }
          return JSON.stringify(out);
        }

        case 'file_list': {
          const target = resolveStore(args?.store);
          if (target.error) return JSON.stringify({ error: target.error });
          const payload: any = {};
          if (typeof args?.prefix === 'string' && args.prefix.trim()) payload.prefix = args.prefix.trim();
          if (args?.limit != null) payload.limit = args.limit;
          if (typeof args?.cursor === 'string' && args.cursor) payload.cursor = args.cursor;
          const data = await storeFetch(target.storeId, 'list', payload);
          return JSON.stringify({ ...data, store: target.name, storeId: target.storeId });
        }

        case 'file_delete': {
          const target = resolveStore(args?.store);
          if (target.error) return JSON.stringify({ error: target.error });
          if (typeof args?.path !== 'string' || !args.path.trim()) {
            return JSON.stringify({ error: 'path is required' });
          }
          const data = await storeFetch(target.storeId, 'delete', { path: args.path.trim() });
          return JSON.stringify({ ...data, store: target.name, storeId: target.storeId });
        }

        case 'sqlite_exec':
        case 'sqlite_query': {
          // Both map to the /sql route on a SQLITE-type store. A dataset-type
          // store here is rejected server-side ("not a sqlite store").
          //
          // exec vs query is NOT merely guidance: sqlite_query is documented as
          // "Run a SELECT", so it sends readOnly:true and the backend's
          // assertReadOnly gate (handlers/sqlite-store.js) refuses anything that
          // writes AND suppresses the save. Without that flag the two tools were
          // the same full write primitive, so a tool the model is told is a
          // read could DROP a table — and an agent driven by untrusted content
          // (invariant #5) is exactly who would be talked into doing it.
          // sqlite_exec keeps write access, which is its stated purpose.
          const target = resolveStore(args?.store);
          if (target.error) return JSON.stringify({ error: target.error });
          if (typeof args?.sql !== 'string' || !args.sql.trim()) {
            return JSON.stringify({ error: 'sql is required (a non-empty SQL string)' });
          }
          const payload: any = { sql: args.sql };
          if (name === 'sqlite_query') payload.readOnly = true;
          if (Array.isArray(args?.params)) payload.params = args.params;
          const data = await storeFetch(target.storeId, 'sql', payload);
          return JSON.stringify({ ...data, store: target.name, storeId: target.storeId });
        }

        default:
          return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  },

  tools: [
    {
      name: 'dataset_append',
      description: 'Append ONE structured JSON record to a bound store, durably. Records persist across your stateless runs and are auto-tagged with your agent type so you can filter to your own writes later. Use to accumulate data you will query/aggregate (e.g. per-run metrics, processed items). Append ONE record per call.',
      input_schema: {
        type: 'object',
        properties: {
          store: { type: 'string', description: 'The logical store NAME to write to (e.g. "scorecards"), taken from the AVAILABLE STORES list — pick by description. NOT an id. If exactly one store is bound you may omit this and it defaults to that store; you can ONLY write to a bound store name.' },
          record: { type: 'object', description: 'An arbitrary JSON object — one row of data. Its keys become queryable fields (e.g. {"repo":"owner/x","stars":1200}). One record per call.' },
          description: { type: 'string', description: 'Optional, informational note about this write. The store already exists from deploy, so this is not required and does not create anything.' },
          agent: { type: 'string', description: 'Optional writing-agent tag. Defaults to your own agent type — leave unset to auto-tag.' },
        },
        required: ['record'],
      },
    },
    {
      name: 'dataset_query',
      description: 'Run a SQL-style query over a bound store to build reports: select/aggregate (count|sum|avg|min|max), filter, group, order, limit, and bound by month. Returns { columns, rows }. Use this to compute summaries/aggregations from records you appended earlier.',
      input_schema: {
        type: 'object',
        properties: {
          store: { type: 'string', description: 'The logical store NAME to query (e.g. "scorecards"), taken from the AVAILABLE STORES list — pick by description. NOT an id. If exactly one store is bound you may omit this and it defaults to that store.' },
          select: {
            type: 'array',
            description: 'Columns to return. Each item is { field?, agg?, as? }. agg ∈ count|sum|avg|min|max; omit field for count(*). Omit `select` entirely to return raw rows.',
          },
          where: {
            type: 'array',
            description: 'Filters, ANDed. Each item is { field, op, value }; op ∈ eq|ne|gt|gte|lt|lte|like. `field` is a JSON key of the stored record.',
          },
          groupBy: {
            type: 'array',
            description: 'Field names to group by (array of strings) for aggregation.',
          },
          orderBy: {
            type: 'array',
            description: 'Sort spec. Each item is { field|as, dir }; dir ∈ asc|desc.',
          },
          limit: { type: 'number', description: 'Maximum number of rows to return.' },
          since: { type: 'string', description: "Inclusive lower bound month, 'yyyy-MM' (e.g. '2026-01')." },
          until: { type: 'string', description: "Inclusive upper bound month, 'yyyy-MM' (e.g. '2026-06')." },
          agent: { type: 'string', description: 'Filter to records written by one agent namespace. Omit to query across all writers.' },
        },
        required: [],
      },
    },
    {
      name: 'ensure_store',
      description: 'Create (or reuse) a store ON DEMAND for THIS agent — use when you need a store that was NOT declared/bound at deploy. Idempotent by name and private to this agent: calling again with the same name returns the SAME store (safe to call at the start of every run). Returns { storeId }. For type "sqlite" you then define schema with sqlite_exec (CREATE TABLE IF NOT EXISTS) and read/write via sqlite_exec/sqlite_query using this name.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A short logical name for the store (e.g. "linkedin_posts"). Letters, digits, _ and - only.' },
          type: { type: 'string', enum: ['sqlite', 'dataset', 'file'], description: 'Store type. "sqlite" (default) = a mutable relational DB whose schema YOU define with SQL. "dataset" = append-only JSON records for later aggregation/analytics. "file" = arbitrary file/blob storage by relative path (file_put/file_get/file_list/file_delete).' },
          description: { type: 'string', description: 'What this store is for (shown in the Storage UI).' },
        },
        required: ['name'],
      },
    },
    {
      name: 'sqlite_exec',
      description: 'For SQLITE-type stores: run SQL that CHANGES data — CREATE TABLE (use IF NOT EXISTS), INSERT, UPDATE, DELETE (one or more statements in one call). The store is a real, mutable SQLite database that persists across your stateless runs. Returns { rowsModified, wrote }. Use this to build schema on the fly and to update rows / track changing state (e.g. a queue with a status column).',
      input_schema: {
        type: 'object',
        properties: {
          store: { type: 'string', description: 'The logical store NAME (a sqlite-type store from AVAILABLE STORES) — pick by description. NOT an id. If exactly one store is bound you may omit this.' },
          sql: { type: 'string', description: 'The SQL to run. May contain multiple statements separated by ";". Prefer CREATE TABLE IF NOT EXISTS for idempotent schema.' },
          params: { type: 'array', description: 'Optional positional bind params for a SINGLE parameterized statement (safe binding of values), e.g. sql "UPDATE t SET s=? WHERE id=?" with params ["done", 1].' },
        },
        required: ['sql'],
      },
    },
    {
      name: 'sqlite_query',
      description: 'For SQLITE-type stores: run a read-only SELECT (optionally with `params` for safe binding) against the store\'s SQLite database. Returns { columns, rows }. Never changes data. Use to read back rows/state you stored earlier.',
      input_schema: {
        type: 'object',
        properties: {
          store: { type: 'string', description: 'The logical store NAME (a sqlite-type store from AVAILABLE STORES) — pick by description. NOT an id. If exactly one store is bound you may omit this.' },
          sql: { type: 'string', description: 'A single SELECT statement. Use ? placeholders + `params` for any values.' },
          params: { type: 'array', description: 'Optional positional bind params for the SELECT, e.g. ["linkedin_personal"].' },
        },
        required: ['sql'],
      },
    },
    {
      name: 'file_put',
      description: 'For FILE-type stores: write (or overwrite) ONE file at a relative path — raw JSON dumps, CSVs, images, snapshots, any blob you want to keep across your stateless runs. Text goes in `content`; binary goes base64-encoded in `contentBase64` (pass exactly one). SIZE: there is no practical limit — anything over ~3.5 MiB is streamed straight to object storage via a presigned URL automatically, so do NOT gzip, base64-wrap, chunk or split a file just to make it fit. Non-ASCII paths (e.g. 个人报告.html) are fine — do not transliterate. Overwriting the same path UPDATES the file. Returns { ok, path, size }.',
      input_schema: {
        type: 'object',
        properties: {
          store: { type: 'string', description: 'The logical store NAME (a file-type store from AVAILABLE STORES) — pick by description. NOT an id. If exactly one store is bound you may omit this.' },
          path: { type: 'string', description: 'Relative file path, e.g. "dumps/run-42.json" or "img/chart.png". Letters, digits, ".", "_", "-" and "/" only; no "..", no leading "/".' },
          content: { type: 'string', description: 'Text content (UTF-8). Use for JSON/CSV/text files.' },
          contentBase64: { type: 'string', description: 'Base64-encoded binary content (images etc.). Alternative to `content`.' },
          contentType: { type: 'string', description: 'Optional MIME type (e.g. "application/json", "image/png"). Defaults sensibly.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'file_get',
      description: 'For FILE-type stores: read ONE stored file back by its relative path. Text files come back as `content` (encoding "utf8"); binary files come back as `contentBase64` (encoding "base64"). Returns { path, size, contentType, lastModified, content|contentBase64, encoding }.',
      input_schema: {
        type: 'object',
        properties: {
          store: { type: 'string', description: 'The logical store NAME (a file-type store from AVAILABLE STORES). If exactly one store is bound you may omit this.' },
          path: { type: 'string', description: 'The relative file path to fetch (as listed by file_list / used in file_put).' },
        },
        required: ['path'],
      },
    },
    {
      name: 'file_list',
      description: 'For FILE-type stores: list the stored files — each entry has { path, size, lastModified }. Optionally filter by a path `prefix` (e.g. "dumps/"). Paginated via `cursor` when there are more results.',
      input_schema: {
        type: 'object',
        properties: {
          store: { type: 'string', description: 'The logical store NAME (a file-type store from AVAILABLE STORES). If exactly one store is bound you may omit this.' },
          prefix: { type: 'string', description: 'Optional path prefix filter, e.g. "dumps/" or "reports/2026".' },
          limit: { type: 'number', description: 'Max entries to return (default/max 1000).' },
          cursor: { type: 'string', description: 'Pagination cursor from a previous file_list response (nextCursor).' },
        },
        required: [],
      },
    },
    {
      name: 'file_delete',
      description: 'For FILE-type stores: delete ONE stored file by its relative path. Returns { ok, path, deleted }. Errors if the path does not exist.',
      input_schema: {
        type: 'object',
        properties: {
          store: { type: 'string', description: 'The logical store NAME (a file-type store from AVAILABLE STORES). If exactly one store is bound you may omit this.' },
          path: { type: 'string', description: 'The relative file path to delete.' },
        },
        required: ['path'],
      },
    },
  ],
};
