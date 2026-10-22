/**
 * TRIPWIRES for the pairs this image shares with the rest of the tree and
 * nothing reconciles at run time (CLAUDE.md two-places rule):
 *
 *   1. /data — the Dockerfile's VOLUME + PGDATA and the entrypoint's PGDATA
 *      default must all be under the ONE path every sidecar mounts (north-star
 *      #9: a declared `dataPath` that differs from what the app writes loses
 *      the data silently). The template spec's `dataPath` is checked too when
 *      the sibling repo is present.
 *   2. port — Dockerfile EXPOSE/ENV, the entrypoint default and the template
 *      spec's `port` must agree, or the manager health-checks a port nothing
 *      listens on.
 *   3. version — package.json `version` is what publish-sidecar.sh publishes
 *      under; the template spec pins the same number (its updateChannel is
 *      null, so a mismatch means every deploy installs the OLD image forever).
 *   4. engine — `engineVersion` names the agent-graph the image ships. It is
 *      built from the tree (packages/agent-graph) into the sidecar's package
 *      feed, never fetched from npm (founder, 2026-10-17: @zibby/* is not
 *      published there any more), so engineVersion must equal the tree's
 *      version, and the package must not be a registry `dependency`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

const dockerfile = read('Dockerfile');
const entrypoint = read('entrypoint.sh');
const pkg = JSON.parse(read('package.json'));

// The template-carried spec lives in the sibling repo; a lone checkout skips
// the cross-repo halves rather than failing on a missing tree.
const SPEC_FILE = resolve(ROOT, '..', '..', '..', 'workflow-templates', 'graph-memory', 'sidecar-spec.mjs');
const spec = existsSync(SPEC_FILE) ? readFileSync(SPEC_FILE, 'utf8') : null;
const specField = (name) => (spec && spec.match(new RegExp(`^\\s*${name}: (?:'([^']+)'|(\\d+))`, 'm')) || []).slice(1).find(Boolean);

test('durable state lives at /data — image, entrypoint and declaration agree', () => {
  assert.match(dockerfile, /^VOLUME \["\/data"\]/m);
  assert.match(dockerfile, /^ENV PGDATA=\/data\//m);
  assert.match(entrypoint, /^: "\$\{PGDATA:=\/data\//m);
  if (spec) assert.equal(specField('dataPath'), '/data');
});

test('one port — Dockerfile, entrypoint and declaration', () => {
  const exposed = dockerfile.match(/^EXPOSE (\d+)/m)[1];
  const envPort = dockerfile.match(/^ENV PORT=(\d+)/m)[1];
  const entryPort = entrypoint.match(/^: "\$\{PORT:=(\d+)\}"/m)[1];
  assert.equal(exposed, '8093');
  assert.equal(envPort, exposed);
  assert.equal(entryPort, exposed);
  if (spec) assert.equal(specField('port'), exposed);
});

test('one version — package.json is what gets published, the spec pins it', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  if (spec) {
    assert.equal(specField('name'), 'graph-memory');
    assert.equal(specField('version'), pkg.version,
      'bump sidecar-spec.mjs `version` (and its s3Url/sha256 after publishing) together with package.json');
  }
});

test('the engine comes from the package feed at EXACTLY engineVersion, never from npm', () => {
  assert.match(pkg.engineVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.engineOf, '@zibby/agent-graph-memory');
  assert.deepEqual(pkg.packageFeed, ['@zibby/agent-graph-memory']);
  assert.equal(pkg.dependencies?.['@zibby/agent-graph-memory'], undefined,
    'a registry dependency would make npm fetch the engine — it comes from the package feed (packageFeed)');
  for (const name of Object.keys(pkg.dependencies || {})) assert.doesNotMatch(name, /^@zibby\//, `${name} would come from npm`);
  // The tree's engine version, when the tree is checked out beside this repo.
  const tree = resolve(ROOT, '..', '..', '..', 'agent-graph', 'package.json');
  if (existsSync(tree)) {
    assert.equal(pkg.engineVersion, JSON.parse(readFileSync(tree, 'utf8')).version,
      'engineVersion must be the version packages/agent-graph builds — the feed holds that one only');
  }
  // The Dockerfile installs from the feed through the scoped registry and checks
  // every @zibby/* dir against it; its build-time assert reads the SAME field.
  assert.match(dockerfile, /^COPY \.packed \/tmp\/feed$/m);
  assert.match(dockerfile, /--@zibby:registry=http:\/\/127\.0\.0\.1:/);
  assert.match(dockerfile, /assert-package-sources\.mjs \/tmp\/feed\/manifest\.json \/app\/node_modules/);
  assert.doesNotMatch(dockerfile, /COPY vendor\//);
  assert.equal(pkg.scripts?.vendor, undefined);
  assert.match(dockerfile, /require\("\.\/package\.json"\)\.engineVersion/);
  assert.match(dockerfile, /node_modules\/@zibby\/agent-graph-memory\/package\.json/);
});

test('an existing /data volume still opens: same Postgres major, same owner ids, same stop signal', () => {
  // Every /data/pg written by 0.1.1 (Debian `pgvector/pgvector:pg16` base) is a
  // Postgres 16 cluster owned by uid/gid 999. Postgres refuses a data dir it
  // does not own, and Alpine's package would create `postgres` as uid 70.
  assert.match(dockerfile, /addgroup -S -g 999 postgres/);
  assert.match(dockerfile, /adduser -S -D -u 999 -G postgres /);
  assert.match(dockerfile, /apk add --no-cache postgresql16 /);
  // The build asks the server itself for its major and the pgvector version.
  assert.match(dockerfile, /^ARG PGVECTOR_VERSION=\d+\.\d+\.\d+$/m);
  assert.match(dockerfile, /\[ "\$got" = "16 \$\{PGVECTOR_VERSION\}" \]/);
  // The old base's stop signal; the entrypoint's trap handles it.
  assert.match(dockerfile, /^STOPSIGNAL SIGINT$/m);
  assert.match(entrypoint, /^trap stop_all TERM INT EXIT$/m);
});

test('the entrypoint runs the server on the postgres driver and forwards the platform bearer', () => {
  assert.match(entrypoint, /agent-graph-server --driver postgres/);
  // The engine defaults to 127.0.0.1; the control-plane dials the container over
  // the infra network, so the server must be told to bind every interface (this
  // was found by the first smoke: /health unreachable from outside the container).
  assert.match(entrypoint, /^: "\$\{HOST:=0\.0\.0\.0\}"/m);
  assert.match(entrypoint, /--host "\$HOST"/);
  assert.match(entrypoint, /--auth-token "\$SIDECAR_AUTH_TOKEN"/);
  // Postgres is never reachable off the container.
  assert.match(entrypoint, /listen_addresses=\$PG_HOST/);
  assert.match(entrypoint, /^PG_HOST=127\.0\.0\.1$/m);
});
