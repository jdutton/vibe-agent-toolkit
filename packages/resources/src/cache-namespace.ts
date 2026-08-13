/**
 * The cache namespace: one directory per *release of VAT*, derived automatically,
 * plus a hand-bumped revision for parser behaviour.
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
 *   root path AND {@link PARSER_BEHAVIOR_REVISION}.
 *
 * The path component is load-bearing and must survive any future change here:
 * every worktree on a machine reads the same version out of the same manifest,
 * so branch A and branch B and the published release of that number would
 * otherwise all share one namespace — exactly when invalidation matters most.
 *
 * ## What was traded away, deliberately
 *
 * The dev discriminator used to also mix in a fingerprint (size + mtime) of the
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
 * So the automatic mechanism is gone and the hazard it covered is **back, on
 * purpose**: within one worktree, editing parser behaviour and rebuilding will
 * serve parse facts written by the previous build. Nothing detects that for
 * you. The replacement is deliberate rather than automatic, and there are
 * exactly two ways to exercise it:
 *
 * 1. Bump {@link PARSER_BEHAVIOR_REVISION} when you change what a parse means.
 *    This is the durable answer — it moves the namespace for every developer
 *    and every worktree, not just yours.
 * 2. Run `vat cache clear` when you merely *suspect* staleness. This is the
 *    local answer, and it costs nothing but a rescan.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { normalizedTmpdir, resolveFromImportMeta, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

/** Hex digits of the dev discriminator. Short on purpose — it is a cache path, not a security boundary. */
const DEV_FINGERPRINT_LENGTH = 6;

/**
 * Hand-bumped revision of *what a cached parse fact means*.
 *
 * **If you change parser behaviour, increment this in the same change.** Nothing
 * in the build will do it for you and nothing will fail if you forget — that is
 * the accepted cost of a dev cache that survives a rebuild (see the module doc).
 * A stale entry is a well-formed answer to a question the parser no longer asks;
 * it looks exactly like a hit.
 *
 * ### The modules this revision covers
 *
 * The boundary is behavioural, not a directory. Bump when you change what any of
 * these produce — this is the same list the removed build fingerprint watched,
 * carried over because it is precisely the "if you edit this, bump this" set:
 *
 * - **`link-parser`** — the markdown link/reference facts themselves.
 * - **`html-link-parser`** — the HTML-embedded reference facts.
 * - **`content-key`** — how input bytes map to a cache key. A change here
 *   re-files every entry, so old entries are unreachable rather than wrong, but
 *   the revision keeps the two keyspaces from sharing a directory.
 * - **`unresolved-references`** — the `unresolvedReferences` fact, imported by
 *   `link-parser` and therefore able to change a parse result without
 *   `link-parser` itself being touched.
 * - **`parse-cache`** — the `ParseFacts` shape (`dehydrate`/`rehydrate`). Adding
 *   or removing a field changes what an entry even contains.
 *
 * ### When you only *suspect* staleness
 *
 * Do not bump speculatively — a bump discards every developer's cache, not just
 * yours. Run **`vat cache clear`** instead: it removes the whole
 * `<tmpdir>/.vat-cache/` tree, including the parse tenant under the current
 * namespace, and the next run rebuilds it.
 */
export const PARSER_BEHAVIOR_REVISION = 1;

/** Resolved once — neither the version nor the install location changes mid-process. */
let cached: string | undefined;

/**
 * Read this package's version from its own manifest.
 *
 * All packages in the monorepo share one version, so `@vibe-agent-toolkit/resources`
 * reporting `0.1.42` IS the VAT version. Read at runtime rather than compiled in,
 * because a constant would have to be maintained by hand — and unlike
 * {@link PARSER_BEHAVIOR_REVISION}, which tracks a meaning no file can observe,
 * the version is already written down.
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
 * The dev discriminator: a pure digest of where this checkout lives and which
 * parser revision it speaks.
 *
 * Touches no filesystem and reads no module state, so it is stable across a
 * rebuild by construction — a rebuild changes neither argument. That is exactly
 * the property the namespace exists to have, and keeping it a pure function is
 * what lets a test assert it without fighting the process-level memo in
 * {@link vatCacheNamespace}.
 *
 * @param moduleDir - Directory this package's code was resolved from
 * @param revision - Parser behaviour revision, normally {@link PARSER_BEHAVIOR_REVISION}
 * @returns Six lowercase hex digits
 */
export function devNamespaceDigest(moduleDir: string, revision: number): string {
  return createHash('sha256')
    .update(`vat-cache-namespace\0${toForwardSlash(moduleDir)}\0r${String(revision)}`, 'utf-8')
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

  cached = `${version}-dev-${devNamespaceDigest(moduleDir, PARSER_BEHAVIOR_REVISION)}`;
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
