/**
 * What a hand-built `perf` row says about the probe's measurements when its
 * case is not about them: nothing was read.
 *
 * Not a test file. Spread into a literal row so every case that builds one by
 * hand says "no probe data" the same way, and a new row field is added here once.
 */

import type { PerfCommandStats } from '../src/facets/perf/types.js';

/** The probe-derived fields of a row for which no probe record and no debug facts exist. */
export const NO_PROBE_DATA: Pick<PerfCommandStats, 'surfaces' | 'cpuMs' | 'processes' | 'checksOverlapped' | 'gateDeclinedBy'> = {
  surfaces: {},
  cpuMs: null,
  processes: [],
  checksOverlapped: null,
  gateDeclinedBy: null,
};
