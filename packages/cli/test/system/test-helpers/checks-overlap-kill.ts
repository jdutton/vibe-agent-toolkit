/**
 * What the killed and dead checks-child arms of the overlap differential share: the scaled bound a
 * watchdog kill runs under, and the assertions every such arm makes.
 *
 * 🪤 The phase runs its child under the DEFAULT bound and `vat validate` accepts no flag to change
 * it, so a watchdog kill case would wait five minutes. `parent-only-fast-clock.mjs` scales the
 * supervising process's clock from the spawn on, so the default bound elapses in the real seconds
 * `measureBudget()` derives for this machine, exactly as a standalone kill case derives `--budget`.
 * Overlapped, the spawn comes during the resources phase, so the scaled clock covers the rest of
 * that phase too; the sequential run's resources phase runs unscaled, so an output change the
 * scaled clock caused fails the comparison.
 *
 * 🚨 Every killed arm asserts each run ended within {@link KILL_WITHIN_BUDGETS} measured budgets. A
 * preload that silently failed to load would leave the default bound in force, and the arm would
 * wait the full default bound for the same kill. Only the scaled clock ends a run that soon: before
 * it, the run is two populations (the `resources` phase's and the child's); after it, one budget of
 * scaled silence.
 *
 * ⚠️ The headroom is EMPIRICAL. `measureBudget()` times `vat resources check --budget 0` over the
 * warm store the runs start from, so it bounds the CHILD's population, not the `resources`
 * phase's — which `vat validate` runs first and nothing here measures. That the multiple holds is
 * observed on the CI runners, not derived — and on Windows it was observed with the system tier on
 * ONE worker; at two, a sibling fork can load the machine between the measurement and the run it
 * sizes. Re-observe it there if it reds.
 */

import { cpSync, rmSync } from 'node:fs';

import { VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/utils';
import { expect } from 'vitest';

import { DEFAULT_BUDGET_SECONDS } from '../../../src/commands/resources/check-supervisor.js';

import {
  type ArmOptions,
  type BothModes,
  CHECKS_BANNER,
  CHILD_MARKER,
  expectFacts,
  expectSameOutput,
  type ModeRun,
  type OverlapFixture,
  overlappedFacts,
} from './checks-overlap.js';
import { type Finding, TXT_ROWS, vat, writeConfig } from './checks-phase.js';
import { measureBudget } from './measure-check-budget.js';

/**
 * How many measured budgets a scaled kill may take, end to end: the `resources` phase's population,
 * the child's, one budget of silence, and headroom for a loaded machine. Chosen by observation —
 * see the module header for why it is not derived.
 */
const KILL_WITHIN_BUDGETS = 3;

/** A warm arm whose default bound elapses in this machine's measured budget, and the time each run must beat. */
interface BoundedArm {
  readonly arm: ArmOptions;
  readonly withinMs: number;
}

/**
 * The arm that makes the phase's default bound elapse in this machine's measured budget: the fast
 * clock (plus `more`), the scale that maps the default bound onto the measured one, and the real
 * time the kill must beat. Measured beside each killed case, never once per file.
 *
 * @param fixture - The fixture
 * @param committed - The fixture's committed checks, put back after the probe
 * @param more - Further test-only preloads
 * @returns The warm arm and the bound each run must beat
 */
export function boundedPhase(fixture: OverlapFixture, committed: Parameters<typeof writeConfig>[1], ...more: string[]): BoundedArm {
  // A cheap statement in place of the committed one. The committed config is put back before any
  // run: an edited config is a tree the store has not seen.
  writeConfig(fixture.project, [['quick', TXT_ROWS]]);
  let budgetSeconds: number;
  try {
    budgetSeconds = warmBudgetSeconds(fixture);
  } finally {
    writeConfig(fixture.project, committed);
  }
  const withinMs = KILL_WITHIN_BUDGETS * budgetSeconds * 1000;
  return {
    arm: {
      store: 'warm',
      preloads: ['parent-only-fast-clock.mjs', ...more],
      env: () => ({
        TEST_PARENT_CLOCK_SCALE: String(DEFAULT_BUDGET_SECONDS / budgetSeconds),
        // A stalled child ends itself only well past the bound, so the kill asserted is the watchdog's.
        TEST_CHILD_MAX_STALL_MS: String(2 * withinMs),
      }),
    },
    withinMs,
  };
}

/**
 * This machine's measured budget, as `measureBudget()` derives it, from one `vat resources check
 * --budget 0` over the warm store the runs start from and the fixture's committed checks (each must
 * finish). Measured beside each case that uses it, never once per file.
 *
 * @param fixture - The fixture, seeded
 * @returns The budget, in seconds
 */
export function warmBudgetSeconds(fixture: OverlapFixture): number {
  return measureBudget(() => {
    rmSync(fixture.cache, { recursive: true, force: true });
    cpSync(fixture.seeded, fixture.cache, { recursive: true });
    return vat(fixture.project, ['resources', 'check', '--budget', '0'], { [VAT_CACHE_DIR_ENV]: fixture.cache }).elapsedMs;
  }).budgetSeconds;
}

/**
 * The seed run of a fixture whose committed check never finishes: its default bound, scaled, elapses
 * in one real second once the child is spawned, by which time the resources phase has written the
 * store.
 */
export const SEED_UNDER_FAST_CLOCK: Pick<ArmOptions, 'preloads' | 'env'> = {
  preloads: ['parent-only-fast-clock.mjs'],
  env: () => ({ TEST_PARENT_CLOCK_SCALE: String(DEFAULT_BUDGET_SECONDS) }),
};

/**
 * The gate overlapped one run and not the other, the overlapped child's held line was replayed
 * after the checks banner (these arms publish no finding of the phase's own to bound it), and the
 * two runs are the same bytes.
 *
 * @param both - The arm's runs
 */
export function expectReplayedAtTurn(both: BothModes): void {
  expectFacts(both, overlappedFacts(expect.any(Number)));
  const { stderr } = both.overlapped;
  expect(stderr.indexOf(CHECKS_BANNER), stderr).toBeGreaterThanOrEqual(0);
  expect(stderr.indexOf(CHILD_MARKER), `the child's line after the checks banner\n${stderr}`).toBeGreaterThan(stderr.indexOf(CHECKS_BANNER));
  expectSameOutput(both.overlapped, both.sequential);
}

/**
 * {@link expectReplayedAtTurn}, and each run ended within the bound.
 *
 * @param both - The arm's runs
 * @param withinMs - The bound
 */
export function expectKilledInBothModes(both: BothModes, withinMs: number): void {
  expectReplayedAtTurn(both);
  for (const run of [both.overlapped, both.sequential]) expect(run.elapsedMs, run.mode).toBeLessThan(withinMs);
}

/**
 * A run's published findings.
 *
 * @param run - One mode's run
 * @returns Its findings
 */
export function findingsOf(run: ModeRun): Finding[] {
  return (run.document['findings'] ?? []) as Finding[];
}

/**
 * A run's published error, and its checks phase's.
 *
 * @param run - One mode's run
 * @returns Both, as published
 */
export function errorsOf(run: ModeRun): { run: { code: string } | undefined; phase: { message: string } | undefined } {
  const data = (run.document['data'] ?? {}) as { phases?: Array<{ name: string; error?: { message: string } }> };
  return {
    run: run.document['error'] as { code: string } | undefined,
    phase: data.phases?.find((phase) => phase.name === 'checks')?.error,
  };
}
