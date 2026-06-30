import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve as resolvePath } from 'path';
import { resolveIntegrationToken, clearTokenCache } from '@zibby/core/backend-client.js';

/**
 * LinkedIn skill — TWO capabilities over TWO distinct OAuth providers:
 *   - linkedin_business (Community Management API, org Pages): list admin
 *     Organizations + create DRAFT posts on a company Page.
 *   - linkedin_personal (Share on LinkedIn, member profile): PUBLISH a post to
 *     the authenticated member's own feed (member profiles have no DRAFT state).
 *
 * Mirrors notion.js / figma.js (the hand-written generic-bin skills: a
 * `tools[]` array + a `handleToolCall` switch, served over MCP by
 * bin/mcp-skill.mjs). handleToolCall NEVER throws — every HTTP/parse failure
 * is returned as { ok:false, error } so an unconnected/erroring LinkedIn can't
 * crash the run.
 *
 * Auth: LinkedIn is an OAuth integration, now split into TWO providers (the
 * single `linkedin` provider is GONE). Each call resolves the VARIANT-SPECIFIC
 * member access token via resolveIntegrationToken('linkedin_business') (org
 * tools) or resolveIntegrationToken('linkedin_personal') (member publish). The
 * backend connect handler decrypts the stored token and returns
 * { provider, token, ... }; the personal endpoint also returns the resolved
 * member id as `memberId`. We send the token as `Authorization: Bearer <token>`.
 * When no token is available the helper throws a clear "LinkedIn not connected"
 * error that handleToolCall surfaces as { ok:false, error }.
 *
 * Every LinkedIn REST (/rest/*) call REQUIRES the versioned-API headers:
 *   Authorization: Bearer <token>
 *   LinkedIn-Version: <YYYYMM>            (pins the request/response schema)
 *   X-Restli-Protocol-Version: 2.0.0
 *   Content-Type: application/json        (on bodies)
 */

function resolveSkillBin() {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

// LinkedIn versioned REST API. The LinkedIn-Version header is REQUIRED and
// pins the request/response schema; use a recent stable YYYYMM month.
const LINKEDIN_VERSION = '202506';
const LINKEDIN_BASE = 'https://api.linkedin.com';

/**
 * Extract a numeric organization id from a urn (urn:li:organization:123) or a
 * bare numeric id. Returns the id string, or null if none can be found.
 */
export function parseOrgId(ref) {
  if (ref == null) return null;
  const s = String(ref).trim();
  if (!s) return null;
  const m = s.match(/urn:li:organization:(\d+)/i);
  if (m) return m[1];
  if (/^\d+$/.test(s)) return s;
  return null;
}

/** Best-effort human name off a /rest/organizations/{id} payload. */
function orgName(org) {
  if (!org) return '';
  if (org.localizedName) return String(org.localizedName);
  const loc = org.name && org.name.localized;
  if (loc && typeof loc === 'object') {
    const first = Object.values(loc)[0];
    if (first) return String(first);
  }
  return '';
}

/** Read a response header value regardless of Headers-instance vs plain map. */
function readHeader(headers, key) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(key);
  return headers[key] || headers[key.toLowerCase()] || null;
}

/**
 * Single chokepoint for every LinkedIn REST call. Resolves the OAuth bearer
 * for the given `provider` via resolveIntegrationToken(provider) — defaulting
 * to 'linkedin_business' (org Community Management API); pass
 * 'linkedin_personal' for member-profile calls — sets the required
 * versioned-API headers, retries once on transient auth errors, and returns
 * { status, headers, body }. Throws (trimmed) on non-2xx so handleToolCall can
 * surface it as JSON.
 *
 * Keep this the single auth chokepoint — don't resolve tokens at call sites.
 */
export async function linkedinApi(path, opts = {}, provider = 'linkedin_business') {
  const makeRequest = async () => {
    const { token } = await resolveIntegrationToken(provider);
    if (typeof token !== 'string' || !token) {
      throw new Error('LinkedIn is not connected: no access token available. Connect LinkedIn in Integrations.');
    }
    const url = path.startsWith('https://') ? path : `${LINKEDIN_BASE}${path}`;
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'LinkedIn-Version': LINKEDIN_VERSION,
        'X-Restli-Protocol-Version': '2.0.0',
        Accept: 'application/json',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`LinkedIn API ${res.status}: ${err.slice(0, 300)}`);
    }
    const raw = await res.text().catch(() => '');
    let body = {};
    if (raw && raw.trim()) {
      try { body = JSON.parse(raw); } catch { body = { raw }; }
    }
    return { status: res.status, headers: res.headers, body };
  };

  try {
    return await makeRequest();
  } catch (error) {
    const msg = String(error?.message || error || '').toLowerCase();
    const shouldRetry = msg.includes('token') || msg.includes('401') || msg.includes('unauthorized');
    if (!shouldRetry) throw error;
    clearTokenCache(provider);
    return makeRequest();
  }
}

export const linkedinSkill = {
  id: 'linkedin',
  serverName: 'linkedin',
  allowedTools: ['mcp__linkedin__*'],
  // NO requiresIntegration. The two capabilities use two DIFFERENT providers
  // (linkedin_business for the org tools, linkedin_personal for the publish
  // tool), and either one connected is enough to be useful. The
  // "personal OR business" OR-group gating is done in the BACKEND map
  // (REQUIRED_INTEGRATION_MAP → linkedin: {any:[linkedin_personal,
  // linkedin_business]}), exactly like git-write (git-write.js omits
  // requiresIntegration and is gated via {any:[github,gitlab]}). Declaring a
  // single requiresIntegration here would force ONE specific provider and
  // break the OR-group.
  // Token is resolved per-call via the backend (not injected as env), so there
  // are no env keys to forward to the MCP child.
  envKeys: [],
  description: 'LinkedIn — (business) list admin Organizations + create DRAFT posts on a company Page, and (personal) PUBLISH a post to your own member profile feed',

  promptFragment: `## LinkedIn (connected)
You can post to LinkedIn two ways — an ORG company Page (business) and your own member PROFILE (personal). Each path needs its own LinkedIn integration connected.

Business (company Page) — DRAFT only:
- linkedin_list_organizations: List the Organizations (company Pages) the member ADMINISTERS. Returns [{ id, urn, name, vanityName }]. Call this first to choose the author org. (needs LinkedIn Business connected)
- linkedin_create_draft_post: Create a DRAFT post on a company Page. Pass organizationId (or organizationUrn) + text (the post commentary). The post is created in DRAFT state (never published automatically) so a human reviews and publishes it in LinkedIn. Returns { postUrn }. (needs LinkedIn Business connected)

Personal (your own profile) — PUBLISHES IMMEDIATELY:
- linkedin_publish_post: PUBLISH a post to your OWN member profile feed. Pass text (the post body) + optional visibility ('PUBLIC' default, or 'CONNECTIONS'). UNLIKE the org draft tool, this PUBLISHES the post immediately — LinkedIn has no DRAFT state for member profiles, so there is no human review step. Returns { postUrn }. (needs LinkedIn Personal connected)

Notes:
- Org-page posts are ALWAYS created as a DRAFT; personal-profile posts are ALWAYS published live — choose the tool accordingly.
- If the relevant LinkedIn integration is not connected these tools return { ok:false, error }; treat that as "LinkedIn unavailable" and continue.`,

  resolve() {
    // Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs), pointing it at
    // this module's linkedinSkill export. It registers every entry in tools[]
    // as an MCP tool and dispatches each call through handleToolCall — so the
    // model gets real mcp__linkedin__* tools. The module arg is resolved
    // RELATIVE TO bin/ at runtime → node_modules/@zibby/skills/dist/linkedin.js
    // in a published install (mirrors notion.js / figma.js). No env to forward:
    // linkedinApi resolves the token via the backend.
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env: {}, description: this.description };
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/linkedin.js', 'linkedinSkill'],
      env: {},
      description: this.description,
      // Force tools into the system prompt (see notion.js / figma.js resolve()).
      alwaysLoad: true,
    };
  },

  async handleToolCall(name, args) {
    try {
      switch (name) {
        case 'linkedin_list_organizations': {
          // ACLs where the member is an APPROVED ADMINISTRATOR. Org tools use
          // the BUSINESS (Community Management API) provider.
          const { body } = await linkedinApi('/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED', {}, 'linkedin_business');
          const elements = Array.isArray(body.elements) ? body.elements : [];
          const organizations = [];
          for (const el of elements) {
            const target = el.organizationalTarget || el['organizationalTarget~'] || el.organization;
            const id = parseOrgId(target);
            if (!id) continue;
            let name = '';
            let vanityName = '';
            try {
              const org = (await linkedinApi(`/rest/organizations/${id}`, {}, 'linkedin_business')).body;
              name = orgName(org);
              vanityName = org.vanityName || '';
            } catch {
              // Name resolution is best-effort — still return the org by id/urn.
            }
            organizations.push({ id, urn: `urn:li:organization:${id}`, name, vanityName });
          }
          return JSON.stringify({ ok: true, count: organizations.length, organizations });
        }

        case 'linkedin_create_draft_post': {
          const orgRef = args?.organizationUrn || args?.organizationId || args?.organization || args?.orgId;
          const id = parseOrgId(orgRef);
          if (!id) {
            return JSON.stringify({ ok: false, error: 'A valid organizationId or organizationUrn (urn:li:organization:{id}) is required' });
          }
          const text = args?.text;
          if (typeof text !== 'string' || !text.trim()) {
            return JSON.stringify({ ok: false, error: 'text (the post commentary) is required' });
          }
          // Only PUBLIC visibility is supported for org-page posts here; default it.
          const visibility = args?.visibility ? String(args.visibility).toUpperCase() : 'PUBLIC';
          const author = `urn:li:organization:${id}`;
          const requestBody = {
            author,
            commentary: text,
            visibility,
            distribution: {
              feedDistribution: 'MAIN_FEED',
              targetEntities: [],
              thirdPartyDistributionChannels: [],
            },
            lifecycleState: 'DRAFT',
            isReshareDisabledByAuthor: false,
          };
          const res = await linkedinApi('/rest/posts', { method: 'POST', body: requestBody }, 'linkedin_business');
          // The created post URN comes back in the x-restli-id (or x-linkedin-id)
          // response header; fall back to the body id if present.
          const postUrn =
            readHeader(res.headers, 'x-restli-id') ||
            readHeader(res.headers, 'x-linkedin-id') ||
            res.body?.id ||
            null;
          return JSON.stringify({
            ok: true,
            postUrn,
            author,
            lifecycleState: 'DRAFT',
            visibility,
            status: res.status,
          });
        }

        case 'linkedin_publish_post': {
          // PERSONAL / member-profile publish. The personal token endpoint
          // returns the resolved member id alongside the token; the author urn
          // is urn:li:person:{memberId}. Resolve it directly here (linkedinApi
          // doesn't expose memberId); linkedinApi resolves the token again for
          // the POST — that's fine, tokens are cached.
          const { memberId } = await resolveIntegrationToken('linkedin_personal');
          if (!memberId) {
            return JSON.stringify({ ok: false, error: 'LinkedIn (personal) not connected or member id unavailable — reconnect LinkedIn Personal' });
          }
          const text = args?.text;
          if (typeof text !== 'string' || !text.trim()) {
            return JSON.stringify({ ok: false, error: 'text (the post body) is required' });
          }
          const visibility = args?.visibility ? String(args.visibility).toUpperCase() : 'PUBLIC';
          const author = `urn:li:person:${memberId}`;
          const requestBody = {
            author,
            commentary: text,
            visibility,
            distribution: {
              feedDistribution: 'MAIN_FEED',
              targetEntities: [],
              thirdPartyDistributionChannels: [],
            },
            // Member profiles have NO DRAFT state — this PUBLISHES immediately.
            lifecycleState: 'PUBLISHED',
            isReshareDisabledByAuthor: false,
          };
          const res = await linkedinApi('/rest/posts', { method: 'POST', body: requestBody }, 'linkedin_personal');
          // Same URN extraction as the draft tool: x-restli-id (or
          // x-linkedin-id) response header, then the body id.
          const postUrn =
            readHeader(res.headers, 'x-restli-id') ||
            readHeader(res.headers, 'x-linkedin-id') ||
            res.body?.id ||
            null;
          return JSON.stringify({
            ok: true,
            postUrn,
            author,
            lifecycleState: 'PUBLISHED',
            visibility,
            status: res.status,
          });
        }

        default:
          return JSON.stringify({ ok: false, error: `Unknown tool: ${name}` });
      }
    } catch (e) {
      // NEVER throw — surface as JSON so the caller can tolerate it.
      return JSON.stringify({ ok: false, error: e.message });
    }
  },

  tools: [
    {
      name: 'linkedin_list_organizations',
      description: 'List the LinkedIn Organizations (company Pages) the authenticated member ADMINISTERS. Returns [{ id, urn, name, vanityName }]. Call this first to choose the author org for a draft post.',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'linkedin_create_draft_post',
      description: 'Create a DRAFT post on a LinkedIn Organization (company Page). The post is created in DRAFT state (never published automatically) so a human can review and publish it in LinkedIn. Returns the created post URN.',
      input_schema: {
        type: 'object',
        properties: {
          organizationId: { type: 'string', description: 'The numeric organization id (e.g. "12345"). Alternative to organizationUrn.' },
          organizationUrn: { type: 'string', description: 'The organization URN, e.g. "urn:li:organization:12345". Alternative to organizationId.' },
          text: { type: 'string', description: 'The post commentary (the body text of the post).' },
          visibility: { type: 'string', enum: ['PUBLIC'], description: 'Post visibility. Defaults to PUBLIC.' },
        },
        required: ['text'],
      },
    },
    {
      name: 'linkedin_publish_post',
      description: 'PUBLISH a post to the authenticated member\'s OWN LinkedIn profile feed (personal). UNLIKE linkedin_create_draft_post (which only drafts on a company Page), this PUBLISHES the post IMMEDIATELY — LinkedIn has no DRAFT state for member profiles, so there is no human review step. Returns the created post URN. Requires the LinkedIn Personal integration connected.',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The post body (the commentary text of the post).' },
          visibility: { type: 'string', enum: ['PUBLIC', 'CONNECTIONS'], description: 'Post visibility: PUBLIC (anyone) or CONNECTIONS (your connections only). Defaults to PUBLIC.' },
        },
        required: ['text'],
      },
    },
  ],
};
