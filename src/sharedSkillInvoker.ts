/** A fresh Worker per legacy skill call: zero idle Worker memory per run. */
import { Worker } from 'node:worker_threads';
import type { SharedSkillContext } from './sharedMcpServer.js';
import { SHARED_SKILL_MODULES } from './sharedSkillModules.js';

/** True only for built-in public skills with an audited direct Worker module. */
export function canInvokePublicSkill(skillId: string): boolean {
  return Object.hasOwn(SHARED_SKILL_MODULES, skillId);
}

export interface SharedSkillWorkerCall {
  skillId: string;
  toolName: string;
  args: Record<string, unknown>;
  context: SharedSkillContext;
  /** Exact-run container Config.Env. Never accepted from the MCP client. */
  runEnv: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const SAFE_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNSAFE_RUNTIME_KEYS = new Set(['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD']);
const ISOLATED_HOME = '/nonexistent/zibby-shared-skill';

function workerEnv(runEnv: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(runEnv)) {
    if (!SAFE_ENV_KEY.test(key) || UNSAFE_RUNTIME_KEYS.has(key)
      || key.startsWith('DYLD_') || key === 'HOME' || key === 'USERPROFILE') continue;
    if (typeof value !== 'string') throw new TypeError(`Invalid run environment value for ${key}`);
    env[key] = value;
  }
  // A missing run token must never fall back to the platform operator's
  // ~/.zibby/config.json while a worker is serving an agent request.
  env.HOME = ISOLATED_HOME;
  env.USERPROFILE = ISOLATED_HOME;
  return env;
}

/**
 * Invoke one graph-authorized skill tool without ever modifying the platform
 * process environment. The route authenticates and authorizes first.
 */
export function invokeSharedSkillWorker({
  skillId, toolName, args, context, runEnv, timeoutMs, signal,
}: SharedSkillWorkerCall): Promise<unknown> {
  if (!skillId || !toolName || !context?.executionId || !context?.projectId || !runEnv
    || typeof runEnv !== 'object' || Array.isArray(runEnv)) {
    return Promise.reject(new TypeError('Invalid shared skill worker call'));
  }
  if (!canInvokePublicSkill(skillId)) {
    return Promise.reject(new Error(`No public shared skill Worker for ${skillId}`));
  }
  if (signal?.aborted) return Promise.reject(new Error('Skill call cancelled'));

  const env = workerEnv(runEnv);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./sharedSkillWorker.js', import.meta.url), {
      env,
      // A run-scoped call must not inherit the platform's loaders, inspectors
      // or test flags. The worker loads built JS without special exec flags.
      execArgv: [],
      workerData: { skillId, toolName, args, context },
    });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      void worker.terminate().catch(() => {});
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(new Error('Skill call cancelled'));
    worker.on('message', (message) => {
      if (message?.ok) finish(undefined, message.value);
      else finish(new Error(message?.error || 'Skill worker failed'));
    });
    worker.on('error', (error) => finish(error));
    worker.on('exit', (code) => {
      if (!settled) finish(new Error(`Skill worker exited (${code})`));
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (Number.isFinite(timeoutMs) && timeoutMs! > 0) {
      timer = setTimeout(() => finish(new Error('Skill call timed out')), timeoutMs);
      timer.unref();
    }
  });
}
