/**
 * repo-access — the ONE rule for "may this run touch this repository?"
 *
 * THE PROMISE. Project Settings → Repository access says a project's agents may
 * use the repositories selected there and nothing else. The platform keeps that
 * promise in two layers:
 *
 *   1. CREDENTIAL (control plane): a project with nothing selected for a
 *      provider gets no credential for it at all, and a GitHub App token is
 *      minted scoped to the selection.
 *   2. USE (here): a personal access token cannot be narrowed — it reaches
 *      everything its owner can — so every tool call, API request, clone and
 *      push inside a run is checked against the selection before the token is
 *      used. This module is that check. Everything that touches a repository
 *      (the github / gitlab / git skills, `ghFetch` / `glFetch`, the token
 *      splice in `secure-git.authedUrl`, template nodes that call a provider
 *      directly) asks it; none of them keeps a list of its own.
 *
 * THE CHANNEL. The control plane stamps the selection on every run it scopes as
 * one environment variable:
 *
 *   REPO_ALLOWLIST={"github":["owner/repo",…],"gitlab":["group/sub/repo",…]}
 *
 *   • PRESENT  ⇒ enforced. A provider with an empty (or missing) list reaches
 *     NOTHING — "nothing selected" means no access, never "everything".
 *   • PRESENT but unreadable ⇒ enforced with nothing allowed (fail-closed).
 *   • ABSENT   ⇒ not a run the platform scoped (a developer's own `zibby run`
 *     with their own token): unrestricted, exactly as before.
 *
 * JSON rather than a comma list because the empty selection has to survive the
 * trip: skills forward only non-empty env values to their tool processes, so a
 * comma list could not tell "nothing selected" from "not scoped". `[]` inside a
 * JSON object can.
 *
 * Matching is by provider + full path, case-insensitive, slash- and
 * `.git`-normalized (GitHub and GitLab both look paths up case-insensitively).
 *
 * ONE RULE, TWO BYTE-IDENTICAL COPIES. This file (packages/core) is canonical.
 * @zibby/skills carries a vendored copy at src/lib/repo-access.js, bundled into
 * each skill, because a tool process must be able to check a repository no
 * matter which @zibby/core it resolves (a new core export subpath is invisible
 * to an image whose core manifest predates it). Edit HERE, then
 *   cp packages/core/src/utils/repo-access.js packages/skills/src/lib/repo-access.js
 * skills' repo-access-vendored.test.ts fails on any drift.
 */

export const REPO_ALLOWLIST_ENV = 'REPO_ALLOWLIST';
export const REPO_NOT_SELECTED = 'REPO_NOT_SELECTED';

const PROVIDERS = Object.freeze(['github', 'gitlab']);
const PROVIDER_LABEL = Object.freeze({ github: 'GitHub', gitlab: 'GitLab' });

/**
 * The ONE normalisation for a repository path: trimmed, no leading/trailing
 * slashes, no trailing `.git`, lowercase.
 * @param {unknown} p
 * @returns {string}
 */
export function normalizeRepoPath(p) {
  return String(p ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/g, '')
    .toLowerCase();
}

/**
 * Read the run's allowlist.
 * @param {Record<string, string|undefined>} [env]
 * @returns {null | { github: Set<string>, gitlab: Set<string>, unreadable: boolean }}
 *   null when the run is not scoped (variable absent).
 */
export function readRepoAllowlist(env = process.env) {
  const raw = env ? env[REPO_ALLOWLIST_ENV] : undefined;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const out = { github: new Set(), gitlab: new Set(), unreadable: false };
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    out.unreadable = true;
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    out.unreadable = true;
    return out;
  }
  for (const provider of PROVIDERS) {
    const list = parsed[provider];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const p = normalizeRepoPath(entry);
      if (p) out[provider].add(p);
    }
  }
  return out;
}

/** Is the run scoped at all? */
export function repoAccessEnforced(env = process.env) {
  return readRepoAllowlist(env) !== null;
}

/**
 * The structured refusal a tool returns to the model. `code` is what a prompt
 * or a hint table keys on; `error` is the plain sentence; `fix` says what to do
 * instead of retrying.
 */
export function repoRefusal(provider, repo, allow) {
  const label = PROVIDER_LABEL[provider] || provider;
  const allowed = allow && allow[provider] ? [...allow[provider]].sort() : [];
  const shown = String(repo || '').trim() || '(unnamed repository)';
  const which = allowed.length
    ? `The ${label} repositories selected for this project are: ${allowed.join(', ')}.`
    : `This project has no ${label} repositories selected.`;
  return {
    error: `The ${label} repository "${shown}" is not selected for this project, so this project's agents cannot use it. ${which} `
      + 'A project owner can change this in Project Settings → Repository access.',
    code: REPO_NOT_SELECTED,
    provider,
    repo: shown,
    allowedRepos: allowed,
    fix: allowed.length
      ? 'Work only with the selected repositories listed in allowedRepos. If the task needs this one, tell the person it has to be selected in Project Settings first. Do not retry the same repository under another spelling or id.'
      : 'Tell the person this project has no repositories selected, and that one has to be selected in Project Settings → Repository access before agents can use it. Do not retry.',
  };
}

/** Thrown where a function cannot return a refusal (a clone URL, a fetch). */
export class RepoNotSelectedError extends Error {
  constructor(refusal) {
    super(refusal.error);
    this.name = 'RepoNotSelectedError';
    this.code = REPO_NOT_SELECTED;
    this.refusal = refusal;
  }
}

/** True for an error this module raised — by CODE, never instanceof (every
 * package build carries its own copy of this class). */
export function isRepoNotSelected(err) {
  return Boolean(err && err.code === REPO_NOT_SELECTED && err.refusal);
}

/**
 * Decide one repository.
 * @param {'github'|'gitlab'|string} provider
 * @param {string} repo  full path ("owner/repo", "group/sub/repo")
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ allowed: true } | { allowed: false, refusal: object }}
 */
export function repoAccess(provider, repo, env = process.env) {
  const allow = readRepoAllowlist(env);
  if (!allow) return { allowed: true };
  // Only the two providers a project selects repositories for are bounded here.
  // Any other host is not a project repository and receives no credential.
  if (!PROVIDERS.includes(provider)) return { allowed: true };
  const p = normalizeRepoPath(repo);
  if (p && allow[provider].has(p)) return { allowed: true };
  return { allowed: false, refusal: repoRefusal(provider, repo, allow) };
}

/** Throw RepoNotSelectedError unless the repository is selected. */
export function assertRepoAllowed(provider, repo, env = process.env) {
  const d = repoAccess(provider, repo, env);
  if (!d.allowed) throw new RepoNotSelectedError(d.refusal);
}

/**
 * Keep only the items whose repository is selected. Items for which `pathOf`
 * returns nothing are kept (they name no repository). Unscoped run ⇒ unchanged.
 */
export function filterAllowedRepos(provider, items, pathOf, env = process.env) {
  if (!Array.isArray(items)) return items;
  const allow = readRepoAllowlist(env);
  if (!allow || !PROVIDERS.includes(provider)) return items;
  return items.filter((item) => {
    const p = pathOf(item);
    if (p === undefined || p === null || p === '') return true;
    return allow[provider].has(normalizeRepoPath(p));
  });
}

/**
 * The selected repositories for a provider (normalized), or null when the run
 * is not scoped.
 */
export function selectedRepos(provider, env = process.env) {
  const allow = readRepoAllowlist(env);
  if (!allow) return null;
  return allow[provider] ? [...allow[provider]].sort() : [];
}

/**
 * Every self-hosted GitLab host this run is configured for (lowercase, port-
 * less): GITLAB_URL / GITLAB_INSTANCE_URL / GITLAB_API_URL plus each server of a
 * GITLAB_INSTANCES table. Only HOSTS are read out of the table; its tokens are
 * never touched here.
 */
export function gitlabHostsFromEnv(env = process.env) {
  const hosts = new Set();
  const add = (raw) => {
    try {
      const h = new URL(String(raw).trim()).hostname.toLowerCase();
      if (h) hosts.add(h);
    } catch { /* not a URL — ignore */ }
  };
  for (const k of ['GITLAB_URL', 'GITLAB_INSTANCE_URL', 'GITLAB_API_URL']) {
    if (env && env[k]) add(env[k]);
  }
  if (env && env.GITLAB_INSTANCES) {
    try {
      const table = JSON.parse(env.GITLAB_INSTANCES);
      if (Array.isArray(table)) for (const e of table) if (e && e.host) add(e.host);
    } catch { /* the gitlab skill reports a malformed table itself */ }
  }
  return [...hosts];
}

/**
 * Which repository a git URL points at: `{ provider, path }`, or null when the
 * host is not github.com / gitlab.com / one of `gitlabHosts`.
 * Accepts https URLs and scp-style `git@host:path` remotes.
 *
 * @param {string} url
 * @param {{ gitlabHosts?: string[], env?: object }} [opts]  self-hosted GitLab
 *   hosts (default: gitlabHostsFromEnv(env))
 */
export function repoFromGitUrl(url, opts = {}) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  let host = '';
  let pathname = '';
  const scp = raw.match(/^[^@\s/]+@([^:\s/]+):(.+)$/);
  if (scp && !raw.includes('://')) {
    host = scp[1].toLowerCase();
    pathname = scp[2];
  } else {
    try {
      const u = new URL(raw);
      host = u.hostname.toLowerCase();
      pathname = decodeURIComponent(u.pathname);
    } catch {
      return null;
    }
  }
  const gitlabHosts = (opts.gitlabHosts || gitlabHostsFromEnv(opts.env || process.env))
    .map((h) => String(h || '').toLowerCase()).filter(Boolean);
  if (host === 'github.com' || host === 'www.github.com') {
    const parts = normalizeRepoPath(pathname).split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return { provider: 'github', path: `${parts[0]}/${parts[1]}` };
  }
  if (host === 'gitlab.com' || gitlabHosts.includes(host)) {
    // A web URL may carry `/-/tree/main`, `/-/merge_requests/3` … — the project
    // path is everything before the `/-/` separator.
    const beforeSep = pathname.split('/-/')[0];
    const p = normalizeRepoPath(beforeSep);
    if (!p || !p.includes('/')) return null;
    return { provider: 'gitlab', path: p };
  }
  return null;
}

/**
 * Throw RepoNotSelectedError when `url` names a github/gitlab repository that
 * is not selected. A URL on any other host names no project repository and
 * passes (it will not be given a credential either).
 */
export function assertGitUrlAllowed(url, env = process.env) {
  const target = repoFromGitUrl(url, { env });
  if (target) assertRepoAllowed(target.provider, target.path, env);
}
