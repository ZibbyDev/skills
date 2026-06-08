/**
 * Neutral tracker adapter registry.
 * ============================================================================
 *
 * The "neutrality" entry point: pick a tracker by provider id (or by the
 * TRACKER_PROVIDER env var) and drive ANY of Jira / Linear / GitHub / Plane
 * through the same 6-method TrackerAdapter contract. A pipeline that talks to
 * `getAdapter()` is provider-agnostic — switching trackers is a config change,
 * not a code change.
 *
 * See ./types.js for the NeutralTicket / NeutralComment / TrackerAdapter docs.
 */

import { jiraAdapter } from './jira-adapter.js';
import { linearAdapter } from './linear-adapter.js';
import { githubAdapter } from './github-adapter.js';
import { planeAdapter } from './plane-adapter.js';

export { jiraAdapter } from './jira-adapter.js';
export { linearAdapter } from './linear-adapter.js';
export { githubAdapter } from './github-adapter.js';
export { planeAdapter } from './plane-adapter.js';
export { TRACKER_STATE_CATEGORIES } from './types.js';

/**
 * Provider id → adapter. Keys are the canonical provider ids; each value is a
 * {@link import('./types.js').TrackerAdapter}.
 */
export const TRACKER_ADAPTERS = {
  jira: jiraAdapter,
  linear: linearAdapter,
  github: githubAdapter,
  plane: planeAdapter,
};

/** Default provider when none is specified and TRACKER_PROVIDER is unset. */
export const DEFAULT_TRACKER_PROVIDER = 'jira';

/**
 * Resolve a tracker adapter.
 *
 * @param {string} [provider]
 *   Provider id ('jira' | 'linear' | 'github' | 'plane'). When omitted, falls
 *   back to the TRACKER_PROVIDER env var, then to DEFAULT_TRACKER_PROVIDER.
 * @returns {import('./types.js').TrackerAdapter}
 * @throws {Error} if the resolved provider is not registered.
 */
export function getAdapter(provider) {
  const id = String(provider || process.env.TRACKER_PROVIDER || DEFAULT_TRACKER_PROVIDER)
    .trim()
    .toLowerCase();
  const adapter = TRACKER_ADAPTERS[id];
  if (!adapter) {
    const known = Object.keys(TRACKER_ADAPTERS).join(', ');
    throw new Error(`Unknown tracker provider "${id}". Known providers: ${known}.`);
  }
  return adapter;
}
