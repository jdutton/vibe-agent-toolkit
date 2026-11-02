/**
 * Comparing two `memory` reports.
 *
 * The gates are the shared ones (`compareCommandRows`: same facet, a strict
 * body, at most one axis moved). Then, per command: a failed side, a different
 * cache mode or a different accepted exit is no delta at all — the same three
 * reasons, in the same order, as `perf` — and otherwise the MEDIAN peaks are
 * subtracted and judged by {@link magnitudeDelta}.
 */

import type { DecideComparisonOptions } from '../../envelope/coordinate.js';
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
 * Fraction of the smaller median a peak must move by to count as real.
 *
 * Peak RSS is far steadier than wall time — repeats of one `vat build` agree to
 * within a few percent — so the relative gate matches `perf`'s 10% rather than
 * needing to be wider.
 */
const MIN_RELATIVE = 0.1;

/**
 * Kilobytes a peak must move by to count as real: 16 MiB.
 *
 * Below this, the difference is the allocator and V8's heap-growth steps, not
 * anything vat did.
 */
const MIN_ABSOLUTE_KB = 16 * 1024;

/** What happened to one command present on both sides. */
export type MemoryCommandVerdict =
  | { readonly kind: 'changed' | 'unchanged'; readonly peak: MagnitudeDelta }
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
 * Diff one command present on both sides.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @returns The verdict
 */
function verdictFor(before: MemoryCommandStats, after: MemoryCommandStats): MemoryCommandVerdict {
  const reason = unmeasurableReason(before, after);
  if (reason !== null) return { kind: 'unmeasurable', reason };
  const peak = magnitudeDelta(before.medianKb, after.medianKb, MIN_RELATIVE, MIN_ABSOLUTE_KB);
  return { kind: peak.significant ? 'changed' : 'unchanged', peak };
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
  return compareCommandRows<MemoryCommandStats, MemoryCommandVerdict>(
    before,
    after,
    MEMORY_CONTRACT,
    options,
    verdictFor,
  );
}
