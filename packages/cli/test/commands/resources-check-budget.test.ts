/**
 * The time bound on `vat resources check`, and what a run KILLED by it reports.
 *
 * ## The defect this closes
 *
 * This verb runs adopter-authored SQL as an unattended CI gate. An accidental
 * cross join, or a `WITH RECURSIVE` with no termination, runs forever — and
 * nothing in-process can stop it. Measured on Node 24.13.1: the query is
 * synchronous and holds the event loop, `node:sqlite` exposes no interrupt,
 * `worker.terminate()` never resolves against a thread blocked in native SQLite,
 * and the parent's own `process.exit()` does not exit either. An external
 * `SIGKILL` is the only lever there is.
 *
 * So the bound is enforced from OUTSIDE the process doing the work, and the two
 * halves of that live here: deciding when to pull the trigger, and turning what
 * the corpse left on disk into a report that fails the build honestly.
 *
 * ## 🔑 The budget is ABSENCE OF PROGRESS, not a total stopwatch
 *
 * A total-runtime bound would have to be set above the slowest legitimate run on
 * the largest adopter tree, which makes it useless as a hang detector; and it
 * would kill a healthy run that is merely large. The clock resets on every unit
 * the child completes, so a run of forty rules over a huge repository is never
 * at risk while it is making progress, and a single rule that stops making it is
 * caught in one budget. That distinction is the property {@link pollWatchdog}'s
 * cases exist to pin, and it is the one a total stopwatch would silently lose.
 */

import { describe, expect, it } from 'vitest';

import type { ProgressEntry } from '../../src/commands/resources/check-progress.js';
import {
  parseBudgetSeconds,
  pollWatchdog,
  runsInThisProcess,
  type WatchdogState,
} from '../../src/commands/resources/check-supervisor.js';
import {
  buildCheckOutputData,
  buildKilledCheckInput,
  type CheckPayloadInput,
} from '../../src/commands/resources/check.js';

/** The log lines a run writes before it hangs on its second rule. */
const POPULATION: ProgressEntry = {
  kind: 'population',
  population: 'store',
  populationMs: 1180,
  membersEnumerated: 8123,
};
const FIRST_COST: ProgressEntry = { kind: 'check', name: 'no-markdown', durationMs: 4.25, rows: 3 };
const HUNG_START: ProgressEntry = { kind: 'start', name: 'runaway' };
/** A check whose statement THREW before the hang — priced, and with no rows. */
const BROKEN_COST: ProgressEntry = {
  kind: 'check',
  name: 'stale-column',
  durationMs: 0.9,
  broken: true,
};

/** A watchdog that has seen nothing yet, at time zero. */
const FRESH: WatchdogState = { bytesSeen: 0, quietSince: 0 };

describe('parseBudgetSeconds', () => {
  it('defaults to 300 seconds when the flag is not passed', () => {
    // 🔑 The number is a judgement, not a round figure: population alone is
    // ~1.2 s warm on this repository but 33-35 s with a cold parse cache, and a
    // FALSE kill on a big adopter tree is far worse than a slow honest failure.
    // 300 s still converts an infinite hang into a bounded one.
    expect(parseBudgetSeconds(undefined)).toBe(300);
  });

  it('takes the operator\'s number, including a fractional one', () => {
    expect(parseBudgetSeconds('2')).toBe(2);
    expect(parseBudgetSeconds('0.5')).toBe(0.5);
  });

  it('accepts 0 as the documented escape hatch', () => {
    // 0 means NO bound, and the run stays in-process. It is a real choice — a
    // developer at the keyboard has Ctrl-C — so it must not be mistaken for a
    // missing value and silently defaulted.
    expect(parseBudgetSeconds('0')).toBe(0);
  });

  it('refuses a value that is not a number', () => {
    // An operator error, thrown so it exits 2. Silently defaulting a typo would
    // mean `--budget 2O` (letter O) ran with a five-minute bound while the
    // operator believed they had set two seconds.
    expect(() => parseBudgetSeconds('soon')).toThrow(/--budget/);
  });

  it('refuses a negative budget', () => {
    // A negative bound would breach on its first poll and kill every run
    // instantly — a gate that always fails teaches operators to bypass it.
    expect(() => parseBudgetSeconds('-1')).toThrow(/--budget/);
  });
});

describe('runsInThisProcess — the fork', () => {
  it('does the work HERE when a cost log was handed to it', () => {
    // 🚨 The recursion guard, and the reason it is a named function rather than
    // a condition inline in the command. `--cost-log` is what a supervising
    // parent passes its child; a child that read the budget instead would spawn
    // a child of its own, and so on. Note the budget is the DEFAULT here — the
    // cost log has to win against it, not merely alongside it.
    expect(runsInThisProcess({ costLog: 'progress.jsonl', budgetSecs: 300 })).toBe(true);
  });

  it('does the work HERE when the operator removed the bound', () => {
    // `--budget 0` buys nothing from a child: there is nothing to supervise, and
    // a spawn would cost a second process startup for no bound at all.
    expect(runsInThisProcess({ costLog: undefined, budgetSecs: 0 })).toBe(true);
  });

  it('supervises a child when there is a bound and no cost log', () => {
    expect(runsInThisProcess({ costLog: undefined, budgetSecs: 300 })).toBe(false);
  });
});

describe('pollWatchdog', () => {
  it('resets the clock when the log has grown', () => {
    const { state, breach } = pollWatchdog(FRESH, { bytes: 120, now: 5000, budgetMs: 2000 });

    expect(breach).toBe(false);
    expect(state).toStrictEqual({ bytesSeen: 120, quietSince: 5000 });
  });

  it('does not breach while the budget still has room', () => {
    const { breach } = pollWatchdog(FRESH, { bytes: 0, now: 1999, budgetMs: 2000 });

    expect(breach).toBe(false);
  });

  it('breaches once the budget has passed with no new line', () => {
    const { breach } = pollWatchdog(FRESH, { bytes: 0, now: 2000, budgetMs: 2000 });

    expect(breach).toBe(true);
  });

  it('NEVER breaches a run that keeps making progress, however long it takes', () => {
    // 🔑 The property that distinguishes this from a total stopwatch, and the
    // whole reason a large adopter tree is safe. Twenty budgets' worth of wall
    // time elapses; every poll sees a new line; nothing is killed.
    let state = FRESH;
    for (let poll = 1; poll <= 20; poll += 1) {
      const result = pollWatchdog(state, {
        bytes: poll * 60,
        now: poll * 2000,
        budgetMs: 2000,
      });
      expect(result.breach).toBe(false);
      state = result.state;
    }
  });

  it('breaches after the last line, not after the run started', () => {
    // The same run as above, then silence. The budget is counted from the last
    // line — a bound measured from the spawn would have fired long before.
    const after = pollWatchdog(
      { bytesSeen: 1200, quietSince: 40_000 },
      { bytes: 1200, now: 42_000, budgetMs: 2000 },
    );

    expect(after.breach).toBe(true);
  });
});

/**
 * The recovered payload for a run killed while `runaway` was in flight.
 *
 * @param entries - What the child's log held, defaulting to the hang above
 * @returns The input the document is built from
 */
function killed(
  entries: readonly ProgressEntry[] = [POPULATION, FIRST_COST, HUNG_START],
): CheckPayloadInput {
  return buildKilledCheckInput({ entries, root: '/corpus', budgetSecs: 2, durationMs: 3400 });
}

describe('buildKilledCheckInput', () => {
  it('carries the population the child actually reported, never a fabricated one', () => {
    const input = killed();

    expect(input.population).toBe('store');
    expect(input.populationMs).toBe(1180);
    expect(input.membersEnumerated).toBe(8123);
  });

  it('keeps the checks that COMPLETED, with the rows each selected', () => {
    // A killed run is still evidence: the rules that finished were measured, and
    // dropping them would throw away the only per-rule cost data the operator
    // has for narrowing down what to fix.
    const input = killed();

    expect(input.costs).toStrictEqual([{ name: 'no-markdown', durationMs: 4.25, rows: 3 }]);
  });

  it('recovers a BROKEN completed check with no row count at all', () => {
    // 🪤 `rows: 0` on a statement that never returned would read as "selected
    // nothing and passed" — the exact confusion `RESOURCE_CHECK_BROKEN` exists
    // to prevent, and the completed path is careful about. A `?? 0` default here
    // left every other case in this file green, so this is the case that pins it.
    const input = killed([POPULATION, BROKEN_COST, HUNG_START]);

    expect(input.costs).toStrictEqual([{ name: 'stale-column', durationMs: 0.9, broken: true }]);
  });

  it('reports the breach under the non-overridable run-integrity code', () => {
    // 🔑 `RESOURCE_CHECK_BROKEN`, not a code of its own, and for the reason
    // `emptyCorpusFinding` gives: it is the same claim — these assertions did
    // not execute, so the green means nothing — and it needs the identical
    // non-overridability, which `ValidationConfigSchema` grants by refusing that
    // code as a `severity` key.
    const [finding] = killed().issues;

    expect(finding?.code).toBe('RESOURCE_CHECK_BROKEN');
    expect(finding?.severity).toBe('error');
  });

  it('names the check that was in flight and the budget it blew', () => {
    const [finding] = killed().issues;

    expect(finding?.message).toContain('runaway');
    expect(finding?.message).toContain('2');
  });

  it('says the completed checks\' VIOLATIONS are missing from this document', () => {
    // 🪤 The log records COSTS, not findings. A reader who took this issue list
    // as the complete account would conclude the finished rules found nothing —
    // and act on a green that was never claimed.
    const [finding] = killed().issues;

    expect(finding?.message).toMatch(/violation/i);
  });

  it('fails the run: the document it builds is an error', () => {
    // ⛔ A killed run must NEVER exit 0 and must NEVER look like a pass. This is
    // the seam that decides it — the same builder a completed run uses, fed an
    // error-severity finding.
    const payload = buildCheckOutputData(killed());

    expect(payload['status']).toBe('error');
  });

  it('says so when the run was killed between the population and the first check', () => {
    // Real, and not the same as "a rule hung": the child had populated and had
    // not entered a statement. Naming a rule here would blame one that never ran.
    const [finding] = killed([POPULATION]).issues;

    expect(finding?.message).toContain('no check was running');
  });

  it('REFUSES to build a document when population never completed', () => {
    // 🔑 There is no projection, so `population`, `populationSecs` and
    // `membersEnumerated` have no honest value — and `membersEnumerated: 0` is
    // the exact shape that already means "this gate asserted nothing", which
    // would be a second, wrong claim. An operator error (exit 2) is the truthful
    // ending.
    expect(() => killed([])).toThrow(/population/i);
  });

  it('names the budget in the refusal, so the operator can raise it', () => {
    expect(() => killed([])).toThrow(/2/);
  });
});
