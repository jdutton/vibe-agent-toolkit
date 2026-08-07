/**
 * `@vibe-agent-toolkit/utils/eslint` — cross-platform and agentic-code safety rules.
 *
 * These rules enforce the safe helpers published by the rest of this package
 * (`safePath.*` on `/path`, `normalizedTmpdir()`, `mkdirSyncReal()`,
 * `normalizePath()` on `/fs`, `safeExecSync()` on `/process`). The helpers exist
 * because the raw primitives they wrap have platform potholes; the rules exist so
 * a call to the raw primitive fails at lint time on the author's machine rather
 * than in CI on a different OS.
 *
 * They ship as a SUBPATH rather than a separate package because an ESLint plugin
 * is data, not code that runs: every module below exports a plain rule object and
 * none of them `require('eslint')`. So this entry resolves — and the other twelve
 * subpaths keep resolving — whether or not ESLint is installed, which is why
 * `eslint` is declared as an OPTIONAL peer dependency. One install, one version,
 * no way for the rules to drift from the helpers they name.
 *
 * CommonJS on purpose, in an ESM package: the rule modules are `.cjs`, Node keys
 * module format off the extension regardless of the package's `"type"`, and a CJS
 * entry point can be both `require()`d from an `eslint.config.cjs` and `import`ed
 * from an `eslint.config.js`/`.mjs`.
 *
 * Rules whose exemptions name a file (the ONE implementation file allowed to call
 * the primitive) take an `exemptFiles` option — see README.md. The shipped
 * defaults are EMPTY: an exemption is a claim about a specific repo's layout, and
 * inheriting another repo's claim is how a same-named file silently opts itself
 * out of a rule.
 */

'use strict';

const rules = {
  'no-child-process-execSync': require('./rules/no-child-process-execSync.cjs'),
  'no-hardcoded-path-split': require('./rules/no-hardcoded-path-split.cjs'),
  'no-path-startswith': require('./rules/no-path-startswith.cjs'),
  'no-unix-shell-commands': require('./rules/no-unix-shell-commands.cjs'),
  'no-os-tmpdir': require('./rules/no-os-tmpdir.cjs'),
  'no-fs-mkdirSync': require('./rules/no-fs-mkdirSync.cjs'),
  'no-fs-realpathSync': require('./rules/no-fs-realpathSync.cjs'),
  'no-manual-path-normalize': require('./rules/no-manual-path-normalize.cjs'),
  'no-path-sep-in-strings': require('./rules/no-path-sep-in-strings.cjs'),
  'no-path-operations-in-comparisons': require('./rules/no-path-operations-in-comparisons.cjs'),
  'no-path-join': require('./rules/no-path-join.cjs'),
  'no-path-resolve': require('./rules/no-path-resolve.cjs'),
  'no-path-relative': require('./rules/no-path-relative.cjs'),
  'no-test-scoped-functions': require('./rules/no-test-scoped-functions.cjs'),
  'no-fs-promises-cp': require('./rules/no-fs-promises-cp.cjs'),
  'no-url-pathname-for-fs': require('./rules/no-url-pathname-for-fs.cjs'),
  'no-bare-dynamic-import-path': require('./rules/no-bare-dynamic-import-path.cjs'),
  'no-file-url-string-concat': require('./rules/no-file-url-string-concat.cjs'),
  'prefer-startswith-over-regex': require('./rules/prefer-startswith-over-regex.cjs'),
  'no-unsafe-root-join': require('./rules/no-unsafe-root-join.cjs'),
  'require-justified-skip': require('./rules/require-justified-skip.cjs'),
};

/**
 * Rules deliberately LEFT OUT of `configs.recommended`.
 *
 * `recommended` is the cross-platform-safety core: every rule in it flags a call
 * that is wrong (or unportable) regardless of how the adopting project likes to
 * write tests. The two below are neither — they encode a position on TEST STYLE:
 *
 * - `require-justified-skip` — a specific annotation grammar (`SKIP(#123): reason`)
 *   for a disabled test, plus a view on what counts as a tautological assertion.
 * - `no-test-scoped-functions` — a view on WHERE a test helper may be declared
 *   (module scope, never inside `describe`/`it`).
 *
 * Someone installing this package for `safePath.join()` should not silently
 * inherit either. Both ship in `rules` and stay enabled explicitly:
 *
 *   '@vibe-agent-toolkit/require-justified-skip': 'error',
 *
 * That is exactly what VAT's own `eslint.config.js` does — it does not consume
 * `configs.recommended` at all, so this exclusion changes nothing about how this
 * repo lints itself.
 */
const RECOMMENDED_EXCLUDE = new Set([
  'require-justified-skip',
  'no-test-scoped-functions',
  // Excluded for a DIFFERENT reason than the two above: not a style opinion, but
  // an unsound heuristic. It keys on whether an identifier's name ends in `root`
  // rather than on whether any segment is caller-controlled, which makes it
  // simultaneously noisy and blind. Measured on a 4,670-file adopter tree: 108
  // findings, 0 autofixable, and every one of these verified by execution here:
  //
  //   FIRES   safePath.join(repoRoot, 'docs', 'product')  <- all literals, cannot escape
  //   FIRES   safePath.resolve(packageRoot, '..', '..')   <- escaping IS the intent; the fix breaks it
  //   FIRES   safePath.join(repoRoot)                     <- one argument, no segment at all
  //   silent  safePath.join(base, userInput)              <- THE dangerous shape, missed
  //
  // A rule that misses the case it exists to catch must not ride in a config
  // named `recommended` at any severity — a safety core that cries wolf teaches
  // people to ignore it, which costs the true positives too. It still ships, and
  // it still earns `error` where scoped to directories in which a path escape is
  // a security boundary (this repo scopes it to the skill-test staging code).
  // Re-include it when it keys on taint rather than on naming.
  'no-unsafe-root-join',
]);

/**
 * Default severities for `configs.recommended`.
 *
 * `error` is the default: every rule below flags a call whose replacement is a
 * one-line swap, and a wrong answer is a real bug on some platform.
 *
 * `warn` is reserved for the case where a fresh adopter's first run would
 * otherwise be a wall of blocking errors they cannot triage in one sitting:
 * `no-path-join` / `no-path-resolve` / `no-path-relative`, the highest-churn
 * rules by far (they fire on every raw `node:path` call in the codebase).
 * Measured on a 4,670-file adopter tree: 3,963 + 372 + 1 findings, **all
 * autofixable**. All three auto-fix, so `warn` lets a project run `--fix` and
 * burn the list down incrementally instead of blocking CI on day one.
 *
 * Raise them to `error` once the backlog is clear — that is what VAT itself does.
 *
 * The criterion for `warn` is MIGRATION VOLUME, not how real the finding is. Every
 * rule in this pack either prevents a bug or shifts a static-analysis finding left of
 * a merge, and both are worth blocking on; what `warn` buys is a first run that reads
 * as a backlog to `--fix` rather than a wall. `prefer-startswith-over-regex` was
 * briefly graded on a different axis ("style, not a defect") and demoted — that was
 * wrong twice over: avoiding a SonarQube S6557 at lint time instead of at merge time
 * is a real saving, and the rule's matcher rejects any regex containing a
 * metacharacter, so it only fires on true literal prefixes and has near-zero churn.
 * It is `error`.
 */
const RECOMMENDED_WARN = new Set([
  'no-path-join',
  'no-path-resolve',
  'no-path-relative',
]);

/**
 * Plugin namespace an adopter gets from `configs.recommended`, and therefore the
 * prefix on every rule id (`@vibe-agent-toolkit/no-path-join`).
 *
 * Deliberately the SCOPE, not the full subpath specifier: rule ids are the surface
 * adopters type into `rules`, `eslint-disable` comments and CI baselines, and they
 * should not have to change if the pack ever moves house again. (This repo's own
 * config registers the same object under `local` for exactly that reason.)
 */
const NAMESPACE = '@vibe-agent-toolkit';

const plugin = {
  meta: {
    name: '@vibe-agent-toolkit/utils/eslint',
  },
  rules,
  configs: {},
};

plugin.configs.recommended = {
  name: '@vibe-agent-toolkit/utils/eslint/recommended',
  plugins: { [NAMESPACE]: plugin },
  rules: Object.fromEntries(
    Object.keys(rules)
      .filter((name) => !RECOMMENDED_EXCLUDE.has(name))
      .map((name) => [`${NAMESPACE}/${name}`, RECOMMENDED_WARN.has(name) ? 'warn' : 'error']),
  ),
};

module.exports = plugin;
