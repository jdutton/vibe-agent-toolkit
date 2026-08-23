import { existsSync, readFileSync, readdirSync } from 'node:fs';

import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import localRules from '@vibe-agent-toolkit/utils/eslint';
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
 * Includes the agentic code safety rules VAT publishes on the
 * `@vibe-agent-toolkit/utils/eslint` subpath (source: packages/utils/eslint/).
 *
 * The plugin is registered under the `local` NAMESPACE rather than its
 * conventional `@vibe-agent-toolkit` one. Flat config lets the namespace be any
 * key, and every `eslint-disable-next-line local/…` directive in the tree is
 * keyed on it — renaming would silently turn each one into a no-op suppression
 * while the tree still lints clean at first glance. The namespace is a local
 * alias, not part of the published contract; adopters starting fresh get
 * `@vibe-agent-toolkit/…` from `configs.recommended`.
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

/**
 * One `local/no-self-package-import` block per workspace package, each naming
 * that package and scoped to the sources it compiles.
 *
 * The rule does not read `package.json` itself on purpose. Every module on the
 * `./eslint` subpath requires nothing at all — not `eslint`, not a third-party
 * package, not even a Node builtin — which is what keeps `eslint` an optional
 * peer dependency and the pack shippable as a subpath of a runtime package
 * (`packages/utils/test/eslint/subpath-purity.test.ts` asserts the empty set).
 * This file is not on that subpath: it already runs in full Node, so reading the
 * manifests here costs the invariant nothing.
 *
 * `src/**` is exactly what every package's tsconfig `include`s. Test and example
 * trees are excluded from every package build and import their own package by
 * name deliberately, to exercise the public entry point the way a consumer does.
 */
function selfImportConfigs() {
  return readdirSync('packages', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const manifest = `packages/${entry.name}/package.json`;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the path is a workspace directory name read from `packages/` moments earlier, not user input.
      if (!existsSync(manifest)) return [];
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- same path, existence just confirmed above.
      const { name } = JSON.parse(readFileSync(manifest, 'utf8'));
      if (typeof name !== 'string' || name.length === 0) return [];
      return [{
        files: [`packages/${entry.name}/src/**/*.ts`, `packages/${entry.name}/src/**/*.cts`],
        plugins: { local: localRules },
        rules: { 'local/no-self-package-import': ['error', { packageName: name }] },
      }];
    });
}

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
  // `exemptFiles` IS load-bearing now, and was not when this rule landed.
  // The rule covered only test files then, so `packages/utils/src/test-helpers.ts`
  // — which holds the one sanctioned `symlinkSync`/`fs.symlink` pair — was
  // excluded for free by `isTestFile()`, and the original comment here recorded
  // that an entry "could never activate". The rule now covers shipped code too
  // (adopters get it from `@vibe-agent-toolkit/utils/eslint`, and their
  // production symlinks face the same Windows privilege hazard with none of the
  // test lane's ability to skip), so the implementation file needs a real
  // exemption or the rule fires on the very helper it points everyone at.
  'local/no-bare-symlink-in-tests': ['error', {
    exemptFiles: ['packages/utils/src/test-helpers.ts'],
  }],
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
//
// FUTURE ENHANCEMENT: flip this opt-IN allowlist (25 of the plugin's 144 rules) to
// `unicorn/recommended` + an explicit disable list, so a SonarWay smell fails locally
// instead of arriving from Sonar. Measured over `packages/*/src/**/*.ts` (726 files):
// 11 non-fits account for 2,848 of 3,524 findings (`prevent-abbreviations` 1,886,
// `no-null` 518, `no-process-exit` 152); the remaining 27 rules are 676 findings, 477
// of them `--fix`-able. Re-measure before acting, and give it its own branch.
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
  // Mirrors a SonarWay smell. Keep it here so it fails at the desk, not in Sonar.
  'unicorn/prefer-code-point': 'error',
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
      '**/*.d.cts',  // same intent as *.d.ts — a `.cts` declaration file is still a declaration file
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
    // `.cts` is included deliberately. It is TypeScript that Node keys as
    // CommonJS off the extension, which is the only way to author a
    // `--require` preload in an ESM package — and a glob of `**/*.ts` does NOT
    // match it, so a `.cts` file is silently unlinted. That is the same hole
    // the `.cjs` block below was added to close; the CommonJS-specific
    // overrides at the end of this file re-apply to `.cts` for the same reason.
    files: ['**/*.ts', '**/*.tsx', '**/*.cts'],
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
  // pack in `packages/utils/eslint/rules/*.cjs`). These
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

  // CommonJS-specific overrides — `.cjs` and `.cts` files are CJS by intent, so
  // module-syntax rules don't apply. `.cts` is here as well as in the TS block
  // above: it needs the type-aware TS rules AND this CommonJS treatment, or
  // `unicorn/prefer-module` fires on a file whose whole purpose is to be
  // `require`-able.
  {
    files: ['**/*.cjs', '**/*.cts'],
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
      // `require()` IS the module system in these files. In a `.cts` preload it
      // is also the only way to reach a module after deciding at runtime to
      // activate — a static ESM import would load it whether or not the counter
      // is switched on.
      '@typescript-eslint/no-require-imports': 'off',
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

  // Scoped: one content-decoding seam, and no second private decoder beside it.
  //
  // `local/no-raw-text-decode` bans `buf.toString('utf-8')`, `new TextDecoder()`
  // and `readFile(p, 'utf-8')` in favour of `decodeTextContent()` /
  // `readTextContent()`, which live in `packages/utils/src` — at the BOTTOM of
  // the dependency arrow, deliberately. `resources` depends on `utils` and
  // `utils` must never depend on `resources`, so a seam in `resources` would
  // leave `utils`' own reads (an adopter's `.gitignore`, an adopter's
  // `package.json`) with no legal way to comply, and the rule would be widened
  // with exemptions until it meant nothing.
  //
  // The defect it locks shut: the old unconditional UTF-8 decode turned a
  // `working-tree-encoding=UTF-16` markdown document into NUL-interleaved
  // mojibake, the blob stage's binary sniff believed it, and a document with one
  // heading and one link produced no blob row at all. PowerShell 5.1 writes
  // UTF-16LE by default, so that is a Windows-authored file.
  //
  // ## Why this is SCOPED and not repo-wide, stated rather than implied
  //
  // The rule cannot tell a corpus-document read from a read of an artifact we
  // wrote, or from a subprocess's stdout — the rule's own docstring draws that
  // line and requires each exemption to name the writer or the producer. Inside
  // `utils` and `resources` the population needing one is SIX call sites, each
  // carrying that name; `rag`'s one violation needed no exemption — it was a
  // genuine corpus read and got routed through the seam instead. Repo-wide it
  // would be ~350 `readFile(p, 'utf-8')` calls
  // (130 in `src/`, 220 in tests) plus a dozen `child_process` stdout decodes,
  // and settling those is migration work, not a config change. This repo has
  // already learned what an over-firing rule costs: see `no-unsafe-root-join`,
  // demoted out of `configs.recommended` for exactly that.
  //
  // `packages/utils/src`, `packages/resources/src` and (as of the third pass)
  // `packages/rag/src` are the honest scope: the first OWNS the seam, the second
  // owns every corpus-document read (`link-parser`, `html-link-parser`, the
  // projection's blob stage), the third owns exactly one — a HuggingFace
  // `vocab.txt` in `embedding-providers/onnx-utils.ts`, whose encoding is the
  // model publisher's choice, not this project's. **The rest of the repo is NOT
  // covered**, and the widening ledger, measured by running this rule over each
  // candidate package, is: `packages/resource-compiler/src` (5 — the cheapest
  // remaining candidate), `packages/agent-skills/src` (22 — reads `SKILL.md`),
  // `packages/claude-marketplace/src` (20), `packages/cli/src` (31).
  // `packages/projection-sqlite/src` and `packages/schema/src` measure zero — no
  // file reads of any kind, so scoping the rule there guards no real call site
  // and is not a widening pass worth spending. Test directories are deliberately
  // last: a fixture written and read as UTF-8 by the same test is a closed loop,
  // not a content read.
  {
    files: ['packages/utils/src/**/*.ts'],
    plugins: {
      local: localRules,
    },
    rules: {
      // In-package, so the advice names the relative module rather than the
      // package `utils` cannot import from itself.
      'local/no-raw-text-decode': ['error', {
        safeModule: './text-content.js',
        // The ONE file allowed to call the primitives it wraps.
        exemptFiles: ['packages/utils/src/text-content.ts'],
      }],
    },
  },
  {
    files: ['packages/resources/src/**/*.ts'],
    plugins: {
      local: localRules,
    },
    rules: {
      // No `exemptFiles` here: this package implements no decoder, and adding one
      // would be the first step of the widening the rule exists to prevent.
      'local/no-raw-text-decode': ['error', {
        safeModule: '@vibe-agent-toolkit/utils',
      }],
    },
  },
  {
    files: ['packages/rag/src/**/*.ts'],
    plugins: {
      local: localRules,
    },
    rules: {
      // Third pass of the staged widening (see the block comment above). Chosen
      // over `agent-skills`/`cli`/`claude-marketplace` because it measured the
      // fewest violations that were an actual widening: ONE, a HuggingFace
      // `vocab.txt` read in `embedding-providers/onnx-utils.ts`, now routed
      // through the seam. `projection-sqlite` and `schema` measured zero, but
      // zero there means no file reads at all, not a reviewed decision, so they
      // were passed over rather than claimed as "smallest". No `exemptFiles`
      // here for the same reason as `resources`.
      'local/no-raw-text-decode': ['error', {
        safeModule: '@vibe-agent-toolkit/utils',
      }],
    },
  },
  // Scoped: a package's compiled sources must not import that package by its own
  // name. `src/**` is exactly what every package's tsconfig `include`s, and the
  // hazard is a build-time resolution failure, so this is the whole surface where
  // it can bite. Test and example trees are excluded from every package build and
  // import their own package by name deliberately — see the rule's header and the
  // `RECOMMENDED_EXCLUDE` note in `packages/utils/eslint/index.cjs`.
  ...selfImportConfigs(),

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
