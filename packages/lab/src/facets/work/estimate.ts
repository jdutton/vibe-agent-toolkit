/**
 * What `work ab` compares: each row's persistent-store rows decoded, the I10
 * hydration count. A row with no such number is lost, never zero: a failed row,
 * a measured vat that does not emit the counter, or repeats that give no
 * warrant, named with the reason `compare` gives.
 */

import type { FacetEstimate } from '../../harness/ab.js';

import { workStabilityCaveat } from './compare.js';
import { countOf } from './dump.js';
import type { WorkCommandStats } from './types.js';

/** The counter `work ab` compares. */
const AB_COUNTER = 'store.rows.decoded.persistent';

/** The unit its estimates carry. */
const AB_UNIT = 'persistent-store rows decoded';

/**
 * One row's estimate.
 *
 * @param row - A `work` row
 * @returns Its count, or the reason there is none
 */
function workEstimate(row: WorkCommandStats): FacetEstimate {
  const lost = (reason: string): FacetEstimate => ({ name: row.name, value: 0, unit: AB_UNIT, lost: reason });
  if (row.failed) return lost(row.failure ?? 'failed, with no reason recorded');
  const unwarranted = workStabilityCaveat(row, 'measured');
  if (unwarranted !== null) return lost(unwarranted);
  const count = countOf(row, AB_COUNTER);
  if (count === undefined) return lost(`the measured vat does not emit ${AB_COUNTER}`);
  return { name: row.name, value: count, unit: AB_UNIT, lost: null };
}

/**
 * Every row's estimate, in row order: a lost row is kept, never dropped.
 *
 * @param rows - A `work` report's rows
 * @returns One estimate per row
 */
export function workEstimates(rows: readonly WorkCommandStats[]): readonly FacetEstimate[] {
  return rows.map((row) => workEstimate(row));
}
