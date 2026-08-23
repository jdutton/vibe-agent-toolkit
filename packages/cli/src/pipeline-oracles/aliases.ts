/**
 * The two set-level attributes the enumeration oracle needs and the projection
 * substrate deliberately does not carry.
 *
 * `resource_realizations` describes one path in one extent. `targetInsideRoot`
 * and `aliasesEnumeratedPath` are questions about a *crawl* — where a link
 * reaches to relative to the root the command was pointed at, and whether the
 * same file arrived twice under two names in the same lane. They belong to the
 * oracle that measures a crawl, not to the substrate that records a population,
 * so they live here and are projected onto the realization row.
 */

import { realPathOrNull, type ResourceRealizationRow } from '@vibe-agent-toolkit/resources';
import { isAbsolutePath, safePath } from '@vibe-agent-toolkit/utils';

import type { EnumerationRow } from './types.js';

/**
 * The extent id the oracle labels its realizations with.
 *
 * The oracle projects the realization away immediately, so the value is never
 * serialized and never reaches a golden. It exists because `collectRealization`
 * requires an extent — a realization with no extent is not a realization.
 */
export const ORACLE_EXTENT_ID = 'ctx-oracle-enumeration';

/**
 * The resource id the oracle labels its realizations with.
 *
 * Same reasoning as {@link ORACLE_EXTENT_ID}: the enumeration oracle measures
 * paths, not identities, so it does not mint them. Identity minting is
 * `ResourceIdentityMap`'s job and belongs to the population pass.
 */
export const ORACLE_RESOURCE_ID = 'res-oracle';

/**
 * Project a realization row onto the row an enumeration golden records.
 *
 * @param realization - The realization row for this path
 * @param absolutePath - The same path, absolute — needed to resolve its target
 * @param corpusRoot - Root the crawl was pointed at
 * @returns The enumeration row, with `aliasesEnumeratedPath` left false for
 *   {@link markAliases} to fill once the whole population is known
 */
export function toEnumerationRow(
  realization: ResourceRealizationRow,
  absolutePath: string,
  corpusRoot: string,
): EnumerationRow {
  return {
    path: realization.path,
    contentKey: realization.contentKey,
    exists: realization.exists,
    isDirectory: realization.isDirectory,
    gitignored: realization.gitignored,
    isSymlink: realization.isSymlink,
    symlinkResolves: realization.symlinkResolves,
    targetInsideRoot: resolveInsideRoot(absolutePath, corpusRoot),
    // Set-level; filled in by markAliases once the whole population is known.
    aliasesEnumeratedPath: false,
  };
}

/**
 * Mark every row whose real path is shared with another row in the population.
 *
 * Mutates in place: the rows were just built here and have not been handed out.
 *
 * @param rows - The lane's enumerated rows, in capture order
 * @param absolutePaths - The same paths, absolute, in the same order
 */
export function markAliases(rows: EnumerationRow[], absolutePaths: readonly string[]): void {
  const counts = new Map<string, number>();
  const reals: (string | null)[] = absolutePaths.map((absolutePath) => realPathOrNull(absolutePath));

  for (const real of reals) {
    if (real !== null) {
      counts.set(real, (counts.get(real) ?? 0) + 1);
    }
  }

  for (const [index, row] of rows.entries()) {
    const real = reals[index] ?? null;
    row.aliasesEnumeratedPath = real !== null && (counts.get(real) ?? 0) > 1;
  }
}

/**
 * Resolve a path and report whether it really lives inside the corpus root.
 *
 * @param absolutePath - Path to resolve
 * @param corpusRoot - Root the corpus was crawled from
 * @returns True when inside, false when outside, null when unresolvable
 */
function resolveInsideRoot(absolutePath: string, corpusRoot: string): boolean | null {
  const real = realPathOrNull(absolutePath);
  if (real === null) {
    return null;
  }
  const rel = safePath.relative(corpusRoot, real);
  return rel !== '' && !rel.startsWith('..') && !isAbsolutePath(rel);
}
