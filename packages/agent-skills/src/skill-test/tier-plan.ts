/**
 * tier-plan.ts — pure, unit-testable tier grouping + gate policy for the
 * cost-tiered fail-fast eval loop (issue #145 Phase G).
 *
 * Evals carry an optional `tier` (ascending, 0 = cheapest/foundational — see
 * eval-inputs.ts). The harness runs tiers in ascending order, bounded-parallel
 * WITHIN a tier, and applies a GATE between tiers: once a cheaper tier has a
 * gating failure, the higher (more expensive) tiers are SKIPPED so the run stops
 * burning budget as soon as a foundational expectation is broken.
 *
 * Per-subject-model gating (matrix intent): a single `vat skill test run` targets
 * ONE subject model, so the gate here is per-run. In a model matrix the SAME
 * policy scopes per model — a model that fails a foundational tier stops burning
 * budget on the harder tiers for THAT model, independently of the other models.
 * No matrix machinery lives here; this module is the per-run building block.
 *
 * Everything in this module is PURE (no I/O, no spawning) so the grouping and the
 * gate decision unit-test without a harness.
 */

import type { EvalFragment } from './eval-fragment.js';
import type { EvalEntry } from './eval-inputs.js';

/** Tier assigned to an eval that omits `tier` (the cheapest/first tier). */
export const DEFAULT_TIER = 0;

/** One tier's worth of evals, all sharing the same (explicit or defaulted) tier. */
export interface TierGroup {
  /** The tier number (ascending; {@link DEFAULT_TIER} when the eval omitted `tier`). */
  tier: number;
  /** The evals in this tier, in their original suite order. */
  evals: EvalEntry[];
}

/**
 * Group evals by `tier ?? DEFAULT_TIER` and return the groups in ASCENDING tier
 * order (cheapest first). Within a group, evals keep their original suite order.
 * Pure — the caller runs each returned group as one bounded-parallel batch.
 */
export function groupEvalsByTier(evals: readonly EvalEntry[]): TierGroup[] {
  const byTier = new Map<number, EvalEntry[]>();
  for (const entry of evals) {
    const tier = entry.tier ?? DEFAULT_TIER;
    const existing = byTier.get(tier);
    if (existing === undefined) byTier.set(tier, [entry]);
    else existing.push(entry);
  }
  return [...byTier.entries()]
    .sort(([a], [b]) => a - b)
    .map(([tier, tierEvals]) => ({ tier, evals: tierEvals }));
}

/**
 * Whether one graded WITH-arm fragment FULLY passed: every output expectation
 * passed AND (when the eval declared tool expectations) the tool verdict passed.
 * This mirrors the run's COMPOSITE verdict at the single-eval grain — an
 * un-invoked `mustRun`, a hollow/zero-tool run, or a failing output expectation
 * all yield `false`. Pure.
 */
export function fragmentPassed(fragment: EvalFragment): boolean {
  const outputPassed = fragment.expectations.every((e) => e.passed);
  const toolPassed = fragment.tool === undefined || fragment.tool.passed;
  return outputPassed && toolPassed;
}

/**
 * Default gate policy: STOP (return true) when ANY eval in the just-completed
 * tier did not fully pass — i.e. its composite result is a FAIL (an output
 * expectation failed OR a tool verdict failed). A tier with no fragments (or all
 * passing) does not gate. Deliberately simple: "a cheap tier already broke, so
 * don't spend on the expensive ones." Pass the tier's WITH-arm fragments only —
 * the WITHOUT (skill-absent) baseline arm measures the no-skill floor and never
 * drives gating. Pure.
 */
export function shouldGateAfterTier(withArmFragments: readonly EvalFragment[]): boolean {
  return withArmFragments.some((fragment) => !fragmentPassed(fragment));
}

/** The evals of one skipped tier — a distinct SKIPPED state, never counted as passed. */
export interface SkippedTierInfo {
  tier: number;
  evalIds: string[];
}

/**
 * The set of higher tiers that were SKIPPED by the fail-fast gate, and which
 * tier's failure triggered it. SKIPPED is a distinct state (never pass, never
 * graded); this record lets the reporter name exactly what was not run and why.
 */
export interface SkippedEvalsSummary {
  /** The (lower) tier whose gating failure stopped the run. */
  gatedByTier: number;
  /** The lowest tier that was skipped (the first tier above {@link gatedByTier}). */
  firstSkippedTier: number;
  /** Every skipped tier, ascending. */
  tiers: SkippedTierInfo[];
  /** Total number of skipped evals across all skipped tiers. */
  totalSkipped: number;
}

/**
 * Build the {@link SkippedEvalsSummary} for the tiers left unrun after a gate
 * fired. `remaining` are the higher tier groups (ascending) that will NOT be
 * launched. Pure. Defensive on an empty `remaining` (the caller only invokes
 * this when a gate fired with tiers still pending, but an empty set yields a
 * zero-skip summary rather than an index throw).
 */
export function buildSkippedSummary(gatedByTier: number, remaining: readonly TierGroup[]): SkippedEvalsSummary {
  const tiers = remaining.map((group) => ({
    tier: group.tier,
    evalIds: group.evals.map((entry) => String(entry.id)),
  }));
  const totalSkipped = tiers.reduce((sum, t) => sum + t.evalIds.length, 0);
  const first = remaining[0];
  return {
    gatedByTier,
    firstSkippedTier: first === undefined ? gatedByTier : first.tier,
    tiers,
    totalSkipped,
  };
}

/**
 * The single human-legible line naming which tiers were skipped and why. No
 * silent truncation — the reporter emits this verbatim to the summary and stderr
 * so a fail-fast run is never mistaken for a smaller (passing) suite.
 */
export function formatSkippedTiersSummary(summary: SkippedEvalsSummary): string {
  const evalWord = summary.totalSkipped === 1 ? 'eval' : 'evals';
  return (
    `SKIPPED (fail-fast): tier ${summary.firstSkippedTier} and above ` +
    `(${summary.totalSkipped} ${evalWord}) — gated by tier ${summary.gatedByTier} failure`
  );
}
