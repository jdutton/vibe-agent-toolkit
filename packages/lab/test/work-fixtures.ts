/** Rows of the `work` facet, shared by its compare and render suites. */

import { WORK_COUNTER_NAMES, type WorkCounter } from '@vibe-agent-toolkit/utils';

import type { WorkCommandStats } from '../src/facets/work/types.js';

/** Every counter at zero except those given, in tuple order. */
export function workCounters(over: Partial<Record<WorkCounter, number>> = {}): WorkCommandStats['counters'] {
  return WORK_COUNTER_NAMES.map((name) => ({ name, count: over[name] ?? 0 }));
}

/** A measured, stable, warm row; `over` names what differs. */
export function workRow(over: Partial<WorkCommandStats> = {}): WorkCommandStats {
  return {
    name: 'resources-scan',
    args: ['resources', 'scan', 'docs/'],
    cache: 'warm',
    runs: 3,
    comparedRuns: 2,
    stable: true,
    loadRefusedRepeats: 0,
    processes: 1,
    counters: workCounters({ 'store.rows.decoded.persistent': 120, 'git.calls': 2 }),
    varied: [],
    failed: false,
    failure: null,
    ...over,
  };
}
