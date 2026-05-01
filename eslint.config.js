import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';
import pluginNode from 'eslint-plugin-n';
import security from 'eslint-plugin-security';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';

import localRules from './packages/dev-tools/eslint-local-rules/index.js';

/**
 * Simple, strict ESLint configuration
 *
 * Same rules for all code: src, tests, and tools
 * No special cases - consistent standards everywhere
 *
 * Includes custom local rules for agentic code safety (see packages/dev-tools/eslint-local-rules/)
 */

// Local rules — agentic code safety. Apply to both TS and JS source.
const localRulesConfig = {
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
  'local/no-path-join': 'error',
  'local/no-path-resolve': 'error',
  'local/no-path-relative': 'error',
  'local/no-test-scoped-functions': 'error',
  'local/no-fs-promises-cp': 'error',
  'local/no-url-pathname-for-fs': 'error',
  'local/no-bare-dynamic-import-path': 'error',
  'local/prefer-startswith-over-regex': 'error',
};

// Import organization. Apply to both TS and JS source.
const importRulesConfig = {
  'import/no-duplicates': 'error',
  'import/order': ['error', {
    groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
    'newlines-between': 'always',
    alphabetize: { order: 'asc', caseInsensitive: true },
  }],
  'import/first': 'error',
  'import/newline-after-import': 'error',
};

// Unicorn — modern JavaScript. Apply to both TS and JS source. Per-file
// overrides (e.g. CJS opting out of `prefer-module`) live on the file's
// config block.
const unicornRulesConfig = {
  'unicorn/prefer-node-protocol': 'error',
  'unicorn/prefer-module': 'error',
  'unicorn/throw-new-error': 'error',
  'unicorn/no-array-for-each': 'error',
  'unicorn/prefer-string-replace-all': 'error',
  'unicorn/prefer-string-starts-ends-with': 'error',
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
  'unicorn/prefer-top-level-await': 'error',
  'unicorn/no-useless-spread': 'error',
  'unicorn/no-array-push-push': 'error',
  'unicorn/prefer-set-has': 'error',
};

// General rules that apply to both TS and JS — except `no-unused-vars`,
// which the TS block overrides with the @typescript-eslint variant.
const generalRulesConfig = {
  'no-console': 'off',
  'no-undef': 'off',
  'prefer-const': 'error',
  'no-var': 'error',
  'no-lonely-if': 'error',
  'max-depth': ['error', 4],
  'max-params': ['error', 7],
  'no-void': 'error',
  'no-unused-expressions': ['error', {
    allowShortCircuit: false,
    allowTernary: false,
    allowTaggedTemplates: false,
  }],
  'security/detect-object-injection': 'off',
  'sonarjs/cognitive-complexity': ['error', 15],
  'sonarjs/no-duplicate-string': 'warn',
  'n/no-path-concat': 'error',
};

export default [
  // Global ignores
  {
    ignores: [
      'dist/',
      'build/',
      'coverage/',
      'node_modules/',
      'generated/',
      '**/generated/',
      '**/*.d.ts',
      'vitest.config.ts',
      'vitest.*.config.ts',
      'vitest.shared.ts',
      'vitest.setup.js',
      '.worktrees/',  // Git worktrees
      '.claude/worktrees/',  // Claude Code worktrees
      'docs/**/*.ts',  // Documentation scripts (not part of build)
      '**/test-fixtures/**',  // Test fixture data (third-party code)
      '**/test/fixtures/**',  // Test fixture data (emulates user/3p content)
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
      ...localRulesConfig,
      ...importRulesConfig,
      ...unicornRulesConfig,
      ...generalRulesConfig,

      // TypeScript-specific (use @typescript-eslint variant of no-unused-vars)
      'no-unused-vars': 'off',
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

      // Stricter type safety — catches SonarQube-style issues early
      '@typescript-eslint/no-base-to-string': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', {
        allowNumber: true,
        allowBoolean: true,
        allowAny: false,
        allowNullish: false,
      }],
      // Note: no-unsafe-member-access and no-unsafe-assignment are too
      // noisy (260+ warnings) — valuable for new code, too much to fix
      // in the existing codebase right now.
    },
  },

  // Plain JS / CJS / MJS files (eslint configs, dev-tools scripts, local
  // ESLint rules in `packages/dev-tools/eslint-local-rules/*.cjs`). These
  // files were previously unlinted because the TS block above only globs
  // **/*.ts and **/*.tsx — letting findings like SonarCloud's S6324
  // (`prefer-set-has`) and S7773 (`prefer-string-raw`) only surface
  // post-merge. Mirrors the TS block's rule set, dropping rules that
  // require @typescript-eslint type information.
  {
    files: ['**/*.{cjs,mjs,js}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        NodeJS: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
      },
    },
    plugins: {
      unicorn,
      security,
      n: pluginNode,
      import: importPlugin,
      local: localRules,
    },
    rules: {
      ...localRulesConfig,
      ...importRulesConfig,
      ...unicornRulesConfig,
      ...generalRulesConfig,

      // JS-only: use the core no-unused-vars (the TS block uses the
      // @typescript-eslint variant instead).
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },

  // CommonJS-specific overrides — `.cjs` files are CJS by intent, so
  // module-syntax rules don't apply.
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        module: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        exports: 'writable',
      },
    },
    rules: {
      'unicorn/prefer-module': 'off',
      'unicorn/prefer-export-from': 'off',
      'unicorn/prefer-top-level-await': 'off',
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
