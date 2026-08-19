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
 * <normalizedTmpdir()>/.vat-cache/<namespace>/parse/<shard>/<key>.json
 *                                 <namespace>/projection-<shapeDigest>/...  (reserved)
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
 *   through identical code yield identical facts, and the version moves on
 *   every release, so a released build's parsers are consistent by
 *   construction and need no second number tracking them.
 * - **Dev checkout:** `0.1.42-dev-<6 hex>` over the package root path *and*
 *   `ParseFactsSchema`'s own shape.
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
 * Three mechanisms therefore divide the work, and none of them is a second
 * version number:
 *
 * 1. **`ParseFactsSchema` at the read boundary** (`schemas/parse-facts.ts`).
 *    An entry whose shape this build cannot account for is a miss, not a
 *    plausible answer. That covers every change to a stored shape except the
 *    addition of an *optional* field, where "written before the field existed"
 *    and "legitimately absent" are the same bytes.
 * 2. **The shape digest here**, which covers that last case by not letting the
 *    two kinds of entry share a directory in the first place. It is derived
 *    from the schema, so unlike the constant it replaced it cannot fall behind
 *    what the schema actually says.
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

import { normalizedTmpdir, resolveFromImportMeta, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { parseFactsShapeSource } from './schemas/parse-facts.js';

/** Hex digits of the dev discriminator. Short on purpose — it is a cache path, not a security boundary. */
const DEV_FINGERPRINT_LENGTH = 6;

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
      // eslint-disable-next-line security/detect-non-literal-fs-filename, local/no-raw-text-decode -- path derived from this module's own location; own manifest, so the encoding is not discovered
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
 * The dev discriminator: a pure digest of where this checkout lives and what a
 * cache entry is shaped like in it.
 *
 * Both inputs are values, not lookups: this touches no filesystem and reads no
 * module state, so it is stable across a rebuild by construction. That is
 * exactly the property the namespace exists to have, and keeping it a pure
 * function is what lets a test assert it without fighting the process-level
 * memo in {@link vatCacheNamespace}.
 *
 * The two inputs separate different things and are both needed: the path keeps
 * two worktrees apart, the shape keeps two entry formats apart within one.
 *
 * @param moduleDir - Directory this package's code was resolved from
 * @param parseFactsShape - From `parseFactsShapeSource()`; see that docstring
 *   for why it is derived rather than declared
 * @returns Six lowercase hex digits
 */
export function devNamespaceDigest(moduleDir: string, parseFactsShape: string): string {
  return createHash('sha256')
    .update(`vat-cache-namespace\0${toForwardSlash(moduleDir)}\0${parseFactsShape}`, 'utf-8')
    .digest('hex')
    .slice(0, DEV_FINGERPRINT_LENGTH);
}

/**
 * The namespace directory name for this build of VAT.
 *
 * @returns `<version>` when installed, `<version>-dev-<6 hex>` from a checkout
 *
 * @example
 * ```typescript
 * vatCacheNamespace(); // '0.1.42'  (installed)
 * vatCacheNamespace(); // '0.1.42-dev-9f2c1a'  (worktree, stable across rebuilds)
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

  cached = `${version}-dev-${devNamespaceDigest(moduleDir, parseFactsShapeSource())}`;
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
