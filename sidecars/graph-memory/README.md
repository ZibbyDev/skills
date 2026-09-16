# graph-memory sidecar

The fleet's memory GRAPH as a sidecar-backed store type — gbrain's shape with
our open-source engine (`packages/agent-graph`) inside instead of GBrain.

| | gbrain (reference) | graph-memory |
|---|---|---|
| store type | `postgres` | `graph-memory` |
| engine | GBrain CLI (Bun) + PGlite/pgvector | `agent-graph-server` (Node 22) + Postgres 16/pgvector |
| tenant key | `kbId = account:project:storeId` | `graphId = account:project:storeId` |
| REST | `/ingest /query /delete /stat /drop /compact` | `/graph/<op>` (server-contract.md) |
| durable state | `/data` | `/data` (`PGDATA=/data/pg`) |
| per-request config | `withEmbedding` (model/key/dims from the agent's env bag) | `embedding` block in every request body |
| control-plane engine | `backend/src/handlers/postgres-store.js` | `backend/src/handlers/graph-memory-store.js` |
| registration | built-in (`sidecar-registry.js gbrainSpec`) | template-carried (`packages/workflow-templates/graph-memory/sidecar-spec.mjs`) |

## Build (not run by CI yet)

```bash
cd packages/skills/sidecars/graph-memory
npm run vendor                 # npm pack ../../../agent-graph → vendor/agent-graph-0.1.0.tgz
docker build -t custom-sidecar-graph-memory:0.1.0 .
docker run --rm -p 8093:8093 -v graph-memory-data:/data custom-sidecar-graph-memory:0.1.0
curl -s localhost:8093/health
```

The image tag is what the box's installer expects for a TEMPLATE-CARRIED
sidecar (`custom-sidecar-<name>:<version>` — `sidecar-registry.publishImageRef`);
the publish script resolves it, never spell it by hand.

## Publish (both architectures, from any machine with docker + aws)

```bash
bash selfhosted/dist/publish-sidecar.sh graph-memory 0.1.0 --arch amd64
bash selfhosted/dist/publish-sidecar.sh graph-memory 0.1.0 --arch arm64
```

Then copy the printed `version / s3Url / sha256 / bytes` (both arches) into
`packages/workflow-templates/graph-memory/sidecar-spec.mjs` in the SAME change
— `selfhosted/sidecar/__tests__/sidecar-pin-parity.test.js` stays red until the
spec and `sidecar-versions.json` agree.

## Tests

`npm test` runs the declaration tripwires (`/data` parity, port parity, version
parity with the template spec and the vendored engine tarball). Engine behaviour
is tested in `packages/agent-graph`.
