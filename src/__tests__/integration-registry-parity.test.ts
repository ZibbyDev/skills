/**
 * TWO-PLACES TRIPWIRE — the INTEGRATION_REGISTRY display metadata.
 *
 * The same table (provider id → { name, connectPath }) exists TWICE:
 *   - packages/skills/src/integrations.ts        (this package, ESM, published)
 *   - backend/src/services/skill-integrations.js (backend, CJS, → .jsc)
 * Both feed user-visible surfaces — the deploy modal / integration status
 * endpoint render from the backend copy, while the skills copy is what the
 * package exports to templates and tooling. Nothing tied them together, and
 * they had ALREADY drifted: provider `lark` was "Lark" here and "Lark Chat"
 * there, so the same credential rendered under two different names depending on
 * which surface answered. Per CLAUDE.md's TWO-PLACES RULE, a pair that must
 * agree with no tripwire is a shipped bug. This is the tripwire; the `lark`
 * drift itself is fixed in integrations.ts.
 *
 * WHY A TRIPWIRE AND NOT DERIVATION (the rule's preferred fix). Derivation
 * would mean one copy importing the other, and neither direction is available:
 *   - backend → skills is the case CLAUDE.md already documents as impossible
 *     ("the backend is CJS/.jsc and CANNOT ESM-import the registry" — it is why
 *     skill-meta.json is a BUILD-EMITTED manifest rather than a live import).
 *   - skills → backend is worse: @zibby/skills is a PUBLISHED PUBLIC package
 *     and backend is a separate private repo, so the import would not resolve
 *     for any consumer and would leak private source into a public dep.
 * A build-emitted manifest (the skill-meta.json shape) is the only real
 * derivation option and is a disproportionate amount of machinery for ~20 rows
 * of display copy. So: assert, loudly, on every divergence.
 *
 * The backend repo is a SIBLING checkout — present in the dev tree, absent when
 * this public package is checked out alone. The comparison skips when it is not
 * there, which makes probe validity essential: a skip must never look like a
 * pass, so the assertions below refuse to run against a registry that failed to
 * load or came back implausibly small.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { INTEGRATION_REGISTRY as SKILLS_REGISTRY } from '../integrations';

const here = dirname(fileURLToPath(import.meta.url));
const BACKEND_REGISTRY_PATH = join(
  here, '..', '..', '..', '..', 'backend', 'src', 'services', 'skill-integrations.js',
);

/** The backend's copy, or null in a bare @zibby/skills checkout. */
function loadBackendRegistry(): Record<string, any> | null {
  if (!existsSync(BACKEND_REGISTRY_PATH)) return null;
  const require = createRequire(import.meta.url);
  return require(BACKEND_REGISTRY_PATH).INTEGRATION_REGISTRY || null;
}

/**
 * Provider ids each side legitimately carries alone, as of 2026-08-17. This is
 * a RATCHET, not a blessing: the id sets are recorded so that NEW divergence
 * breaks the build while the pre-existing gaps stay visible and explained.
 * Shrinking a list is also a failure — close a gap and you update this.
 */
const ONLY_IN_SKILLS = Object.freeze([
  // Real skills in this package whose provider the backend registry has no
  // display row for. The backend DOES gate on them (REQUIRED_INTEGRATION_MAP's
  // `linkedin` OR-group names both LinkedIn providers), so a surface rendering
  // from the backend registry has no name/connectPath for them — a real gap,
  // reported rather than silently normalized away here.
  'discord',
  'linkedin_business',
  'linkedin_personal',
]);
const ONLY_IN_BACKEND = Object.freeze([
  // Gate-only providers with no runtime skill in this package: `circleci` is an
  // INTEGRATION-GATE MARKER (no skill registers under it) and `penpot` is an
  // account-level MCP provider whose row is rendered by the backend alone.
  'circleci',
  'penpot',
]);

const backendRegistry = loadBackendRegistry();
const describeWithBackend = backendRegistry ? describe : describe.skip;

describe('INTEGRATION_REGISTRY (skills copy)', () => {
  it('every entry is self-consistent — the key IS the id', () => {
    // Runs with or without the backend checkout, so this file is never a
    // no-op. A key/id mismatch silently breaks every lookup keyed by provider.
    for (const [key, entry] of Object.entries(SKILLS_REGISTRY as Record<string, any>)) {
      expect(entry.id, `${key}: key and id must match`).toBe(key);
      expect(entry.name, `${key}: needs a display name`).toBeTruthy();
      expect(entry.connectPath, `${key}: connectPath must target its own provider`)
        .toBe(`/integrations?provider=${key}`);
    }
  });
});

describeWithBackend('INTEGRATION_REGISTRY parity with the backend copy', () => {
  const backend = backendRegistry as Record<string, any>;

  it('the probe actually loaded the backend registry (a skip must not read as a pass)', () => {
    expect(Object.keys(backend).length).toBeGreaterThan(15);
    // Known-good positives: if the require ever returns a stub or a renamed
    // export, these fail instead of the comparisons below passing vacuously.
    expect(backend.github?.name).toBe('GitHub');
    expect(backend.lark?.id).toBe('lark');
  });

  it('providers present in BOTH agree on every display field', () => {
    const shared = Object.keys(SKILLS_REGISTRY).filter((k) => k in backend).sort();
    expect(shared.length).toBeGreaterThan(15);
    for (const id of shared) {
      // One provider, one name, whichever surface answers.
      expect((SKILLS_REGISTRY as any)[id].name, `${id}: display name drift`).toBe(backend[id].name);
      expect((SKILLS_REGISTRY as any)[id].connectPath, `${id}: connectPath drift`)
        .toBe(backend[id].connectPath);
    }
  });

  it('the two Lark providers are named apart, identically on both sides', () => {
    // The specific drift this file was written for: `lark` was "Lark" in this
    // package and "Lark Chat" in the backend, which is exactly the ambiguity
    // the disambiguated names exist to remove.
    expect((SKILLS_REGISTRY as any).lark.name).toBe('Lark Chat');
    expect((SKILLS_REGISTRY as any).lark_docs.name).toBe('Lark App');
    expect(backend.lark.name).toBe('Lark Chat');
    expect(backend.lark_docs.name).toBe('Lark App');
  });

  it('coverage divergence matches the recorded baseline — new gaps break the build', () => {
    const onlySkills = Object.keys(SKILLS_REGISTRY).filter((k) => !(k in backend)).sort();
    const onlyBackend = Object.keys(backend).filter((k) => !(k in SKILLS_REGISTRY)).sort();
    expect(onlySkills, 'a provider was added here without a backend display row')
      .toEqual([...ONLY_IN_SKILLS].sort());
    expect(onlyBackend, 'a provider was added to the backend without a row here')
      .toEqual([...ONLY_IN_BACKEND].sort());
  });
});
