import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';

import eslint from '@eslint/js';
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments';
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
 * Ratchet for `local/no-io-in-unit-tier`: the unit-tier test FILES that today
 * spawn a process or mint a temp directory (185 sites when seeded). The list
 * may only SHRINK — an entry leaves when its file moves to the tier it belongs
 * to (`test/integration/*.integration.test.ts` / `test/system/*.system.test.ts`)
 * or stops CALLING the I/O directly; a new offender is a lint error, not a new
 * line here. Both directions are asserted: `dev-tools/test/eslint-allowlist-ratchets.test.ts`
 * lints every listed file with the exemption lifted and fails on one the rule
 * no longer fires on.
 *
 * ⚠️ The rule measures SYNTAX. I/O routed through a helper (`setupTempDirTestSuite`,
 * `createTempDirTracker`) is invisible to it, so a file can leave this list
 * with its temp tree intact — two files did exactly that. The per-file
 * duration reporter is the backstop for the cost the helper hides.
 *
 * ⚠️ Deliberately NOT unified with the per-file DURATION allowlist in
 * `packages/dev-tools/src/test-tier-budget-allowlist.ts`, although both ratchet
 * the same tier: measured when seeded, only 37 of the 118 files then listed were on the duration list
 * (81 do I/O and are still fast; 70 duration entries are slow for reasons this
 * rule cannot see, e.g. real timers, parse pools). Two questions, two lists —
 * and `eslint.config.js` cannot import a `.ts` module under Node 22 anyway.
 * A file that leaves one list usually leaves the other; check both.
 */
const UNIT_TIER_IO_RATCHET = { allowFiles: [
  'packages/agent-config/test/loader/manifest-loader.test.ts',
  'packages/agent-config/test/validator/agent-validator.test.ts',
  'packages/agent-runtime/test/session/file-session-store.test.ts',
  'packages/agent-skills/test/files-config.test.ts',
  'packages/agent-skills/test/skill-identity.test.ts',
  'packages/agent-skills/test/skill-source/content-hash.test.ts',
  'packages/agent-skills/test/skill-source/fetch-cache.test.ts',
  'packages/agent-skills/test/skill-source/git-clone-env.test.ts',
  'packages/agent-skills/test/skill-source/git-clone.test.ts',
  'packages/agent-skills/test/skill-source/stage.test.ts',
  'packages/agent-skills/test/skill-source/url-source.test.ts',
  'packages/agent-skills/test/skill-source/vendored-source.test.ts',
  'packages/agent-skills/test/skill-test/eval-grader.test.ts',
  'packages/agent-skills/test/skill-test/eval-inputs.test.ts',
  'packages/agent-skills/test/skill-test/harness-location.test.ts',
  'packages/agent-skills/test/skill-test/harness-root-prepare.test.ts',
  'packages/agent-skills/test/skill-test/lock.test.ts',
  'packages/agent-skills/test/skill-test/vendor-manifest.test.ts',
  'packages/agent-skills/test/validators/packaged-size-limit.test.ts',
  'packages/agent-skills/test/validators/plugin-hosted-shape.test.ts',
  'packages/agent-skills/test/validators/referenced-path-missing.test.ts',
  'packages/agent-skills/test/validators/registry-memo-refusal-replay.test.ts',
  'packages/agent-skills/test/validators/registry-memoization.test.ts',
  'packages/agent-skills/test/zip-size-validation.test.ts',
  'packages/claude-marketplace/test/compatibility-analyzer.test.ts',
  'packages/claude-marketplace/test/inventory/extract-install.test.ts',
  'packages/claude-marketplace/test/inventory/extract-marketplace.test.ts',
  'packages/claude-marketplace/test/inventory/extract-plugin.test.ts',
  'packages/claude-marketplace/test/marketplace-defaults.test.ts',
  'packages/claude-marketplace/test/plugin-registry.test.ts',
  'packages/claude-marketplace/test/settings-auditor.test.ts',
  'packages/claude-marketplace/test/settings-compat-checker.test.ts',
  'packages/claude-marketplace/test/walk-following-links.test.ts',
  'packages/cli/test/ard-emit.test.ts',
  'packages/cli/test/commands/audit/nothing-audited.test.ts',
  'packages/cli/test/commands/audit/resources-severity.test.ts',
  'packages/cli/test/commands/cache-control.test.ts',
  'packages/cli/test/commands/claude/marketplace/publish-tree.test.ts',
  'packages/cli/test/commands/claude/marketplace/validate-declared-sources.test.ts',
  'packages/cli/test/commands/consistency-check.test.ts',
  'packages/cli/test/commands/corpus/report.test.ts',
  'packages/cli/test/commands/corpus/runner.test.ts',
  'packages/cli/test/commands/corpus/seed.test.ts',
  'packages/cli/test/commands/inventory-shared-registry.test.ts',
  'packages/cli/test/commands/payload-path-coordinates.test.ts',
  'packages/cli/test/commands/phase-selection.test.ts',
  'packages/cli/test/commands/resources/validate-refusal-stderr.test.ts',
  'packages/cli/test/commands/run-scoped-suite-probe.test.ts',
  'packages/cli/test/commands/skills/validate-non-skill-discovered.test.ts',
  'packages/cli/test/commands/skills/validate-nothing-checked.test.ts',
  'packages/cli/test/org-skill-upload-payload.test.ts',
  'packages/cli/test/utils/agent-runner.test.ts',
  'packages/cli/test/utils/resource-population-source.test.ts',
  'packages/cli/test/utils/user-context-scanner.test.ts',
  'packages/cli/test/verify-vendor-licensing.test.ts',
  'packages/dev-tools/test/common.test.ts',
  'packages/dev-tools/test/compat-empirical/judge-replay.test.ts',
  'packages/dev-tools/test/compat-empirical/load-manifest.test.ts',
  'packages/dev-tools/test/compat-empirical/manual-driver.test.ts',
  'packages/dev-tools/test/compat-empirical/run-loop.test.ts',
  'packages/dev-tools/test/contraband-scan.test.ts',
  'packages/dev-tools/test/engine-floor-agreement.test.ts',
  'packages/dev-tools/test/validate-repo-structure.test.ts',
  'packages/discovery/test/local-scanner.test.ts',
  'packages/lab/test/ab.test.ts',
  'packages/lab/test/crawl-dump.test.ts',
  'packages/lab/test/instrument.test.ts',
  'packages/lab/test/io-capture.test.ts',
  'packages/lab/test/io-counter.test.ts',
  'packages/lab/test/io-dump.test.ts',
  'packages/lab/test/parse-capture.test.ts',
  'packages/lab/test/parse-dump.test.ts',
  'packages/lab/test/store.test.ts',
  'packages/lab/test/vat-lab-cli.test.ts',
  'packages/projection-sqlite/test/derived-tables.test.ts',
  'packages/projection-sqlite/test/ephemeral-store.test.ts',
  'packages/projection-sqlite/test/query.test.ts',
  'packages/projection-sqlite/test/store.test.ts',
  'packages/rag/test/embedding-providers/onnx-model-download.test.ts',
  'packages/resource-compiler/test/cli/stdio-blocking.test.ts',
  'packages/resources/test/ard/ard-manifest.test.ts',
  'packages/resources/test/cache-namespace.test.ts',
  'packages/resources/test/checksum-utils.test.ts',
  'packages/resources/test/content-key.test.ts',
  'packages/resources/test/external-link-validator-auth.test.ts',
  'packages/resources/test/external-link-validator-os-user.test.ts',
  'packages/resources/test/frontmatter-link-validator.test.ts',
  'packages/resources/test/link-auth-content-fetch.test.ts',
  'packages/resources/test/link-parser.test.ts',
  'packages/resources/test/parse-cache.test.ts',
  'packages/resources/test/parse-pool.test.ts',
  'packages/resources/test/parse-timing.test.ts',
  'packages/resources/test/parse-tokenize-probe.test.ts',
  'packages/resources/test/projection-content-cache.test.ts',
  'packages/resources/test/projection-context-id.test.ts',
  'packages/resources/test/projection-crawl-source-refused-listing.test.ts',
  'packages/resources/test/projection-extent-selection.test.ts',
  'packages/resources/test/projection-filesystem-extent.test.ts',
  'packages/resources/test/projection-git-extent.test.ts',
  'packages/resources/test/projection-identity.test.ts',
  'packages/resources/test/projection-package-extent.test.ts',
  'packages/resources/test/projection-realizations.test.ts',
  'packages/resources/test/resolve-local-href.test.ts',
  'packages/utils/test/asset-reference.test.ts',
  'packages/utils/test/crawl-timing-shared.test.ts',
  'packages/utils/test/entrypoint.test.ts',
  'packages/utils/test/git-snapshot-cache.test.ts',
  'packages/utils/test/git-tracker-snapshot-priming.test.ts',
  'packages/utils/test/git-tracker.test.ts',
  'packages/utils/test/git-utils.test.ts',
  'packages/utils/test/gitignore-checker.test.ts',
  'packages/utils/test/remove-scratch-dir.test.ts',
  'packages/utils/test/safe-exec-tool-probe.test.ts',
  'packages/utils/test/skill-test/spawn-claude-registry.test.ts',
  'packages/utils/test/text-content.test.ts',
  'packages/utils/test/timing-dump.test.ts',
] };

/**
 * Ratchet for `local/commands-import-boundary`: the command modules under
 * `packages/cli/src/commands/` that still import `node:fs` (59 sites in 45
 * files when seeded). A command's job is to parse arguments, call
 * a seam and render a report; one that opens the tree itself is an
 * enumeration lane nobody documented — `vat audit` carried a ~700-line walker
 * beside the four declared lanes until it was moved onto `crawlDirectory`.
 * Every other command file is held to the rule at `error` today, so a NEW
 * `node:fs` import in a command is a desk-time failure. The list may only
 * SHRINK: an entry leaves when its file routes the I/O through a seam in
 * `@vibe-agent-toolkit/utils` / `@vibe-agent-toolkit/resources` (or the I/O
 * moves to the library package it belongs to); never add one.
 *
 * Each entry names WHAT the file still does with `fs`, so the next reader can
 * tell an enumeration (`ENUM` — a `readdir`, the shape the rule exists for)
 * from a probe or a copy, and retire the enumerations first.
 */
const COMMANDS_IMPORT_BOUNDARY_RATCHET = { allowFiles: [
  'packages/cli/src/commands/agent/install.ts',                       // access/mkdir/lstat/rm/symlink — install-dir mutation
  'packages/cli/src/commands/agent/installed.ts',                     // ENUM: readdir of the install dir
  'packages/cli/src/commands/agent/uninstall.ts',                     // access/lstat/rm — install-dir mutation
  'packages/cli/src/commands/ard/emit.ts',                            // existsSync probe
  'packages/cli/src/commands/audit.ts',                               // existsSync/stat probes only — the walker is gone (audit/scan-population.ts)
  'packages/cli/src/commands/audit/git-url-clone.ts',                 // mkdtemp/rm — clone scratch dir
  'packages/cli/src/commands/build.ts',                               // ENUM: readdir for phase output; existsSync probes
  'packages/cli/src/commands/cache/clear.ts',                         // ENUM: readdir of the cache dir; rm
  'packages/cli/src/commands/claude/marketplace/changelog-utils.ts',  // readFileSync
  'packages/cli/src/commands/claude/marketplace/git-publish.ts',      // ENUM: readdirSync of the publish tree; mkdtemp/cp/rm
  'packages/cli/src/commands/claude/marketplace/license-utils.ts',    // readFileSync
  'packages/cli/src/commands/claude/marketplace/publish-tree.ts',     // writeFile/cp/readFileSync — publish tree assembly
  'packages/cli/src/commands/claude/marketplace/publish.ts',          // mkdtempSync
  'packages/cli/src/commands/claude/marketplace/validate.ts',         // ENUM: readdirSync over plugins/ and skills/ (lane table: raw-readdir)
  'packages/cli/src/commands/claude/org/skills.ts',                   // ENUM: readdirSync collectFiles + node_modules listing (lane table: raw-readdir)
  'packages/cli/src/commands/claude/plugin/build.ts',                 // ENUM: readdir; mkdir/cp/writeFile — marketplace build
  'packages/cli/src/commands/claude/plugin/helpers.ts',               // existsSync/stat probes, readFile
  'packages/cli/src/commands/claude/plugin/install.ts',               // ENUM: readdirSync ×4; rm/mkdir/cp/symlink — registry + tree copy (audit-A §1.2)
  'packages/cli/src/commands/claude/plugin/plugin-changelog.ts',      // existsSync probes
  'packages/cli/src/commands/claude/plugin/plugin-files.ts',          // existsSync/mkdir/copyFile
  'packages/cli/src/commands/claude/plugin/plugin-validators.ts',     // ENUM: readdir; readFile
  'packages/cli/src/commands/claude/plugin/tree-copy.ts',             // ENUM: readdir; realpath/lstat/copyFile — tree copy
  'packages/cli/src/commands/claude/plugin/uninstall.ts',             // readFileSync
  'packages/cli/src/commands/consistency-check.ts',                   // existsSync probes
  'packages/cli/src/commands/corpus/report.ts',                       // mkdirSync/writeFileSync — report output
  'packages/cli/src/commands/corpus/runner.ts',                       // writeFileSync/existsSync
  'packages/cli/src/commands/corpus/scan.ts',                         // mkdirSync/readFileSync
  'packages/cli/src/commands/corpus/seed.ts',                         // existsSync/readFileSync
  'packages/cli/src/commands/doctor.ts',                              // readFileSync/existsSync probes
  'packages/cli/src/commands/inventory.ts',                           // existsSync probes
  'packages/cli/src/commands/resources/check-progress.ts',            // appendFileSync — cost log
  'packages/cli/src/commands/resources/check-supervisor.ts',          // stat/readFileSync/mkdtemp/rm — child supervision (audit-A §1.2)
  'packages/cli/src/commands/resources/validate.ts',                  // readFile
  'packages/cli/src/commands/skill/review.ts',                        // existsSync/stat probes
  'packages/cli/src/commands/skill/test/configure.ts',                // readFileSync/writeFileSync — config edit
  'packages/cli/src/commands/skill/test/run.ts',                      // existsSync probes
  'packages/cli/src/commands/skills/build.ts',                        // mkdir/rename/rm/mkdtemp — staging
  'packages/cli/src/commands/skills/install.ts',                      // ENUM: readdirSync ×2; rm/cp/mkdtemp/lstat
  'packages/cli/src/commands/skills/list.ts',                         // ENUM: readdirSync of ~/.claude/skills under --user (lane table: raw-readdir)
  'packages/cli/src/commands/skills/package.ts',                      // existsSync/stat probes
  'packages/cli/src/commands/skills/scope-guard.ts',                  // existsSync/stat probes
  'packages/cli/src/commands/skills/shared.ts',                       // existsSync probes, readFile
  'packages/cli/src/commands/skills/skill-discovery.ts',              // existsSync probe
  'packages/cli/src/commands/skills/source-resolvers.ts',             // mkdtemp/existsSync/rm — source staging
  'packages/cli/src/commands/verify.ts',                              // stat/existsSync probes
] };

/**
 * Files still carrying `@typescript-eslint/no-unsafe-member-access` /
 * `no-unsafe-assignment` findings, with the count measured when the ratchet was seeded. A
 * ratchet: the block that consumes this list applies both rules at `error` to
 * every OTHER `src` file, so an entry here is the only way a finding survives.
 * Remove the entry when the file is clean; never add one without the count.
 */
export const NO_UNSAFE_BACKLOG = [
  'packages/agent-skills/src/skill-test/pipeline.ts', // 1
  'packages/cli/src/bin.ts', // 1
  'packages/cli/src/commands/corpus/seed.ts', // 1
  'packages/cli/src/commands/doctor.ts', // 9
  'packages/cli/src/commands/resources/validate.ts', // 1
  'packages/cli/src/utils/config-loader.ts', // 1
  'packages/cli/src/version.ts', // 3
  'packages/dev-tools/src/bump-version.ts', // 15
  'packages/dev-tools/src/determine-publish-tags.ts', // 3
  'packages/dev-tools/src/pre-publish-check.ts', // 3
  'packages/rag/src/embedding-providers/openai-embedding-provider.ts', // 2
  'packages/resource-compiler/src/language-service/completions.ts', // 20
  'packages/resource-compiler/src/language-service/definitions.ts', // 15
  'packages/resource-compiler/src/language-service/diagnostics.ts', // 38
  'packages/resource-compiler/src/language-service/hover.ts', // 18
  'packages/resource-compiler/src/language-service/plugin.ts', // 11
  'packages/resource-compiler/src/language-service/utils.ts', // 65
  'packages/resources/src/link-auth/expand-macro.ts', // 1
  'packages/utils/src/yaml/surgical-yaml.ts', // 2
  'packages/utils/src/zod-introspection.ts', // 9
  'packages/vat-example-cat-agents/src/mcp-collections.ts', // 1
  'packages/vat-example-cat-agents/src/one-shot-llm-analyzer/description-parser.ts', // 1
  'packages/vat-example-cat-agents/src/one-shot-llm-analyzer/photo-analyzer.ts', // 1
];

/**
 * One `local/no-self-package-import` block per workspace package, each naming
 * that package and scoped to the sources it compiles.
 *
 * The rule does not read `package.json` itself on purpose. Every RULE module on
 * the `./eslint` subpath requires nothing at all — not `eslint`, not a
 * third-party package, not even a Node builtin — which is what keeps `eslint` an
 * optional peer dependency and the pack shippable as a subpath of a runtime
 * package (`packages/utils/test/eslint/subpath-purity.test.ts` asserts the empty
 * set for the rules, and exactly `node:fs` + `node:path` for the entry point
 * that lists them).
 * This file is not on that subpath: it already runs in full Node, so reading the
 * manifests here costs the invariant nothing.
 *
 * `src/**` is exactly what every package's tsconfig `include`s. Test and example
 * trees are excluded from every package build and import their own package by
 * name deliberately, to exercise the public entry point the way a consumer does.
 */
function selfImportConfigs() {
  // 🪤 Resolved against THIS FILE, never against the cwd. `readdirSync('packages')`
  // is relative to wherever eslint was started, so any invocation from inside a
  // package — `turbo run lint`, which sets cwd to the package it is linting —
  // died with `ENOENT: scandir 'packages'` before linting a line. Not a finding
  // and not a lint error: a config load failure, exit 2, in every package.
  //
  // A `URL` rather than a `path.join`: this file is subject to the `no-raw-node-path`
  // rule it declares two functions below, and a relative `URL` needs no exemption
  // to be correct on Windows either. The `files:` globs stay strings because flat
  // config already resolves those against the config file's own directory.
  const packagesDir = new URL('packages/', import.meta.url);
  return readdirSync(packagesDir, { withFileTypes: true })
    // Followed inline (this file cannot import the utils helper): a workspace
    // package reached through a link is still a package with a name to guard.
    .filter((entry) => (entry.isSymbolicLink() ? statSync(new URL(`${entry.name}/`, packagesDir)).isDirectory() : entry.isDirectory()))
    .flatMap((entry) => {
      const manifest = new URL(`${entry.name}/package.json`, packagesDir);
      if (!existsSync(manifest)) return [];
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
  // Repo-wide, tests included, no allowlist: 84 sites spawned 'git' or 'node' by
  // bare name (PATH searched at spawn time — SonarCloud S4036 named 13 of them,
  // new code only); all were migrated to process.execPath / NODE_EXECUTABLE /
  // gitExecutable() in one pass, so the next one is an error at the desk.
  'local/no-bare-executable-spawn': 'error',
  'local/no-hardcoded-path-split': 'error',
  'local/no-path-startswith': 'error',
  'local/no-unix-shell-commands': 'error',
  'local/no-os-tmpdir': ['error', PATH_UTILS_EXEMPT],
  'local/no-fs-mkdirSync': ['error', PATH_UTILS_EXEMPT],
  'local/no-fs-realpathSync': ['error', PATH_UTILS_EXEMPT],
  'local/no-manual-path-normalize': 'error',
  'local/no-path-sep-in-strings': 'error',
  'local/no-path-operations-in-comparisons': 'error',
  // One rule over `join`/`resolve`/`relative` (its `functions` option; the
  // default table is all three). `error` here, `warn` in the pack's own
  // `recommended`: this tree has no backlog left to burn down.
  'local/no-raw-node-path': ['error', PATH_IMPL_EXEMPT],
  'local/no-test-scoped-functions': 'error',
  'local/no-fs-promises-cp': 'error',
  'local/no-url-pathname-for-fs': 'error',
  'local/no-bare-dynamic-import-path': 'error',
  'local/no-file-url-string-concat': 'error',
  'local/prefer-startswith-over-regex': 'error',
  'local/require-justified-skip': 'error',
  // Repo-wide, not scoped to the CLI: the hazard is that a phase entry point
  // grows a `process.exit()` and silently truncates an orchestrated run, and the
  // whole point of keying on the `…Phase` name is that a NEW phase — wherever
  // someone puts it — is covered the moment it is named like one. Scoping this
  // to the directory today's phases happen to live in would reintroduce the
  // stale list the naming convention exists to replace.
  'local/no-process-exit-in-phase': 'error',
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
  // ⛔ The mechanism behind `isEntrypoint()`. Enabled here rather than inherited
  // from `configs.recommended` because it is excluded there: `import.meta.main`
  // is only wrong below Node 24.2 / 22.18, which is a fact about the CONSUMER's
  // floor. It is a fact about OURS — this repo declares `>=22.13.0`, where the
  // property is `undefined` — so every such guard here is dead code that exits 0.
  //
  // This is the half of the fix that is not a comment. Three prose
  // `⛔ NOT import.meta.main` banners stood over the three call sites and
  // reverting all three to the bug left the whole suite green; a banner
  // addressed to a human is not a mechanism, and this repo has watched one
  // survive 24 days and a green CI before.
  'local/no-fragile-entrypoint-guard': 'error',
  // A `catch` that neither reads its error nor throws answers every failure
  // the same way, so a permission refusal or a bug reads as "nothing here" at
  // exit 0. This is the one seam `tsc` cannot enumerate: when a callee learns
  // to refuse, every blind catch above it compiles unchanged and absorbs the
  // refusal — which is how a refuse-by-default crawler shipped under a
  // caller that swallowed it. Repo-wide, tests included: a test that swallows
  // is a test that cannot see the failure it is there to catch.
  'local/no-blind-catch': 'error',
  // The two test-tier ratchets. `no-io-in-unit-tier` reads the FILE list above;
  // `no-registry-count-pin` has no backlog — its eleven sites were fixed by
  // pinning the SET a count stood for, or, for the two MEASURED literals (a
  // Node abort code, a calibrated token default), by a disable that names the
  // measurement. The next constant-equals-itself assertion is an error at the desk.
  'local/no-io-in-unit-tier': ['error', UNIT_TIER_IO_RATCHET],
  'local/no-registry-count-pin': ['error', { minLiteral: 5 }],
  // ONE exit-code contract. Every `process.exit(…)` names a member of
  // `ExitCode` (`@vibe-agent-toolkit/schema`): 0 ok, 1 findings, 2 error.
  // Five vocabularies used to coexist (skill test read 1 as "the harness
  // broke", audit exited 0 over `status: error`, the lab had a 3) and the
  // orchestrator read all of them as one. No backlog: 176 sites were migrated
  // the day this was enabled. `allow` is not a ratchet of product code — it
  // names the three EXAMPLE scripts that are not vat verbs and would otherwise
  // take a dependency on `schema` for one line each.
  'local/no-literal-process-exit': ['error', { allow: [
    'packages/gateway-mcp/examples/example-helpers.ts',
    'packages/vat-development-agents/agents/agent-generator/validate-agent.ts',
    'packages/vat-example-cat-agents/examples/photo-analysis-demo.ts',
  ] }],
  // The containment trio, from the sweep that watched a delete, a copy and an
  // uninstall walk out of their root. No backlog and no ratchet: every site
  // was fixed the day these were enabled, so the next `startsWith('..')`, the
  // next `Dirent` walk that drops a symlink on the floor, and the next
  // `z.literal(<number>)` on a `version` field are errors at the desk. The two
  // lexical helpers the first rule points every caller at
  // (`hasParentTraversalSegment`, `relativeEscapesRoot`) carry the only
  // sanctioned disables, with the reason inline.
  'local/no-dotdot-containment': 'error',
  'local/dirent-type-needs-symlink-check': 'error',
  'local/no-version-literal': ['error', { allowNames: [] }],
  // The command/library boundary, as a ratchet (see the list's own comment).
  // `commandGlobs` is the rule's default (`packages/cli/src/commands/`);
  // `forbiddenModules` stays at its default too — no command imports a
  // `@vibe-agent-toolkit/resources/<subpath>` today and the local walker the
  // rule was written against no longer exists.
  'local/commands-import-boundary': ['error', COMMANDS_IMPORT_BOUNDARY_RATCHET],
  // Comments under `src/` may not cite an issue/PR number, an ISO date or a
  // named person: the rule stays in the comment, the history goes to the
  // commit, the CHANGELOG or docs/contributing/. No backlog and no ratchet —
  // 175 blocks were rewritten when this was enabled. The one date shape it
  // leaves alone is `@vendor-claim reviewed=…`, which a freshness gate reads.
  'local/no-decaying-referent': ['error', { names: ['Jeff'], allowDates: false }],
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

// This block is the ONE owner of "which YAML / frontmatter library". `yaml`
// (eemeli) is the library: it round-trips comments and key order, which the
// frontmatter rewriter depends on, and it is the only YAML parser in the
// dependency graph. `js-yaml` and `gray-matter` are banned here — not by a
// CLAUDE.md rule (an earlier version of this comment cited one that never
// existed), and not by a table in `docs/best-practices.md` (which once
// approved `js-yaml`; the lint rule is the durable record, so the docs point
// here). Applied to both TS and JS blocks below.
const OPEN_FRONTMATTER_MESSAGE = 'Use openFrontmatter from @vibe-agent-toolkit/resources — preserves comments.';
const noRestrictedImportsConfig = ['error', {
  paths: [
    {
      name: 'js-yaml',
      message: 'Use `yaml` (eemeli) — the one YAML library in this repo; see noRestrictedImportsConfig in eslint.config.js. Frontmatter writes: openFrontmatter from @vibe-agent-toolkit/resources.',
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
  // VAT is a filesystem tool: nearly every fs call takes a computed path, so
  // this rule fired on all of them. It had accumulated 1,361 disable
  // directives (82% of every directive in the repo) and in 93 commits of
  // history not one removal was a code fix — every one was the call being
  // deleted or moved. Containment is enforced where it matters instead:
  // `local/no-unsafe-root-join` at the harness roots and the containment
  // helpers in `@vibe-agent-toolkit/utils`.
  'security/detect-non-literal-fs-filename': 'off',
  'sonarjs/cognitive-complexity': ['error', 15],
  'sonarjs/no-duplicate-string': 'warn',
  'n/no-path-concat': 'error',
  // Every `eslint-disable*` carries a `-- reason`. The `--` grammar was a
  // convention with no enforcement; 38 src and 127 test directives had none
  // when this landed, and a bare directive is a suppression nobody can review.
  // `eslint-enable` is exempt: the matching disable holds the reason.
  'eslint-comments/require-description': ['error', { ignore: ['eslint-enable'] }],
};

export default [
  // Global ignores
  {
    ignores: [
      'dist/',
      'build/',
      'coverage/',
      'node_modules/',
      // Emitted by tsc-clean-build, gitignored, and NOT source. An interrupted build leaves it
      // behind, and linting it fails the gate on generated code nobody wrote — a spurious red
      // that looks exactly like a real one.
      '**/.tsc-staging/',
      'generated/',
      '**/generated/',
      '**/*.d.ts',
      '**/*.d.cts',  // same intent as *.d.ts — a `.cts` declaration file is still a declaration file
      'vitest.config.ts',
      'vitest.*.config.ts',
      'vitest.shared.ts',
      'vitest.setup.js',
      '.claude/worktrees/',  // Claude Code worktrees
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
    files: ['**/*.ts', '**/*.cts'],
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
      'eslint-comments': eslintComments,
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
      // `no-unsafe-member-access` / `no-unsafe-assignment` are enabled as a
      // RATCHET in the `packages/*/src` block below, not here: see
      // `NO_UNSAFE_BACKLOG`.
    },
  },

  // `@typescript-eslint/no-unsafe-*` — a ratchet over `src/`.
  //
  // This pair sat in a "too noisy (260+ warnings) … right now" note from
  // 2026-02 for seven months with no expiry, which is a decision to never do it.
  // Re-measured when this ratchet was seeded over `packages/*/src/**/*.ts`: 222 findings in 23
  // files, 167 of them in `resource-compiler/src/language-service/` (the TS
  // Language Service plugin API is `any`-typed at its boundary). So: `error`
  // for every OTHER src file from today, and the 23 are listed here with their
  // counts. The list may only shrink — delete an entry when its file is clean.
  // Lint cannot tell you when that is (the rules apply only to files NOT
  // listed); `dev-tools/test/integration/no-unsafe-backlog-ratchet.integration.test.ts`
  // lints each listed file type-aware with the exemption lifted and fails on
  // one that is clean. Adding a file here is the thing this block exists to
  // make visible.
  {
    files: ['packages/*/src/**/*.ts'],
    ignores: NO_UNSAFE_BACKLOG,
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
    },
  },

  // Contracts, over `src/` only.
  //
  // `explicit-zod-strictness`: every `z.object(…)` says what it does with a key
  // it does not declare — `.strict()` (the default here; the reader's strict
  // schema is what CLAUDE.md retired every version integer in favour of) or
  // `.passthrough()` with a comment naming the external owner of the shape
  // (a Claude settings file, a plugin manifest, an npm `package.json`, an
  // adopter config sub-tree that once silently stripped keys and cannot be
  // made strict without bricking those adopters). Zod's silent-strip default
  // is the one answer this repo cannot afford. `src` only: tests build schemas
  // as fixtures, and 125 of them would be noise. No backlog — 74 sites were
  // annotated the day this was enabled.
  //
  // `no-restricted-syntax`: no dispatch on error PROSE. `err.message.includes(…)`
  // held exactly until someone reworded the sentence; three packages recognised
  // a root escape that way. Every VAT error extends `VatError` and carries a
  // `code` — dispatch on `isVatError(err, code)`, `instanceof`, or an errno
  // predicate (`isPathAbsentError`). No backlog of the SHAPE: all 21 direct
  // sites were rewritten. The selectors see only `x.message.<method>(` and
  // `re.test(x.message)`; a message copied into a local first
  // (`const message = err.message; pattern.test(message)`) is invisible to
  // them and is caught by review, not by lint — one such site exists
  // legitimately (vendor prose in `claude/org/skills.ts`).
  {
    files: ['packages/*/src/**/*.ts'],
    rules: {
      'local/explicit-zod-strictness': ['error', { allowDefaultStripIn: [] }],
      'no-restricted-syntax': ['error',
        {
          selector: "CallExpression[callee.type='MemberExpression'][callee.object.type='MemberExpression'][callee.object.property.name='message'][callee.property.name=/^(includes|startsWith|endsWith|match|search)$/]",
          message: 'Do not dispatch on an error message. Dispatch on its code (`isVatError(err, code)`), its class (`instanceof`), or an errno predicate (`isPathAbsentError`) — prose is for humans and changes when it is improved.',
        },
        {
          selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='test'][arguments.0.type='MemberExpression'][arguments.0.property.name='message']",
          message: 'Do not test a regex against an error message. Dispatch on its code (`isVatError(err, code)`), its class (`instanceof`), or an errno predicate (`isPathAbsentError`).',
        },
        // Every VAT error carries a `code`: a class that extends the bare
        // `Error` has none, and the contract above has nothing to dispatch on.
        // One such class survived the sweep by being added after it.
        {
          selector: "ClassDeclaration[superClass.name='Error']",
          message: 'Extend `VatError` from @vibe-agent-toolkit/utils (with a SCREAMING_SNAKE code), not the bare `Error` — every VAT error carries a code a catch block can dispatch on.',
        },
      ],
    },
  },
  // The base class itself is the one legitimate `extends Error` in `src`.
  {
    files: ['packages/utils/src/errors/vat-error.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  // Plain JS / CJS / MJS files (eslint configs, dev-tools scripts, the rule
  // pack in `packages/utils/eslint/rules/*.cjs`). These
  // files were previously unlinted because the TS block above only globs
  // **/*.ts and **/*.cts — letting findings like SonarCloud's S6324
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
      'eslint-comments': eslintComments,
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

  // Test tier. CLAUDE.md has promised "complexity 20 for tests" and "any
  // allowed in tests" since the repo began; until this ratchet landed no block
  // implemented either, and 929 test-file directives (94.5% of the test
  // tier's total) existed for the five rules relaxed here. Tests are held to
  // every other production rule.
  {
    files: ['packages/*/test/**/*.ts', 'test/**/*.ts'],
    rules: {
      'sonarjs/cognitive-complexity': ['error', 20],
      '@typescript-eslint/no-explicit-any': 'off',
      // Test bodies spawn `git`/`node`/`bun` by bare name and build fixture
      // strings that repeat; those are the fixture, not a smell.
      'sonarjs/no-os-command-from-path': 'off',
      'sonarjs/no-duplicate-string': 'off',
      'sonarjs/publicly-writable-directories': 'off',
      'sonarjs/file-permissions': 'off',
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
  // `recommended: false` note in `packages/utils/eslint/rules/no-self-package-import.cjs`.
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
