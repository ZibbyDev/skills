# graph-memory sidecar — server contract

The container runs `agent-graph-server` (from the open-source `agent-graph`
package, `packages/agent-graph`) on the Postgres driver, listening on `PORT`
(8093). The control-plane (`backend/src/handlers/graph-memory-store.js`) is the
ONLY caller; run containers never dial it (they go through the token-gated
`/datasets/stores/:storeId/<op>` route, exactly like the gbrain KB).

## Routes

```
GET  /health              → 200 { ok, driver, version }
POST /graph/<op>          → 200 <tool result>            (op below)
                          → 4xx/5xx { error: { name, message } }
```

`op` ∈ `put`, `link`, `supersede`, `match`, `get`, `recall`, `recall_many`,
`subgraph`, `trace`, `trace_edge`, `stats`, `reembed`, `drop`.

Every op body:

```jsonc
{
  "graphId": "<accountId>:<projectId>:<storeId>",   // SERVER-DERIVED by the control-plane, never client-supplied
  "origin": "agent:<workflowType>",                  // who is writing (omitted on reads)
  "trusted": false,                                  // only a PLATFORM writer may set true → may write provenance 'observed'
  "privileged": false,                               // may supersede / relabel another origin's records
  "readOnly": true,                                  // set on read ops
  "embedding": {                                     // optional — per-request, from the OWNING AGENT's encrypted env bag
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "…",
    "model": "text-embedding-3-small",
    "dims": 1536,
    "text": "label" | "label+attrs" | { "attrs": ["…"] },   // from the template's memoryPolicy.embed
    "kinds": ["…"],                                          // only embed nodes of these kinds
    "maxChars": 2000
  },
  ...toolArgs                                        // the op's arguments: packages/agent-graph/src/tools.ts inputSchemas
}
```

- `drop` additionally requires `"confirm": true` and erases the WHOLE graph.
- `stats` answers `{ nodes, edges, …, bytes }`; the control-plane's size probe
  reads `bytes` (→ sizeBytes) and `nodes` (→ docCount).
- Errors: `400` validation / guard rejection (`ValidationError`, `GuardError`),
  `401` bad or missing bearer, `403` `PermissionError` (wrong origin, `observed`
  from an untrusted handle), `404` unknown id, `500` engine failure.
- Auth: when the server was started with `--auth-token <t>`, every request must
  carry `Authorization: Bearer <t>`. The entrypoint passes it iff the container
  env has `SIDECAR_AUTH_TOKEN` (the control-plane forwards `spec.env.SIDECAR_AUTH_TOKEN`).

## Provenance and trust — where the flag is decided

`trusted` is decided by the CONTROL-PLANE per call site, never by the caller:

| door / caller | origin | trusted |
|---|---|---|
| `/mcp/agent/<uuid>` graph tools reached THROUGH THE BROKER by ANY run of the project — the link's holder or an agent that uses it (`inherit: 'parent'`), however the run was started (the broker serves a run only a row of its own project) | `run:<executionId>` (its own run, not the owner's name) | `true` |
| `/mcp/agent/<uuid>` graph tools from a PAT / the endpoint's own bearer (a model's editor, a human), or any broker hop that is not a run | `agent:<owning workflowType>` | `false` |
| `/datasets/stores/:id/<op>` from ANY run of the project (its run-scoped token carries a signed `executionId`; the execution row is read under the caller's project) | `run:<executionId>` | `true` |
| `/datasets/stores/:id/<op>` from a caller that names no run (a project/console token) | `agent:<owning workflowType>` (resolved from the store's owner row) | `false` |
| a run whose identity does not resolve to an agent row in its project | — | refused (403 `RUN_IDENTITY_UNRESOLVED`) before anything is forwarded |

The decision is ONE pure function, `writerIdentity()` in
`backend/src/handlers/graph-memory-store.js`, fed by both doors: `datasets.js`
(`resolveTenant` → `executionId`, `resolveGraphWriter` → the execution row +
the owner) and `mcp-agent-store.js` (`dispatchGraphToolCall` → the broker's
SIGNED caller stamp, `services/caller-agent-stamp.js` `run: { executionId }`,
which the broker mints from the SAME identity chain that computes the
inherited-link tool allowlist — `services/inherited-links.js
resolveCallerLink`: run token → executionId → execution row → workflowUuid →
that agent's `requires` entry for the entry's alias). So every run of the
project may write `observed` (founder, 2026-10-25: "All agents should be able
to write to the team memory graph"), while a caller that is not a run (a
model's editor on a PAT, a person's console token) can only write
`provenance: 'claimed'` — an `observed` claim from it is refused by the engine
with a `403 PermissionError` naming the fix.

## `privileged`, and the relation tools

`privileged` never comes from a caller and is never set for a plain graph op.
Its one user is the control plane's relation module
(`backend/src/services/graph-relations.js` — the `relation_*` tools of
`backend/src/services/relation-tools.js`, on both doors): retiring or restating
an assertion is decided THERE (a maintainer may retire any; anyone else only a
proposal their own agent made), and because a later run of the same agent is
another origin to the engine, that module asks for a privileged handle for
exactly those `supersede` calls.

The relation tools add NO route and NO field to this contract: a relation is a
set of assertions, each one live edge whose `attrs.relation` carries
`{ v, assertion, op, name, source: { kind, ref? }, external, standing, state,
author: { agent, run }, at, why, quote?, confirmed?, overruled? }`, written with
`link` / `supersede` and read with `trace` / `subgraph` / `get` / `stats`. An
overruled assertion is restated under the engine relation name
`overruled:<relation>`. Every write is saved in the control plane's own storage
before it is applied here, and re-applied after a failure with the SAME
`origin` / `trusted` the control plane established the first time — so this
server may see the same logical write attempted again; the module looks for
the assertion id on the subject's `trace` first and does not write it twice.

### The platform's own record in a graph

The relation module keeps ONE node of its own in a graph it writes relations
to: `platform:relation-log/position` (kind `platform`), written with `put`
under the origin `platform:relation-log` with `privileged: true`, never
embedded. Its `attrs.applied` is how many relation operations the graph holds,
signed (`attrs.sig`) so only the control plane's word counts. A graph that
says less than the control plane's record — restored to an older state, or
empty — gets the missing operations carried out again, in order, each with
its original `origin` / `trusted`. The control plane keeps this node out of
everything the plain graph tools return and refuses a plain write that names
an id under `platform:relation-log/`; `stats` still counts it (one node, one
version per update).

## Data

Everything durable is under `/data` (`PGDATA=/data/pg`), the ONE path every
sidecar mounts its named volume at. The declared `dataPath` in
`packages/workflow-templates/graph-memory/sidecar-spec.mjs` must be the same
string — asserted by `test/declaration.test.js`.
