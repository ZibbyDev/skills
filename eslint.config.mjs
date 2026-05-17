import js from '@eslint/js';
import globals from 'globals';

// globals.node sets fetch/URL/FormData to `false` — override after spread.
// Kept in sync with the parent monorepo's eslint.config.mjs so files lint
// identically in either context.
const NODE_GLOBALS = {
  ...globals.node,
  ...globals.es2021,
  fetch: 'readonly',
  Response: 'readonly',
  Request: 'readonly',
  Headers: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  FormData: 'readonly',
  Blob: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  setImmediate: 'readonly',
  clearInterval: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  structuredClone: 'readonly',
  global: 'readonly',
};

const SHARED_RULES = {
  'no-unused-vars': ['warn', {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    destructuredArrayIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
  }],
  'no-undef': 'error',
  'no-unreachable': 'error',
  'no-empty': ['warn', { allowEmptyCatch: true }],
};

export default [
  js.configs.recommended,

  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
    ],
  },

  // ── Source + node modules ─────────────────────────────────────────────
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    rules: SHARED_RULES,
  },

  // ── Test files (vitest/jest globals + relaxed rules) ──────────────────
  {
    files: [
      '**/__tests__/**/*.js',
      '**/__tests__/**/*.mjs',
      '**/*.test.js',
      '**/*.test.mjs',
      '**/*.spec.js',
    ],
    languageOptions: {
      globals: {
        ...NODE_GLOBALS,
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        vi: 'readonly',
        test: 'readonly',
      },
    },
    rules: {
      ...SHARED_RULES,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
