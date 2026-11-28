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
  46: ['skillText.storeMiss', 'skillText.noStore', 'skillText.storeUnopened', 'skillText.outsideRoot'],
  48: ['store.reads.extent', 'store.reads.blob'],
  49: ['store.rows.decoded.persistent'],
  66: ['extent.derived', 'extent.served', 'blob.storeServed', 'harness.pairsDerived'],
  75: ['rowSet.rows.decoded'],
  89: ['resolve.tsconfig.configs', 'resolve.tsconfig.waves', 'resolve.tsconfig.entriesListed'],
  113: ['hydration.rows.written', 'hydration.rows.copied'],
  117: ['parse.cache.hit', 'parse.dispatched', 'parse.redispatched'],
  126: ['parse.refused.keyDetermined', 'parse.refused.inputCap.read', 'parse.refused.inputCap.dispatch'],
};

/** I10's own term for the store's write side, which no counted row restates. */
const I10_STORE_WRITES = 'I10 "store writes included"';

/** What the content-hashing counters baseline: two rows whose mechanisms are unbuilt. */
const UNBUILT_REHASH_BASELINE = 'the baseline for the unbuilt stat memo and racy re-hash rows';

/** What the read and registry counters answer to: an enforced decision, not a cost row. */
const ONE_READ_PER_RUN =
  'rule 4 of the content-identity decision (one read, one key, one admission per file per run), enforced by work-counters-validate.system.test.ts';

/** What the row-set counters no counted row names answer to. */
const ROW_SET_TIER =
  "the row-set tier's shared proofs (cold, warm, one-file edit, eviction, not demanded: every row-set counter zero in a run naming no row-set relation), enforced by the data-rows system tests; no cost row yet";

/**
 * Each counter no counted row names, with what it answers to instead. With
 * {@link COUNTED_COST_ROWS}, every counter is accounted for exactly once.
 */
export const COUNTERS_WITHOUT_A_COUNTED_ROW: Readonly<Partial<Record<WorkCounter, string>>> = {
  'store.rows.decoded.repeated':
    'one reader per stored row per process: a row decoded twice from one store file while it is open, asserted zero in every arm of work-counters-validate.system.test.ts and work-counters-validate-edit.system.test.ts (expectNoRowDecodedTwice); no cost row, since any is a defect',
  'store.reads.useStampLost':
    "a served extent read whose recency stamp SQLite refused (contention, a read-only file, a full disk, an I/O error): the read still serves and the tree keeps its previous use, so eviction may age it early; reported only, no cost row",
  'store.writes.persistent': I10_STORE_WRITES,
  'store.rows.written.persistent': I10_STORE_WRITES,
  'hydration.writes': "one per hydration that wrote a relation; row 113 is counted by its rows, not its writes.",
  'statement.explained': 'the schema-introspection row\'s cost, an enforced row, not a counted cost',
  'store.miss.refusedPairs': 'the store-miss row, an enforced row, not a counted cost',
  'parse.refused.load': 'load-dependent, bounded by I8; reported only',
  'parse.cache.written':
    "the parse cache's write side as reported (a worker killed after writing but before replying goes uncounted), which validate's checks overlap reads as its post-spawn parent writes (resource-scanning-and-caching.md 3.7b); no cost row",
  'content.hashed': UNBUILT_REHASH_BASELINE,
  'content.hashedBytes': UNBUILT_REHASH_BASELINE,
  'content.read': ONE_READ_PER_RUN,
  'content.gitRead': ONE_READ_PER_RUN,
  'content.gitSized': ONE_READ_PER_RUN,
  'fs.stat': ONE_READ_PER_RUN,
  'fs.lstat':
    'the link-chain walk and the realization lstat, counted by syscall: per path, the components walked below the root plus one per link hop, enforced by relation per phase in validate-in-process-cost.system.test.ts and work-counters-skill-review.system.test.ts',
  'registry.built': ONE_READ_PER_RUN,
  'registry.admitted': ONE_READ_PER_RUN,
  'git.calls': 'I10 git calls; git is no longer pinned, so no cost row restates them',
  'git.snapshots':
    "the git tree snapshots taken, a memo miss in gitTreeSnapshot; the parent's snapshot count on a written miss (spec 1.3), enforced by git-snapshot-count.integration.test.ts; no cost row",
  'git.listings':
    "the warm run's listability check (GitCrawlSource.assertListable), one ignored-side untracked listing per warm run served its extent from the store that demands git content; the cold crawl's prune listings are counted by git.calls alone; no cost row",
  'resolve.tsconfig.reachesOutsideGit':
    "the tsconfig step's TSCONFIG_REACHES_OUTSIDE_GIT condition rows, one per literal files or include entry naming a path outside git content: an answer's size, not a cost; equal to those rows in tsconfig-rows-counters.system.test.ts; no cost row",
  'rowSet.extracted': ROW_SET_TIER,
  'rowSet.storeServed': ROW_SET_TIER,
  'rowSet.refused': ROW_SET_TIER,
  'checks.gate.rows.read':
    "the tier rows validate's checks overlap gate reads to judge its members, summed per member (a content key several members share counts once per member), kept off every store counter so the overlapped and sequential runs count alike, but for the shared tier read when no crawled member reads the tier (resource-scanning-and-caching.md 3.7b); no cost row",
  'collection.matchers.compiled':
    'one compile per collection per holder of the config (registry, MIME resolver, scoped filter), never per file matched; enforced by collection-matcher.test.ts; no cost row',
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
  33: { mechanism: 'start-time probe', status: 'unbuilt' },
  38: { mechanism: 'code identity', status: 'unbuilt' },
  54: { mechanism: 'lease claim', status: 'unbuilt' },
  64: { mechanism: 'leases and pinned bytes', status: 'unbuilt' },
  65: { mechanism: 'stat memo', status: 'unbuilt' },
  114: { mechanism: 'lens', status: 'unbuilt' },
  115: { mechanism: 'racy re-hash', status: 'unbuilt' },
  134: {
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
