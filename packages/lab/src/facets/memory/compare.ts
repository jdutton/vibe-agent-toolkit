/**
 * Comparing two `memory` reports.
 *
 * The gates are the shared ones (`compareCommandRows`: same facet, a strict
 * body, at most one axis moved). Then, per command: a failed side, a different
 * cache mode or a different accepted exit is no delta at all — the same three
 * reasons, in the same order, as `perf` — and otherwise the MEDIAN peaks are
 * subtracted and judged by {@link magnitudeDelta}, with a floor no smaller than
 * the two arms' combined spread, and a change in how many vat processes ran is a
 * change in its own right — between arms of one instrument kind only.
 */

import type { DecideComparisonOptions, InstrumentVersion } from '../../envelope/coordinate.js';
import type { ReportEnvelope } from '../../envelope/envelope.js';
import {
  bothSides,
  cacheModeCaveat,
  type CommandsCompared,
  compareCommandRows,
  type ComparisonRefusal,
  failureCaveat,
  type MagnitudeDelta,
  magnitudeDelta,
} from '../../harness/facet-compare.js';

import { MEMORY_FACET, MemoryBodySchema, type MemoryCommandStats } from './types.js';

/**
 * Fraction of the smaller median a peak must move by to count as real — `perf`'s
 * 10%. The measured spread decides the rest: see {@link spreadKb}.
 */
const MIN_RELATIVE = 0.1;

/**
 * Kilobytes a peak must move by to count as real: 8 MiB — four times the largest
 * median move an A-vs-A null run made (see `docs/facets.md`, "The memory
 * threshold"). Below it, the difference is the allocator and V8's heap-growth
 * steps, not anything vat did.
 */
const MIN_ABSOLUTE_KB = 8 * 1024;

/** How many vat processes each side's repeats ran — one count per side, since a row's repeats agree. */
interface ProcessCounts {
  readonly before: number;
  readonly after: number;
}

/** What happened to one command present on both sides. */
export type MemoryCommandVerdict =
  | { readonly kind: 'changed' | 'unchanged'; readonly peak: MagnitudeDelta; readonly processes: ProcessCounts }
  | { readonly kind: 'unmeasurable'; readonly reason: string };

/** A completed comparison. */
export type MemoryComparisonResult = CommandsCompared<MemoryCommandStats, MemoryCommandVerdict>;

/** The outcome of comparing two memory reports. */
export type MemoryComparison = MemoryComparisonResult | ComparisonRefusal;

/** Options for {@link compareMemory}. */
export type CompareMemoryOptions = DecideComparisonOptions;

/** This facet's body contract, as the shared comparison gates need it. */
const MEMORY_CONTRACT = {
  facet: MEMORY_FACET,
  schema: MemoryBodySchema,
} as const;

/**
 * Why a pair of rows cannot yield a delta, or `null` when it can.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @returns A reason, or `null`
 */
function unmeasurableReason(before: MemoryCommandStats, after: MemoryCommandStats): string | null {
  const caveat = bothSides(before, after, failureCaveat) ?? cacheModeCaveat(before, after);
  if (caveat !== null) return caveat;
  if (before.exitCode === after.exitCode) return null;
  return (
    `accepted exit codes differ (${String(before.exitCode)} vs ${String(after.exitCode)}) — ` +
    'one side had findings the other did not, so the two runs did not do the same work'
  );
}

/**
 * One arm's repeat spread: the range its peaks covered.
 *
 * @param row - A measured row
 * @returns `maxKb - minKb`
 */
function spreadKb(row: MemoryCommandStats): number {
  return row.maxKb - row.minKb;
}

/**
 * How an arm launched vat: `tree` has a commit, `dist` a closure, `npx` neither.
 *
 * @param instrument - The arm's instrument coordinate
 * @returns Its kind
 */
function instrumentKind(instrument: InstrumentVersion): 'tree' | 'dist' | 'npx' {
  if (instrument.commit !== null) return 'tree';
  return instrument.closure === null ? 'npx' : 'dist';
}

/**
 * Diff one command present on both sides.
 *
 * CHANGED needs a move larger than the 8 MiB floor, the 10% gate AND the two
 * arms' combined spread: a delta the repeats themselves wandered across is not
 * a move. A different count of vat processes is CHANGED whatever the peaks did —
 * the peak is the largest of a different set of processes — but only between
 * arms of one launch kind: `kinds` is `null` then, and otherwise names the two.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @param kinds - The two arms' instrument kinds when they differ, else `null`
 * @returns The verdict
 */
function verdictFor(before: MemoryCommandStats, after: MemoryCommandStats, kinds: string | null): MemoryCommandVerdict {
  const reason = unmeasurableReason(before, after);
  if (reason !== null) return { kind: 'unmeasurable', reason };
  const floorKb = Math.max(MIN_ABSOLUTE_KB, spreadKb(before) + spreadKb(after));
  const peak = magnitudeDelta(before.medianKb, after.medianKb, MIN_RELATIVE, floorKb);
  const processes = { before: before.processesPerRepeat[0] ?? 0, after: after.processesPerRepeat[0] ?? 0 };
  const changed = peak.significant || (kinds === null && processes.before !== processes.after);
  return { kind: changed ? 'changed' : 'unchanged', peak, processes };
}

/**
 * Compare two `memory` reports.
 *
 * @param before - The baseline report
 * @param after - The report being compared against it
 * @param options - Axis options
 * @returns A comparison, or a refusal explaining why the two cannot be compared
 */
export function compareMemory(
  before: ReportEnvelope<unknown>,
  after: ReportEnvelope<unknown>,
  options: CompareMemoryOptions = {},
): MemoryComparison {
  const was = instrumentKind(before.coordinate.instrument);
  const now = instrumentKind(after.coordinate.instrument);
  const kinds = was === now ? null : `${was} vs ${now}`;
  return compareCommandRows<MemoryCommandStats, MemoryCommandVerdict>(
    before,
    after,
    MEMORY_CONTRACT,
    options,
    (b, a) => verdictFor(b, a, kinds),
    (verdict) =>
      kinds !== null && 'processes' in verdict && verdict.processes.before !== verdict.processes.after
        ? `instrument kinds differ (${kinds}), and each launches vat through its own processes, so the count is not compared`
        : null,
  );
}
