import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import localRules from '@vibe-agent-toolkit/eslint-plugin';
import importPlugin from 'eslint-plugin-import';
import pluginNode from 'eslint-plugin-n';
import security from 'eslint-plugin-security';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';

/**
 * Simple, strict ESLint configuration
 *
 * Same rules for all code: src, tests, and tools
 * No special cases - consistent standards everywhere
 *
 * Includes the agentic code safety rules VAT publishes as
 * `@vibe-agent-toolkit/eslint-plugin` (source: packages/eslint-plugin/).
 *
 * The plugin is registered under the `local` NAMESPACE rather than its
 * conventional `@vibe-agent-toolkit` one. Flat config lets the namespace be any
 * key, and 43 `eslint-disable-next-line local/…` directives across 8 packages
 * are keyed on it — renaming would silently turn every one of them into a
 * no-op suppression while the tree still lints clean at first glance. The
 * namespace is a local alias, not part of the published contract; adopters
 * starting fresh get `@vibe-agent-toolkit/…` from `configs.recommended`.
 */

/**
 * Files allowed to call the raw primitive each rule bans — the ones that
 * IMPLEMENT (or assert the native behavior of) the safe wrapper.
 *
 * These are passed as rule OPTIONS, not inherited from a default: the plugin
 * ships no built-in exemptions, because "packages/utils/src/path-utils.ts" is a
 * claim about THIS repo's layout and would be a silent hole in anyone else's.
 */
const PATH_IMPL_EXEMPT = { exemptFiles: [
  // Pure `safePath` definitions, the fs-touching ones, and the test that
  // asserts the platform-native behavior those wrap.
  'packages/utils/src/path-core.ts',
  'packages/utils/src/path-utils.ts',
  'packages/utils/test/path-utils.test.ts',
] };
const PATH_UTILS_EXEMPT = { exemptFiles: ['packages/utils/src/path-utils.ts'] };
const SAFE_EXEC_EXEMPT = { exemptFiles: ['packages/utils/src/safe-exec.ts'] };

// Local rules — agentic code safety. Apply to both TS and JS source.
const localRulesConfig = {
  'local/no-child-process-execSync': ['error', SAFE_EXEC_EXEMPT],
  'local/no-hardcoded-path-split': 'error',
  'local/no-path-startswith': 'error',
  'local/no-unix-shell-commands': 'error',
  'local/no-os-tmpdir': ['error', PATH_UTILS_EXEMPT],
  'local/no-fs-mkdirSync': ['error', PATH_UTILS_EXEMPT],
  'local/no-fs-realpathSync': ['error', PATH_UTILS_EXEMPT],
  'local/no-manual-path-normalize': 'error',
  'local/no-path-sep-in-strings': 'error',
  'local/no-path-operations-in-comparisons': 'error',
  'local/no-path-join': ['error', PATH_IMPL_EXEMPT],
  'local/no-path-resolve': ['error', PATH_IMPL_EXEMPT],
  'local/no-path-relative': ['error', PATH_IMPL_EXEMPT],
  'local/no-test-scoped-functions': 'error',
  'local/no-fs-promises-cp': 'error',
  'local/no-url-pathname-for-fs': 'error',
  'local/no-bare-dynamic-import-path': 'error',
  'local/no-file-url-string-concat': 'error',
  'local/prefer-startswith-over-regex': 'error',
  'local/require-justified-skip': 'error',
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

// Ban legacy YAML / frontmatter libraries — see CLAUDE.md yaml-lib rule.
// Applied to both TS and JS blocks below.
const OPEN_FRONTMATTER_MESSAGE = 'Use openFrontmatter from @vibe-agent-toolkit/resources — preserves comments.';
const noRestrictedImportsConfig = ['error', {
  paths: [
    {
      name: 'js-yaml',
      message: 'Use `yaml` (eemeli) per CLAUDE.md yaml-lib rule. Frontmatter writes: openFrontmatter from @vibe-agent-toolkit/resources.',
    },
    { name: 'gray-matter', message: OPEN_FRONTMATTER_MESSAGE },
    { name: 'front-matter', message: OPEN_FRONTMATTER_MESSAGE },
  ],
}];

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
      '**/resources/skills/evals/**',  // Skill-test eval suites + fixtures (test input, often intentionally broken). Mirrored in validate-repo-structure.ts + vibe-agent-toolkit.config.yaml — keep in sync.
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

      'no-restricted-imports': noRestrictedImportsConfig,

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

  // Plain JS / CJS / MJS files (eslint configs, dev-tools scripts, the rule
  // pack in `packages/eslint-plugin/rules/*.cjs`). These
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

      'no-restricted-imports': noRestrictedImportsConfig,

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

  // Scoped: enforce safePath.joinUnderRoot() for security-root path joins
  // in the skill-test staging code. This catches the Windows drive-letter
  // escape bug class where a caller-controlled segment can break containment
  // when joined raw under a harness root.
  {
    files: [
      'packages/agent-skills/src/skill-test/**/*.ts',
      'packages/utils/src/skill-test/**/*.ts',
    ],
    plugins: {
      local: localRules,
    },
    rules: {
      'local/no-unsafe-root-join': 'error',
    },
  },
];
