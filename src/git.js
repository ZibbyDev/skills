import { spawn } from 'child_process';
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync } from 'fs';
import { resolve, join, basename } from 'path';

const DEFAULT_CHECKOUT_DIR = '.zibby/repos';

function exec(cmd, cwd, env = {}) {
  return new Promise((res, reject) => {
    const proc = spawn(cmd, {
      cwd,
      shell: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`Exit ${code}: ${stderr.trim() || stdout.trim()}`));
      else res(stdout.trim());
    });
    proc.on('error', err => reject(err));
  });
}

export const gitSkill = {
  id: 'git',
  description: 'Clone and manage git repositories for codebase analysis',
  envKeys: ['GITHUB_TOKEN', 'GITLAB_TOKEN'],

  promptFragment: `## Git Repositories
You can clone and explore git repositories locally for codebase analysis:
- git_checkout: Clone a repo (or pull if already cloned). Supports GitHub and GitLab with auto-auth.
- git_list_repos: List locally cloned repos
- git_explore: Quick overview of a cloned repo's structure (key files, package.json, routes, etc.)

When a test ticket lacks context, use this workflow:
1. Clone the relevant repo with git_checkout
2. Use git_explore to understand the project structure
3. Use shell commands (grep, cat) to read specific files for deeper understanding
4. Use GitHub/GitLab skills to read related PRs and commits
5. Build well-informed test specs and save them to files before running tests`,

  resolve() {
    return null;
  },

  async handleToolCall(name, args, context) {
    const cwd = context?.options?.workspace || process.cwd();

    try {
      switch (name) {
        case 'git_checkout': return await handleCheckout(args, cwd);
        case 'git_list_repos': return handleListRepos(args, cwd);
        case 'git_explore': return handleExplore(args, cwd);
        default: return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  },

  tools: [
    {
      name: 'git_checkout',
      description: 'Clone a git repository locally (or pull latest if already cloned). Auto-authenticates with GitHub/GitLab tokens if available.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Repository URL (e.g. "https://github.com/org/repo" or "org/repo" shorthand for GitHub)' },
          branch: { type: 'string', description: 'Branch to checkout (default: repo default branch)' },
          shallow: { type: 'boolean', description: 'Shallow clone with depth 1 (default: true, faster)' },
          name: { type: 'string', description: 'Local directory name override (default: repo name from URL)' },
        },
        required: ['url'],
      },
    },
    {
      name: 'git_list_repos',
      description: 'List locally cloned repositories',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'git_explore',
      description: 'Quick structural overview of a cloned repo: key files, package.json info, directory tree (top 2 levels), detected framework/language',
      input_schema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repo name (as listed by git_list_repos)' },
          depth: { type: 'number', description: 'Directory tree depth (default: 2)' },
        },
        required: ['repo'],
      },
    },
  ],
};

async function handleCheckout(args, cwd) {
  let { url, branch, shallow = true, name } = args;

  if (!url.includes('://') && !url.startsWith('git@')) {
    url = `https://github.com/${url}`;
  }

  const repoName = name || basename(url.replace(/\.git$/, ''));
  const reposDir = resolve(cwd, DEFAULT_CHECKOUT_DIR);
  mkdirSync(reposDir, { recursive: true });
  const repoPath = join(reposDir, repoName);

  let authUrl = url;
  const ghToken = process.env.GITHUB_TOKEN;
  const glToken = process.env.GITLAB_TOKEN;
  const glUrl = process.env.GITLAB_URL;

  if (url.includes('github.com') && ghToken) {
    authUrl = url.replace('https://github.com', `https://x-access-token:${ghToken}@github.com`);
  } else if (glToken && glUrl) {
    try {
      const host = new URL(glUrl).host;
      if (url.includes(host)) {
        authUrl = url.replace(`https://${host}`, `https://oauth2:${glToken}@${host}`);
      }
    } catch { /* use original */ }
  }

  if (existsSync(join(repoPath, '.git'))) {
    const pullCmd = branch
      ? `git -C "${repoPath}" fetch origin ${branch} && git -C "${repoPath}" checkout ${branch} && git -C "${repoPath}" pull origin ${branch}`
      : `git -C "${repoPath}" pull`;
    await exec(pullCmd, cwd);
    const head = await exec(`git -C "${repoPath}" log -1 --format="%h %s"`, cwd);
    return JSON.stringify({
      action: 'updated',
      repo: repoName,
      path: repoPath,
      branch: branch || 'default',
      head,
    });
  }

  const cloneArgs = ['git', 'clone'];
  if (shallow) cloneArgs.push('--depth', '1');
  if (branch) cloneArgs.push('--branch', branch);
  cloneArgs.push(`"${authUrl}"`, `"${repoPath}"`);

  await exec(cloneArgs.join(' '), cwd);
  const head = await exec(`git -C "${repoPath}" log -1 --format="%h %s"`, cwd);

  return JSON.stringify({
    action: 'cloned',
    repo: repoName,
    path: repoPath,
    branch: branch || 'default',
    shallow,
    head,
  });
}

function handleListRepos(args, cwd) {
  const reposDir = resolve(cwd, DEFAULT_CHECKOUT_DIR);
  if (!existsSync(reposDir)) return JSON.stringify({ repos: [], message: 'No repos cloned yet' });

  const repos = [];
  for (const entry of readdirSync(reposDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const repoPath = join(reposDir, entry.name);
    if (!existsSync(join(repoPath, '.git'))) continue;
    const stat = statSync(repoPath);
    repos.push({
      name: entry.name,
      path: repoPath,
      lastModified: stat.mtime.toISOString(),
    });
  }
  return JSON.stringify({ repos, total: repos.length, directory: reposDir });
}

function handleExplore(args, cwd) {
  const { repo, depth = 2 } = args;
  const repoPath = resolve(cwd, DEFAULT_CHECKOUT_DIR, repo);
  if (!existsSync(repoPath)) return JSON.stringify({ error: `Repo not found: ${repo}. Run git_checkout first.` });

  const result = { repo, path: repoPath };

  const pkgPath = join(repoPath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      result.packageJson = {
        name: pkg.name,
        version: pkg.version,
        scripts: pkg.scripts ? Object.keys(pkg.scripts) : [],
        dependencies: pkg.dependencies ? Object.keys(pkg.dependencies).slice(0, 30) : [],
        devDependencies: pkg.devDependencies ? Object.keys(pkg.devDependencies).slice(0, 20) : [],
      };
      if (pkg.dependencies?.react) result.framework = 'React';
      else if (pkg.dependencies?.next) result.framework = 'Next.js';
      else if (pkg.dependencies?.vue) result.framework = 'Vue';
      else if (pkg.dependencies?.angular) result.framework = 'Angular';
      else if (pkg.dependencies?.express) result.framework = 'Express';
      else if (pkg.dependencies?.fastify) result.framework = 'Fastify';
    } catch { /* skip */ }
  }

  const pySetup = join(repoPath, 'pyproject.toml');
  if (existsSync(pySetup)) result.language = 'Python';
  const goMod = join(repoPath, 'go.mod');
  if (existsSync(goMod)) result.language = 'Go';
  const cargo = join(repoPath, 'Cargo.toml');
  if (existsSync(cargo)) result.language = 'Rust';
  if (existsSync(pkgPath)) result.language = result.language || 'JavaScript/TypeScript';

  const tree = [];
  function walk(dir, prefix, currentDepth) {
    if (currentDepth > depth) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const filtered = entries
      .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '__pycache__' && e.name !== 'dist' && e.name !== 'build' && e.name !== '.git')
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    for (const entry of filtered) {
      const isDir = entry.isDirectory();
      tree.push(`${prefix}${isDir ? '\u{1f4c1}' : '\u{1f4c4}'} ${entry.name}`);
      if (isDir && currentDepth < depth) {
        walk(join(dir, entry.name), `${prefix}  `, currentDepth + 1);
      }
    }
  }
  walk(repoPath, '', 1);
  result.tree = tree.slice(0, 80);
  if (tree.length > 80) result.treeTruncated = true;

  const keyFiles = ['README.md', 'README.rst', 'src/App.tsx', 'src/App.jsx', 'src/App.js',
    'src/routes.tsx', 'src/routes.js', 'app/routes.tsx', 'app/routes.js',
    'src/index.tsx', 'src/index.ts', 'src/main.tsx', 'src/main.ts',
    'pages/_app.tsx', 'pages/_app.js', 'app/layout.tsx',
    'docker-compose.yml', 'Dockerfile', '.env.example'];
  result.keyFilesFound = keyFiles.filter(f => existsSync(join(repoPath, f)));

  return JSON.stringify(result);
}
