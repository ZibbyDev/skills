# graph-memory sidecar — the fleet's MEMORY GRAPH engine behind the stable REST
# contract in server-contract.md. The engine is OUR open-source `agent-graph`
# (packages/agent-graph, MIT) running its `agent-graph-server` binary on the
# Postgres driver; Postgres + pgvector are embedded in the SAME container, the
# way the gbrain sidecar embeds its database — one process tree, one `/data`
# volume, no external database to stand up. ONE shared engine per box hosts N
# isolated tenants: every request names its graph by a SERVER-DERIVED
# `graphId` (backend/src/handlers/graph-memory-store.js), never a client one.
#
# BASE: the official pgvector image (Debian, Postgres 16 + the vector
# extension, MIT/PostgreSQL licences). Node 22 is added for the engine
# (agent-graph requires >=22.13).
FROM pgvector/pgvector:pg16

# Node 22 for the engine. curl/gnupg are only needed to add the NodeSource repo
# and are removed again; ca-certificates stays (outbound HTTPS to the embedding
# provider).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get purge -y --auto-remove curl gnupg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The engine, installed from the npm REGISTRY: `package.json` pins
# `@zibby/agent-graph-memory` to an EXACT version (no ^/~) — the same number as
# its `engineVersion` field, which test/declaration.test.js asserts and the
# build-time check below re-verifies against what npm actually RESOLVED. The
# package is public (`npm view @zibby/agent-graph-memory`), so no vendored
# tarball and no registry credential are needed to build this image.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# TWO-PLACES TRIPWIRE (CLAUDE.md): the engine version this image SHIPS must be
# the one package.json SAYS it ships (`engineVersion`), and the server binary
# the entrypoint execs must actually exist. A pin without an assert is a wish.
# The engine's package.json is read by PATH, not by bare specifier: the package
# has an `exports` map that (correctly) does not expose `./package.json`, so
# `require("@zibby/agent-graph-memory/package.json")` throws ERR_PACKAGE_PATH_NOT_EXPORTED
# — which is not a version mismatch and must not be reported as one. Two
# separate asserts so each failure names ITS OWN cause.
RUN node -e ' \
  const got = require("./node_modules/@zibby/agent-graph-memory/package.json").version; \
  const want = require("./package.json").engineVersion; \
  if (got !== want) throw new Error(`@zibby/agent-graph-memory ${got} installed but package.json engineVersion says ${want}`); \
  console.log(`@zibby/agent-graph-memory ${got} ok`);'
RUN test -x node_modules/.bin/agent-graph-server \
    || (echo "agent-graph-server binary missing from the installed @zibby/agent-graph-memory — does the published package still declare it under package.json bin?" && exit 1)
# The Postgres driver loads `pg` lazily (an OPTIONAL peer of the engine, so a
# SQLite-only install stays dependency-free); this image declares it as a real
# dependency and asserts it resolves, or the first request would 500.
RUN node -e 'require.resolve("pg"); console.log("pg ok")'

COPY entrypoint.sh server-contract.md README.md ./
RUN chmod +x /app/entrypoint.sh

# DURABLE STATE LIVES AT /data — ONE path, every sidecar (north-star #9). The
# declared `dataPath` in the template's sidecar-spec.mjs and the PGDATA the
# entrypoint writes are the SAME string; nothing cross-checks them, so this is
# asserted by packages/skills/sidecars/graph-memory/test/declaration.test.js.
# Owned by `postgres` here so the named volume Docker seeds from this directory
# is writable WITHOUT any capability grant (no chown at start ⇒ no capAdd).
RUN mkdir -p /data && chown -R postgres:postgres /data
VOLUME ["/data"]
ENV PGDATA=/data/pg
ENV PORT=8093
ENV PATH="/app/node_modules/.bin:${PATH}"

# Single-user image: everything (initdb, postgres, the engine) runs as the
# unprivileged postgres user, so the manager's CapDrop-ALL baseline is enough.
USER postgres

EXPOSE 8093

# The engine's own health route (server-contract.md: GET /health → {ok, driver,
# version}); node so no extra binary is kept in the image for the probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8093) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

ENTRYPOINT ["/app/entrypoint.sh"]
