#!/usr/bin/env bash
# graph-memory sidecar entrypoint — embedded Postgres + the agent-graph server,
# one process tree, one /data volume.
#
#   1. initdb into $PGDATA (/data/pg) the FIRST time only — the named volume the
#      control-plane mounts at /data persists it across idle-reap + relaunch.
#   2. start Postgres on 127.0.0.1 ONLY (never reachable off the container),
#      create the `graph` database + the vector extension (idempotent).
#   3. run `agent-graph-server --driver postgres` on $PORT (8093), forwarding
#      SIGTERM/SIGINT so the manager's stop cleanly shuts BOTH down.
#
# AUTH: the control-plane forwards `spec.env.SIDECAR_AUTH_TOKEN` as a Bearer
# when the spec carries one (backend/src/handlers/graph-memory-store.js — the
# same contract postgres-store.js has with the gbrain sidecar). When the
# container was started WITH that variable, the server is told to require it
# (`--auth-token`); unset ⇒ no auth, the infra network is the boundary — the
# gbrain sidecar's default. (Note for readers of the brief that spelled it
# `$SIDECAR_TOKEN`: the env NAME is the pipe the platform already owns, so the
# existing spelling is kept rather than a second one added.)
set -euo pipefail

: "${PORT:=8093}"
# The engine's own default bind is 127.0.0.1 (a local dev default). In this
# container the CALLER is the control-plane on the infra network, so the server
# must listen on every interface of the container — Postgres, by contrast, stays
# on 127.0.0.1 below because nothing outside the container may reach it.
: "${HOST:=0.0.0.0}"
: "${PGDATA:=/data/pg}"
PG_PORT=5432
PG_HOST=127.0.0.1
PG_USER=graph
PG_DB=graph
PG_BIN="$(pg_config --bindir)"

log() { printf '[graph-memory] %s\n' "$*" >&2; }

# ── 1. first boot: initialise the cluster under /data ────────────────────────
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  log "initialising Postgres cluster at $PGDATA"
  mkdir -p "$PGDATA"
  # Local-only trust auth: the listener is bound to 127.0.0.1 inside the
  # container and nothing else can reach it; a password would protect nothing.
  "$PG_BIN/initdb" -D "$PGDATA" --auth=trust --username="$PG_USER" --encoding=UTF8 --no-instructions >/dev/null
fi

# ── 2. start Postgres (localhost only), ensure db + extension ────────────────
# Unix sockets under /tmp: /var/run/postgresql is root-owned in the base image
# and this process runs unprivileged.
"$PG_BIN/pg_ctl" -D "$PGDATA" -w -t 60 -l /tmp/postgres.log \
  -o "-c listen_addresses=$PG_HOST -c port=$PG_PORT -c unix_socket_directories=/tmp" start

stop_all() {
  local code=$?
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  "$PG_BIN/pg_ctl" -D "$PGDATA" -m fast -w -t 30 stop >/dev/null 2>&1 || true
  exit "$code"
}
trap stop_all TERM INT EXIT

psql_() { "$PG_BIN/psql" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -v ON_ERROR_STOP=1 -qtA "$@"; }
if [ "$(psql_ -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$PG_DB'")" != "1" ]; then
  log "creating database $PG_DB"
  psql_ -d postgres -c "CREATE DATABASE $PG_DB"
fi
psql_ -d "$PG_DB" -c "CREATE EXTENSION IF NOT EXISTS vector" >/dev/null

# ── 3. the engine ────────────────────────────────────────────────────────────
AUTH_ARGS=()
if [ -n "${SIDECAR_AUTH_TOKEN:-}" ]; then
  AUTH_ARGS=(--auth-token "$SIDECAR_AUTH_TOKEN")
fi
log "starting agent-graph-server on $HOST:$PORT (driver=postgres, auth=$([ ${#AUTH_ARGS[@]} -gt 0 ] && echo on || echo off))"
agent-graph-server --driver postgres \
  --pg "postgres://$PG_USER@$PG_HOST:$PG_PORT/$PG_DB" \
  --host "$HOST" --port "$PORT" "${AUTH_ARGS[@]}" &
SERVER_PID=$!
wait "$SERVER_PID"
