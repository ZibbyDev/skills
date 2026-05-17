/**
 * Prepack script — copies framework docs from docsite/ into docs/
 * so they ship with the npm package. Only runs before npm publish.
 * The docs/ folder is .gitignored (never committed).
 */
/* eslint-disable no-undef */
import { cpSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..');
const docsiteDir = join(pkgRoot, '..', '..', 'docsite', 'docs');
const targetDir = join(pkgRoot, 'docs');

if (!existsSync(docsiteDir)) {
  console.warn('[copy-docs] docsite/docs/ not found — skipping (npm install context)');
  process.exit(0);
}

mkdirSync(targetDir, { recursive: true });
cpSync(docsiteDir, targetDir, { recursive: true });
console.log(`[copy-docs] Copied docsite/docs/ → packages/skills/docs/`);
