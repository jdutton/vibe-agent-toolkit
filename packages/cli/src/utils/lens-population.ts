/**
 * Where a run's LENS populations came from — the one vocabulary `vat resources
 * query`, `check`, and `check`'s progress log all publish.
 *
 * Its own module, and a leaf, so a schema file can name it without importing
 * the lens evaluators that compute it.
 */

import { POPULATION_ORIGINS } from '@vibe-agent-toolkit/resources';

/**
 * Every lens provenance a run can publish: `'none'` when no evaluated lens
 * populated anything, otherwise one of the population origins — derived from
 * `POPULATION_ORIGINS`, so a new origin reaches every schema at once.
 */
export const LENS_POPULATIONS = ['none', ...POPULATION_ORIGINS] as const;

/**
 * Where the lenses' populations came from, as a run publishes it: `'none'` when
 * no evaluated lens populated anything, `'store'` when every one that did was
 * served from the store, otherwise `'derived'`.
 */
export type LensPopulation = (typeof LENS_POPULATIONS)[number];
