import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import security from 'eslint-plugin-security';
import pluginNode from 'eslint-plugin-n';
import importPlugin from 'eslint-plugin-import';
import localRules from './packages/dev-tools/eslint-local-rules/index.js';

/**
 * Simple, strict ESLint configuration
 *
 * Same rules for all code: src, tests, and tools
 * No special cases - consistent standards everywhere
 *
 * Includes custom local rules for agentic code safety (see packages/dev-tools/eslint-local-rules/)
 */

export default [
  // Global ignores
  {
    ignores: [
      'dist/',
      'build/',
      'coverage/',
      'node_modules/',
      '**/*.d.ts',
      'vitest.config.ts',
      'vitest.*.config.ts',
      '.worktrees/',  // Git worktrees
      'docs/**/*.ts',  // Documentation scripts (not part of build)
      '**/test-fixtures/**',  // Test fixture data (third-party code)
      '**/transformer-fixtures/**',  // Transformer test fixtures (sample code)
    ],
  },

  // Base recommended configs
  eslint.configs.recommended,
  sonarjs.configs.recommended,
  security.configs.recommended,

  // Main configuration - applies to ALL TypeScript files
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2024,
        sourceType: 'module',
        project: './tsconfig.eslint.json',
      },
      globals: {
        NodeJS: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      unicorn,
      security,
      n: pluginNode,
      import: importPlugin,
      local: localRules,
    },
    rules: {
      // Local rules - agentic code safety
      'local/no-child-process-execSync': 'error',
      'local/no-hardcoded-path-split': 'error',
      'local/no-path-startswith': 'error',
      'local/no-unix-shell-commands': 'error',
      'local/no-os-tmpdir': 'error',
      'local/no-fs-mkdirSync': 'error',
      'local/no-fs-realpathSync': 'error',
      'local/no-manual-path-normalize': 'error',
      'local/no-path-sep-in-strings': 'error',
      'local/no-path-operations-in-comparisons': 'error',

      // TypeScript
      'no-unused-vars': 'off', // Use @typescript-eslint/no-unused-vars instead
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', {
        prefer: 'type-imports',
        fixStyle: 'inline-type-imports',
      }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/no-redundant-type-constituents': 'error',
      '@typescript-eslint/prefer-function-type': 'error',
      '@typescript-eslint/no-require-imports': 'error', // Enforce ESM imports, ban require()

      // Stricter type safety - catch SonarQube-style issues early
      '@typescript-eslint/no-base-to-string': 'error', // Prevent [object Object] in strings
      '@typescript-eslint/restrict-template-expressions': ['error', {
        allowNumber: true,
        allowBoolean: true,
        allowAny: false,
        allowNullish: false,
      }],
      // Note: no-unsafe-member-access and no-unsafe-assignment are too noisy (260 warnings)
      // They're valuable for new code but too much to fix in existing codebase

      // General
      'no-console': 'off',
      'no-undef': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
      'no-lonely-if': 'error', // Catches else { if } → else if
      'max-depth': ['error', 4],
      'max-params': ['error', 7], // Matches SonarQube threshold

      // Code quality - align with SonarQube
      'no-void': 'error', // SonarQube: "confusing, type-dependent" - use explicit patterns
      'no-unused-expressions': ['error', {
        allowShortCircuit: false,
        allowTernary: false,
        allowTaggedTemplates: false,
      }],

      // Security
      'security/detect-object-injection': 'off',

      // SonarJS
      'sonarjs/cognitive-complexity': ['error', 15],
      'sonarjs/no-duplicate-string': 'warn',

      // Node.js
      'n/no-path-concat': 'error',

      // Import organization
      'import/no-duplicates': 'error',
      'import/order': ['error', {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        'newlines-between': 'always',
        alphabetize: { order: 'asc', caseInsensitive: true },
      }],
      'import/first': 'error',
      'import/newline-after-import': 'error',

      // Unicorn - modern JavaScript
      'unicorn/prefer-node-protocol': 'error',
      'unicorn/prefer-module': 'error',
      'unicorn/throw-new-error': 'error',
      'unicorn/no-array-for-each': 'error',
      'unicorn/prefer-string-replace-all': 'error',
      'unicorn/prefer-array-find': 'error',
      'unicorn/prefer-array-some': 'error',
      'unicorn/prefer-at': 'error',
      'unicorn/prefer-includes': 'error',
      'unicorn/no-for-loop': 'error',
      'unicorn/prefer-spread': 'error',
      'unicorn/no-instanceof-array': 'error',
      'unicorn/prefer-date-now': 'error',
      'unicorn/prefer-ternary': 'off',
      'unicorn/prefer-string-raw': 'error',
      'unicorn/prefer-number-properties': 'error',
      'unicorn/no-negated-condition': 'error',
      'unicorn/prefer-export-from': 'error',
      'unicorn/prefer-structured-clone': 'error',
      'unicorn/no-zero-fractions': 'error',
      'unicorn/prefer-top-level-await': 'error', // Catches .then() chains in top-level code
      'unicorn/no-useless-spread': 'error', // Catches {...{foo: 'bar'}}
      'unicorn/no-array-push-push': 'error', // Catches arr.push(a); arr.push(b)
    },
  },

  // Override for factory-based test files
  // These files generate complete test suites dynamically via factory functions
  // ESLint's static analysis doesn't recognize dynamically generated tests
  {
    files: [
      '**/runtime-*/test/pure-function.test.ts',
      '**/runtime-*/test/llm-analyzer.test.ts',
    ],
    rules: {
      'sonarjs/no-empty-test-file': 'off',
    },
  },
];
