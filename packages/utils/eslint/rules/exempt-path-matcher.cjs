/**
 * Shared exemption matcher for local ESLint rule factories.
 *
 * Rules that ban an unsafe primitive have to exempt the ONE file that implements
 * the safe replacement. Doing that with `filename.includes('path-utils.ts')` is a
 * silent hole: any file anywhere — in this repo or in a consumer repo running
 * these rules — whose path merely CONTAINS that string opts itself out. A private
 * `tools/hooks/path-utils.ts` full of raw `tmpdir()` / `realpathSync()` calls
 * linted clean for exactly this reason.
 *
 * Exemptions are therefore repo-relative paths matched at a path-segment
 * boundary: the linted filename must either BE the exempt path, or END WITH
 * `/` + the exempt path. Matching happens on forward slashes — a rule pack whose
 * whole purpose is enforcing cross-platform path handling must not itself be
 * `\` vs `/` dependent.
 *
 * Three shapes of exemption live here, and every local rule must take one of
 * them rather than reaching for `includes()` again:
 *
 * - `createExemptPathMatcher` — "is this THAT file?" (a named implementation file)
 * - `createExemptDirectoryMatcher` — "is this file INSIDE that directory?" (a package
 *   that owns a centralized wrapper)
 * - `isTestFile` — "is this a test file?" (a category, anchored on the basename's
 *   extension rather than on a path segment)
 *
 * `eslint-rule-factory.cjs`, `path-function-rule-factory.cjs`,
 * `no-command-direct-factory.cjs` and `no-unix-shell-commands.cjs` all use these.
 * Do not re-implement any of them: the sibling-factory copy is how the bug
 * shipped four times in the first place.
 *
 * A fourth export, `createConfigurableExemptPathMatcher`, wires the file-shaped
 * exemption to the rule's own ESLint option so each CONSUMER declares the paths
 * for its own repo. It also lives here (rather than in each factory) for the same
 * reason: two copies is how the bug spread last time.
 */

/** Forward-slash a path and drop any leading `./` or `/` noise used for anchoring. */
function normalizeForMatch(value) {
  return String(value).replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
}

/**
 * Build a predicate that reports whether a linted filename is one of `exemptPaths`.
 *
 * @param {readonly string[]} exemptPaths - Repo-relative paths, e.g.
 *   `['packages/utils/src/path-utils.ts']`. A bare basename is accepted by the
 *   matcher but matches that filename ANYWHERE in the tree (ESLint filenames are
 *   absolute, so the `endsWith('/' + target)` leg is what fires) — pass the full
 *   repo-relative path. Rules surface that mistake via
 *   {@link reportUnanchoredExemptEntries}.
 * @returns {(filename: string) => boolean} Anchored, separator-agnostic predicate.
 */
function createExemptPathMatcher(exemptPaths) {
  const targets = [...exemptPaths]
    .map((exemptPath) => normalizeForMatch(exemptPath).replace(/^\/+/, ''))
    .filter((exemptPath) => exemptPath.length > 0);

  return function isExemptPath(filename) {
    if (!filename) {
      return false;
    }
    const normalized = normalizeForMatch(filename);
    return targets.some(
      (target) => normalized === target || normalized.endsWith(`/${target}`),
    );
  };
}

/**
 * JSON Schema for the `exemptFiles` rule option, for a rule's `meta.schema`.
 *
 * `additionalProperties: false` on purpose: a typo'd option key must be an ESLint
 * config error, not a silently ignored exemption list (which would read as "the
 * rule stopped firing for no reason").
 */
const EXEMPT_FILES_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    exemptFiles: {
      type: 'array',
      items: { type: 'string' },
      uniqueItems: true,
    },
  },
  additionalProperties: false,
});

/**
 * Wire a file-shaped exemption to the rule's `exemptFiles` option.
 *
 * An exemption names the ONE file in a SPECIFIC repo that implements the safe
 * replacement, so it cannot be shipped as a useful default: a package publishing
 * `packages/utils/src/path-utils.ts` as a built-in exemption hands every consumer
 * a hole at that path. Hence the empty default here, and hence REPLACE rather
 * than merge semantics — a consumer's list is the whole list.
 *
 * @param {readonly string[]} [defaultPaths] - Fallback used only when the rule is
 *   configured with no `exemptFiles` option. Ship this empty unless the rule
 *   itself owns the file (no shipped rule in this package does).
 * @returns {(context: object) => (filename: string) => boolean} Resolver taking an
 *   ESLint rule context and returning the anchored predicate for that invocation.
 */
function createConfigurableExemptPathMatcher(defaultPaths = []) {
  const defaultMatcher = createExemptPathMatcher(defaultPaths);
  const cache = new Map();

  return function exemptMatcherFor(context) {
    const configured = context.options?.[0]?.exemptFiles;
    if (!Array.isArray(configured)) {
      return defaultMatcher;
    }
    // JSON, not join(): a delimiter cheap enough to be collision-free is a raw
    // NUL, which this repo bans in source (git and ripgrep treat the file as
    // binary and skip its contents), and any printable delimiter can legally
    // appear in a path.
    const key = JSON.stringify(configured);
    let matcher = cache.get(key);
    if (!matcher) {
      matcher = createExemptPathMatcher(configured);
      cache.set(key, matcher);
    }
    return matcher;
  };
}

/**
 * `messageId` every rule that accepts `exemptFiles` must declare, so an
 * unanchored entry is reported through the normal lint channel.
 *
 * Not a JSON Schema `pattern` on the option, which would be the obvious place:
 * the schema sees the RAW string, and `./path-utils.ts` contains a `/` while
 * normalizing to exactly the same repo-wide exemption as `path-utils.ts`. A
 * check that the wrong spelling slips past is worse than none. Not a
 * `process.emitWarning` either — a notice on stderr is not a reported finding
 * and gets scrolled past.
 */
const UNANCHORED_EXEMPT_FILE = 'unanchoredExemptFile';

/**
 * The `meta.messages` entry for {@link UNANCHORED_EXEMPT_FILE}.
 *
 * ESLint filenames are ABSOLUTE, and an exemption matches when the filename ends
 * with `/` + the entry. So a bare basename does not mean "the file at the repo
 * root" (as this module's JSDoc used to claim) — it means EVERY file with that
 * name, anywhere in the tree, including ones added later by someone who never
 * saw the config. That is the same repo-wide hole the anchoring rewrite closed,
 * reopened one config entry at a time.
 */
const UNANCHORED_EXEMPT_MESSAGE =
  'exemptFiles entry "{{entry}}" is a bare filename, so it exempts EVERY file named ' +
  '"{{entry}}" anywhere in the repo — including files added later. Give the ' +
  'repo-relative path instead (e.g. "packages/utils/src/{{entry}}").';

/**
 * The configured `exemptFiles` entries that are not anchored to a directory.
 *
 * Runs on the NORMALIZED entry, so `./x.ts` and `x.ts` are both caught.
 *
 * @param {object} context - ESLint rule context.
 * @returns {string[]} Offending entries, as the consumer spelled them.
 */
function findUnanchoredExemptEntries(context) {
  const configured = context.options?.[0]?.exemptFiles;
  if (!Array.isArray(configured)) {
    return [];
  }
  return configured.filter((entry) => {
    const normalized = normalizeForMatch(entry).replace(/^\/+/, '');
    return normalized.length > 0 && !normalized.includes('/');
  });
}

/**
 * Report every unanchored `exemptFiles` entry against the `Program` node.
 *
 * Deliberately stateless — no "warn once per process" dedupe. ESLint caches
 * results per file, so a rule that remembers having warned goes SILENT on the
 * second run against a warm cache, which is precisely when a stale config is
 * least likely to be noticed.
 *
 * @param {object} context - ESLint rule context.
 * @param {object} node - The `Program` node to anchor the report on.
 */
function reportUnanchoredExemptEntries(context, node) {
  for (const entry of findUnanchoredExemptEntries(context)) {
    context.report({ node, messageId: UNANCHORED_EXEMPT_FILE, data: { entry } });
  }
}

/**
 * Build a predicate that reports whether a linted filename lives UNDER one of
 * `exemptDirs`.
 *
 * The directory flavor of the same bug: `filename.includes('packages/git/')`
 * also exempted `vendor/copy-packages/git/` and `tools/my-packages/git/` — any
 * directory whose name merely ENDS WITH the exempt one. Anchoring means the
 * directory must start the repo-relative path or be preceded by a `/`.
 *
 * @param {readonly string[]} exemptDirs - Repo-relative directories, with or
 *   without a trailing slash, e.g. `['packages/git/']`.
 * @returns {(filename: string) => boolean} Anchored, separator-agnostic predicate.
 */
function createExemptDirectoryMatcher(exemptDirs) {
  // Normalize each directory to a `<dir>/` PREFIX rather than stripping trailing
  // slashes: a trailing-slash strip needs either `/\/+$/` (flagged by
  // sonarjs/slow-regex) or `.split('/')` (banned repo-wide by this very rule pack).
  const prefixes = [...exemptDirs]
    .map((dir) => normalizeForMatch(dir).replace(/^\/+/, ''))
    .filter((dir) => dir.length > 0)
    .map((dir) => (dir.endsWith('/') ? dir : `${dir}/`));

  return function isUnderExemptDirectory(filename) {
    if (!filename) {
      return false;
    }
    const normalized = normalizeForMatch(filename);
    return prefixes.some(
      (prefix) => normalized.startsWith(prefix) || normalized.includes(`/${prefix}`),
    );
  };
}

/**
 * Test-file naming convention, anchored to the END of the BASENAME.
 *
 * This is a CATEGORY check, not a path exemption, so `createExemptPathMatcher`
 * is the wrong tool: there is no repo-relative path to compare against. What
 * "anchored" means here is that the extension must terminate the last path
 * segment. `filename.includes('.test.ts')` satisfied neither end — it exempted
 * `example.test.ts.bak`, a directory named `.test.ts-helpers/`, and (a real
 * tracked file in this repo) `tsconfig.test.json` via the `.test.js` spelling.
 *
 * The repo convention is `*.test.ts` (unit, `*.integration.test.ts`, and
 * `*.system.test.ts` all land on it); the js/mjs/cjs/mts/tsx variants are
 * covered because a category predicate that only knew one extension would be
 * the next silent hole. `.spec.` is deliberately absent — this repo has zero
 * such files and vitest's `include` globs would not run them.
 */
const TEST_FILE_EXTENSION = /\.test\.[cm]?[jt]sx?$/;

/**
 * @param {string} filename - Path as ESLint reports it (absolute, any separator).
 * @returns {boolean} True when the file itself is a test file.
 */
function isTestFile(filename) {
  if (!filename) {
    return false;
  }
  const normalized = normalizeForMatch(filename);
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  return TEST_FILE_EXTENSION.test(basename);
}

module.exports = {
  EXEMPT_FILES_SCHEMA,
  UNANCHORED_EXEMPT_FILE,
  UNANCHORED_EXEMPT_MESSAGE,
  createConfigurableExemptPathMatcher,
  createExemptDirectoryMatcher,
  createExemptPathMatcher,
  findUnanchoredExemptEntries,
  isTestFile,
  normalizeForMatch,
  reportUnanchoredExemptEntries,
};
