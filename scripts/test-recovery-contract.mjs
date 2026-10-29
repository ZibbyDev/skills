// Integration contract with the backend's real HTTP/SQLite harness. Requires
// both checkouts; a missing pair fails instead of reporting a skipped pass.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const skills = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backend = process.env.ZIBBY_BACKEND_DIR || resolve(skills, '../../backend');
if (!existsSync(resolve(backend, 'src/services/__tests__/recovery-notifications.test.js'))
    || !existsSync(resolve(skills, 'dist/agentMessaging.js'))) {
  throw Error('Build skills and set ZIBBY_BACKEND_DIR to the paired backend checkout before this contract check.');
}
const result = spawnSync('npm', ['test', '--', '--runInBand',
  'src/services/__tests__/recovery-notifications.test.js', '-t', 'built needs_you'], {
  cwd: backend, env: { ...process.env, ZIBBY_SKILLS_DIR: skills }, stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
