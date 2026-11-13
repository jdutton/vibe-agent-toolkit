/**
 * Each `accepted, counted` row of the hazard register, keyed by its line number,
 * mapped to the counters that count it ({@link COUNTED_COST_ROWS}) or to the
 * unbuilt mechanism whose counter waits on it ({@link UNCOUNTED_COST_ROWS}).
 * The change that builds a mechanism adds its counter and moves its row.
 */

import type { WorkCounter } from '@vibe-agent-toolkit/utils';

/** The register, repo-relative. */
export const HAZARD_REGISTER_PATH = 'docs/architecture/fact-extractors-hazard-register.md';

/** The status prefix that marks a counted cost row. */
export const COUNTED_STATUS_PREFIX = 'accepted, counted';

/** Register line number to the counters that count that row. */
export const COUNTED_COST_ROWS: Readonly<Record<number, readonly [WorkCounter, ...WorkCounter[]]>> = {
  56: ['extent.derived', 'extent.served'],
  57: ['store.rows.decoded.persistent', 'store.rows.decoded.ephemeral'],
  61: ['parse.cache.hit', 'parse.dispatched', 'parse.redispatched'],
  69: ['parse.refused.keyDetermined', 'parse.refused.inputCap.read', 'parse.refused.inputCap.dispatch'],
};

/** I10's own term for the store's write side, which no counted row restates. */
const I10_STORE_WRITES = 'I10 "store writes included"';

/** What the content-hashing counters baseline: two rows whose mechanisms are unbuilt. */
const UNBUILT_REHASH_BASELINE = 'the baseline for the unbuilt stat memo and racy re-hash rows';

/**
 * Each counter no counted row names, with what it answers to instead. With
 * {@link COUNTED_COST_ROWS}, every counter is accounted for exactly once.
 */
export const COUNTERS_WITHOUT_A_COUNTED_ROW: Readonly<Partial<Record<WorkCounter, string>>> = {
  'store.reads.persistent': 'I10 store reads',
  'store.reads.ephemeral': 'I10 store reads',
  'store.writes.persistent': I10_STORE_WRITES,
  'store.writes.ephemeral': I10_STORE_WRITES,
  'store.rows.written.persistent': I10_STORE_WRITES,
  'store.rows.written.ephemeral': I10_STORE_WRITES,
  'store.miss.refusedPairs': 'the store-miss row, an enforced row, not a counted cost',
  'parse.refused.load': 'load-dependent, bounded by I8; reported only',
  'content.hashed': UNBUILT_REHASH_BASELINE,
  'content.hashedBytes': UNBUILT_REHASH_BASELINE,
  'git.calls': 'I10 git calls; git is no longer pinned, so no cost row restates them',
};

/** A counted cost row whose counter waits on its mechanism. */
export interface UncountedCostRow {
  /** The mechanism the cost comes from. */
  readonly mechanism: string;
  /** Always `unbuilt`: a built mechanism is counted, never listed here. */
  readonly status: 'unbuilt';
}

/** Register line number to the unbuilt mechanism whose cost that row accepts. */
export const UNCOUNTED_COST_ROWS: Readonly<Record<number, UncountedCostRow>> = {
  31: { mechanism: 'start-time probe', status: 'unbuilt' },
  36: { mechanism: 'code identity', status: 'unbuilt' },
  44: { mechanism: 'lease claim', status: 'unbuilt' },
  54: { mechanism: 'leases and pinned bytes', status: 'unbuilt' },
  55: { mechanism: 'stat memo', status: 'unbuilt' },
  58: { mechanism: 'lens', status: 'unbuilt' },
  59: { mechanism: 'racy re-hash', status: 'unbuilt' },
  77: {
    mechanism: "worker round trip (measured by the lab's parse-facet tier row, not a work counter)",
    status: 'unbuilt',
  },
};

/**
 * The register lines whose status column starts with {@link COUNTED_STATUS_PREFIX}.
 *
 * @param register - The register's text
 * @returns Their 1-based line numbers, ascending
 */
export function countedRegisterRows(register: string): number[] {
  return register
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => line.startsWith('|') && statusCell(line).startsWith(COUNTED_STATUS_PREFIX))
    .map(({ number }) => number);
}

/**
 * A table row's second cell, trimmed — the register's status column.
 *
 * @param line - One table row
 * @returns The status, or `''` for a row with fewer cells
 */
function statusCell(line: string): string {
  return (line.split('|')[2] ?? '').trim();
}
