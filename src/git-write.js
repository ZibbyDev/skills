/**
 * git-write — REQUIRED, provider-agnostic git skill, NOW create-PR-capable.
 *
 * This is an EXTENSION of `gitSkill` (git.js): it inherits the EXACT SAME
 * read tools (git_checkout / git_list_repos / git_explore), resolve() and
 * handleToolCall, and ADDS provider-agnostic mutation tools —
 * `git_open_pr` (opens a pull request / merge request off an already-pushed
 * branch) and `git_merge_pr` (merges/accepts an open PR/MR by number) — each
 * returning the REAL provider value (pr_url / merge sha). The ONLY
 * gate difference (vs `git`) is the backend's integration map:
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
 * Why expose create-PR THROUGH git-write rather than declaring
 * SKILLS.GITHUB + SKILLS.GITLAB on the node? Those two skills each carry
 * `requiresIntegration`, so declaring BOTH would force BOTH providers
 * connected (an AND gate) — breaking the "GitHub OR GitLab" OR-group. By
 * folding the create-PR/MR capability into git-write (whose gate is the
 * {any:[github,gitlab]} OR-group) the agent gets a real create-PR tool with
 * NO change to the deploy gating.
 *
 * `git_open_pr` does NOT reimplement the provider API calls. It detects the
 * provider from the repoUrl and DELEGATES to the already-published, already-
 * tested `github_create_pr` (github.js) / `gitlab_create_mr` (gitlab.js) tools
 * — so the returned pr_url is the REAL html_url / web_url from the provider
 * response, never a value the model could fabricate, and all the expected-
 * business-error handling ({ success:false, skippedReason }) is inherited.
 *
 * Read-only clone/explore agents keep SKILLS.GIT (optional).
 *
 * We REUSE gitSkill's read-tool implementation (spread it) rather than
 * duplicate the clone/explore logic — they must never drift. handleToolCall
 * handles git_open_pr here and delegates everything else to gitSkill.
 */

import { gitSkill } from './git.js';
import { githubSkill } from './github.js';
import { gitlabSkill } from './gitlab.js';

/**
 * Detect the provider from a repo/clone URL. Returns { provider, owner, repo }
 * for github / gitlab, or null for an unrecognized host. Mirrors the
 * sentry-triage fix-node's parseRepo so the dispatch agrees with the
 * deterministic fallback path.
 */
export function detectProvider(url) {
  let m = (url || '').match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (m) return { provider: 'github', owner: m[1], repo: m[2] };
  m = (url || '').match(/gitlab\.com[/:](.+?)\/([^/]+?)(?:\.git)?$/);
  if (m) return { provider: 'gitlab', owner: m[1], repo: m[2] };
  return null;
}

export const gitWriteSkill = {
  // Inherit resolve / envKeys / description and the read tools from gitSkill.
  // Spreading shares the SAME function references, so the read-tool behaviour
  // can never diverge from gitSkill. We then OVERRIDE id, tools (add
  // git_open_pr), promptFragment (advertise it) and handleToolCall (handle
  // git_open_pr, else delegate to gitSkill).
  ...gitSkill,
  id: 'git-write',

  // Pull in BOTH providers' env keys so whichever delegate handles the call
  // has the token it needs (github_create_pr uses resolveIntegrationToken,
  // gitlab_create_mr reads GITLAB_TOKEN/GITLAB_OAUTH_TOKEN/GITLAB_*).
  envKeys: [
    ...(gitSkill.envKeys || []),
    ...(githubSkill.envKeys || []),
    ...(gitlabSkill.envKeys || []),
  ].filter((k, i, a) => a.indexOf(k) === i),

  promptFragment: `${gitSkill.promptFragment}

## Opening a pull request / merge request (git_open_pr)
After you have pushed a branch, OPEN the PR/MR with the provider-agnostic tool:
- git_open_pr: Open a pull request (GitHub) or merge request (GitLab) from an already-pushed branch. Provider is auto-detected from \`repoUrl\` (github.com or gitlab.com). Args:
    { repoUrl, head (the pushed source branch), base? (target branch; default the repo default), title, body? }
  Returns the REAL provider url (\`pr_url\` = GitHub html_url / GitLab web_url) — NEVER fabricate a PR url; only ever report the url this tool returns. Expected business outcomes (no commits between base and head, a PR/MR already exists, base==head) come back as { success:false, skippedReason } — that is a normal "nothing to open", not a hard failure.

## Merging a pull request / merge request (git_merge_pr)
To MERGE an open PR/MR, use the provider-agnostic tool:
- git_merge_pr: Merge a pull request (GitHub) or accept a merge request (GitLab) by number. Provider is auto-detected from \`repoUrl\`. Args:
    { repoUrl, number (the PR/MR number; GitLab alias: iid), mergeMethod? ('merge'|'squash'|'rebase', GitHub only; default 'squash') }
  Returns { success:true, merged:true, sha } with the REAL merge SHA from the provider. Expected non-mergeable states (draft, failing checks, conflicts, head sha moved, pipeline not done) come back as { success:false, skippedReason } — a normal "not mergeable yet", not a hard failure.`,

  /**
   * Handle git_open_pr in-process by DELEGATING to the github/gitlab skills'
   * already-tested create tools (so the API call + real-url guarantee + the
   * expected-business-error handling are reused, not re-implemented). Every
   * other tool (git_checkout / git_list_repos / git_explore) is delegated to
   * gitSkill — the read surface is unchanged.
   */
  async handleToolCall(name, args, context) {
    if (name !== 'git_open_pr' && name !== 'git_merge_pr') {
      return gitSkill.handleToolCall(name, args, context);
    }
    try {
      const a = args || {};
      const repoUrl = a.repoUrl || a.repo_url || a.url;
      if (!repoUrl) {
        return JSON.stringify({ error: 'repoUrl is required (the github.com/gitlab.com repo to open/merge the PR/MR against)' });
      }

      if (name === 'git_merge_pr') {
        // MERGE an open PR/MR. Mirrors git_open_pr: detect the provider from
        // repoUrl and DELEGATE to the already-tested github_merge_pr /
        // gitlab_accept_mr tools (so the real merge SHA + the expected
        // non-mergeable handling { success:false, skippedReason } are reused,
        // not re-implemented). `number` is the PR/MR number (GitLab alias iid).
        const number = a.number ?? a.iid ?? a.prNumber;
        if (number == null) {
          return JSON.stringify({ error: 'number (the PR/MR number to merge; GitLab alias: iid) is required' });
        }
        const parsed = detectProvider(repoUrl);
        if (!parsed) {
          return JSON.stringify({
            success: false,
            skippedReason: `Unrecognized repo host: ${repoUrl}. git_merge_pr supports github.com and gitlab.com.`,
          });
        }
        if (parsed.provider === 'github') {
          // DELEGATE to github_merge_pr (github.js) — returns the REAL merge sha.
          return githubSkill.handleToolCall('github_merge_pr', {
            owner: parsed.owner,
            repo: parsed.repo,
            number,
            mergeMethod: a.mergeMethod,
          }, context);
        }
        // GitLab: DELEGATE to gitlab_accept_mr (gitlab.js) — returns the REAL
        // merge_commit_sha. The "group/repo" path is the project id GitLab accepts.
        return gitlabSkill.handleToolCall('gitlab_accept_mr', {
          project: `${parsed.owner}/${parsed.repo}`,
          iid: number,
        }, context);
      }

      // ---- git_open_pr ----
      // Accept both GitHub-style (head/base) and GitLab-style
      // (source_branch/target_branch) arg names so the tool reads naturally
      // for either provider.
      const head = a.head || a.source_branch || a.sourceBranch || a.branch;
      const base = a.base || a.target_branch || a.targetBranch;
      const { title, body } = a;
      if (!head || !title) {
        return JSON.stringify({ error: 'head (the pushed source branch) and title are required' });
      }

      const parsed = detectProvider(repoUrl);
      if (!parsed) {
        return JSON.stringify({
          success: false,
          skippedReason: `Unrecognized repo host: ${repoUrl}. git_open_pr supports github.com and gitlab.com.`,
        });
      }

      if (parsed.provider === 'github') {
        // DELEGATE to github_create_pr (github.js) — returns the REAL html_url.
        return githubSkill.handleToolCall('github_create_pr', {
          owner: parsed.owner,
          repo: parsed.repo,
          head,
          base,
          title,
          body,
        }, context);
      }

      // GitLab: DELEGATE to gitlab_create_mr (gitlab.js) — returns the REAL
      // web_url. The "group/repo" path is the project id GitLab accepts.
      return gitlabSkill.handleToolCall('gitlab_create_mr', {
        project: `${parsed.owner}/${parsed.repo}`,
        source_branch: head,
        target_branch: base,
        title,
        description: body,
      }, context);
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  },

  // Inherited read tools + the new provider-agnostic create-PR/MR tool.
  tools: [
    ...(gitSkill.tools || []),
    {
      name: 'git_open_pr',
      description: 'Open a pull request (GitHub) or merge request (GitLab) from an already-pushed branch. The provider is auto-detected from repoUrl. Returns the REAL provider-returned url (pr_url = GitHub html_url / GitLab web_url) — never fabricate a PR url. Expected business outcomes (no commits between base and head, a PR/MR already exists, base==head) return { success:false, skippedReason } rather than erroring. Delegates to the github/gitlab provider APIs (the same auth path the github_*/gitlab_* tools use).',
      input_schema: {
        type: 'object',
        properties: {
          repoUrl: { type: 'string', description: 'The repo URL the PR/MR is opened against (e.g. "https://github.com/org/repo" or "https://gitlab.com/group/repo"). Provider is detected from the host.' },
          head: { type: 'string', description: 'Source branch to merge FROM (must already be pushed). GitLab alias: source_branch.' },
          base: { type: 'string', description: 'Target branch to merge INTO (default: the repo/project default branch). GitLab alias: target_branch.' },
          title: { type: 'string', description: 'PR/MR title' },
          body: { type: 'string', description: 'PR/MR description (markdown)' },
        },
        required: ['repoUrl', 'head', 'title'],
      },
    },
    {
      name: 'git_merge_pr',
      description: 'Merge a pull request (GitHub) or accept a merge request (GitLab) by number. The provider is auto-detected from repoUrl. Returns { success:true, merged:true, sha } with the REAL merge SHA from the provider — never fabricate it. Expected non-mergeable states (draft, failing checks, conflicts, head sha moved, pipeline not done) return { success:false, skippedReason } rather than erroring. Delegates to the github/gitlab provider APIs (the same auth path the github_*/gitlab_* tools use).',
      input_schema: {
        type: 'object',
        properties: {
          repoUrl: { type: 'string', description: 'The repo URL the PR/MR belongs to (e.g. "https://github.com/org/repo" or "https://gitlab.com/group/repo"). Provider is detected from the host.' },
          number: { type: 'number', description: 'The PR (GitHub) / MR (GitLab) number to merge. GitLab alias: iid.' },
          mergeMethod: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'How to merge (GitHub only; default: squash). Ignored for GitLab.' },
        },
        required: ['repoUrl', 'number'],
      },
    },
  ],
};
