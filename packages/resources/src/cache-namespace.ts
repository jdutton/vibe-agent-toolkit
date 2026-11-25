/**
 * The cache namespace: one directory per *release of VAT*, derived
 * automatically, and one per worktree in a source checkout.
 *
 * ## Why this exists
 *
 * A content-addressed cache keys on the parser's INPUT. It cannot see a change
 * to the parser itself — so when VAT starts producing different facts from
 * unchanged bytes, every entry written by the previous build becomes a
 * well-formed answer to the wrong question. Fail-soft does not help: a valid
 * entry filed under a key whose meaning has shifted is indistinguishable from a
 * correct hit.
 *
 * ## Layout
 *
 * ```
 * <vatCacheRoot()>/CACHEDIR.TAG
 *                  <namespace>/parse/<shard>/<key>.json
 *                  <namespace>/projection-<shapeDigest>/projection.db
 * ```
 *
 * `vatCacheRoot()` is `VAT_CACHE_DIR`, or `<normalizedTmpdir()>/.vat-cache` by
 * default — see `cache-root.ts`. Every cache tenant whose contents depend on
 * VAT's own code lives under the namespace, so one directory rename invalidates
 * all of them together, and `vat cache prune` removes every namespace but this
 * build's. The external-link verdict caches are facts about the world, not
 * about this build, and they are not persistable either: they live outside this
 * root, in `vatLinkCacheDirectory()`.
 *
 * ## What the namespace is
 *
 * - **Installed VAT:** `0.1.42-p<6 hex>`: the package version, then a digest of
 *   the resolved parser versions (see below). Two machines running the same
 *   release that resolve the same parsers share a namespace, which is the
 *   point — identical bytes through identical code yield identical facts, and
 *   the version moves on every release, so a released build's own code is
 *   consistent by construction and needs no second number tracking it.
 * - **Dev checkout:** `0.1.42-dev-<6 hex>` over the package root path,
 *   `ParseFactsSchema`'s own shape, the digest of the skill-text
 *   declaration a markdown parse applies (`SKILL_TEXT_DECLARATION`), and the
 *   same resolved parser versions.
 *
 * ## The bound on "consistent by construction"
 *
 * That claim covers VAT's own code and **not** the parsers VAT depends on, and
 * it is stated here so it is not read wider than it holds. This package declares
 * `remark-parse ^11.0.0`, `yaml ^2.6.1`, `parse5 ^7.3.0` and
 * `github-slugger ^2.0.0` — four semver **ranges**, not four pins (read off
 * `packages/resources/package.json`; re-check there, this sentence is not
 * derived from it). Two machines installing the *identical* VAT release
 * can therefore resolve different minors of any of them, share one namespace,
 * and write disagreeing facts under identical keys.
 *
 * That is a **wrongness** class, not the coldness class the rest of this
 * docstring reasons about: precisely the failure the namespace exists to
 * prevent, arriving through the one door it does not guard. Because the store
 * only ever adds rows for a key it does not cover (insert-only reuse by content
 * key), a row written under one resolution would be served under another.
 *
 * **The resolved parser versions are therefore an input to the namespace, in
 * every build** (ADR decision D17): the versions of the parsers named above, read
 * from the resolved packages at run time the way {@link readVersion} reads this
 * package's own. This is not a version constant, and one must not be added: a
 * hand-bumped integer is banned in this repo (see the closing paragraph, and it
 * was already removed from this very file once), and it would not address this,
 * because the drift lives in a *dependency resolution* that no human-maintained
 * number tracks. The digest reads what is installed, so it moves when the
 * resolution does and at no other time.
 *
 * The path component is load-bearing and must survive any future change here:
 * every worktree on a machine reads the same version out of the same manifest,
 * so branch A and branch B and the published release of that number would
 * otherwise all share one namespace — exactly when invalidation matters most.
 *
 * ## Why the shape, and not the build
 *
 * The dev discriminator used to mix in a fingerprint (size + mtime) of the
 * emitted parser modules, so that any `tsc --build` moved the namespace and the
 * dev cache went cold automatically. That is the strongest version of the
 * guarantee above — it caught a parser edit whether or not the developer
 * thought about it — and it is the option that was **rejected**, for a measured
 * reason:
 *
 * > A rebuild is not a schema change. Fingerprinting the build made *every*
 * > edit anywhere in the package — a comment, a log line, an unrelated
 * > module — start a fresh, empty namespace, and nothing ever evicted the old
 * > one. Measured on one developer machine: **65 namespaces, 267 MB**, of which
 * > a single day of rebuilds accounted for ~200 MB of near-duplicate content.
 * > A dev cache that is cold after every build is also a dev cache that is
 * > never actually measured warm, and a cache directory that only grows is a
 * > defect in its own right.
 *
 * What replaced it keeps the automatic part and drops the churn: the digest
 * takes the *shape of a cache entry* as its second input, via
 * {@link parseFactsShapeSource}. Rebuilding unchanged code cannot move it —
 * nothing there reads a file or an mtime — while changing what an entry
 * contains moves it every time, without anyone deciding to.
 *
 * Its third input is the digest of the skill-text declaration
 * (`skillTextDeclarationDigest(SKILL_TEXT_DECLARATION)`): every regex and
 * constant the skill-text core applies to a markdown parse, whose record each
 * entry holds (`ParseFacts.skillText`). So the dev namespace also covers the
 * declaration: a pattern edit in a dev checkout lands in a new namespace and
 * cold-starts the WHOLE parse cache, every entry of every kind with it, and the
 * projection store beneath the namespace too. That churn is accepted: it is one
 * rescan per pattern edit, against a skill-text record that was the old
 * pattern's answer under a valid key. A published build needs none of it, since
 * its namespace is the package version. What no input covers is a change to the
 * core's control flow with the declaration unchanged: that is mechanism 3's.
 *
 * Three mechanisms therefore divide the work, and none of them is a second
 * version number:
 *
 * 1. **`ParseFactsSchema` at the read boundary** (`schemas/parse-facts.ts`).
 *    An entry whose shape this build cannot account for is a miss, not a
 *    plausible answer. That covers every change to a stored shape except the
 *    addition of an *optional* field, where "written before the field existed"
 *    and "legitimately absent" are the same bytes.
 * 2. **The shape and declaration digests here**, which cover that last case by
 *    not letting the two kinds of entry share a directory in the first place,
 *    and a pattern edit by the same move. Both are derived (from the schema,
 *    and from the declaration the core applies), so unlike the constant they
 *    replaced they cannot fall behind what they stand for.
 * 3. **`vat cache clear`**, for what neither can see: a change to what a parse
 *    *means* with its shape unchanged — swap the token estimator and every warm
 *    entry keeps serving the old count under a perfectly valid, correctly named
 *    key. It costs a rescan and nothing else, and a developer who changed
 *    parser behaviour is the one person who does not need to be told they did.
 *
 * There is deliberately no hand-bumped revision constant here. It was removed
 * once and must not come back: it protected developers only (an installed
 * build's namespace already moves per release), it required someone to
 * remember, and carrying a second versioning scheme alongside the version is
 * debt that buys nothing the three mechanisms above do not.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import {
  isPathAbsentError,
  resolveFromImportMeta,
  safePath,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';

import { vatCacheRoot } from './cache-root.js';
import { parseFactsShapeSource } from './schemas/parse-facts.js';
import { SKILL_TEXT_DECLARATION, skillTextDeclarationDigest } from './skill-text/declaration.js';

/** Hex digits of the dev discriminator. Short on purpose — it is a cache path, not a security boundary. */
const DEV_FINGERPRINT_LENGTH = 6;

/** The four parsers whose resolved versions are an input to every namespace (ADR decision D17). */
const PARSER_PACKAGES = ['remark-parse', 'yaml', 'parse5', 'github-slugger'] as const;

/** Resolved once — neither the version nor the install location changes mid-process. */
let cached: string | undefined;

/**
 * Read this package's version from its own manifest.
 *
 * All packages in the monorepo share one version, so `@vibe-agent-toolkit/resources`
 * reporting `0.1.42` IS the VAT version. Read at runtime rather than compiled in:
 * a constant would have to be maintained by hand, and the version is already
 * written down.
 */
function readVersion(moduleDir: string): string {
  for (const relative of ['../package.json', '../../package.json']) {
    try {
      const manifestPath = safePath.join(moduleDir, relative);
      // VAT's OWN published manifest, not corpus content: npm writes it, this
      // repo commits it, and its encoding is not an adopter's choice.
      // eslint-disable-next-line local/no-raw-text-decode -- path derived from this module's own location; own manifest, so the encoding is not discovered
      const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null) {
        const version = (parsed as { version?: unknown }).version;
        if (typeof version === 'string' && version !== '') return version;
      }
    } catch (error) {
      // No manifest at this candidate: try the next. A package with no
      // manifest at either falls through to 'unknown', which still yields a
      // usable (if uninformative) namespace rather than throwing on a cache
      // lookup. A manifest that IS there but cannot be read or is not JSON is
      // our own install being broken, and that stays loud.
      if (!isPathAbsentError(error)) throw error;
    }
  }
  return 'unknown';
}

/**
 * The version a resolved parser package declares: the nearest `package.json`
 * above its entry point that names a version.
 *
 * Resolved from the entry point, not `<name>/package.json`, because a package
 * with an `exports` map need not export its manifest. A nested stub manifest
 * (`{"type":"commonjs"}` under a `dist/` directory) names no version and is
 * walked past. A manifest that cannot be read or is not JSON stays loud, as in
 * {@link readVersion}; no manifest at all is a broken install and also loud.
 */
function parserVersion(resolveEntry: NodeJS.Require, name: string): string {
  let directory = safePath.join(resolveEntry.resolve(name), '..');
  for (;;) {
    try {
      // A dependency's own published manifest, written by the package manager.
      // eslint-disable-next-line local/no-raw-text-decode -- path derived from a resolved entry point; own dependency manifest, so the encoding is not discovered
      const parsed: unknown = JSON.parse(readFileSync(safePath.join(directory, 'package.json'), 'utf8'));
      const version = typeof parsed === 'object' && parsed !== null ? (parsed as { version?: unknown }).version : undefined;
      if (typeof version === 'string' && version !== '') return version;
    } catch (error) {
      if (!isPathAbsentError(error)) throw error;
    }
    const parent = safePath.join(directory, '..');
    if (parent === directory) throw new Error(`No package.json naming a version above the entry point of ${name}`);
    directory = parent;
  }
}

/**
 * The versions of the parsers VAT depends on, as installed: read from the
 * resolved packages at run time, never written down.
 *
 * @param moduleDir - Directory this package's code was resolved from
 * @returns One `{ name, version }` per parser, in declaration order
 */
export function resolvedParserVersions(moduleDir: string): readonly { name: string; version: string }[] {
  const resolveEntry = createRequire(safePath.join(moduleDir, 'cache-namespace.js'));
  return PARSER_PACKAGES.map((name) => ({ name, version: parserVersion(resolveEntry, name) }));
}

/**
 * Six hex digits over the sorted `name`/`version` pairs (NUL-separated, which no package name holds), so the order a list is
 * given in cannot move it. Pure, so a test asserts it without the process memo.
 *
 * @param list - From {@link resolvedParserVersions}
 * @returns Six lowercase hex digits
 */
export function parserVersionsDigest(list: readonly { name: string; version: string }[]): string {
  const entries = list.map(({ name, version }) => `${name}\0${version}`).sort((left, right) => left.localeCompare(right));
  return createHash('sha256')
    .update(`vat-parser-versions\0${entries.join('\0')}`, 'utf-8')
    .digest('hex')
    .slice(0, DEV_FINGERPRINT_LENGTH);
}

/**
 * The installed build's namespace: the package version, then the parser digest.
 *
 * @param version - The package version
 * @param parserDigest - From {@link parserVersionsDigest}
 * @returns `<version>-p<6 hex>`
 */
export function installedNamespaceName(version: string, parserDigest: string): string {
  return `${version}-p${parserDigest}`;
}

/**
 * Is this module running from an installed package rather than a source checkout?
 *
 * `node_modules` in the resolved path is the signal. It is the one marker that
 * survives every install shape this repo supports (npm, pnpm's symlink farm,
 * bun's workspace links) without asking the filesystem any further questions.
 */
function isInstalled(moduleDir: string): boolean {
  return toForwardSlash(moduleDir).includes('/node_modules/');
}

/**
 * The dev discriminator: a pure digest of where this checkout lives, what a
 * cache entry is shaped like in it, which skill-text declaration its markdown
 * entries were computed under, and which parser versions are resolved.
 *
 * All four inputs are values, not lookups: this touches no filesystem and reads no
 * module state, so it is stable across a rebuild by construction. That is
 * exactly the property the namespace exists to have, and keeping it a pure
 * function is what lets a test assert it without fighting the process-level
 * memo in {@link vatCacheNamespace}.
 *
 * The four inputs separate different things and are all needed: the path keeps
 * two worktrees apart, the shape keeps two entry formats apart within one, and
 * the declaration digest keeps two skill-text pattern sets apart within one
 * format (see "Why the shape, and not the build"), and the parser versions keep
 * two dependency resolutions apart.
 *
 * @param moduleDir - Directory this package's code was resolved from
 * @param parseFactsShape - From `parseFactsShapeSource()`; see that docstring
 *   for why it is derived rather than declared
 * @param skillTextDeclaration - From `skillTextDeclarationDigest(SKILL_TEXT_DECLARATION)`
 * @param parserVersions - From `parserVersionsDigest(resolvedParserVersions(moduleDir))`
 * @returns Six lowercase hex digits
 */
export function devNamespaceDigest(moduleDir: string, parseFactsShape: string, skillTextDeclaration: string, parserVersions: string): string {
  return createHash('sha256')
    .update(`vat-cache-namespace\0${toForwardSlash(moduleDir)}\0${parseFactsShape}\0${skillTextDeclaration}\0${parserVersions}`, 'utf-8')
    .digest('hex')
    .slice(0, DEV_FINGERPRINT_LENGTH);
}

/**
 * The namespace directory name for this build of VAT.
 *
 * @returns `<version>-p<6 hex>` when installed, `<version>-dev-<6 hex>` from a checkout
 *
 * @example
 * ```typescript
 * vatCacheNamespace(); // '0.1.42-p3fa9c0'  (installed)
 * vatCacheNamespace(); // '0.1.42-dev-9f2c1a'  (worktree, stable across rebuilds)
 * ```
 */
export function vatCacheNamespace(): string {
  if (cached !== undefined) return cached;

  const moduleDir = safePath.join(resolveFromImportMeta(import.meta.url), '..');
  const version = readVersion(moduleDir);
  const parsers = parserVersionsDigest(resolvedParserVersions(moduleDir));

  if (isInstalled(moduleDir)) {
    cached = installedNamespaceName(version, parsers);
    return cached;
  }

  cached = `${version}-dev-${devNamespaceDigest(moduleDir, parseFactsShapeSource(), skillTextDeclarationDigest(SKILL_TEXT_DECLARATION), parsers)}`;
  return cached;
}

/**
 * Root for the tenants this build of VAT owns.
 *
 * @returns Absolute path, forward-slashed
 */
export function vatCacheNamespaceRoot(): string {
  return safePath.join(vatCacheRoot(), vatCacheNamespace());
}

/**
 * Directory holding cached parse facts for this build.
 *
 * @returns Absolute path, forward-slashed
 */
export function parseCacheDirectory(): string {
  return safePath.join(vatCacheNamespaceRoot(), 'parse');
}

/** A namespace's release part: `major.minor.patch`. */
const NAMESPACE_RELEASE = /^\d+\.\d+\.\d+$/u;

/** A namespace's optional suffix after the first `-`: a prerelease, `dev-<hex>`, or both. */
const NAMESPACE_SUFFIX = /^[0-9A-Za-z.-]+$/u;

/**
 * Whether `name` is shaped like a namespace: a semver version, optionally
 * followed by `-` and a prerelease or `dev-<hex>` suffix. Split at the first
 * `-` rather than one pattern, so neither half needs a nested quantifier.
 */
function isNamespaceName(name: string): boolean {
  const dash = name.indexOf('-');
  if (dash === -1) return NAMESPACE_RELEASE.test(name);
  return NAMESPACE_RELEASE.test(name.slice(0, dash)) && NAMESPACE_SUFFIX.test(name.slice(dash + 1));
}

/**
 * Names older VAT releases wrote directly under the cache root: the link caches
 * (before `vatLinkCacheDirectory()`) and the root-level `parse/` directory
 * (before the parse cache moved under the namespace).
 */
const LEGACY_ROOT_ENTRY = /^(?:external-links\.json.*|auth-.+|parse)$/u;

/**
 * Whether `name`, an entry directly under a cache root, is one VAT writes
 * there: a namespace (any VAT build's), or a name an older release kept at the
 * root. `vat cache prune` removes only these — never an entry it does not
 * recognise, whatever else it finds in the directory.
 *
 * @param name - A single path segment
 * @returns True for VAT's own root entries
 */
export function isVatCacheRootEntryName(name: string): boolean {
  return isNamespaceName(name) || LEGACY_ROOT_ENTRY.test(name);
}
