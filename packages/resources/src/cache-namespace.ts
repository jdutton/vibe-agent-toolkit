/**
 * The cache namespace: one directory per *build of VAT*, derived automatically.
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
 * This used to be handled by a hand-bumped `CONTENT_KEY_SCHEMA_VERSION`. That is
 * a discipline, not a mechanism: nothing in the build fails when someone changes
 * the parser and forgets. The namespace replaces it with something automatic.
 *
 * ## Layout
 *
 * ```
 * <normalizedTmpdir()>/.vat-cache/<namespace>/parse/<shard>/<key>.json
 *                                 <namespace>/parquet/...      (reserved)
 * ```
 *
 * Every cache tenant whose contents depend on VAT's own code lives under the
 * namespace, so one directory rename invalidates all of them together. Tenants
 * that do NOT depend on VAT's code stay at the `.vat-cache` root and keep their
 * own policy — external link reachability and authenticated link content are
 * facts about the world, not about this build, and re-fetching them on every
 * VAT upgrade would be pure waste.
 *
 * ## What the namespace is
 *
 * - **Installed VAT:** the package version, e.g. `0.1.42`. Two machines running
 *   the same release share a namespace, which is the point — identical bytes
 *   through identical code yield identical facts.
 * - **Dev checkout:** `0.1.42-dev-<6 hex>`, where the digits cover the package
 *   root path AND a fingerprint of the emitted parser modules.
 *
 * The path alone is not enough, and the reason is the whole design: every
 * worktree on a machine reads the same version out of the same manifest, so
 * branch A and branch B and the published release of that number would all share
 * one namespace — exactly when invalidation matters most. Adding the path
 * separates worktrees. Adding the build fingerprint separates *edits within one
 * worktree*, which is the case a path-only scheme still gets wrong, and it is
 * the common case while developing a parser.
 *
 * The cost is deliberate: after `tsc --build` the dev cache is cold. That is the
 * correct answer — the code that produced those entries no longer exists — and
 * it does not disturb measurement, since repeated runs without a rebuild share a
 * namespace and warm normally.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

import { normalizedTmpdir, resolveFromImportMeta, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

/** Hex digits of the dev discriminator. Short on purpose — it is a cache path, not a security boundary. */
const DEV_FINGERPRINT_LENGTH = 6;

/**
 * Emitted modules whose contents determine the facts a parse produces.
 *
 * Deliberately a short, explicit list rather than a directory walk: the walk
 * would fingerprint unrelated churn (declaration maps, sourcemaps) and make the
 * dev namespace move for edits that cannot change a single parse fact.
 *
 * `link-parser.js` imports `unresolved-references.js` (the `unresolvedReferences`
 * fact), and `parse-cache.js` defines the `ParseFacts` shape (`dehydrate`/
 * `rehydrate`) that determines what a cache entry even contains -- both are
 * listed explicitly rather than assumed to move whenever `link-parser.js` does,
 * since a fingerprint over an import graph is exactly the kind of walk this
 * module deliberately avoids.
 *
 * Exported for {@link buildFingerprint}'s tests, not because callers outside
 * this module have a legitimate use for the list.
 */
export const PARSER_MODULES = [
  'link-parser.js',
  'html-link-parser.js',
  'content-key.js',
  'unresolved-references.js',
  'parse-cache.js',
] as const;

/** Resolved once — neither the version nor the install location changes mid-process. */
let cached: string | undefined;

/**
 * Read this package's version from its own manifest.
 *
 * All packages in the monorepo share one version, so `@vibe-agent-toolkit/resources`
 * reporting `0.1.42` IS the VAT version. Read at runtime rather than compiled in,
 * because a constant would have to be maintained by hand — the failure mode this
 * whole module exists to remove.
 */
function readVersion(moduleDir: string): string {
  for (const relative of ['../package.json', '../../package.json']) {
    try {
      const manifestPath = safePath.join(moduleDir, relative);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derived from this module's own location
      const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null) {
        const version = (parsed as { version?: unknown }).version;
        if (typeof version === 'string' && version !== '') return version;
      }
    } catch {
      // Try the next candidate. A package with no readable manifest falls
      // through to the caller's 'unknown', which still yields a usable (if
      // uninformative) namespace rather than throwing on a cache lookup.
    }
  }
  return 'unknown';
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
 * Stat a module's emitted `.js`, falling back to its `.ts` source.
 *
 * Under Vitest/tsx the code runs straight from `packages/*\/src/*.ts` -- there
 * is no emitted `.js` beside it to stat, so without this fallback every entry
 * in {@link PARSER_MODULES} reads as absent regardless of what a developer
 * actually edited, and the fingerprint (and therefore the dev cache namespace)
 * never moves while iterating on the parser from source. Dist-mode behavior is
 * unchanged: when the `.js` exists, it wins and the `.ts` is never consulted.
 */
function statModuleFile(moduleDir: string, jsName: string): ReturnType<typeof statSync> | undefined {
  const candidates = [jsName, jsName.replace(/\.js$/u, '.ts')];
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed basenames beside this module
      return statSync(safePath.join(moduleDir, candidate));
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/**
 * Fingerprint the emitted parser modules by size and mtime.
 *
 * Size+mtime rather than content: this runs on every process start, and reading
 * three files to hash them costs more than the cache saves on a small corpus.
 * A rebuild always moves mtime, which is the event this needs to catch; the
 * failure mode it trades away (identical mtime AND size after a real change) is
 * not reachable through `tsc --build`.
 */
export function buildFingerprint(moduleDir: string): string {
  const parts: string[] = [];
  for (const name of PARSER_MODULES) {
    const stat = statModuleFile(moduleDir, name);
    if (stat === undefined) {
      // Absent under both extensions (a partial build, or a module removed
      // entirely). Recorded as such so its absence is itself part of the
      // fingerprint.
      parts.push(`${name}:absent`);
    } else {
      parts.push(`${name}:${String(stat.size)}:${String(stat.mtimeMs)}`);
    }
  }
  return parts.join('\0');
}

/**
 * The namespace directory name for this build of VAT.
 *
 * @returns `<version>` when installed, `<version>-dev-<6 hex>` from a checkout
 *
 * @example
 * ```typescript
 * vatCacheNamespace(); // '0.1.42'  (installed)
 * vatCacheNamespace(); // '0.1.42-dev-9f2c1a'  (worktree, re-derived after each build)
 * ```
 */
export function vatCacheNamespace(): string {
  if (cached !== undefined) return cached;

  const moduleDir = safePath.join(resolveFromImportMeta(import.meta.url), '..');
  const version = readVersion(moduleDir);

  if (isInstalled(moduleDir)) {
    cached = version;
    return cached;
  }

  const digest = createHash('sha256')
    .update(`vat-cache-namespace\0${toForwardSlash(moduleDir)}\0${buildFingerprint(moduleDir)}`, 'utf-8')
    .digest('hex')
    .slice(0, DEV_FINGERPRINT_LENGTH);

  cached = `${version}-dev-${digest}`;
  return cached;
}

/**
 * Root of every VAT cache tenant, shared across builds.
 *
 * Tenants that do NOT depend on VAT's own code live directly here; anything
 * whose contents this build determines belongs under {@link vatCacheNamespaceRoot}.
 *
 * @returns Absolute path, forward-slashed
 */
export function vatCacheRoot(): string {
  return safePath.join(normalizedTmpdir(), '.vat-cache');
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
