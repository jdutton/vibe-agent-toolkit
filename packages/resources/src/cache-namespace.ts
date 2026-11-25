/**
 * The cache namespace: one directory per VAT version.
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
 * default; see `cache-root.ts`. Every cache tenant whose contents depend on
 * VAT's own code lives under the namespace, so a new VAT version starts a new
 * directory for all of them together, and `vat cache prune` removes every
 * namespace but this version's. The external-link verdict caches are facts
 * about the world, not about this build, and they are not persistable either:
 * they live outside this root, in `vatLinkCacheDirectory()`.
 *
 * ## What the namespace is
 *
 * The npm package version, and nothing else: `0.2.0` for an installed build and
 * for a source checkout of that version alike. All packages in the monorepo
 * share one version, so this package's version IS the VAT version.
 *
 * ## What it does not see, by decision
 *
 * Within one VAT version the cache is never invalidated by a change to VAT's
 * code or to the dependencies it resolves. A content-addressed cache keys on a
 * parser's INPUT, so when the code that derives a fact changes (a parser edit
 * in a checkout, a dependency resolving another minor under a semver range, a
 * pattern edit in the skill-text declaration, an added optional field), entries
 * written before the change are served after it under the same key. Two
 * checkouts of one version, and a checkout and the release of its version,
 * share one namespace, and one store wherever they share a cache root: the
 * default `<tmpdir>/.vat-cache` on one machine, or one `VAT_CACHE_DIR` set
 * for both. The exposure is anyone running different code of one version
 * against one cache root.
 *
 * That is the ruled trade: cache invalidation stays simple. A developer who
 * changes what VAT derives clears the cache when they want a cold one:
 * `vat cache clear` deletes the whole cache root. `vat cache prune` removes
 * every other version's namespace and every other-shape store, and keeps this
 * version's. This repo's own gate and CI are each isolated. `bun run vat`
 * gives every checkout its own `VAT_CACHE_DIR`
 * (`packages/dev-tools/src/run-vat.ts`) unless one is set. CI sets
 * `$RUNNER_TEMP/vat-cache`, and its `actions/cache` key hashes `bun.lock` and
 * the `src/` of the packages the CLI runs (utils, schema, resources,
 * projection-sqlite, discovery, agent-skills, claude-marketplace, cli;
 * `.github/workflows/validate.yml`), so a change to either restores no older
 * cache.
 *
 * What still separates entries within a version is derived from shape, never a
 * second version number: `ParseFactsSchema` at the read boundary rejects an
 * entry whose shape this build cannot account for, and the projection store
 * lives under `projection-<shapeDigest>`. There is deliberately no hand-bumped
 * revision constant here, and one must not be added (see
 * `docs/contributing/no-version-constants.md`).
 */

import { readFileSync } from 'node:fs';

import { isPathAbsentError, resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';

import { vatCacheRoot } from './cache-root.js';

/** Resolved once: the version does not change mid-process. */
let cached: string | undefined;

/**
 * Read this package's version from its own manifest.
 *
 * Read at runtime rather than compiled in: a constant would have to be
 * maintained by hand, and the version is already written down.
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
 * The namespace directory name for this build of VAT: its version.
 *
 * @returns The package version, the same from an installed build and a source checkout
 *
 * @example
 * ```typescript
 * vatCacheNamespace(); // '0.2.0'
 * ```
 */
export function vatCacheNamespace(): string {
  cached ??= readVersion(safePath.join(resolveFromImportMeta(import.meta.url), '..'));
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

/** A namespace's optional prerelease after the first `-` (semver's prerelease characters). */
const NAMESPACE_SUFFIX = /^[0-9A-Za-z.-]+$/u;

/**
 * Whether `name` is shaped like a namespace: a semver version, optionally
 * followed by `-` and a prerelease. Split at the first `-` rather than one
 * pattern, so neither half needs a nested quantifier.
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
 * root. `vat cache prune` removes only these, never an entry it does not
 * recognise, whatever else it finds in the directory.
 *
 * @param name - A single path segment
 * @returns True for VAT's own root entries
 */
export function isVatCacheRootEntryName(name: string): boolean {
  return isNamespaceName(name) || LEGACY_ROOT_ENTRY.test(name);
}
