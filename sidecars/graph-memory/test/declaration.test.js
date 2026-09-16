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
 *   4. engine — `engineVersion` names the agent-graph the image ships, and the
 *      `file:` dependency must point at a tarball of exactly that version.
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

test('the engine dependency is a tarball of exactly engineVersion', () => {
  const dep = pkg.dependencies['agent-graph-memory'];
  assert.match(pkg.engineVersion, /^\d+\.\d+\.\d+$/);
  const m = /^file:vendor\/agent-graph-memory-(\d+\.\d+\.\d+)\.tgz$/.exec(dep);
  assert.ok(m, `agent-graph must be a file: tarball under vendor/ until it is on the npm registry (got '${dep}')`);
  assert.equal(m[1], pkg.engineVersion);
  // …and the Dockerfile's build-time assert reads the SAME field, so a bump
  // that forgets one of the two fails the build, not a box.
  assert.match(dockerfile, /require\("\.\/package\.json"\)\.engineVersion/);
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
