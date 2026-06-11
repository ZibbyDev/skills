import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve as resolvePath } from 'path';
import { resolveIntegrationToken } from '@zibby/core/backend-client.js';
import { INTEGRATIONS } from './integrations.js';

/**
 * Resolve the path to the generic skill MCP server binary. Derived from
 * `import.meta.url` (NOT a package self-reference) so it works in src/
 * during dev, dist/ after bundling, and node_modules/@zibby/skills/ in a
 * published install — bin/ is always a sibling of this module's dir. See
 * sentry.js resolveSentryBin() for the full rationale on why we avoid
 * require.resolve('@zibby/skills/bin/...') (the dist/package.json self-ref
 * trap that made the MCP server silently never spawn).
 */
function resolveSkillBin() {
  if (process.env.MCP_SKILL_PATH) return process.env.MCP_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, '..', 'bin', 'mcp-skill.mjs');
  return existsSync(candidate) ? candidate : null;
}

async function ghFetch(path, opts = {}) {
  const { token } = await resolveIntegrationToken('github');
  const url = path.startsWith('https://') ? path : `https://api.github.com${path}`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': opts.accept || 'application/vnd.github.v3+json',
    'User-Agent': 'Zibby-App',
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
  };
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${err.slice(0, 300)}`);
  }
  if (opts.raw) return res.text();
  return res.json();
}

export const githubSkill = {
  id: 'github',
  serverName: 'github',
  allowedTools: ['mcp__github__*'],
  requiresIntegration: INTEGRATIONS.GITHUB, // see sentrySkill.requiresIntegration for semantics
  envKeys: ['GITHUB_TOKEN'],
  description: 'GitHub — issues, PRs, commits, code search, file reading',

  promptFragment: `## GitHub (connected)
You have access to the user's GitHub repositories. Available tools:

### Discovery
- github_list_repos: Lists ALL accessible repos (personal + orgs, private + public, up to 200 repos)
- github_search_repos: Search for a specific repo by name (e.g., "electron", "my-app")
- github_get_user: Get authenticated user's profile
- github_list_orgs: List organizations with accessible repos

### Clone & Code Reading
- github_clone: Clone a repo locally. If the user specifies a destination (e.g. "to my Desktop", "to ~/Downloads"), pass that as the destination param. Otherwise it defaults to ~/zibby-repos/. ALWAYS show the contents field in the response.
- github_get_file: Read a file's content from a repo (without cloning)
- github_list_commits: List recent commits
- github_get_commit: Get commit details and diff

### Issues & PRs
- github_search_issues: Search issues and PRs
- github_search_code: Search code across repos
- github_get_pr: Get PR details
- github_get_pr_diff: Get PR diff
- github_list_pr_files: List PR changed files
- github_list_pr_comments: Get PR comments
- github_create_review: Post a review on a PR — a summary body plus optional inline comments on specific file/line positions, with an event (COMMENT, APPROVE, or REQUEST_CHANGES)
- github_create_issue: Create new issue
- github_list_issues: List issues in a repo (filter by state/labels/since cursor) — excludes PRs
- github_get_issue: Get a single issue's full detail (title, body, state, labels, assignee, url)
- github_get_issue_comments: Get the comment thread on an issue
- github_add_issue_comment: Add a comment to an issue (also used to record a PR link)
- github_close_issue / github_reopen_issue: Close (optionally completed/not_planned) or reopen an issue
- github_label_issue: Add / set / remove labels on an issue

### Important: "Check out" / "Clone"
When user says "check out repo-name" or "clone repo-name":
1. Call github_clone. Pass the user's requested destination if given (e.g. "~/Downloads", "/Users/me/Desktop"). The tool handles ~ expansion and absolute paths.
2. Display the path and contents field (directory listing)
3. STOP. Do not offer to inspect files or ask what to do next.

When user just wants to "look at" or "read" files (not clone):
- Use github_get_file to read individual files via API`,

  resolve() {
    // Spawn the GENERIC skill MCP server (bin/mcp-skill.mjs), pointing it
    // at this module's githubSkill export. That binary registers every
    // entry in `tools[]` as an MCP tool and dispatches each call straight
    // through handleToolCall — so the model gets real mcp__github__* tools.
    //
    // Returning `{ command: null }` here (the previous behaviour) handed the
    // claude SDK an unspawnnable server → "SDK init returned no mcp_servers"
    // → the model had ZERO github tools. We do NOT launch the official
    // @modelcontextprotocol/server-github (removed on purpose): we want the
    // skill's own hand-written tool surface, not a duplicate that lured the
    // model into intermittently-failing tools.
    //
    // The module arg is resolved RELATIVE TO bin/ at runtime, so
    // `../dist/github.js` → node_modules/@zibby/skills/dist/github.js in a
    // published install (mirrors how mcp-sentry.mjs imports ../dist/sentry.js).
    const bin = resolveSkillBin();
    if (!bin) return { command: null, args: [], env: {}, description: this.description };
    const env = {};
    for (const key of this.envKeys) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return {
      type: 'stdio',
      command: 'node',
      args: [bin, '../dist/github.js', 'githubSkill'],
      env,
      description: this.description,
      // Force tools into the system prompt instead of deferring behind the
      // SDK's ToolSearch (see sentry.js resolve() for why MCP-served tools
      // are otherwise invisible to the model).
      alwaysLoad: true,
    };
  },

  async handleToolCall(name, args) {
    try {
      switch (name) {
        case 'github_search_issues': {
          const q = args.query;
          if (!q) return JSON.stringify({ error: 'query is required' });
          const data = await ghFetch(`/search/issues?q=${encodeURIComponent(q)}&per_page=${args.limit || 20}`);
          const items = (data.items || []).map(i => ({
            number: i.number,
            title: i.title,
            state: i.state,
            repo: i.repository_url?.split('/').slice(-2).join('/'),
            url: i.html_url,
            user: i.user?.login,
            isPR: !!i.pull_request,
            labels: (i.labels || []).map(l => l.name),
            createdAt: i.created_at,
          }));
          return JSON.stringify({ total: data.total_count, items });
        }

        case 'github_search_code': {
          const q = args.query;
          if (!q) return JSON.stringify({ error: 'query is required' });
          const scope = args.repo ? `+repo:${args.repo}` : '';
          const lang = args.language ? `+language:${args.language}` : '';
          const data = await ghFetch(`/search/code?q=${encodeURIComponent(q)}${scope}${lang}&per_page=${args.limit || 15}`);
          const items = (data.items || []).map(i => ({
            name: i.name,
            path: i.path,
            repo: i.repository?.full_name,
            url: i.html_url,
            score: i.score,
          }));
          return JSON.stringify({ total: data.total_count, items });
        }

        case 'github_get_pr': {
          const { owner, repo, number } = args;
          if (!owner || !repo || !number) return JSON.stringify({ error: 'owner, repo, and number are required' });
          const pr = await ghFetch(`/repos/${owner}/${repo}/pulls/${number}`);
          return JSON.stringify({
            number: pr.number,
            title: pr.title,
            state: pr.state,
            merged: pr.merged,
            body: pr.body?.slice(0, 5000),
            user: pr.user?.login,
            branch: pr.head?.ref,
            base: pr.base?.ref,
            changedFiles: pr.changed_files,
            additions: pr.additions,
            deletions: pr.deletions,
            createdAt: pr.created_at,
            mergedAt: pr.merged_at,
            url: pr.html_url,
            labels: (pr.labels || []).map(l => l.name),
          });
        }

        case 'github_get_pr_diff': {
          const { owner, repo, number } = args;
          if (!owner || !repo || !number) return JSON.stringify({ error: 'owner, repo, and number are required' });
          const diff = await ghFetch(`/repos/${owner}/${repo}/pulls/${number}`, {
            accept: 'application/vnd.github.v3.diff',
            raw: true,
          });
          const truncated = diff.length > 15000;
          return JSON.stringify({
            number,
            diff: truncated ? diff.slice(0, 15000) : diff,
            truncated,
            totalLength: diff.length,
          });
        }

        case 'github_list_pr_files': {
          const { owner, repo, number } = args;
          if (!owner || !repo || !number) return JSON.stringify({ error: 'owner, repo, and number are required' });
          const files = await ghFetch(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`);
          return JSON.stringify({
            total: files.length,
            files: files.map(f => ({
              filename: f.filename,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
              patch: f.patch?.slice(0, 3000),
            })),
          });
        }

        case 'github_list_pr_comments': {
          const { owner, repo, number } = args;
          if (!owner || !repo || !number) return JSON.stringify({ error: 'owner, repo, and number are required' });
          const comments = await ghFetch(`/repos/${owner}/${repo}/pulls/${number}/comments?per_page=50`);
          const issueComments = await ghFetch(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=50`);
          const all = [
            ...comments.map(c => ({
              type: 'review',
              user: c.user?.login,
              body: c.body?.slice(0, 1000),
              path: c.path,
              line: c.line,
              createdAt: c.created_at,
            })),
            ...issueComments.map(c => ({
              type: 'issue',
              user: c.user?.login,
              body: c.body?.slice(0, 1000),
              createdAt: c.created_at,
            })),
          ].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
          return JSON.stringify({ total: all.length, comments: all });
        }

        case 'github_create_review': {
          // Post a full PR review in one call: a summary body + optional
          // inline comments + an event (COMMENT | APPROVE | REQUEST_CHANGES).
          // Mirrors the GitHub "Create a review for a pull request" REST API:
          // https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
          // Inline comments use the modern { path, line, side, body } shape
          // (line = line number in the file's NEW version; side LEFT|RIGHT).
          const { owner, repo, number, body, event, comments } = args || {};
          if (!owner || !repo || !number) {
            return JSON.stringify({ error: 'owner, repo, and number are required' });
          }
          const ev = (event || 'COMMENT').toUpperCase();
          if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(ev)) {
            return JSON.stringify({ error: `event must be COMMENT, APPROVE, or REQUEST_CHANGES (got ${event})` });
          }
          // GitHub rejects a COMMENT/REQUEST_CHANGES review with neither a body
          // nor inline comments. Guard so the agent gets a clear error, not a 422.
          const inline = Array.isArray(comments)
            ? comments
                .filter((c) => c && c.path && c.body && (c.line != null || c.position != null))
                .map((c) => {
                  const out = { path: c.path, body: String(c.body) };
                  if (c.line != null) {
                    out.line = Number(c.line);
                    out.side = c.side === 'LEFT' ? 'LEFT' : 'RIGHT';
                  } else {
                    out.position = Number(c.position);
                  }
                  return out;
                })
            : [];
          if (ev !== 'APPROVE' && !body && inline.length === 0) {
            return JSON.stringify({ error: 'a COMMENT or REQUEST_CHANGES review needs a body and/or inline comments' });
          }
          const payload = { event: ev };
          if (body) payload.body = String(body);
          if (inline.length > 0) payload.comments = inline;
          const review = await ghFetch(`/repos/${owner}/${repo}/pulls/${number}/reviews`, {
            method: 'POST',
            body: payload,
          });
          return JSON.stringify({
            ok: true,
            id: review.id,
            state: review.state,
            event: ev,
            commentsPosted: inline.length,
            url: review.html_url,
          });
        }

        case 'github_list_commits': {
          const { owner, repo, branch, path, limit } = args;
          if (!owner || !repo) return JSON.stringify({ error: 'owner and repo are required' });
          let url = `/repos/${owner}/${repo}/commits?per_page=${limit || 20}`;
          if (branch) url += `&sha=${encodeURIComponent(branch)}`;
          if (path) url += `&path=${encodeURIComponent(path)}`;
          const commits = await ghFetch(url);
          return JSON.stringify({
            total: commits.length,
            commits: commits.map(c => ({
              sha: c.sha?.slice(0, 8),
              fullSha: c.sha,
              message: c.commit?.message?.slice(0, 300),
              author: c.commit?.author?.name,
              date: c.commit?.author?.date,
              url: c.html_url,
            })),
          });
        }

        case 'github_get_commit': {
          const { owner, repo, sha } = args;
          if (!owner || !repo || !sha) return JSON.stringify({ error: 'owner, repo, and sha are required' });
          const commit = await ghFetch(`/repos/${owner}/${repo}/commits/${sha}`);
          return JSON.stringify({
            sha: commit.sha?.slice(0, 8),
            message: commit.commit?.message,
            author: commit.commit?.author?.name,
            date: commit.commit?.author?.date,
            stats: commit.stats,
            files: (commit.files || []).map(f => ({
              filename: f.filename,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
              patch: f.patch?.slice(0, 3000),
            })),
          });
        }

        case 'github_get_file': {
          const { owner, repo, path, ref } = args;
          if (!owner || !repo || !path) return JSON.stringify({ error: 'owner, repo, and path are required' });
          let url = `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
          if (ref) url += `?ref=${encodeURIComponent(ref)}`;
          const data = await ghFetch(url);
          if (data.type !== 'file') {
            if (Array.isArray(data)) {
              return JSON.stringify({
                type: 'directory',
                path,
                entries: data.map(e => ({ name: e.name, type: e.type, size: e.size, path: e.path })),
              });
            }
            return JSON.stringify({ error: `Not a file: ${data.type}` });
          }
          const content = Buffer.from(data.content || '', 'base64').toString('utf-8');
          const truncated = content.length > 20000;
          return JSON.stringify({
            path: data.path,
            size: data.size,
            sha: data.sha?.slice(0, 8),
            content: truncated ? content.slice(0, 20000) : content,
            truncated,
          });
        }

        case 'github_get_user': {
          // GitHub App installation tokens can't call /user (user-to-server only)
          // Use /installation/repositories to infer the installation owner
          try {
            const installationRepos = await ghFetch('/installation/repositories?per_page=1');
            if (installationRepos.repositories && installationRepos.repositories.length > 0) {
              const firstRepo = installationRepos.repositories[0];
              const ownerLogin = firstRepo.owner.login;
              const ownerType = firstRepo.owner.type;
              
              // Get owner details (works for both users and orgs)
              const ownerUrl = ownerType === 'Organization' ? `/orgs/${ownerLogin}` : `/users/${ownerLogin}`;
              const owner = await ghFetch(ownerUrl);
              
              return JSON.stringify({
                login: owner.login,
                name: owner.name || owner.login,
                avatar: owner.avatar_url,
                bio: owner.bio || owner.description,
                type: ownerType,
                isOrg: ownerType === 'Organization',
                publicRepos: owner.public_repos,
                message: 'Showing GitHub App installation owner (GitHub Apps cannot access /user endpoint)',
              });
            }
            return JSON.stringify({ error: 'No repositories accessible to this GitHub App installation' });
          } catch (err) {
            return JSON.stringify({ error: `GitHub App cannot access /user endpoint. Use github_list_repos instead. (${err.message})` });
          }
        }

        case 'github_list_orgs': {
          // GitHub App installation tokens can't call /user/orgs
          // Instead, list all accessible repos and extract unique org owners
          try {
            const installationRepos = await ghFetch('/installation/repositories?per_page=100');
            const repos = installationRepos.repositories || [];
            const orgSet = new Map();
            
            for (const repo of repos) {
              if (repo.owner.type === 'Organization') {
                if (!orgSet.has(repo.owner.login)) {
                  orgSet.set(repo.owner.login, {
                    login: repo.owner.login,
                    description: null,
                    url: repo.owner.url,
                  });
                }
              }
            }
            
            const orgs = Array.from(orgSet.values());
            return JSON.stringify({ 
              count: orgs.length, 
              orgs,
              message: 'Extracted from accessible repositories (GitHub Apps cannot access /user/orgs directly)',
            });
          } catch (err) {
            return JSON.stringify({ error: `GitHub App cannot list orgs via /user/orgs. Error: ${err.message}` });
          }
        }

        case 'github_clone': {
          const { owner, repo, destination } = args;
          if (!owner || !repo) return JSON.stringify({ error: 'owner and repo are required' });
          
          const { execSync } = await import('child_process');
          const { join, resolve: resolvePath } = await import('path');
          const { existsSync, mkdirSync } = await import('fs');
          const { homedir, platform } = await import('os');
          
          const { token } = await resolveIntegrationToken('github');
          const homeDir = homedir();

          function expandPath(p) {
            const expanded = p.replace(/^~(?=$|\/|\\)/, homeDir);
            return resolvePath(expanded);
          }

          const baseDir = destination ? expandPath(destination) : join(homeDir, 'zibby-repos');
          const destPath = join(baseDir, repo);
          
          mkdirSync(baseDir, { recursive: true });
          
          if (existsSync(destPath)) {
            return JSON.stringify({ 
              error: `Directory ${destPath} already exists. Remove it first or use a different destination.`,
              existingPath: destPath,
            });
          }
          
          try {
            // Clone using token for auth (suppress git output to avoid mixing with spinner)
            const repoUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
            execSync(`git clone ${repoUrl} "${destPath}"`, { stdio: 'pipe' }); // Changed from 'inherit' to 'pipe'
            
            // List contents (cross-platform)
            const isWindows = platform() === 'win32';
            let contents;
            
            if (isWindows) {
              // Windows: use dir
              contents = execSync(`dir "${destPath}"`, { encoding: 'utf-8', shell: 'cmd.exe' });
            } else {
              // Unix: use ls -la
              contents = execSync(`ls -la "${destPath}"`, { encoding: 'utf-8' });
            }
            
            return JSON.stringify({
              success: true,
              path: destPath,
              message: `Cloned ${owner}/${repo} to ${destPath}`,
              contents: contents.split('\n').slice(0, 30).join('\n'), // First 30 lines
              instructions: 'IMPORTANT: Show the contents field to the user - it contains the directory listing.',
            });
          } catch (err) {
            return JSON.stringify({ error: `Clone failed: ${err.message}` });
          }
        }

        case 'github_search_repos': {
          const { query, limit } = args;
          if (!query) return JSON.stringify({ error: 'query is required' });
          
          // First get all accessible repos
          const allReposResult = await this.handleToolCall('github_list_repos', { limit: 200 }, {});
          const allReposData = JSON.parse(allReposResult);
          
          if (allReposData.error) return JSON.stringify(allReposData);
          
          // Search repos by name
          const searchLower = query.toLowerCase();
          const matches = allReposData.repos.filter(r =>
            r.name.toLowerCase().includes(searchLower) ||
            r.fullName.toLowerCase().includes(searchLower) ||
            (r.description && r.description.toLowerCase().includes(searchLower))
          );
          
          return JSON.stringify({
            query,
            count: matches.length,
            repos: matches.slice(0, limit || 20),
          });
        }

        case 'github_list_repos': {
          const { owner, type, sort, direction, limit } = args;
          const perPage = 100;
          const maxResults = limit || 200; // Fetch more by default to include private repos
          let allRepos = [];
          
          // If no owner specified, use GitHub App installation repositories endpoint
          if (!owner) {
            let page = 1;
            let hasMore = true;
            
            while (hasMore && allRepos.length < maxResults) {
              const url = `/installation/repositories?per_page=${perPage}&page=${page}`;
              const data = await ghFetch(url);
              const repos = data.repositories || [];
              
              if (repos.length === 0) break;
              
              allRepos = allRepos.concat(repos);
              hasMore = repos.length === perPage;
              page++;
            }
            
            const mappedRepos = allRepos.slice(0, maxResults).map(r => ({
              name: r.name,
              fullName: r.full_name,
              private: r.private,
              description: r.description,
              language: r.language,
              defaultBranch: r.default_branch,
              updatedAt: r.updated_at,
              stars: r.stargazers_count,
              url: r.html_url,
            }));
            
            const privateCount = mappedRepos.filter(r => r.private).length;
            const publicCount = mappedRepos.filter(r => !r.private).length;
            
            return JSON.stringify({ 
              count: mappedRepos.length,
              repos: mappedRepos,
              privateCount,
              publicCount,
              message: `Found ${privateCount} private and ${publicCount} public repos`,
            });
          }
          
          // If owner specified, use org/user repos endpoint (with pagination)
          const isOrg = await ghFetch(`/orgs/${owner}`).then(() => true).catch(() => false);
          let page = 1;
          let hasMore = true;
          
          while (hasMore && allRepos.length < maxResults) {
            let url;
            if (isOrg) {
              url = `/orgs/${owner}/repos?per_page=${perPage}&page=${page}&type=${type || 'all'}&sort=${sort || 'updated'}&direction=${direction || 'desc'}`;
            } else {
              url = `/users/${owner}/repos?per_page=${perPage}&page=${page}&type=${type || 'all'}&sort=${sort || 'updated'}&direction=${direction || 'desc'}`;
            }
            
            const data = await ghFetch(url);
            const repos = Array.isArray(data) ? data : [];
            
            if (repos.length === 0) break;
            
            allRepos = allRepos.concat(repos);
            hasMore = repos.length === perPage;
            page++;
          }
          
          const mappedRepos = allRepos.slice(0, maxResults).map(r => ({
            name: r.name,
            fullName: r.full_name,
            private: r.private,
            description: r.description,
            language: r.language,
            defaultBranch: r.default_branch,
            updatedAt: r.updated_at,
            stars: r.stargazers_count,
            url: r.html_url,
          }));
          
          return JSON.stringify({ count: mappedRepos.length, repos: mappedRepos });
        }

        case 'github_create_issue': {
          const { owner, repo, title, body } = args;
          if (!owner || !repo || !title) return JSON.stringify({ error: 'owner, repo, and title are required' });
          const data = await ghFetch(`/repos/${owner}/${repo}/issues`, {
            method: 'POST',
            body: { title, body: body || '' },
          });
          return JSON.stringify({ number: data.number, url: data.html_url, title: data.title });
        }

        // ---- Issue tracker tools (back the neutral tracker adapter) ----
        // These reuse ghFetch (the GitHub OAuth/installation-token auth path)
        // and the REST Issues API: https://docs.github.com/en/rest/issues
        case 'github_list_issues': {
          // listCandidates: poll a repo for issues by state/labels/since cursor.
          // NOTE: GitHub's /issues endpoint returns PRs too (a PR IS an issue);
          // we filter out anything carrying pull_request so callers only see
          // real issues.
          const { owner, repo, state, labels, since, assignee, sort, direction, limit } = args || {};
          if (!owner || !repo) return JSON.stringify({ error: 'owner and repo are required' });
          const params = new URLSearchParams();
          params.set('state', state || 'open'); // open | closed | all
          params.set('per_page', String(limit || 30));
          params.set('sort', sort || 'updated'); // created | updated | comments
          params.set('direction', direction || 'desc');
          if (labels) params.set('labels', Array.isArray(labels) ? labels.join(',') : labels);
          if (since) params.set('since', since); // ISO-8601; only issues updated at/after this
          if (assignee) params.set('assignee', assignee);
          const data = await ghFetch(`/repos/${owner}/${repo}/issues?${params.toString()}`);
          const issues = (Array.isArray(data) ? data : [])
            .filter(i => !i.pull_request)
            .map(i => ({
              number: i.number,
              title: i.title,
              state: i.state,
              labels: (i.labels || []).map(l => (typeof l === 'string' ? l : l.name)),
              assignee: i.assignee?.login || null,
              assignees: (i.assignees || []).map(a => a.login),
              user: i.user?.login,
              comments: i.comments,
              url: i.html_url,
              createdAt: i.created_at,
              updatedAt: i.updated_at,
            }));
          return JSON.stringify({ count: issues.length, issues });
        }

        case 'github_get_issue': {
          // getTicket: full single-issue detail.
          const { owner, repo, number } = args || {};
          if (!owner || !repo || !number) return JSON.stringify({ error: 'owner, repo, and number are required' });
          const i = await ghFetch(`/repos/${owner}/${repo}/issues/${number}`);
          if (i.pull_request) {
            return JSON.stringify({ error: `#${number} is a pull request, not an issue`, isPR: true });
          }
          return JSON.stringify({
            number: i.number,
            title: i.title,
            body: i.body || '',
            state: i.state,
            stateReason: i.state_reason || null,
            labels: (i.labels || []).map(l => (typeof l === 'string' ? l : l.name)),
            assignee: i.assignee?.login || null,
            assignees: (i.assignees || []).map(a => a.login),
            user: i.user?.login,
            milestone: i.milestone?.title || null,
            comments: i.comments,
            url: i.html_url,
            createdAt: i.created_at,
            updatedAt: i.updated_at,
            closedAt: i.closed_at,
          });
        }

        case 'github_get_issue_comments': {
          // getComments: chronological comment thread on an issue.
          const { owner, repo, number, limit } = args || {};
          if (!owner || !repo || !number) return JSON.stringify({ error: 'owner, repo, and number are required' });
          const data = await ghFetch(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=${limit || 100}`);
          const comments = (Array.isArray(data) ? data : []).map(c => ({
            id: c.id,
            user: c.user?.login,
            body: c.body || '',
            createdAt: c.created_at,
            updatedAt: c.updated_at,
            url: c.html_url,
          }));
          return JSON.stringify({ count: comments.length, comments });
        }

        case 'github_add_issue_comment': {
          // addComment (also the fallback path for linkPullRequest — drop a
          // markdown PR link into the thread; see linkPullRequest mapping).
          const { owner, repo, number, body } = args || {};
          if (!owner || !repo || !number || !body) return JSON.stringify({ error: 'owner, repo, number, and body are required' });
          const c = await ghFetch(`/repos/${owner}/${repo}/issues/${number}/comments`, {
            method: 'POST',
            body: { body },
          });
          return JSON.stringify({ ok: true, id: c.id, url: c.html_url });
        }

        case 'github_close_issue': {
          // transition: GitHub issues have only open|closed. Optional
          // stateReason ('completed' | 'not_planned') for the close kind.
          const { owner, repo, number, stateReason } = args || {};
          if (!owner || !repo || !number) return JSON.stringify({ error: 'owner, repo, and number are required' });
          const body = { state: 'closed' };
          if (stateReason) body.state_reason = stateReason; // completed | not_planned
          const i = await ghFetch(`/repos/${owner}/${repo}/issues/${number}`, { method: 'PATCH', body });
          return JSON.stringify({ ok: true, number: i.number, state: i.state, stateReason: i.state_reason || null, url: i.html_url });
        }

        case 'github_reopen_issue': {
          // transition (the other direction): closed -> open.
          const { owner, repo, number } = args || {};
          if (!owner || !repo || !number) return JSON.stringify({ error: 'owner, repo, and number are required' });
          const i = await ghFetch(`/repos/${owner}/${repo}/issues/${number}`, {
            method: 'PATCH',
            body: { state: 'open' },
          });
          return JSON.stringify({ ok: true, number: i.number, state: i.state, url: i.html_url });
        }

        case 'github_label_issue': {
          // labelling — back transition/state-modelling done via labels
          // (e.g. an "in progress" or "needs-triage" label). mode controls
          // whether we add to, replace, or remove from the existing set.
          const { owner, repo, number, labels, mode } = args || {};
          if (!owner || !repo || !number) return JSON.stringify({ error: 'owner, repo, and number are required' });
          const list = Array.isArray(labels) ? labels : (labels ? [labels] : []);
          if (!list.length) return JSON.stringify({ error: 'labels (string or array) is required' });
          const op = mode || 'add'; // add | set | remove
          if (op === 'set') {
            const i = await ghFetch(`/repos/${owner}/${repo}/issues/${number}`, {
              method: 'PATCH',
              body: { labels: list },
            });
            return JSON.stringify({ ok: true, number: i.number, labels: (i.labels || []).map(l => (typeof l === 'string' ? l : l.name)) });
          }
          if (op === 'remove') {
            for (const label of list) {
              await ghFetch(`/repos/${owner}/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`, { method: 'DELETE' });
            }
            const i = await ghFetch(`/repos/${owner}/${repo}/issues/${number}`);
            return JSON.stringify({ ok: true, number: i.number, labels: (i.labels || []).map(l => (typeof l === 'string' ? l : l.name)) });
          }
          // default: add (POST appends, preserving existing labels)
          const data = await ghFetch(`/repos/${owner}/${repo}/issues/${number}/labels`, {
            method: 'POST',
            body: { labels: list },
          });
          return JSON.stringify({ ok: true, number, labels: (Array.isArray(data) ? data : []).map(l => (typeof l === 'string' ? l : l.name)) });
        }

        default:
          return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  },

  tools: [
    {
      name: 'github_get_user',
      description: 'Get the authenticated GitHub user profile and their organizations',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'github_list_orgs',
      description: 'List GitHub organizations the authenticated user belongs to',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'github_list_repos',
      description: 'List repositories for a user or org. If no owner given, lists the authenticated user\'s repos.',
      input_schema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Org or user login. Omit to list your own repos.' },
          type: { type: 'string', enum: ['all', 'public', 'private', 'forks', 'sources', 'member'], description: 'Filter by type (default: all)' },
          sort: { type: 'string', enum: ['created', 'updated', 'pushed', 'full_name'], description: 'Sort field (default: updated)' },
          direction: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction (default: desc)' },
          limit: { type: 'number', description: 'Max repos to return (default: 30)' },
        },
      },
    },
    {
      name: 'github_clone',
      description: 'Clone a GitHub repository to the local filesystem. Use when user says "check out" or "clone" a repo.',
      input_schema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner (user or org name)' },
          repo: { type: 'string', description: 'Repository name' },
          destination: { type: 'string', description: 'Destination directory. Accepts absolute paths, ~-prefixed paths, or relative names. Defaults to ~/zibby-repos/<repo>.' },
        },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'github_search_repos',
      description: 'Search accessible repositories by name or description. Use this when the user asks to find a specific repo.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term to match against repo name or description (e.g., "electron", "my-app")' },
          limit: { type: 'number', description: 'Max results (default: 20)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'github_search_issues',
      description: 'Search GitHub issues and pull requests',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'GitHub search query (e.g. "SCRUM-123", "login bug repo:org/app")' },
          limit: { type: 'number', description: 'Max results (default: 20)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'github_search_code',
      description: 'Search code across GitHub repositories by keyword',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Code search query (e.g. "handleLogin", "class AuthService")' },
          repo: { type: 'string', description: 'Scope to a specific repo (e.g. "org/app"). Optional.' },
          language: { type: 'string', description: 'Filter by language (e.g. "javascript", "python"). Optional.' },
          limit: { type: 'number', description: 'Max results (default: 15)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'github_get_pr',
      description: 'Get details of a pull request — title, description, branch, stats',
      input_schema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          number: { type: 'number', description: 'PR number' },
        },
        required: ['owner', 'repo', 'number'],
      },
    },
    {
      name: 'github_get_pr_diff',
      description: 'Get the unified diff of a pull request — the actual code changes',
      input_schema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          number: { type: 'number', description: 'PR number' },
        },
        required: ['owner', 'repo', 'number'],
      },
    },
    {
      name: 'github_list_pr_files',
      description: 'List files changed in a PR with per-file patches',
      input_schema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          number: { type: 'number', description: 'PR number' },
        },
        required: ['owner', 'repo', 'number'],
      },
    },
    {
      name: 'github_list_pr_comments',
      description: 'Get all review and issue comments on a PR',
      input_schema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          number: { type: 'number', description: 'PR number' },
        },
        required: ['owner', 'repo', 'number'],
      },
    },
    {
      name: 'github_create_review',
      description: 'Post a review on a pull request: a summary body plus optional inline comments anchored to file/line, with an event (COMMENT, APPROVE, or REQUEST_CHANGES). Use this to deliver a code review back to the PR.',
      input_schema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          number: { type: 'number', description: 'PR number' },
          body: { type: 'string', description: 'The review summary (markdown). Shown as the top-level review comment.' },
          event: {
            type: 'string',
            enum: ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'],
            description: 'Review verdict. Default COMMENT (no approval state). Use REQUEST_CHANGES for blocking issues.',
          },
          comments: {
            type: 'array',
            description: 'Optional inline comments, each anchored to a changed line.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'File path as it appears in the diff' },
                line: { type: 'number', description: 'Line number in the file\'s NEW version (the right side of the diff)' },
                side: { type: 'string', enum: ['LEFT', 'RIGHT'], description: 'RIGHT (new) or LEFT (old). Default RIGHT.' },
                body: { type: 'string', description: 'The inline comment text (markdown)' },
              },
              required: ['path', 'line', 'body'],
            },
          },
        },
        required: ['owner', 'repo', 'number'],
      },
    },
    {
      name: 'github_list_commits',
      description: 'List recent commits on a branch, optionally filtered by file path',
      input_schema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          branch: { type: 'string', description: 'Branch name (default: repo default branch)' },
          path: { type: 'string', description: 'Filter commits touching this file path' },
          limit: { type: 'number', description: 'Max commits (default: 20)' },
        },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'github_get_commit',
      description: 'Get details of a specific commit — message, stats, file diffs',
      input_schema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          sha: { type: 'string', description: 'Commit SHA (full or short)' },
        },
        required: ['owner', 'repo', 'sha'],
      },
    },
    {
      name: 'github_get_file',
      description: 'Read a file (or list a directory) from a GitHub repo. Works on any branch/ref.',
      input_schema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          path: { type: 'string', description: 'File or directory path (e.g. "src/auth/login.ts")' },
          ref: { type: 'string', description: 'Branch, tag, or commit SHA (default: repo default branch)' },
        },
        required: ['owner', 'repo', 'path'],
      },
    },
    {
      name: 'github_create_issue',
      description: 'Create a GitHub issue',
      input_schema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          title: { type: 'string', description: 'Issue title' },
          body: { type: 'string', description: 'Issue body (markdown)' },
        },
        required: ['owner', 'repo', 'title'],
      },
    },
    {
      name: 'github_list_issues',
      description: 'List issues in a repo (excludes pull requests). Filter by state, labels, and an updated-since cursor for polling.',
      input_schema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state (default: open)' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Only issues carrying ALL of these labels' },
          since: { type: 'string', description: 'ISO-8601 timestamp; only issues updated at/after this (polling cursor)' },
          assignee: { type: 'string', description: 'Filter by assignee login, "none", or "*"' },
          sort: { type: 'string', enum: ['created', 'updated', 'comments'], description: 'Sort field (default: updated)' },
          direction: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction (default: desc)' },
          limit: { type: 'number', description: 'Max issues (default: 30, max 100 per page)' },
        },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'github_get_issue',
      description: 'Get a single GitHub issue with full detail (title, body, state, labels, assignee, url)',
      input_schema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          number: { type: 'number', description: 'Issue number' },
        },
        required: ['owner', 'repo', 'number'],
      },
    },
    {
      name: 'github_get_issue_comments',
      description: 'Get the comment thread on a GitHub issue (chronological)',
      input_schema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          number: { type: 'number', description: 'Issue number' },
          limit: { type: 'number', description: 'Max comments (default: 100)' },
        },
        required: ['owner', 'repo', 'number'],
      },
    },
    {
      name: 'github_add_issue_comment',
      description: 'Add a comment to a GitHub issue. Also the way to record a PR link on an issue (post a markdown link).',
      input_schema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          number: { type: 'number', description: 'Issue number' },
          body: { type: 'string', description: 'Comment body (markdown)' },
        },
        required: ['owner', 'repo', 'number', 'body'],
      },
    },
    {
      name: 'github_close_issue',
      description: 'Close a GitHub issue. Optionally set the close reason (completed or not_planned).',
      input_schema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          number: { type: 'number', description: 'Issue number' },
          stateReason: { type: 'string', enum: ['completed', 'not_planned'], description: 'Why the issue was closed (optional)' },
        },
        required: ['owner', 'repo', 'number'],
      },
    },
    {
      name: 'github_reopen_issue',
      description: 'Reopen a closed GitHub issue',
      input_schema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          number: { type: 'number', description: 'Issue number' },
        },
        required: ['owner', 'repo', 'number'],
      },
    },
    {
      name: 'github_label_issue',
      description: 'Add, set (replace all), or remove labels on a GitHub issue. Labels back state-like transitions on GitHub.',
      input_schema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          number: { type: 'number', description: 'Issue number' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Label name(s)' },
          mode: { type: 'string', enum: ['add', 'set', 'remove'], description: 'add appends, set replaces all, remove deletes (default: add)' },
        },
        required: ['owner', 'repo', 'number', 'labels'],
      },
    },
  ],
};
