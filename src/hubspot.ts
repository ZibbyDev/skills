import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve as resolvePath } from 'path';
import { resolveIntegrationToken } from '@zibby/core/backend-client.js';
import { INTEGRATIONS } from './integrations.js';
import { fetchWithDeadline } from './lib/http-deadline.js';

/**
 * HubSpot CRM skill — search/read/create/update CRM objects (contacts,
 * companies, deals, tickets, notes, tasks, feedback submissions, custom
 * objects) over the HubSpot REST API.
 *
 * Mirrors figma.js (the hand-written generic-bin skill: a `tools[]` array +
 * a `handleToolCall` switch, served over MCP by bin/mcp-skill.mjs).
 *
 * Auth: HubSpot is a first-class OAuth 2.0 integration. The token is resolved
 * per-call via resolveIntegrationToken('hubspot') — the backend
 * (handlers/hubspot.js + integration-tokens.js) auto-refreshes the short-lived
 * access token from the stored refresh token and returns a currently-valid
 * bearer. It authenticates with the standard `Authorization: Bearer <token>`
 * header. Declaring requiresIntegration gates deploy on a connected HubSpot
 * integration (mirrored in backend skill-integrations.js → INTEGRATIONS.HUBSPOT).
 * Identical to how figma.js resolves its token — the backend abstracts
 * token-vs-OAuth, so the skill doesn't care.
 */

function resolveSkillBin() {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

/**
 * Single chokepoint for every HubSpot REST call. Resolves a currently-valid
 * OAuth access token via the backend (auto-refreshed on/near expiry), issues
 * the request with a Bearer header, and throws a trimmed error on non-2xx so
 * handleToolCall can surface it as JSON. Tolerates an empty body (e.g. some
 * association writes).
 */
async function hubspotFetch(path, opts: any = {}) {
  const { token } = await resolveIntegrationToken('hubspot');
  if (!token) {
    throw new Error('HubSpot not connected — Connect HubSpot in Integrations.');
  }
  const url = path.startsWith('https://') ? path : `https://api.hubapi.com${path}`;
  const headers: any = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
  };
  const res = await fetchWithDeadline(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }, { kind: 'api', what: `HubSpot ${opts.method || 'GET'} ${path}` });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    const hint = (res.status === 401 || res.status === 403)
      ? ' — token invalid/expired or missing the required Private App scope for this object'
      : '';
    throw new Error(`HubSpot API ${res.status}${hint}: ${err.slice(0, 300)}`);
  }
  // Tolerate an empty body (204 No Content, or a write that returns nothing).
  const text = await res.text().catch(() => '');
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/** Validate an objectType arg: must be a non-empty string. Returns it trimmed, or null. */
function normalizeObjectType(objectType) {
  if (typeof objectType !== 'string') return null;
  const t = objectType.trim();
  return t || null;
}

/** Build a `?properties=a,b&...` query string from an optional properties list/CSV + extras. */
function buildQuery(properties, extra: any = {}) {
  const params = new URLSearchParams();
  if (properties != null) {
    const csv = Array.isArray(properties) ? properties.join(',') : String(properties);
    if (csv) params.set('properties', csv);
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v != null && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

const OBJECT_TYPE_DESC = 'The CRM object type — one of the common values '
  + '`contacts`, `companies`, `deals`, `tickets`, `notes`, `tasks`, '
  + '`feedback_submissions` (customer feedback: NPS/CSAT/CES), or any custom '
  + 'object name/id.';

export const hubspotSkill: any = {
  id: 'hubspot',
  // Backend-calling: the MCP child talks to Zibby's own backend — the
  // session-env contract is guaranteed by backendSession.ts at registration
  // (declare ONCE here; see backend-session-env-contract.test.ts).
  callsBackend: true,
  serverName: 'hubspot',
  allowedTools: ['mcp__hubspot__*'],
  // HubSpot is a first-class OAuth integration. The backend connect handler
  // (backend/src/handlers/hubspot.js) stores the OAuth tokens and the skill
  // resolves a valid access token at runtime via
  // resolveIntegrationToken('hubspot'). Declaring this gates deploy on a
  // connected HubSpot integration (mirrored in
  // backend/src/services/skill-integrations.js → INTEGRATIONS.HUBSPOT).
  requiresIntegration: INTEGRATIONS.HUBSPOT,
  // The OAuth access token is resolved per-call via the backend — and THAT
  // call is why these keys exist: resolveIntegrationToken() authenticates to
  // Zibby's backend with the session credential, and envKeys IS the spawned
  // MCP child's ENTIRE environment (resolve() copies only these keys), so
  // without them every mcp__hubspot__* call dies in the child with a
  // misleading session error (the github/gitlab/lark trap — see
  // backend-session-env-contract.test.ts).
  envKeys: ['PROJECT_API_TOKEN', 'ZIBBY_ACCOUNT_API_URL', 'ZIBBY_ENV'],
  description: 'HubSpot CRM — search/read/create/update contacts, companies, deals, tickets, notes and feedback submissions via the HubSpot REST API.',

  promptFragment: `## HubSpot CRM
You have access to the user's HubSpot CRM via the HubSpot REST API (OAuth — the user connects HubSpot in Integrations; the token is resolved and auto-refreshed for you). The connected app grants the CRM scopes for the objects you touch.

HubSpot's object model is **uniform** — nearly every tool takes an \`objectType\` (\`contacts\`, \`companies\`, \`deals\`, \`tickets\`, \`notes\`, \`tasks\`, \`feedback_submissions\`, or a custom object). Records are \`{ id, properties }\`; you set/read named properties.

**Before you create/update/search, call \`hubspot_list_properties\` to learn the valid property names for that object type** (they're not guessable). \`feedback_submissions\` is where NPS/CSAT/CES customer-feedback survey responses live.

### Identity
- hubspot_whoami: Confirm the token works — returns the portal (hub) id, account type, time zone, UI domain.

### Schema
- hubspot_list_properties: List the defined properties (name, label, type, fieldType) for an objectType. Do this first so you use real property names.

### Read
- hubspot_search: Search an objectType by full-text \`query\` OR structured \`filters\` (array of {propertyName, operator, value}). Returns { total, results:[{id, properties}] }.
- hubspot_get_object: Fetch one record by id (optionally selecting specific properties).
- hubspot_list_objects: Page through all records of an objectType (limit + after cursor).

### Write
- hubspot_create_object: Create a record from a \`properties\` object.
- hubspot_update_object: Patch a record's \`properties\` by id.
- hubspot_create_note: Convenience — log a note (hs_note_body) and optionally associate it to a contact/company/deal/ticket.
- hubspot_associate: Associate two records (fromType/fromId ↔ toType/toId) with the default association type.`,

  resolve() {
    // Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs), pointing it at
    // this module's hubspotSkill export. It registers every entry in tools[]
    // as an MCP tool and dispatches each call through handleToolCall — so the
    // model gets real mcp__hubspot__* tools. The module arg is resolved
    // RELATIVE TO bin/ at runtime → node_modules/@zibby/skills/dist/hubspot.js
    // in a published install (mirrors figma.js importing ../dist/<mod>.js).
    // envKeys carries the backend-session allowlist hubspotFetch's
    // resolveIntegrationToken() call needs INSIDE the child (see envKeys).
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env: {}, description: this.description };
    const env: any = {};
    for (const key of this.envKeys) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/hubspot.js', 'hubspotSkill'],
      env,
      description: this.description,
      // NO `alwaysLoad`: the SDK defers MCP tools behind ToolSearch by design and
      // ToolSearch reaches them — measured, see MCP_TOOL_LOADING.md.
    };
  },

  async handleToolCall(name, args) {
    try {
      const a = args || {};
      switch (name) {
        case 'hubspot_whoami': {
          const info = await hubspotFetch('/account-info/v3/details');
          return JSON.stringify({
            portalId: info.portalId,
            accountType: info.accountType,
            timeZone: info.timeZone,
            uiDomain: info.uiDomain,
            companyCurrency: info.companyCurrency,
          });
        }

        case 'hubspot_list_properties': {
          const objectType = normalizeObjectType(a.objectType);
          if (!objectType) return JSON.stringify({ error: 'objectType is required (e.g. contacts, companies, deals, tickets, feedback_submissions)' });
          const data = await hubspotFetch(`/crm/v3/properties/${encodeURIComponent(objectType)}`);
          const properties = (data.results || []).map((p) => ({
            name: p.name,
            label: p.label,
            type: p.type,
            fieldType: p.fieldType,
          }));
          return JSON.stringify({ objectType, count: properties.length, properties });
        }

        case 'hubspot_search': {
          const objectType = normalizeObjectType(a.objectType);
          if (!objectType) return JSON.stringify({ error: 'objectType is required' });
          const limit = Number.isFinite(Number(a.limit)) && Number(a.limit) > 0 ? Math.trunc(Number(a.limit)) : 20;
          const body: any = { limit };
          if (a.query) body.query = String(a.query);
          if (Array.isArray(a.filters) && a.filters.length) {
            body.filterGroups = [{ filters: a.filters }];
          }
          if (a.properties != null) {
            body.properties = Array.isArray(a.properties) ? a.properties : String(a.properties).split(',').map((s) => s.trim()).filter(Boolean);
          }
          const data = await hubspotFetch(`/crm/v3/objects/${encodeURIComponent(objectType)}/search`, { method: 'POST', body });
          return JSON.stringify({
            total: data.total ?? (data.results ? data.results.length : 0),
            results: (data.results || []).map((r) => ({ id: r.id, properties: r.properties })),
          });
        }

        case 'hubspot_get_object': {
          const objectType = normalizeObjectType(a.objectType);
          if (!objectType) return JSON.stringify({ error: 'objectType is required' });
          if (!a.id) return JSON.stringify({ error: 'id is required' });
          const qs = buildQuery(a.properties, { associations: a.associations });
          const data = await hubspotFetch(`/crm/v3/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(a.id)}${qs}`);
          return JSON.stringify({ id: data.id, properties: data.properties, ...(data.associations ? { associations: data.associations } : {}) });
        }

        case 'hubspot_list_objects': {
          const objectType = normalizeObjectType(a.objectType);
          if (!objectType) return JSON.stringify({ error: 'objectType is required' });
          const limit = Number.isFinite(Number(a.limit)) && Number(a.limit) > 0 ? Math.trunc(Number(a.limit)) : 20;
          const qs = buildQuery(a.properties, { limit, after: a.after });
          const data = await hubspotFetch(`/crm/v3/objects/${encodeURIComponent(objectType)}${qs}`);
          return JSON.stringify({
            results: (data.results || []).map((r) => ({ id: r.id, properties: r.properties })),
            paging: data.paging || null,
          });
        }

        case 'hubspot_create_object': {
          const objectType = normalizeObjectType(a.objectType);
          if (!objectType) return JSON.stringify({ error: 'objectType is required' });
          if (!a.properties || typeof a.properties !== 'object' || Array.isArray(a.properties)) {
            return JSON.stringify({ error: 'properties is required (an object of { propertyName: value } — call hubspot_list_properties first for valid names)' });
          }
          const data = await hubspotFetch(`/crm/v3/objects/${encodeURIComponent(objectType)}`, { method: 'POST', body: { properties: a.properties } });
          return JSON.stringify({ id: data.id, properties: data.properties });
        }

        case 'hubspot_update_object': {
          const objectType = normalizeObjectType(a.objectType);
          if (!objectType) return JSON.stringify({ error: 'objectType is required' });
          if (!a.id) return JSON.stringify({ error: 'id is required' });
          if (!a.properties || typeof a.properties !== 'object' || Array.isArray(a.properties)) {
            return JSON.stringify({ error: 'properties is required (an object of { propertyName: value })' });
          }
          const data = await hubspotFetch(`/crm/v3/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(a.id)}`, { method: 'PATCH', body: { properties: a.properties } });
          return JSON.stringify({ id: data.id, properties: data.properties });
        }

        case 'hubspot_create_note': {
          if (!a.body || typeof a.body !== 'string') {
            return JSON.stringify({ error: 'body is required (the note text)' });
          }
          // hs_timestamp is required by HubSpot. Accept an ISO `timestamp` arg;
          // otherwise default to now (guarded so a locked-down runtime can't
          // crash the whole call).
          let timestamp = typeof a.timestamp === 'string' && a.timestamp ? a.timestamp : null;
          if (!timestamp) {
            try { timestamp = new Date().toISOString(); } catch { timestamp = null; }
          }
          if (!timestamp) return JSON.stringify({ error: 'timestamp is required (pass an ISO 8601 string, e.g. 2026-01-01T00:00:00.000Z)' });
          const created = await hubspotFetch('/crm/v3/objects/notes', {
            method: 'POST',
            body: { properties: { hs_note_body: a.body, hs_timestamp: timestamp } },
          });
          const noteId = created.id;
          // Optionally associate the note to CRM records.
          const targets = [
            ['contacts', a.contactId],
            ['companies', a.companyId],
            ['deals', a.dealId],
            ['tickets', a.ticketId],
          ].filter(([, id]: any) => id != null && id !== '');
          const associatedTo = [];
          for (const [toType, toId] of targets) {
            try {
              await hubspotFetch(`/crm/v4/objects/notes/${encodeURIComponent(noteId)}/associations/default/${toType}/${encodeURIComponent(toId)}`, { method: 'PUT' });
              associatedTo.push({ toType, toId: String(toId) });
            } catch (e) {
              associatedTo.push({ toType, toId: String(toId), error: e.message });
            }
          }
          return JSON.stringify({ id: noteId, properties: created.properties, associatedTo });
        }

        case 'hubspot_associate': {
          const fromType = normalizeObjectType(a.fromType);
          const toType = normalizeObjectType(a.toType);
          if (!fromType || !a.fromId || !toType || !a.toId) {
            return JSON.stringify({ error: 'fromType, fromId, toType and toId are all required' });
          }
          await hubspotFetch(`/crm/v4/objects/${encodeURIComponent(fromType)}/${encodeURIComponent(a.fromId)}/associations/default/${encodeURIComponent(toType)}/${encodeURIComponent(a.toId)}`, { method: 'PUT' });
          return JSON.stringify({ ok: true });
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
      name: 'hubspot_whoami',
      description: 'Confirm the HubSpot token works: returns the portal (hub) id, account type, time zone and UI domain.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'hubspot_list_properties',
      description: 'List the defined properties (name, label, type, fieldType) for a CRM object type. Call this FIRST so you use valid property names when creating/updating/searching.',
      input_schema: {
        type: 'object',
        properties: {
          objectType: { type: 'string', description: OBJECT_TYPE_DESC },
        },
        required: ['objectType'],
      },
    },
    {
      name: 'hubspot_search',
      description: 'Search a CRM object type. Pass a full-text `query` OR structured `filters` (array of {propertyName, operator, value}, e.g. operator EQ/CONTAINS_TOKEN/GT/…). Returns { total, results:[{id, properties}] }.',
      input_schema: {
        type: 'object',
        properties: {
          objectType: { type: 'string', description: OBJECT_TYPE_DESC },
          query: { type: 'string', description: 'Optional full-text search string.' },
          filters: {
            type: 'array',
            description: 'Optional structured filters (ANDed). Each: { propertyName, operator, value }. Operators: EQ, NEQ, LT, LTE, GT, GTE, CONTAINS_TOKEN, HAS_PROPERTY, IN, …',
            items: {
              type: 'object',
              properties: {
                propertyName: { type: 'string' },
                operator: { type: 'string' },
                value: { type: 'string' },
              },
            },
          },
          properties: { type: 'array', items: { type: 'string' }, description: 'Optional: property names to return on each result.' },
          limit: { type: 'number', description: 'Max results (default 20).' },
        },
        required: ['objectType'],
      },
    },
    {
      name: 'hubspot_get_object',
      description: 'Fetch one CRM record by id. Returns { id, properties }.',
      input_schema: {
        type: 'object',
        properties: {
          objectType: { type: 'string', description: OBJECT_TYPE_DESC },
          id: { type: 'string', description: 'The record id.' },
          properties: { type: 'array', items: { type: 'string' }, description: 'Optional: specific property names to return.' },
          associations: { type: 'string', description: 'Optional: comma-separated object types to also return associations for (e.g. "companies,deals").' },
        },
        required: ['objectType', 'id'],
      },
    },
    {
      name: 'hubspot_list_objects',
      description: 'Page through records of a CRM object type. Returns { results, paging } — pass paging.next.after back as `after` for the next page.',
      input_schema: {
        type: 'object',
        properties: {
          objectType: { type: 'string', description: OBJECT_TYPE_DESC },
          properties: { type: 'array', items: { type: 'string' }, description: 'Optional: property names to return on each record.' },
          limit: { type: 'number', description: 'Page size (default 20).' },
          after: { type: 'string', description: 'Optional paging cursor from a previous response (paging.next.after).' },
        },
        required: ['objectType'],
      },
    },
    {
      name: 'hubspot_create_object',
      description: 'Create a CRM record. Pass `properties` as an object of { propertyName: value } (call hubspot_list_properties first for valid names). Returns { id, properties }.',
      input_schema: {
        type: 'object',
        properties: {
          objectType: { type: 'string', description: OBJECT_TYPE_DESC },
          properties: { type: 'object', description: 'Object of { propertyName: value } to set on the new record.' },
        },
        required: ['objectType', 'properties'],
      },
    },
    {
      name: 'hubspot_update_object',
      description: 'Update (PATCH) a CRM record by id. Pass `properties` as an object of { propertyName: value }. Returns { id, properties }.',
      input_schema: {
        type: 'object',
        properties: {
          objectType: { type: 'string', description: OBJECT_TYPE_DESC },
          id: { type: 'string', description: 'The record id to update.' },
          properties: { type: 'object', description: 'Object of { propertyName: value } to change.' },
        },
        required: ['objectType', 'id', 'properties'],
      },
    },
    {
      name: 'hubspot_create_note',
      description: 'Log a note (hs_note_body) and optionally associate it to a contact/company/deal/ticket. Returns { id, associatedTo }.',
      input_schema: {
        type: 'object',
        properties: {
          body: { type: 'string', description: 'The note text (stored as hs_note_body).' },
          contactId: { type: 'string', description: 'Optional: associate the note to this contact id.' },
          companyId: { type: 'string', description: 'Optional: associate the note to this company id.' },
          dealId: { type: 'string', description: 'Optional: associate the note to this deal id.' },
          ticketId: { type: 'string', description: 'Optional: associate the note to this ticket id.' },
          timestamp: { type: 'string', description: 'Optional ISO 8601 timestamp for the note (defaults to now).' },
        },
        required: ['body'],
      },
    },
    {
      name: 'hubspot_associate',
      description: 'Associate two CRM records with the default association type (e.g. a contact to a company). Returns { ok:true }.',
      input_schema: {
        type: 'object',
        properties: {
          fromType: { type: 'string', description: 'Source object type (e.g. contacts).' },
          fromId: { type: 'string', description: 'Source record id.' },
          toType: { type: 'string', description: 'Target object type (e.g. companies).' },
          toId: { type: 'string', description: 'Target record id.' },
        },
        required: ['fromType', 'fromId', 'toType', 'toId'],
      },
    },
  ],
};
