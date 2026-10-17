# graph-memory sidecar — the fleet's MEMORY GRAPH engine behind the stable REST
# contract in server-contract.md. The engine is OUR open-source `agent-graph`
# (packages/agent-graph, MIT) running its `agent-graph-server` binary on the
# Postgres driver; Postgres + pgvector are embedded in the SAME container, the
# way the gbrain sidecar embeds its database — one process tree, one `/data`
# volume, no external database to stand up. ONE shared engine per box hosts N
# isolated tenants: every request names its graph by a SERVER-DERIVED
# `graphId` (backend/src/handlers/graph-memory-store.js), never a client one.
#
# BASE: Alpine with its own Postgres 16 + Node 22 packages, pgvector compiled in
# a throw-away stage so no compiler ships. Until 0.1.1 the base was the Debian
# `pgvector/pgvector:pg16` image + NodeSource Node (~690 MB unpacked, ~220 MB
# download); the same Postgres 16 / Node 22 / pgvector here is a fraction of
# that, chiefly by leaving out what this container never uses: the LLVM JIT
# (postgresql16-jit is a separate apk and is not installed), the full ICU data
# set, npm, and the build toolchain.
#
# DATA-DIR COMPATIBILITY with volumes created by the Debian image (an upgraded
# box opens the SAME /data volume):
#   - Postgres MAJOR stays 16 (on-disk format); asserted below.
#   - the `postgres` user keeps uid/gid 999 — the Debian image's ids, which own
#     every existing /data/pg; Alpine's package would otherwise create uid 70
#     and Postgres refuses a data dir it does not own. Pinned by
#     test/declaration.test.js.
#   - collation: musl has no glibc collations, but the engine declares every
#     TEXT column `COLLATE "C"` (byte order, libc-independent), so no index the
#     engine builds depends on the libc locale (checked on a 0.1.1 cluster: zero
#     indexes on the database default collation). The one visible difference:
#     an old cluster still carries glibc's collation-version stamp ("2.36"),
#     which musl cannot report, so Postgres logs `database "graph" has no actual
#     collation version, but a version was recorded` per connection — a WARNING
#     only. `REFRESH COLLATION VERSION` refuses that change on musl, and editing
#     the catalog by hand is not worth silencing a log line.
ARG ALPINE_VERSION=3.22
ARG PGVECTOR_VERSION=0.8.6

# ── pgvector, built against the SAME postgresql16 the runtime installs ───────
FROM alpine:${ALPINE_VERSION} AS pgvector
ARG PGVECTOR_VERSION
# postgresql16 itself is installed for ITS pg_config (/usr/libexec/postgresql16);
# the /usr/bin/pg_config that -dev drags in via libpq-dev is the 17 client's.
RUN apk add --no-cache build-base git postgresql16 postgresql16-dev
RUN git clone --branch "v${PGVECTOR_VERSION}" --depth 1 https://github.com/pgvector/pgvector.git /src/pgvector
WORKDIR /src/pgvector
# OPTFLAGS="" — pgvector's default is -march=native, which would bake the BUILD
# machine's CPU into vector.so (SIGILL on an older box). with_llvm=no: no JIT
# bitcode, the runtime has no JIT.
RUN make PG_CONFIG=/usr/libexec/postgresql16/pg_config OPTFLAGS="" with_llvm=no \
    && make PG_CONFIG=/usr/libexec/postgresql16/pg_config OPTFLAGS="" with_llvm=no install DESTDIR=/out

# ── the engine's node_modules (npm stays in this stage) ──────────────────────
FROM alpine:${ALPINE_VERSION} AS deps
RUN apk add --no-cache nodejs npm
WORKDIR /app
# The engine, installed from the npm REGISTRY: `package.json` pins
# `@zibby/agent-graph-memory` to an EXACT version (no ^/~) — the same number as
# its `engineVersion` field, which test/declaration.test.js asserts and the
# build-time check below re-verifies against what npm actually RESOLVED. The
# package is public (`npm view @zibby/agent-graph-memory`), so no vendored
# tarball and no registry credential are needed to build this image. Both the
# engine and `pg` are pure JavaScript (no native addon), so musl is no concern.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --no-package-lock

# ── runtime ──────────────────────────────────────────────────────────────────
FROM alpine:${ALPINE_VERSION}
ARG PGVECTOR_VERSION

# uid/gid 999 BEFORE the package install (its pre-install script keeps an
# existing user) — see DATA-DIR COMPATIBILITY above. Alpine's base gives gid 999
# to an unused `ping` group; it is removed so the ids match the old image's.
RUN delgroup ping \
    && addgroup -S -g 999 postgres \
    && adduser -S -D -u 999 -G postgres -h /var/lib/postgresql -s /bin/sh postgres

# bash: the entrypoint's shell. ca-certificates: outbound HTTPS to the embedding
# provider. Node is Alpine's own build (same 22.x line the engine requires,
# >=22.13); Postgres is the 16 series.
RUN apk add --no-cache postgresql16 nodejs bash ca-certificates

COPY --from=pgvector /out/usr/lib/postgresql16/ /usr/lib/postgresql16/
COPY --from=pgvector /out/usr/share/postgresql16/extension/ /usr/share/postgresql16/extension/

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./

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

# Postgres major + pgvector: start a throw-away cluster and ask the SERVER —
# proves the major is 16 (existing /data volumes are 16 clusters), that the
# vector.so built above actually LOADS in this runtime, and that the extension
# version a fresh `CREATE EXTENSION vector` installs is PGVECTOR_VERSION (an
# existing cluster records its extension version in its catalog; a different
# default here would leave it on scripts this image does not carry).
USER postgres
RUN set -e; d="$(mktemp -d)"; \
    initdb -D "$d" --auth=trust --username=graph --no-instructions >/dev/null; \
    pg_ctl -D "$d" -w -l "$d/log" -o "-c listen_addresses='' -c unix_socket_directories=$d" start >/dev/null; \
    got="$(psql -h "$d" -U graph -d postgres -v ON_ERROR_STOP=1 -qtA -c "CREATE EXTENSION vector" \
      -c "SELECT current_setting('server_version_num')::int / 10000 || ' ' || extversion FROM pg_extension WHERE extname = 'vector'")"; \
    pg_ctl -D "$d" -m fast -w stop >/dev/null; rm -rf "$d"; \
    [ "$got" = "16 ${PGVECTOR_VERSION}" ] \
      || { echo "expected Postgres 16 + pgvector ${PGVECTOR_VERSION}, the server reports: $got"; exit 1; }; \
    echo "postgres major + pgvector: $got ok"
USER root

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
# The Debian base set this; a new cluster gets the same locale names in its
# catalog either way (all engine text is COLLATE "C", so it orders nothing).
ENV LANG=en_US.utf8

# Single-user image: everything (initdb, postgres, the engine) runs as the
# unprivileged postgres user, so the manager's CapDrop-ALL baseline is enough.
USER postgres

EXPOSE 8093

# The engine's own health route (server-contract.md: GET /health → {ok, driver,
# version}); node so no extra binary is kept in the image for the probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8093) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# SIGINT, as the Debian/postgres base declared: `docker stop` reaches the
# entrypoint's trap (TERM and INT both stop the engine, then Postgres -m fast).
STOPSIGNAL SIGINT

ENTRYPOINT ["/app/entrypoint.sh"]
