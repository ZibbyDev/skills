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

| door | origin | trusted |
|---|---|---|
| `/mcp/agent/<uuid>` graph tools (a model's editor / a fleet member via `endpoint:graph-memory/mcp`) | `agent:<owning workflowType>` | `false` |
| `/datasets/stores/:id/<op>` (the `graph-memory` skill inside a run) | `agent:<owning workflowType>` (resolved from the store's owner row) | `false` |
| a platform-originated write (none today) | the platform component | `true` |

So a model-facing call can only write `provenance: 'claimed'` — an `observed`
claim is refused by the engine with a `403 PermissionError` naming the fix.

## Data

Everything durable is under `/data` (`PGDATA=/data/pg`), the ONE path every
sidecar mounts its named volume at. The declared `dataPath` in
`packages/workflow-templates/graph-memory/sidecar-spec.mjs` must be the same
string — asserted by `test/declaration.test.js`.
