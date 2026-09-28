/**
 * Shared scaffolding for building `VerdictDeltas` entries, used by the
 * `reconcileDeltas` unit suite and the planted-delta integration suite.
 *
 * Not a test file — no `.test.ts` suffix, so the runner does not collect it.
 * Pure: it does no I/O, so the unit tier can import it as freely as the
 * integration tier.
 */

import type { VerdictDeltas } from '../src/facets/verdict/deltas.js';

/**
 * @param defaults - The fields every entry in one suite shares
 * @returns An `entry(declared)` builder closed over those defaults, with empty
 *   finding lists unless `declared` sets them
 */
export function verdictDeltaEntryFactory(
  defaults: Pick<VerdictDeltas['deltas'][number], 'subject' | 'verb' | 'changelog' | 'reason'>,
): (declared: Partial<VerdictDeltas['deltas'][number]>) => VerdictDeltas['deltas'][number] {
  return (declared) => ({
    ...defaults,
    findingsAdded: [],
    findingsRemoved: [],
    ...declared,
  });
}
