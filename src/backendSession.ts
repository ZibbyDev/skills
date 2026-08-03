/**
 * backendSession — the ONE place the "backend-calling skill" contract lives.
 *
 * A skill whose CHILD-executed code calls Zibby's own backend
 * (resolveIntegrationToken / getAccountApiUrl — the cloud auth path, and the
 * self-host per-turn-JWT path) declares it ONCE with `callsBackend: true` on
 * the skill object. This module then GUARANTEES the spawned MCP child's env
 * carries the backend-session keys — authors no longer hand-maintain the same
 * allowlist in both envKeys and resolve() (the two-places drift that bit
 * github/gitlab 2026-07 and lark/lark-docs 2026-08; see
 * src/__tests__/backend-session-env-contract.test.ts).
 *
 * The marker is ALSO consumed downstream: the self-host Copilot's turn-local
 * delivery (backend/copilot-runtime chat-ops-bot/lib/turn-local-skills.js)
 * reflects `callsBackend` off the registry to decide which children get the
 * per-turn short-lived JWT instead of a stored PAT.
 *
 * Wiring: src/index.ts applies withBackendSessionEnv() to every skill at
 * registration, so the REGISTERED skill (what the engine resolves) always
 * honors the marker. Existing skills keep their explicit resolve() allowlists
 * — this wrapper only ADDS missing session keys (a key the resolve() already
 * set always wins), so behavior for the fixed skills is byte-identical.
 */

/** The session keys a backend-calling MCP child needs (the contract-test set). */
export const BACKEND_SESSION_KEYS = Object.freeze([
  'PROJECT_API_TOKEN',
  'ZIBBY_ACCOUNT_API_URL',
  'ZIBBY_ENV',
] as const);

// Wrap-state tracked OUT-OF-BAND (a WeakMap, never a property write) so a
// FROZEN skill object (some skills Object.freeze their export) neither throws
// nor double-wraps; original → its enforced version, so a repeat call returns
// the SAME enforced object.
const _wrapped = new WeakMap<object, object>();

/**
 * Enforce the callsBackend contract on a skill object (idempotent):
 *   - envKeys gains any missing session key (the engine's command-style
 *     fallback copies ONLY envKeys — tool-resolver.ts);
 *   - resolve() is wrapped so a spawned child's env (a spec with `command`)
 *     gains any session key present in process.env that the original resolve()
 *     omitted. Keys the resolve() DID set always win — no override, no drop.
 * Skills without callsBackend (or without resolve/command) pass through
 * untouched. Mutates in place when possible; a frozen/sealed skill is wrapped
 * as a shallow CLONE instead — always consume the RETURN value (index.ts
 * registers the return, so the registry copy is the enforced one either way).
 */
export function withBackendSessionEnv<T extends Record<string, any>>(skill: T): T {
  if (!skill || skill.callsBackend !== true) return skill;
  if (_wrapped.has(skill)) return _wrapped.get(skill) as T;
  const target: any = Object.isExtensible(skill) && !Object.isFrozen(skill)
    ? skill
    : { ...skill };
  _wrapped.set(skill, target);
  _wrapped.set(target, target);

  // Engine command-style fallback path: env is copied from envKeys.
  if (target.command || Array.isArray(target.envKeys)) {
    const keys = Array.isArray(target.envKeys) ? [...target.envKeys] : [];
    for (const k of BACKEND_SESSION_KEYS) if (!keys.includes(k)) keys.push(k);
    target.envKeys = keys;
  }

  if (typeof target.resolve === 'function') {
    const baseResolve = target.resolve;
    target.resolve = function resolveWithBackendSession(...args: any[]) {
      const resolved = baseResolve.apply(this, args);
      // No child spawned (null / remote / bin unresolvable) → nothing to add.
      if (!resolved || !resolved.command) return resolved;
      const env = { ...(resolved.env || {}) };
      for (const k of BACKEND_SESSION_KEYS) {
        if (env[k] === undefined && process.env[k]) env[k] = process.env[k];
      }
      return { ...resolved, env };
    };
  }
  return target;
}
