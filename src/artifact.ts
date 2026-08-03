import { SKILL_META } from '@zibby/skill-ids';
/**
 * artifact.js — publish a self-contained, shareable HTML/Markdown page.
 *
 * WHAT IT IS
 * ──────────
 * A hand-written multi-tool skill (same shape as kvMemory.js / datasetStore.js /
 * github.js): `serverName`, `allowedTools`, `tools[]`, `handleToolCall`, and a
 * `resolve()` that spawns the GENERIC bin/mcp-skill.mjs. It gives ANY agent (the
 * Copilot first) a way to PUBLISH a standalone page — a status report, a plan, a
 * comparison table, a dashboard-y summary, a diagram — to Zibby's own object
 * store and get back a shareable URL. Like Claude Code's Artifact tool, for Zibby
 * agents.
 *
 * TWO LAYERS — do NOT conflate (see strategy/artifact-generation-skill-2026-07.md)
 * ────────────────────────────────────────────────────────────────────────────
 *   - CONTENT (the rendered HTML/MD blob) → OBJECT STORE (ARTIFACTS_BUCKET). It's
 *     an OUTPUT, not memory. Written SERVER-SIDE by the control-plane so the
 *     object-store credentials never enter the hostile run container (invariant
 *     #5): the skill POSTs the content to POST {base}/artifacts and the backend
 *     does the privileged S3 write.
 *   - INDEX / metadata ({id,title,url,kind,createdAt,summary}) → kv-memory. "What
 *     I made" is structured MEMORY, so it rides the SHIPPED kv-memory layer
 *     (POST {base}/credits/review-memory, op 'store'/'recall', auto-namespaced by
 *     WORKFLOW_TYPE, IDENTICAL to kvMemory.js). `artifact_list` is therefore NOT a
 *     tool this skill defines — it is kv_recall_prefix('artifact:') on the shipped
 *     kv-memory skill (which the Copilot loads alongside this one). We write the
 *     index under the SAME scope shape kv-memory reads (`${ns}:artifact:<id>`) so a
 *     later kv_recall_prefix('artifact:') sees exactly the artifacts this agent
 *     published — no new store, no new table.
 *
 * TOOLS
 * ─────
 *   artifact_publish({ title, html | markdown, kind?, favicon?, summary? })
 *        → control-plane writes the blob (ARTIFACTS_BUCKET, account+project scoped)
 *        → index record written to kv-memory (scope `${ns}:artifact:<id>`)
 *        → returns { id, url }
 *   artifact_update({ id, title?, html?|markdown? })  → same url, new version
 *   artifact_get({ id })                              → { metadata, content }
 *   (artifact_list = kv_recall_prefix('artifact:') on the kv-memory skill)
 *
 * AUTH — identical to kvMemory.js / datasetStore.js
 * ──────────────────────────────────────────────────
 * Calls ZIBBY'S OWN backend with PROJECT_API_TOKEN (Bearer) against
 * ZIBBY_ACCOUNT_API_URL (default api-prod.zibby.app). Tenancy (account + project)
 * is enforced SERVER-SIDE from the Bearer token — the skill NEVER sends
 * account/project. Mirrors @zibby/core/backend-client.js getSessionToken()/
 * getAccountApiUrl() rather than importing a non-existent helper.
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
 * The per-agent namespace prefix — IDENTICAL to kvMemory.js agentNamespace().
 * WORKFLOW_TYPE is injected into every Fargate run; fall back to the literal
 * 'agent' so the skill never crashes outside a run. Trimmed; an empty/
 * whitespace-only value also falls back. Keeping this byte-identical to
 * kv-memory is what makes `kv_recall_prefix('artifact:')` (which uses the same
 * namespacing) list exactly the artifacts this agent published.
 */
function agentNamespace() {
  const wt = typeof process.env.WORKFLOW_TYPE === 'string' ? process.env.WORKFLOW_TYPE.trim() : '';
  return wt || 'agent';
}

/** The kv-memory scope an artifact's index record lives at. */
function indexScope(id) {
  return `${agentNamespace()}:artifact:${id}`;
}

/**
 * POST {base}/artifacts — the privileged, SERVER-SIDE blob write. Body carries
 * the content ({ title, html|markdown, kind?, favicon?, id? }); the backend does
 * the S3 PutObject (ARTIFACTS_BUCKET) so object-store creds never enter this run.
 * Returns { id, url, ... }. Throws a descriptive error on a non-2xx.
 */
async function artifactWriteFetch(payload) {
  const session = getSessionToken();
  if (!session) {
    throw new Error('No backend credential (PROJECT_API_TOKEN). Artifacts are only available inside a Zibby run.');
  }
  // '/credits/artifacts', not '/artifacts': on cloud the main API sits at its
  // 500-resource cap, so these routes live on the credits RestApi (same
  // placement as review-memory below); self-host mounts the same alias.
  const res = await fetch(`${getAccountApiUrl()}/credits/artifacts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`artifact write failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

/** GET {base}/artifacts/{id} — authenticated fetch of one artifact's metadata + source content. */
async function artifactReadFetch(id) {
  const session = getSessionToken();
  if (!session) {
    throw new Error('No backend credential (PROJECT_API_TOKEN). Artifacts are only available inside a Zibby run.');
  }
  const res = await fetch(`${getAccountApiUrl()}/credits/artifacts/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${session}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`artifact get failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Upsert the artifact's INDEX record into kv-memory (the SAME route + table the
 * kv-memory skill uses). op 'store' preserves createdAt server-side across
 * upserts (review-memory.js keeps the first createdAt), so an update never loses
 * the original creation time. Best-effort caller: publish/update surface the
 * error but the blob is already written.
 */
async function indexStore(id, record) {
  const session = getSessionToken();
  if (!session) return; // no run credential → nothing to index against
  const res = await fetch(`${getAccountApiUrl()}/credits/review-memory`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'store', scope: indexScope(id), content: JSON.stringify(record) }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`artifact index write failed (${res.status}): ${body.slice(0, 200)}`);
  }
}

/** Recall the existing index record for `id` (returns the parsed object or null). */
async function indexRecall(id) {
  const session = getSessionToken();
  if (!session) return null;
  const res = await fetch(`${getAccountApiUrl()}/credits/review-memory`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'recall', scope: indexScope(id) }),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data?.found || !data?.memory?.content) return null;
  try { return JSON.parse(data.memory.content); } catch { return null; }
}

/** Pull the ONE content field (html or markdown) out of args; returns { format, content } or null. */
function pickContent(args) {
  if (typeof args?.html === 'string' && args.html.length > 0) return { format: 'html', content: args.html };
  if (typeof args?.markdown === 'string' && args.markdown.length > 0) return { format: 'markdown', content: args.markdown };
  return null;
}

export const artifactSkill: any = {
  id: 'artifact',
  // Backend-calling: the MCP child talks to Zibby's own backend — the
  // session-env contract is guaranteed by backendSession.ts at registration
  // (declare ONCE here; see backend-session-env-contract.test.ts).
  callsBackend: true,
  // ONE source for toggle metadata — by reference, never a copy (skills-platform rule).
  meta: SKILL_META['artifact'],
  serverName: 'artifact',
  allowedTools: ['mcp__artifact__*'],
  description: 'Artifacts — publish a self-contained, shareable HTML/Markdown page to Zibby and get back a URL; the index of what you published is your memory.',

  promptFragment: `## Artifacts (publish a shareable page, remember what you made)
You can PUBLISH a standalone page — a status report, a plan, a comparison table,
a dashboard-y summary, a diagram, a "here's what I found" write-up — and get back
a shareable URL. The page is a self-contained HTML (or Markdown) document; it is
sandboxed when viewed (no external network, no ambient credentials), so keep all
CSS/JS/images INLINE (inline <style>/<script>, data: URIs) — external URLs will
be blocked.

Tools:
- artifact_publish: Publish a NEW page. Pass a \`title\` and EITHER \`html\` OR
  \`markdown\` (not both). Optional \`kind\` (e.g. "report", "plan", "dashboard"),
  \`favicon\` (an emoji), and \`summary\` (one line for your own index). Returns
  { id, url }. Share the url; keep the id if you'll update it later.
- artifact_update: Revise an EXISTING page by \`id\` (same url, new version). Pass
  the fields to change (\`title\`, \`html\`|\`markdown\`).
- artifact_get: Fetch one artifact by \`id\` → { metadata, content } so you can
  reuse / edit / re-publish it.

To recall WHAT YOU HAVE ALREADY PUBLISHED, use your kv-memory tool
kv_recall_prefix with keyPrefix "artifact:" — each entry is the index record
{ id, title, url, kind, createdAt, summary } for a page you made. (Publishing
records this automatically; you don't store it yourself.)`,

  resolve() {
    // Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs) pointing at this
    // module's artifactSkill export — same FIXED pattern as kvMemory/datasetStore
    // (NEVER return { command: null }). The module arg resolves relative to bin/
    // at runtime → ../dist/artifact.js in a published install.
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env: {}, description: this.description };
    const env: any = {};
    for (const key of [
      'PROJECT_API_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_ENV', 'ZIBBY_PROD_ACCOUNT_API_URL', 'ZIBBY_USER_TOKEN',
      // The namespace source (matches kv-memory) so the index scope lines up.
      'WORKFLOW_TYPE',
    ]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/artifact.js', 'artifactSkill'],
      env,
      description: this.description,
      // Force tools into the system prompt instead of deferring behind the SDK's
      // ToolSearch (same as kvMemory.js) — the Copilot loads this as a CORE skill.
      alwaysLoad: true,
    };
  },

  async handleToolCall(name, args) {
    try {
      switch (name) {
        case 'artifact_publish': {
          const title = typeof args?.title === 'string' ? args.title.trim() : '';
          if (!title) return JSON.stringify({ error: 'title is required' });
          const picked = pickContent(args);
          if (!picked) return JSON.stringify({ error: 'provide exactly one of html or markdown (non-empty string)' });

          const payload: any = { title, [picked.format]: picked.content };
          if (typeof args?.kind === 'string' && args.kind.trim()) payload.kind = args.kind.trim();
          if (typeof args?.favicon === 'string' && args.favicon.trim()) payload.favicon = args.favicon.trim();

          const written = await artifactWriteFetch(payload); // { id, url, createdAt, ... }
          const id = written?.id;
          const url = written?.url;
          if (!id || !url) return JSON.stringify({ error: 'artifact write returned no id/url', response: written });

          const record: any = {
            id,
            title,
            url,
            kind: payload.kind || null,
            createdAt: written.createdAt || new Date().toISOString(),
            summary: typeof args?.summary === 'string' && args.summary.trim() ? args.summary.trim() : title,
          };
          try { await indexStore(id, record); } catch (e) {
            // Blob is published; surface the index warning but don't fail the publish.
            return JSON.stringify({ id, url, indexWarning: e.message });
          }
          return JSON.stringify({ id, url });
        }

        case 'artifact_update': {
          const id = typeof args?.id === 'string' ? args.id.trim() : '';
          if (!id) return JSON.stringify({ error: 'id is required' });
          const picked = pickContent(args);
          const title = typeof args?.title === 'string' ? args.title.trim() : '';
          if (!picked && !title) {
            return JSON.stringify({ error: 'nothing to update — pass a new title and/or html|markdown' });
          }
          const payload: any = { id };
          if (title) payload.title = title;
          if (picked) payload[picked.format] = picked.content;
          if (typeof args?.kind === 'string' && args.kind.trim()) payload.kind = args.kind.trim();
          if (typeof args?.favicon === 'string' && args.favicon.trim()) payload.favicon = args.favicon.trim();

          const written = await artifactWriteFetch(payload); // { id, url, updatedAt, createdAt? }
          const url = written?.url;
          if (!url) return JSON.stringify({ error: 'artifact update returned no url', response: written });

          // Merge the index record: keep the original createdAt (recall it), bump
          // updatedAt + any changed fields.
          const prior = (await indexRecall(id)) || {};
          const record: any = {
            ...prior,
            id,
            url,
            title: title || prior.title || 'Untitled',
            kind: payload.kind || prior.kind || null,
            createdAt: prior.createdAt || written.createdAt || new Date().toISOString(),
            updatedAt: written.updatedAt || new Date().toISOString(),
          };
          if (typeof args?.summary === 'string' && args.summary.trim()) record.summary = args.summary.trim();
          else if (!record.summary) record.summary = record.title;
          try { await indexStore(id, record); } catch (e) {
            return JSON.stringify({ id, url, indexWarning: e.message });
          }
          return JSON.stringify({ id, url });
        }

        case 'artifact_get': {
          const id = typeof args?.id === 'string' ? args.id.trim() : '';
          if (!id) return JSON.stringify({ error: 'id is required' });
          const data = await artifactReadFetch(id); // { metadata, content }
          return JSON.stringify(data);
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
      name: 'artifact_publish',
      description: 'Publish a NEW self-contained, shareable page (report/plan/table/dashboard/diagram/write-up) and get back a shareable URL. Pass a title and EITHER html OR markdown. Keep all CSS/JS/images INLINE (inline <style>/<script>, data: URIs) — the page is sandboxed on view and external URLs are blocked. Returns { id, url }.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The page title (also the browser tab title).' },
          html: { type: 'string', description: 'The page content as a self-contained HTML document (or fragment). Provide this OR markdown, not both.' },
          markdown: { type: 'string', description: 'The page content as Markdown (rendered to HTML on serve). Provide this OR html, not both.' },
          kind: { type: 'string', description: 'Optional label for what this is, e.g. "report", "plan", "dashboard", "diagram". Stored in your index.' },
          favicon: { type: 'string', description: 'Optional emoji used as the browser-tab icon, e.g. "📊".' },
          summary: { type: 'string', description: 'Optional one-line summary for your own index (defaults to the title). Helps you recall later what this page was.' },
        },
        required: ['title'],
      },
    },
    {
      name: 'artifact_update',
      description: 'Revise an EXISTING artifact by id — the shareable URL stays the same, the content is replaced (new version). Pass the fields to change (title and/or html|markdown). Returns { id, url }.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The id of the artifact to update (from a prior artifact_publish, or your kv-memory "artifact:" index).' },
          title: { type: 'string', description: 'New title (optional).' },
          html: { type: 'string', description: 'New HTML content (optional). Provide this OR markdown.' },
          markdown: { type: 'string', description: 'New Markdown content (optional). Provide this OR html.' },
          kind: { type: 'string', description: 'Optional updated kind label.' },
          favicon: { type: 'string', description: 'Optional updated emoji favicon.' },
          summary: { type: 'string', description: 'Optional updated one-line index summary.' },
        },
        required: ['id'],
      },
    },
    {
      name: 'artifact_get',
      description: 'Fetch ONE artifact you published, by id → { metadata, content }. Use to reuse / edit / re-publish a page. To LIST what you have published, use your kv-memory tool kv_recall_prefix with keyPrefix "artifact:".',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The artifact id.' },
        },
        required: ['id'],
      },
    },
  ],
};
