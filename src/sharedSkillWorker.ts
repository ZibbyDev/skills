/** One isolated legacy skill call for the shared HTTP MCP service. */
import { parentPort, workerData } from 'node:worker_threads';
import { getSkill } from './index.js';

interface WorkerInput {
  skillId: string;
  toolName: string;
  args: Record<string, unknown>;
  context: Record<string, unknown>;
}

const input = workerData as WorkerInput;

async function run() {
  const skill: any = getSkill(input.skillId);
  if (!skill || !Array.isArray(skill.tools) || typeof skill.handleToolCall !== 'function') {
    throw new Error('Skill is not a hand-written tool handler');
  }
  if (!skill.tools.some((tool: any) => tool?.name === input.toolName)) {
    throw new Error('Tool is not declared by this skill');
  }

  // The worker starts with the exact run's Docker Config.Env so resolve()
  // computes the same child env as the old stdio path. Then discard every
  // ambient run variable that resolve() did not explicitly forward. This
  // mutation is confined to this throwaway Worker, never the shared process.
  const resolved = await skill.resolve?.();
  if (!resolved || !resolved.env || typeof resolved.env !== 'object') {
    throw new Error('Skill has no resolved environment for shared serving');
  }
  const minimum = ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'LANG', 'TZ'];
  const nextEnv: Record<string, string> = {};
  for (const key of minimum) {
    if (process.env[key]) nextEnv[key] = process.env[key]!;
  }
  for (const [key, value] of Object.entries(resolved.env)) {
    if (typeof value === 'string' && key !== 'HOME' && key !== 'USERPROFILE'
      && key !== 'NODE_OPTIONS' && key !== 'NODE_PATH' && key !== 'LD_PRELOAD'
      && !key.startsWith('DYLD_')) nextEnv[key] = value;
  }
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, nextEnv);

  return skill.handleToolCall(input.toolName, input.args, input.context);
}

run().then(
  (value) => parentPort?.postMessage({ ok: true, value }),
  (error) => parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }),
);
