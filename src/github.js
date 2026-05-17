import { resolveIntegrationToken } from '@zibby/core/backend-client.js';
import { INTEGRATIONS } from './integrations.js';

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
- github_create_issue: Create new issue

### Important: "Check out" / "Clone"
When user says "check out repo-name" or "clone repo-name":
1. Call github_clone. Pass the user's requested destination if given (e.g. "~/Downloads", "/Users/me/Desktop"). The tool handles ~ expansion and absolute paths.
2. Display the path and contents field (directory listing)
3. STOP. Do not offer to inspect files or ask what to do next.

When user just wants to "look at" or "read" files (not clone):
- Use github_get_file to read individual files via API`,

  resolve() {
    const env = {};
    for (const key of this.envKeys) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github@latest'], env };
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
  ],
};
