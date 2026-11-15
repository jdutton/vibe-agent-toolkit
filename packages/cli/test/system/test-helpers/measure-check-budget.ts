/**
 * The bound a killed `vat resources check` case runs under, DERIVED from what this machine costs
 * right now — never a literal.
 *
 * 🪤 **The bound cannot be a literal, and a literal is what shipped.** The budget is time WITHOUT
 * progress, and the population is ONE unit — so a bound that does not clear the population kills
 * the run before any rule exists, and a case asserting the RULE's name has nothing to assert on. A
 * flat 2 s cleared it on an idle machine and did not clear it inside the full system suite: one CI
 * run reported `expected 2 to be 1`, and the same file passed 7/7 in isolation minutes later. That
 * is a test whose premise silently acquired a second requirement — that a population fit inside a
 * hardcoded number of seconds — and the machine decides whether it holds.
 *
 * 🪤 **Measure beside each killed case, never once per file.** The load a sibling suite puts on
 * the machine is not constant across a file: a probe taken on a quiet box sized a bound that a busy
 * one then blew during the population.
 */

/**
 * The floor under the killed cases' bound. Small, so the suite does not pay for it on an idle
 * machine.
 */
const BUDGET_FLOOR_SECONDS = 2;

/** How many measured baselines of headroom the bound gets over the population. */
const BUDGET_BASELINE_HEADROOM = 3;

/** What this machine costs RIGHT NOW, and the bound derived from it. */
export interface MeasuredBudget {
  /** A real run of the same verb over the same tree, in-process and complete. */
  baselineMs: number;
  /** The bound a killed case runs under, in seconds — derived, never a literal. */
  budgetSeconds: number;
}

/**
 * Probe the machine and derive the bound from what it measured.
 *
 * @param probe - Runs one complete, cheap `vat resources check --budget 0` over the case's own
 *   tree (spawn, population and one cheap statement) and returns its wall time in milliseconds
 * @returns The baseline and the bound
 */
export function measureBudget(probe: () => number): MeasuredBudget {
  const baselineMs = probe();
  return {
    baselineMs,
    budgetSeconds: Math.max(
      BUDGET_FLOOR_SECONDS,
      Math.ceil((baselineMs / 1000) * BUDGET_BASELINE_HEADROOM),
    ),
  };
}
