/**
 * The extent digest — `zone_provenance.extentDigest` (§7.4) and the
 * convergence oracle the closure stratum's fixpoint tests against (§7.2).
 *
 * ## Why it is required rather than nullable
 *
 * Recording *which* contributors ran detects only total absence. Divergence is
 * a difference in **extent**, and on-demand materialisation makes partial
 * divergence the common case: a skill configured `publish: false` is inside the
 * extent `vat validate` asks for and outside the distribution-consistency
 * extent `vat verify` asks for. Both runs record an identical contributor set,
 * both report complete, and a gate counting broken bundled references returns
 * 12 and 11. So `ZoneProvenanceRowSchema.extentDigest` is non-nullable, and a
 * contributor whose digest cannot be computed gets **no provenance row** — its
 * extent is then undeclarable by any check, which is the loud failure the
 * design wants rather than a silently weakened claim.
 *
 * ## Two properties the implementation must have
 *
 * 1. **Order-insensitive.** A contributor is not required to emit rows in a
 *    stable order — a set walked out of a `Map`, a `Promise.all` fan-in, and a
 *    directory crawl all vary run to run. An order-sensitive digest would
 *    report false non-convergence on every iteration and turn the fixpoint into
 *    an unconditional `ClosureNonConvergenceError`.
 * 2. **Total over the contribution.** A digest watching memberships alone would
 *    call a run converged while realizations, tags or conditions were still
 *    being attached. Every table participates.
 */

import { createHash } from 'node:crypto';

import { compareCodeUnits } from '@vibe-agent-toolkit/utils';

import type { ExtentContribution } from './contributor.js';

/**
 * Every table an {@link ExtentContribution} carries.
 *
 * Spelled out rather than derived from `Object.keys(contribution)` on purpose:
 * a contributor that omitted a key would otherwise silently shrink the digest's
 * coverage, and this list is what makes "every table participates" checkable by
 * the compiler when a table is added.
 */
const DIGESTED_TABLES = [
  'conditions',
  'contexts',
  'memberships',
  'realizations',
  'resources',
  'tags',
] as const satisfies readonly (keyof ExtentContribution)[];

/**
 * Digest the full contribution: order-insensitive, total over every table.
 *
 * Each row is serialized **wrapped in its table name** rather than concatenated
 * behind a separator character: a separator is only injective while no column
 * can contain it, and `realization_conditions.message` is free-form text. The
 * wrap makes a `resource_extents` row and any future two-column table
 * distinguishable by construction.
 *
 * @param contribution - The rows one contributor produced in one invocation
 * @returns Lowercase hex SHA-256 over the canonical, sorted row set
 */
export function extentDigest(contribution: ExtentContribution): string {
  const serializedRows: string[] = [];
  for (const table of DIGESTED_TABLES) {
    for (const row of contribution[table]) {
      serializedRows.push(canonicalize({ table, row }));
    }
  }
  // Sorting the serialized rows — not the rows themselves — is what makes the
  // digest independent of emission order.
  serializedRows.sort(compareCodeUnits);
  return createHash('sha256').update(serializedRows.join('\n'), 'utf8').digest('hex');
}

/**
 * Serialize a value so that two structurally equal values produce identical
 * strings, whatever order their keys were built in.
 *
 * `JSON.stringify` alone is not enough: it preserves insertion order, so two
 * row objects with the same columns assembled by different code paths would
 * digest differently. Dates are normalised to ISO-8601 because
 * `resource_realizations.mtime` is a `Date` after Zod coercion.
 *
 * @param value - Any row, column value or nested JSON value
 * @returns A canonical string form
 */
function canonicalize(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    // Array order IS data (`lens_entry_points.ancestry` is "nearest ancestor
    // first"), so it is preserved rather than sorted.
    const items = value.map((item: unknown) => canonicalize(item));
    return `[${items.join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    // An absent key and a key holding `undefined` are the same fact; keeping
    // both would make the digest move on a no-op change.
    .filter(([, item]) => item !== undefined)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`);
  entries.sort(compareCodeUnits);
  return `{${entries.join(',')}}`;
}

// `compareCodeUnits` is imported from `@vibe-agent-toolkit/utils`. It was declared privately here
// first; the digest is the reason it must never be `localeCompare` — collation is locale-dependent
// (`ä` sorts differently under `sv-SE` than under `de-DE`), so a digest ordered by it would differ
// between two machines populating the same corpus, which is precisely the comparison
// `zone_provenance.extentDigest` exists to make.
