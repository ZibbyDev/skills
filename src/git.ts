import { spawn, execSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync } from 'fs';
import { resolve, join, basename } from 'path';

const DEFAULT_CHECKOUT_DIR = '.zibby/repos';

/**
 * Is `rawUrl` an https URL whose host is EXACTLY `host`?
 *
 * A substring test (`url.includes('github.com')`) is not good enough and was a
 * live token-exfiltration bug: `https://github.com@attacker.example/x.git`
 * contains the string "github.com", so the old code spliced the GitHub token in
 * and produced
 *   https://x-access-token:<TOKEN>@github.com@attacker.example/x.git
 * whose REAL host is whatever follows the LAST `@` — attacker.example. git then
 * sent the token there as basic auth. `url` reaches this code from a model-chosen
 * tool argument, and the skill is exposed to agents that read untrusted content,
 * so the host must be parsed, never matched.
 *
 * https-only on purpose: a token belongs in an https basic-auth URL and nowhere
 * else (not http://, not ssh://, not git://).
 */
export function isHttpsHost(rawUrl: string, host: string): boolean {
  try {
    const u = new URL(rawUrl);
    return u.protocol === 'https:' && u.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Return `rawUrl` with basic-auth credentials attached, built through the URL
 * object rather than string replacement so the authority can never be rewritten
 * by the input. Callers MUST have validated the host with isHttpsHost first.
 */
export function withCredentials(rawUrl: string, user: string, token: string): string {
  const u = new URL(rawUrl);
  u.username = encodeURIComponent(user);
  u.password = encodeURIComponent(token);
  return u.toString();
}

/**
 * Redact any VCS token (or the authenticated-URL userinfo) from a string before
 * it is returned to the model. Covers the literal token values this skill
 * embeds in clone URLs AND the generic `user:secret@host` / `x-access-token:...`
 * / `oauth2:...` URL forms git echoes in its errors.
 */
function redactGitSecrets(msg) {
  let out = String(msg == null ? '' : msg);
  for (const tok of [process.env.GITHUB_TOKEN, process.env.GITLAB_TOKEN]) {
    if (tok) out = out.split(tok).join('***');
  }
  return out
    .replace(/x-access-token:[^@\s]*@/g, 'x-access-token:***@')
    .replace(/oauth2:[^@\s]*@/g, 'oauth2:***@')
    .replace(/https?:\/\/[^/@\s:]+:[^@\s]+@/g, (m) => m.replace(/:[^@\s]+@/, ':***@'));
}

/**
 * SECURITY (CLAUDE.md §5) — strip the auth token from a freshly-cloned repo's
 * on-disk git state. A `git clone https://x-access-token:<tok>@host/...` bakes
 * that authenticated URL into `<dest>/.git/config`; a Fargate agent then reads
 * UNTRUSTED PR/issue content with a Bash tool and could `cat .git/config` /
 * `git remote -v` to exfiltrate the tenant token (the shell ENV is scrubbed but
 * the repo config was not). This rewrites `origin` to the TOKENLESS `cleanUrl`
 * so the repo the model works in holds no secret. Push is unaffected:
 * deterministic workflow nodes re-inject the token transiently right before
 * `git push`, and the model is instructed never to push from Bash.
 *
 * `execSyncFn` is injected so this works from the execSync-based clone tools
 * (github_clone / gitlab_clone). The set-url command uses only the tokenless
 * URL, so a failure message carries no secret — but we still mask `token`
 * defensively and never throw (a scrub failure must not break a good clone; it
 * is logged so a regression is visible).
 *
 * @param {(cmd:string, opts?:object)=>any} execSyncFn
 * @param {string} destPath  the cloned repo directory
 * @param {string} cleanUrl  the tokenless remote URL to set on origin
 * @param {string} [token]   the secret, masked out of any error log
 * @param {string} [label]   caller name for the log line
 */
export function scrubClonedRemoteSync(execSyncFn, destPath, cleanUrl, token, label = 'clone') {
  try {
    execSyncFn(`git -C "${destPath}" remote set-url origin "${cleanUrl}"`, { stdio: 'pipe' });
  } catch (err) {
    let m = String(err?.message || err);
    if (token) m = m.split(token).join('***');
    console.error(`[${label}] WARNING: failed to strip token from .git/config: ${m}`);
  }
}

function exec(cmd, cwd, env: any = {}) {
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

export const gitSkill: any = {
  id: 'git',
  description: 'Clone and manage git repositories for codebase analysis',
  envKeys: ['GITHUB_TOKEN', 'GITLAB_TOKEN'],
  // Tools run ONLY inside the assistant strategy's loop (handleToolCall;
  // resolve() below is null — no MCP server). Under claude/codex/gemini the
  // tools don't exist, so the engine must not inject the fragment there
  // (strategy-registry gates on this flag — the 2026-08-02 gitlab-kb-sync run
  // burned turns hunting for a git_checkout the prompt advertised).
  inProcessOnly: true,

  promptFragment: `## Git Repositories
You can clone and explore git repositories locally for codebase analysis:
- git_checkout: Clone a repo (or pull if already cloned). Supports GitHub and GitLab with auto-auth.
- git_list_repos: List locally cloned repos
- git_explore: Quick overview of a cloned repo's structure (key files, package.json, routes, etc.)

When your task needs repository context you don't have yet:
1. Clone the relevant repo with git_checkout
2. Use git_explore to understand the project structure
3. Use shell commands (grep, cat) to read specific files for deeper understanding
4. Use GitHub/GitLab skills to read related PRs and commits when history matters`,

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
      // git_checkout embeds the VCS token in the clone URL; git/exec errors can
      // echo that URL back. Redact any token value + the URL userinfo so the
      // model never sees a live credential in an error message.
      return JSON.stringify({ error: redactGitSecrets(e.message) });
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

  if (isHttpsHost(url, 'github.com') && ghToken) {
    authUrl = withCredentials(url, 'x-access-token', ghToken);
  } else if (glToken && glUrl) {
    try {
      const host = new URL(glUrl).host;
      if (isHttpsHost(url, host)) {
        authUrl = withCredentials(url, 'oauth2', glToken);
      }
    } catch { /* use original */ }
  }

  if (existsSync(join(repoPath, '.git'))) {
    // The repo was cloned by a PRIOR call, which stripped the token from
    // .git/config (origin is tokenless — see scrubClonedRemoteSync). So the
    // network fetch/pull must authenticate via the `authUrl` passed as a
    // command ARGUMENT (transient — git does NOT persist a URL given to
    // fetch/pull), never off `origin`. For a public repo authUrl === url.
    const pullCmd = branch
      ? `git -C "${repoPath}" fetch "${authUrl}" ${branch} && git -C "${repoPath}" checkout ${branch} && git -C "${repoPath}" merge --ff-only FETCH_HEAD`
      : `git -C "${repoPath}" pull "${authUrl}"`;
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

  // SECURITY (§5): strip the token the clone baked into .git/config. `url` is
  // the tokenless form (authUrl injected the secret only for the clone); for a
  // public repo authUrl === url so this is a harmless no-op re-set.
  scrubClonedRemoteSync(execSync, repoPath, url, ghToken || glToken, 'git_checkout');

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

  const result: any = { repo, path: repoPath };

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
