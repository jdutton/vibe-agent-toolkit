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
 * is data, not code that runs: every rule module exports a plain rule object and
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
 * ## The manifest is the directory
 *
 * There is no hand-maintained list of rules here. Every `rules/*.cjs` whose
 * export carries a `meta` object IS a rule, keyed by its basename; the modules
 * that export a factory or a helper object (`eslint-rule-factory`,
 * `no-command-direct-factory`, `exempt-path-matcher`, `safe-import`,
 * `dead-import`) have no `meta` and are skipped. Each rule then declares its own
 * place in `configs.recommended` through `meta.docs.recommended` and
 * `meta.docs.recommendedSeverity`, beside the rule it describes — so adding a
 * rule is one file, and the README/docs table is generated from the same
 * metadata (`bun run generate:eslint-rules-doc` in `packages/utils`).
 *
 * The last hand list here held 27 entries and was mirrored by three literal
 * counts in two test files and two prose counts in two docs, every one of which
 * had drifted at least once. A directory listing cannot drift.
 *
 * `node:fs` and `node:path` are the ONLY external modules this subpath reaches,
 * and only from this file: the rule modules themselves still require nothing —
 * `test/eslint/subpath-purity.test.ts` pins both halves. Two builtins that ship
 * with every Node install do not change the optional-peer property, which was
 * only ever about `eslint` and third-party packages.
 *
 * Rules whose exemptions name a file (the ONE implementation file allowed to call
 * the primitive) take an `exemptFiles` option — see README.md. The shipped
 * defaults are EMPTY: an exemption is a claim about a specific repo's layout, and
 * inheriting another repo's claim is how a same-named file silently opts itself
 * out of a rule.
 */

'use strict';

const { readdirSync } = require('node:fs');
const path = require('node:path');

const RULES_DIR = path.join(__dirname, 'rules');

/**
 * The two values `recommendedSeverity` may take. A rule that is not
 * recommended may still declare one — it is the severity the rule WOULD ride
 * at, and the generated docs table prints it — but `off` is not a spelling: a
 * rule that wants to be off is a rule with `recommended: false`.
 */
const RECOMMENDED_SEVERITIES = new Set(['error', 'warn']);

/**
 * Read a rule's `meta.docs` and refuse anything a rule in this pack must not ship
 * without. Thrown at load time, so a malformed rule fails every consumer's
 * `eslint` run at startup rather than silently landing outside `recommended`.
 */
function validateRuleDocs(name, rule) {
  if (typeof rule.create !== 'function') {
    throw new TypeError(`eslint rule '${name}' exports a meta but no create function`);
  }
  const docs = rule.meta.docs;
  if (typeof docs?.description !== 'string' || docs.description.length === 0) {
    throw new TypeError(`eslint rule '${name}' has no meta.docs.description`);
  }
  if (typeof docs.recommended !== 'boolean') {
    throw new TypeError(`eslint rule '${name}' must declare meta.docs.recommended as a boolean`);
  }
  if (docs.recommendedSeverity !== undefined && !RECOMMENDED_SEVERITIES.has(docs.recommendedSeverity)) {
    throw new TypeError(`eslint rule '${name}' declares meta.docs.recommendedSeverity outside 'error' | 'warn'`);
  }
  if (docs.recommended && docs.recommendedSeverity === undefined) {
    throw new TypeError(`eslint rule '${name}' is recommended but declares no meta.docs.recommendedSeverity`);
  }
}

/**
 * Every rule module under `rules/`, keyed by basename, in directory order
 * (which `readdirSync` returns sorted on every platform this package supports).
 *
 * Distinguished from the factories and helpers by a `meta` export, not by
 * filename: a naming convention is a claim nobody checks, and a factory that
 * happened to be named `no-…` would otherwise be registered as a rule whose
 * `create` is a function that builds rules.
 */
function discoverRules(rulesDir = RULES_DIR) {
  const rules = {};
  for (const file of readdirSync(rulesDir)) {
    if (!file.endsWith('.cjs')) {
      continue;
    }
    // eslint-disable-next-line security/detect-non-literal-require -- the directory listing IS the manifest; every entry is a file this package ships
    const candidate = require(path.join(rulesDir, file));
    if (typeof candidate !== 'object' || candidate === null || typeof candidate.meta !== 'object') {
      continue;
    }
    const name = file.slice(0, -'.cjs'.length);
    validateRuleDocs(name, candidate);
    rules[name] = candidate;
  }
  return rules;
}

const rules = discoverRules();

/**
 * Plugin namespace an adopter gets from `configs.recommended`, and therefore the
 * prefix on every rule id (`@vibe-agent-toolkit/no-raw-node-path`).
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
  /** Test seam: the discovery walk over an arbitrary directory, so the load-time refusals can be exercised on a fixture. */
  __internal: { discoverRules },
};

/**
 * `configs.recommended` is the cross-platform-safety core: every rule whose
 * `meta.docs.recommended` is true, at the severity it declares.
 *
 * `error` is the norm: every such rule flags a call whose replacement is a
 * one-line swap, and a wrong answer is a real bug on some platform. `warn` is
 * reserved for the case where a fresh adopter's first run would otherwise be a
 * wall of blocking errors they cannot triage in one sitting — the criterion is
 * MIGRATION VOLUME, not how real the finding is. A rule whose findings were
 * doubted would be out of `recommended` entirely, not demoted.
 *
 * Each rule that opts OUT states why beside its own `recommended: false`. The
 * reasons fall into a few families — a position on TEST STYLE
 * (`require-justified-skip`, `no-test-scoped-functions`), a heuristic that keys
 * on a NAMING CONVENTION rather than the property it cares about
 * (`no-unsafe-root-join`, `no-process-exit-in-phase`), a SEAM that only exists
 * once the consumer writes it (`no-raw-text-decode`), a REQUIRED OPTION this
 * config cannot supply (`no-self-package-import`), and a claim about the
 * CONSUMER's environment that is right for some and wrong for others
 * (`no-fragile-entrypoint-guard`, `no-bare-symlink-in-tests`). Someone installing
 * this package for `safePath.join()` should not silently inherit any of them.
 * All still ship in `rules` and are enabled by naming them — which is what
 * VAT's own `eslint.config.js` does; it does not consume `configs.recommended`.
 */
plugin.configs.recommended = {
  name: '@vibe-agent-toolkit/utils/eslint/recommended',
  plugins: { [NAMESPACE]: plugin },
  rules: Object.fromEntries(
    Object.entries(rules)
      .filter(([, rule]) => rule.meta.docs.recommended)
      .map(([name, rule]) => [`${NAMESPACE}/${name}`, rule.meta.docs.recommendedSeverity]),
  ),
};

module.exports = plugin;
