/**
 * git-write — REQUIRED, provider-agnostic git skill.
 *
 * This is a thin ALIAS of `gitSkill` (git.js): it exposes the EXACT SAME
 * tools (git_checkout / git_list_repos / git_explore), the same resolve()
 * and the same handleToolCall — there is zero behavioural difference at
 * runtime. The ONLY distinction is the gate the BACKEND applies:
 *
 *   - `git`       → OPTIONAL_INTEGRATION_MAP  (deploy NOT blocked; the
 *                   meta-skill works anonymously on public repos).
 *   - `git-write` → REQUIRED_INTEGRATION_MAP  ({any:[github,gitlab]}) — at
 *                   least one provider MUST be connected before deploy.
 *
 * Repo-MUTATING agents (push a branch / open a PR / MR) declare
 * SKILLS.GIT_WRITE instead of SKILLS.GIT: you cannot write to a repo
 * anonymously, so deploying with neither GitHub nor GitLab connected would
 * leave the agent unable to push/PR. The required OR-group makes the deploy
 * modal render "GitHub OR GitLab" as a hard requirement.
 *
 * Read-only clone/explore agents keep SKILLS.GIT (optional).
 *
 * We deliberately REUSE gitSkill's implementation (spread it) rather than
 * duplicate the clone/explore logic — they must never drift. Only `id` (and
 * the prompt's heading, for the agent's benefit) differ.
 */

import { gitSkill } from './git.js';

export const gitWriteSkill = {
  // Inherit tools, resolve, handleToolCall, envKeys, description — identical
  // surface to `git`. Spreading shares the SAME function references, so the
  // tool behaviour can never diverge from gitSkill.
  ...gitSkill,
  id: 'git-write',
};
