import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve as resolvePath } from 'path';
import { resolveIntegrationToken, clearTokenCache } from '@zibby/core/backend-client.js';
import { fetchWithDeadline } from './lib/http-deadline.js';

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

/**
 * INJECTED-TOKEN fast path (Zibby Copilot per-turn credential injection).
 *
 * The Zibby Copilot is ONE shared Slack/Lark bot backed by ONE project's
 * PROJECT_API_TOKEN. resolveIntegrationToken(provider) authenticates with that
 * PAT, so the account is inferred SERVER-SIDE from the PAT — meaning the shared
 * bot would only ever see the PROJECT OWNER's LinkedIn, never the (different)
 * person who actually sent the Slack message.
 *
 * To let the bot post to the VERIFIED SENDER's OWN LinkedIn, the copilot-runtime
 * (a TRUSTED backend service that already KMS-decrypts tenants' creds directly)
 * resolves the EMAIL-VERIFIED Slack sender's OWN linkedin_personal token straight
 * from the encrypted store and injects it into THIS turn's env
 * (ZIBBY_INJECTED_LINKEDIN_TOKEN / ZIBBY_INJECTED_LINKEDIN_MEMBER_ID, set +
 * restored per-turn — never persisted, never cross-turn). When present it takes
 * PRECEDENCE over resolveIntegrationToken so the post is attributed to the sender.
 *
 * SCOPED to linkedin_personal ONLY (member-profile publishing). It is NEVER used
 * for the business/org provider (company Pages) or any other integration. Absent
 * (no injection) → this returns null and the normal PAT chokepoint runs
 * unchanged (self-host + cloud), so the Fargate linkedin-post workflow, which
 * never sets these vars, is byte-for-byte unaffected.
 */
export function injectedPersonalToken() {
  const token = String(process.env.ZIBBY_INJECTED_LINKEDIN_TOKEN || '').trim();
  if (!token) return null;
  const memberId = String(process.env.ZIBBY_INJECTED_LINKEDIN_MEMBER_ID || '').trim();
  return { token, memberId };
}

/**
 * STRICT CHAT-TURN INVARIANT (fail-CLOSED) — ZIBBY_CHAT_STRICT_PERSONAL=1.
 * Set UNCONDITIONALLY by the Copilot runtime for EVERY chat turn (Slack +
 * Lark, owner or not). Under it, the PERSONAL-tier provider
 * (linkedin_personal) must NEVER fall through to the PAT-resolved project-
 * owner token: the ONLY accepted credential is the per-turn injected sender
 * token (the runtime injects the OWNER's own LinkedIn through the same path,
 * so the owner keeps working). No injected token → HARD REFUSE for ANY sender
 * — verified non-owner, same-account colleague, UNVERIFIED sender (the class
 * the old per-sender flags failed OPEN on), or the owner with no LinkedIn.
 * The business/org provider (company Pages) is team-tier and unaffected.
 * Absent the flag (Fargate workflows, self-host, direct tool use) → the
 * normal PAT chokepoint runs unchanged.
 */
export function chatStrictPersonal() {
  return String(process.env.ZIBBY_CHAT_STRICT_PERSONAL || '').trim() === '1';
}

/** Belt-and-braces legacy flag: this turn's verified sender ≠ the tenant owner. */
export function senderIsNonOwner() {
  return String(process.env.ZIBBY_SENDER_IS_NON_OWNER || '').trim() === '1';
}

// HARD-REFUSAL message when a chat turn has no injected LinkedIn of the
// sender's own (sender-neutral: non-owners, unverified senders AND the owner
// with no LinkedIn connected). Deliberately avoids "token"/"401"/
// "unauthorized" so the linkedinApi retry heuristic never retries it.
export const PERSONAL_REFUSAL =
  "You haven't connected your own LinkedIn account — connect it at https://studio.zibby.dev/integrations (LinkedIn). For privacy, I can't post or act as anyone else's LinkedIn (including the project owner's) on your behalf.";

/**
 * The single PERSONAL-tier credential gate for linkedin_personal calls:
 * injected sender token wins; otherwise a strict chat turn (or a flagged
 * non-owner sender) HARD-REFUSES rather than falling through to the owner's
 * PAT-resolved token. Returns the injected token/memberId or null (= caller
 * may use the legacy PAT path). Throws PERSONAL_REFUSAL on the gated paths.
 */
export function personalTierCredentialGate() {
  const injected = injectedPersonalToken();
  if (injected) return injected;
  if (chatStrictPersonal() || senderIsNonOwner()) throw new Error(PERSONAL_REFUSAL);
  return null;
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
export async function linkedinApi(path, opts: any = {}, provider = 'linkedin_business') {
  const makeRequest = async () => {
    // PERSONAL-TIER gate (linkedin_personal ONLY — single chokepoint, runs
    // BEFORE any network call):
    //   1. injected sender token (Copilot per-turn injection) — the sender's
    //      OWN member token (the runtime injects the owner's own LinkedIn
    //      through the same path); used VERBATIM, attributed to the sender.
    //   2. STRICT CHAT-TURN gate (primary, fail-CLOSED) + non-owner flag
    //      (belt-and-braces): no injected token → HARD REFUSE — never the
    //      PAT-resolved owner token on a chat turn.
    //   3. no chat-sender context (Fargate workflows, self-host) → the
    //      existing resolveIntegrationToken path, unchanged.
    // The business/org provider (company Pages, team-tier) is unaffected.
    let token;
    if (provider === 'linkedin_personal') {
      const injected = personalTierCredentialGate();
      if (injected) token = injected.token;
    }
    if (!token) ({ token } = await resolveIntegrationToken(provider));
    if (typeof token !== 'string' || !token) {
      throw new Error('LinkedIn is not connected: no access token available. Connect LinkedIn in Integrations.');
    }
    const url = path.startsWith('https://') ? path : `${LINKEDIN_BASE}${path}`;
    const res = await fetchWithDeadline(url, {
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
    }, { kind: 'api', what: `LinkedIn ${opts.method || 'GET'} ${path}` });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`LinkedIn API ${res.status}: ${err.slice(0, 300)}`);
    }
    const raw = await res.text().catch(() => '');
    let body: any = {};
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

/**
 * Resolve the OAuth bearer for `provider` using the EXACT SAME precedence
 * linkedinApi's makeRequest() uses — so an image upload is authenticated with
 * the identical credential (and fail-CLOSED personal-tier gate) as the post it
 * attaches to. For linkedin_personal the injected sender token wins and a
 * strict chat turn hard-refuses; otherwise resolveIntegrationToken(provider).
 * Used for the raw PUT to the image upload URL (a different host than the REST
 * base, so we can't route it through linkedinApi's versioned-header fetch).
 */
async function resolveProviderToken(provider) {
  let token;
  if (provider === 'linkedin_personal') {
    const injected = personalTierCredentialGate();
    if (injected) token = injected.token;
  }
  if (!token) ({ token } = await resolveIntegrationToken(provider));
  if (typeof token !== 'string' || !token) {
    throw new Error('LinkedIn is not connected: no access token available. Connect LinkedIn in Integrations.');
  }
  return token;
}

/** Best-effort image MIME from a file path; defaults to image/png. */
function mimeForPath(p) {
  const ext = String(p || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  switch (ext) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'png':
    default: return 'image/png';
  }
}

/**
 * Upload a LOCAL image file to LinkedIn's Images API and return its
 * `urn:li:image:...` URN, ready to attach to a post via
 * requestBody.content.media = { id: <urn>, altText }.
 *
 * Uses the SAME provider/token/gate as the post (resolveProviderToken):
 *   1. initializeUpload — POST /rest/images?action=initializeUpload with
 *      { initializeUploadRequest: { owner: <author urn> } } (through linkedinApi,
 *      so it carries the versioned-API headers + the personal-tier gate). Reads
 *      value.uploadUrl + value.image from the response.
 *   2. single-request upload — PUT the raw file bytes to uploadUrl with
 *      Authorization: Bearer <same provider token> + the image Content-Type.
 *   3. return value.image (the image URN).
 *
 * Throws on any non-2xx / missing field — handleToolCall catches it and returns
 * { ok:false, error } so a bad image can't crash the run or cause a post.
 */
export async function uploadImage(provider, ownerUrn, imagePath, mimeType?: any) {
  if (typeof imagePath !== 'string' || !imagePath.trim()) {
    throw new Error('imagePath (a local image file path) is required to upload an image');
  }
  // 1. initializeUpload (routed through the single auth chokepoint).
  const { body } = await linkedinApi('/rest/images?action=initializeUpload', {
    method: 'POST',
    body: { initializeUploadRequest: { owner: ownerUrn } },
  }, provider);
  const uploadUrl = body?.value?.uploadUrl;
  const imageUrn = body?.value?.image;
  if (!uploadUrl || !imageUrn) {
    throw new Error(`LinkedIn image initializeUpload returned no uploadUrl/image (got: ${JSON.stringify(body).slice(0, 200)})`);
  }
  // 2. read bytes + resolve the SAME provider token, then single-request PUT.
  const bytes = readFileSync(imagePath);
  const token = await resolveProviderToken(provider);
  const res = await fetchWithDeadline(uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': mimeType || mimeForPath(imagePath),
    },
    body: bytes,
  }, { kind: 'transfer', what: 'LinkedIn image upload' });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`LinkedIn image upload ${res.status}: ${err.slice(0, 300)}`);
  }
  return imageUrn;
}

export const linkedinSkill: any = {
  id: 'linkedin',
  // Backend-calling: the MCP child talks to Zibby's own backend — the
  // session-env contract is guaranteed by backendSession.ts at registration
  // (declare ONCE here; see backend-session-env-contract.test.ts).
  callsBackend: true,
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

  promptFragment: `## LinkedIn
You can post to LinkedIn two ways — an ORG company Page (business) and your own member PROFILE (personal). Each path needs its own LinkedIn integration connected.

Business (company Page) — DRAFT only:
- linkedin_list_organizations: List the Organizations (company Pages) the member ADMINISTERS. Returns [{ id, urn, name, vanityName }]. Call this first to choose the author org. (needs LinkedIn Business connected)
- linkedin_create_draft_post: Create a DRAFT post on a company Page. Pass organizationId (or organizationUrn) + text (the post commentary). The post is created in DRAFT state (never published automatically) so a human reviews and publishes it in LinkedIn. Returns { postUrn }. Set dry_run:true to VALIDATE which LinkedIn account/profile the post would go to (and preview the text) WITHOUT posting — nothing is published; returns { dryRun, target, wouldPostAs, textPreview }. (needs LinkedIn Business connected)

Personal (your own profile) — PUBLISHES IMMEDIATELY:
- linkedin_publish_post: PUBLISH a post to your OWN member profile feed. Pass text (the post body) + optional visibility ('PUBLIC' default, or 'CONNECTIONS'). UNLIKE the org draft tool, this PUBLISHES the post immediately — LinkedIn has no DRAFT state for member profiles, so there is no human review step. Returns { postUrn }. Set dry_run:true to VALIDATE which member profile the post would publish to (and preview the text) WITHOUT publishing — nothing is posted; returns { dryRun, target, wouldPostAs, textPreview }. Use this to confirm the identity before an approved publish. (needs LinkedIn Personal connected)

Attaching an image (optional, both tools):
- Both linkedin_create_draft_post and linkedin_publish_post accept imagePath (a LOCAL image file path, e.g. a PNG returned by social_card_render) + optional imageAltText. When imagePath is set, the image is uploaded to LinkedIn's Images API (same connected account/token as the post) and attached to the post as its media. On a dry_run nothing is uploaded — the result just reports imageWouldAttach:true.

Notes:
- Org-page posts are ALWAYS created as a DRAFT; personal-profile posts are ALWAYS published live — choose the tool accordingly.
- PUBLISHING IS OUTWARD-FACING AND IRREVERSIBLE. linkedin_publish_post posts live to a real audience the instant you call it — there is no undo and no draft state for member profiles. Only call it after the human has EXPLICITLY approved publishing THIS specific text in THIS conversation. If you wrote or edited the text, show it and get an explicit "yes, publish" first; if you are unsure, HOLD/draft rather than publish. The org draft tool (linkedin_create_draft_post) is the safe default when a human still needs to review.
- If the relevant LinkedIn integration is not connected these tools return { ok:false, error }; treat that as "LinkedIn unavailable" and continue.`,

  resolve() {
    // Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs), pointing it at
    // this module's linkedinSkill export. It registers every entry in tools[]
    // as an MCP tool and dispatches each call through handleToolCall — so the
    // model gets real mcp__linkedin__* tools. The module arg is resolved
    // RELATIVE TO bin/ at runtime → node_modules/@zibby/skills/dist/linkedin.js
    // in a published install (mirrors notion.js / figma.js). The child does
    // NOT inherit the run env — this env is its ENTIRE environment — so BOTH
    // the backend-session allowlist (what resolveIntegrationToken('linkedin_*')
    // needs to call Zibby's backend from inside the child; the
    // github/gitlab/lark trap, see backend-session-env-contract.test.ts) AND
    // the Copilot per-turn injection + fail-CLOSED gate vars are forwarded
    // EXPLICITLY (an env-filtering spawner must never silently drop the safety
    // gate — that would fail open to the owner).
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env: {}, description: this.description };
    const env: any = {};
    for (const k of ['PROJECT_API_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_ENV', 'ZIBBY_INJECTED_LINKEDIN_TOKEN', 'ZIBBY_INJECTED_LINKEDIN_MEMBER_ID', 'ZIBBY_SENDER_IS_NON_OWNER', 'ZIBBY_CHAT_STRICT_PERSONAL']) {
      if (process.env[k]) env[k] = process.env[k];
    }
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/linkedin.js', 'linkedinSkill'],
      env,
      description: this.description,
      // NO `alwaysLoad`: the SDK defers MCP tools behind ToolSearch by design and
      // ToolSearch reaches them — measured, see MCP_TOOL_LOADING.md.
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
          const imagePath = typeof args?.imagePath === 'string' ? args.imagePath.trim() : '';
          const imageAltText = typeof args?.imageAltText === 'string' ? args.imageAltText : '';

          // DRY RUN — validate WHICH org the post would go to (+ preview the
          // text) WITHOUT creating anything. Confirms the caller-passed org
          // id/urn and best-effort resolves the org name via a READ-only call.
          // Never hits /rest/posts, and NEVER uploads the image — so nothing is
          // created; it only reports that an image WOULD attach.
          if (args?.dry_run === true) {
            try {
              let name = '';
              try {
                const org = (await linkedinApi(`/rest/organizations/${id}`, {}, 'linkedin_business')).body;
                name = orgName(org);
              } catch {
                // Org name is best-effort — the caller explicitly passed this
                // org id/urn, so it is the confirmed target regardless.
              }
              return JSON.stringify({
                dryRun: true,
                target: 'organization',
                wouldPostAs: { name, id, urn: author },
                visibility,
                textPreview: text,
                ...(imagePath ? { imageWouldAttach: true, imagePath } : {}),
                note: 'DRY RUN — nothing was posted',
              });
            } catch (e) {
              return JSON.stringify({ dryRun: true, ok: false, error: e.message });
            }
          }

          const requestBody: any = {
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
          // Optional image attachment — upload via the Images API (same
          // business provider/token as the post) and attach the returned URN.
          // Posts API (LinkedIn-Version 202506) shape: content.media = { id, altText }.
          if (imagePath) {
            const imageUrn = await uploadImage('linkedin_business', author, imagePath);
            requestBody.content = { media: { id: imageUrn, altText: imageAltText || '' } };
          }
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
          // PERSONAL / member-profile publish. The author urn is
          // urn:li:person:{memberId}. When the runtime injected the verified
          // sender's identity, the member id comes from the injection (the
          // sender's OWN member id) — NOT from resolveIntegrationToken, whose
          // PAT-inferred account would be the shared project owner's. Otherwise
          // the personal token endpoint returns the resolved member id alongside
          // the token. linkedinApi resolves the token again for the POST (same
          // injected/PAT precedence) — that's fine, tokens are cached.
          // personalTierCredentialGate throws the PERSONAL_REFUSAL on a strict
          // chat turn / flagged non-owner with no injection — same fail-CLOSED
          // contract as linkedinApi (never the owner's PAT-resolved identity).
          const injected = personalTierCredentialGate();
          const memberId = injected
            ? injected.memberId
            : (await resolveIntegrationToken('linkedin_personal')).memberId;
          if (!memberId) {
            return JSON.stringify({ ok: false, error: 'LinkedIn (personal) not connected or member id unavailable — reconnect LinkedIn Personal' });
          }
          const text = args?.text;
          if (typeof text !== 'string' || !text.trim()) {
            return JSON.stringify({ ok: false, error: 'text (the post body) is required' });
          }
          const visibility = args?.visibility ? String(args.visibility).toUpperCase() : 'PUBLIC';
          const author = `urn:li:person:${memberId}`;
          const imagePath = typeof args?.imagePath === 'string' ? args.imagePath.trim() : '';
          const imageAltText = typeof args?.imageAltText === 'string' ? args.imageAltText : '';

          // DRY RUN — validate WHICH member profile the post would publish to
          // (+ preview the text) WITHOUT publishing. Proves WHO the configured
          // token would post as via the READ-only OpenID /v2/userinfo endpoint
          // (the personal provider is a "Sign In with LinkedIn using OpenID
          // Connect" token, so `openid profile` is in scope). Never hits
          // /rest/posts, and NEVER uploads the image — so nothing is published;
          // it only reports that an image WOULD attach.
          if (args?.dry_run === true) {
            try {
              const info = (await linkedinApi('/v2/userinfo', {}, 'linkedin_personal')).body;
              const name =
                info?.name ||
                [info?.given_name, info?.family_name].filter(Boolean).join(' ') ||
                '';
              const id = info?.sub ? String(info.sub) : memberId;
              return JSON.stringify({
                dryRun: true,
                target: 'member',
                wouldPostAs: { name, id, urn: `urn:li:person:${id}` },
                visibility,
                textPreview: text,
                ...(imagePath ? { imageWouldAttach: true, imagePath } : {}),
                note: 'DRY RUN — nothing was posted',
              });
            } catch (e) {
              return JSON.stringify({ dryRun: true, ok: false, error: e.message });
            }
          }

          const requestBody: any = {
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
          // Optional image attachment — upload via the Images API (same
          // personal provider/token/gate as the post) and attach the returned
          // URN. Posts API (LinkedIn-Version 202506): content.media = { id, altText }.
          if (imagePath) {
            const imageUrn = await uploadImage('linkedin_personal', author, imagePath);
            requestBody.content = { media: { id: imageUrn, altText: imageAltText || '' } };
          }
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
      description: 'Create a DRAFT post on a LinkedIn Organization (company Page). The post is created in DRAFT state (never published automatically) so a human can review and publish it in LinkedIn. Returns the created post URN. Optionally ATTACH an image: pass imagePath (a local PNG file path, e.g. one returned by social_card_render) and it is uploaded to LinkedIn and attached to the post. Set dry_run:true to VALIDATE which LinkedIn account/profile the post would go to (and preview the text) WITHOUT posting — nothing is published or uploaded (a set imagePath is reported as imageWouldAttach:true).',
      input_schema: {
        type: 'object',
        properties: {
          organizationId: { type: 'string', description: 'The numeric organization id (e.g. "12345"). Alternative to organizationUrn.' },
          organizationUrn: { type: 'string', description: 'The organization URN, e.g. "urn:li:organization:12345". Alternative to organizationId.' },
          text: { type: 'string', description: 'The post commentary (the body text of the post).' },
          visibility: { type: 'string', enum: ['PUBLIC'], description: 'Post visibility. Defaults to PUBLIC.' },
          imagePath: { type: 'string', description: 'Optional. A LOCAL image file path (e.g. a PNG returned by social_card_render). When set, the image is uploaded to LinkedIn and attached to the post as its media. Not uploaded on a dry_run.' },
          imageAltText: { type: 'string', description: 'Optional alt text for the attached image (accessibility). Only used when imagePath is set.' },
          dry_run: { type: 'boolean', description: 'Set dry_run:true to VALIDATE which LinkedIn account/profile the post would go to (and preview the text) WITHOUT posting — nothing is published or uploaded. Returns { dryRun, target, wouldPostAs, visibility, textPreview, imageWouldAttach? }. Defaults to false.' },
        },
        required: ['text'],
      },
    },
    {
      name: 'linkedin_publish_post',
      description: 'PUBLISH a post to the authenticated member\'s OWN LinkedIn profile feed (personal). UNLIKE linkedin_create_draft_post (which only drafts on a company Page), this PUBLISHES the post IMMEDIATELY — LinkedIn has no DRAFT state for member profiles, so there is no human review step. Returns the created post URN. Requires the LinkedIn Personal integration connected. Optionally ATTACH an image: pass imagePath (a local PNG file path, e.g. one returned by social_card_render) and it is uploaded to LinkedIn and attached to the post. Set dry_run:true to VALIDATE which LinkedIn account/profile the post would go to (and preview the text) WITHOUT posting — nothing is published or uploaded (a set imagePath is reported as imageWouldAttach:true).',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The post body (the commentary text of the post).' },
          visibility: { type: 'string', enum: ['PUBLIC', 'CONNECTIONS'], description: 'Post visibility: PUBLIC (anyone) or CONNECTIONS (your connections only). Defaults to PUBLIC.' },
          imagePath: { type: 'string', description: 'Optional. A LOCAL image file path (e.g. a PNG returned by social_card_render). When set, the image is uploaded to LinkedIn and attached to the post as its media. Not uploaded on a dry_run.' },
          imageAltText: { type: 'string', description: 'Optional alt text for the attached image (accessibility). Only used when imagePath is set.' },
          dry_run: { type: 'boolean', description: 'Set dry_run:true to VALIDATE which LinkedIn account/profile the post would go to (and preview the text) WITHOUT posting — nothing is published or uploaded. Returns { dryRun, target, wouldPostAs, visibility, textPreview, imageWouldAttach? }. Defaults to false.' },
        },
        required: ['text'],
      },
    },
  ],
};
