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
 * at risk while its rules keep finishing, and a single rule that stops finishing
 * is caught in one budget. That distinction is the property
 * {@link pollWatchdog}'s cases exist to pin, and it is the one a total stopwatch
 * would silently lose.
 *
 * ⚠️ It is a property of the CHECKS, and only of them. The population emits ONE
 * line, at its end, so for the longest single unit in a cold run the budget IS
 * the total-runtime bound — see `check-supervisor.ts`'s header for the measured
 * reason instrumenting it further would look like an improvement and not be one.
 */

import { describe, expect, it } from 'vitest';

import type { ProgressEntry } from '../../src/commands/resources/check-progress.js';
import { unitInFlight } from '../../src/commands/resources/check-progress.js';
import {
  type AbnormalDeath,
  parseBudgetSeconds,
  pollWatchdog,
  requireSupervisableFlags,
  resolveChildEnding,
  runsInThisProcess,
  type WatchdogState,
} from '../../src/commands/resources/check-supervisor.js';
import {
  buildCheckOutputData,
  buildInterruptedCheckInput,
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

/** The line that says every statement is done and the document is being built. */
const CHECKS_DONE: ProgressEntry = { kind: 'checks-complete' };

/** A watchdog that has seen nothing yet, at time zero. */
const FRESH: WatchdogState = { bytesSeen: 0, quietSince: 0 };

/** Whatever a supervising parent handed its child as `--cost-log`. */
const A_COST_LOG = 'progress.jsonl';
/** Node's own heap abort — the signal a runaway that SELECTS rows dies of. */
const ABORTED = 'SIGABRT';
/** A binary that is not there, for the spawn-failure cases. */
const MISSING_BIN = '/nope/vat';
const MISSING_BIN_DETAIL = `spawn ${MISSING_BIN} ENOENT`;
/** That binary's death, as the supervisor resolves it. */
const NOT_INSTALLED: AbnormalDeath = {
  kind: 'spawn-failed',
  binary: MISSING_BIN,
  detail: MISSING_BIN_DETAIL,
};
/**
 * A spawn that failed because the RUNNER had nothing left, not because anything
 * is misinstalled. `EAGAIN` is "no free process slot" and arrives on exactly the
 * saturated, memory-pressured machine this whole feature is about.
 */
const SATURATED_DETAIL = 'spawn EAGAIN';
/** What Node's `ChildProcess.kill()` reports when the kernel REFUSES the signal. */
const KILL_REFUSED = 'kill EPERM';
/** The child a refused kill leaves running, so the operator has a handle on it. */
const ORPHAN_PID = 4242;
/**
 * The sentence that admits to knowing nothing.
 *
 * 🪤 Its own words are why the SIGKILL guard was blind: it contains "outside",
 * so `/outside|OOM/i` matched the FALL-THROUGH and deleting the SIGKILL branch
 * left the assertion green. Every remedy case below therefore asserts this
 * phrase is ABSENT as well as asserting what is present.
 */
const NO_INFORMATION = 'The cause is outside anything this command can observe';

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
    expect(runsInThisProcess({ costLog: A_COST_LOG, budgetSecs: 300 })).toBe(true);
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

  it('NEVER breaches while units keep COMPLETING, however long the run takes', () => {
    // 🔑 The property that distinguishes this from a total stopwatch. Twenty
    // budgets' worth of wall time elapses; every poll sees a new line; nothing
    // is killed.
    //
    // ⚠️ The name used to say "a run that keeps making progress", which
    // overclaimed. This function is only ever as good as the lines it is fed,
    // and the POPULATION emits exactly one, at its end — so for that unit the
    // budget really is the total-runtime bound the design argues against. The
    // per-unit property is true of the CHECKS. See `check-supervisor.ts`'s
    // header for why instrumenting the population further would be worse than
    // saying so: ~88% of a cold one is a single blob stage that emits nothing.
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
  return buildInterruptedCheckInput({
    entries,
    root: '/corpus',
    ending: { kind: 'budget', budgetSecs: 2 },
    durationMs: 3400,
  });
}

/**
 * The recovered payload for a run whose child DIED — no watchdog involved.
 *
 * @param signal - What killed the child
 * @param entries - What the child's log held, defaulting to the hang above
 * @returns The input the document is built from
 */
function died(
  signal: string,
  entries: readonly ProgressEntry[] = [POPULATION, FIRST_COST, HUNG_START],
): CheckPayloadInput {
  return diedOf({ kind: 'signal', signal }, entries);
}

/**
 * The same, for a death that is not a signal at all.
 *
 * Separate from {@link died} rather than folded into it because three of the
 * four death kinds carry fields a signal name cannot express — and each of them
 * earns DIFFERENT advice, which is the whole reason `AbnormalDeath` is a union.
 *
 * @param death - How the child ended
 * @param entries - What the child's log held, defaulting to the hang above
 * @returns The input the document is built from
 */
function diedOf(
  death: AbnormalDeath,
  entries: readonly ProgressEntry[] = [POPULATION, FIRST_COST, HUNG_START],
): CheckPayloadInput {
  return buildInterruptedCheckInput({
    entries,
    root: '/corpus',
    ending: { kind: 'abnormal', death },
    durationMs: 3400,
  });
}

describe('buildInterruptedCheckInput', () => {
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
    // 🪤 `toContain('2')` was the assertion here, and it guarded nothing a digit
    // could not satisfy. The budget is asserted with the words around it.
    const [finding] = killed().issues;

    expect(finding?.message).toContain('runaway');
    expect(finding?.message).toContain('no progress for 2s');
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

  it('HEDGES that window, because a run that finished every rule also lands in it', () => {
    // 🚨 The hedge ("or after the last one") was deleted on the strength of
    // `checks-complete` — but the last check's cost is filed BEFORE its rows are
    // turned into issues, and `checks-complete` is written after that. A kill in
    // between leaves a log of nothing but completed checks, which reads as
    // `idle` — and the unhedged sentence then tells an operator whose run
    // completed forty rules that it died "between the population and the first
    // statement". The window is narrow, not absent, so the sentence must cover it.
    const [finding] = killed([POPULATION, FIRST_COST]).issues;

    expect(finding?.message).toContain('after the last one');
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
    // 🚨 This asserted `/2/`, and the sentence beside it says population is
    // "~1.2s warm here but 33-35s" — so deleting the interpolated budget left it
    // GREEN on the digit in an unrelated measurement. Assert the words.
    expect(() => killed([])).toThrow(/no progress for 2s/);
  });
});

describe('parseBudgetSeconds — the EMPTY value', () => {
  // 🚨 The defect: `Number('')` is 0, and 0 is this flag's documented escape
  // hatch — "no bound, may hang forever". So `--budget "$CHECK_BUDGET"` with the
  // variable unset did not shorten the bound and did not refuse; it silently
  // REMOVED the bound, on the one flag whose whole job is to stop an unattended
  // job hanging. An unset shell variable is a far more common CI accident than
  // the typo'd `2O` the guard was originally written for.
  it.each([
    ['the empty string', ''],
    ['a space', ' '],
    ['a newline', '\n'],
    ['a tab', '\t'],
  ])('refuses %s rather than reading it as --budget 0', (_label, raw) => {
    expect(() => parseBudgetSeconds(raw)).toThrow(/--budget/);
  });

  it('still accepts hex, deliberately', () => {
    // `Number('0x10')` is 16, and that is KEPT. Hex is unambiguous, it cannot
    // arise from an unset variable, and refusing it would buy nothing. Recorded
    // as a decision so the next reader does not "fix" it into a refusal.
    expect(parseBudgetSeconds('0x10')).toBe(16);
  });
});

describe('requireSupervisableFlags', () => {
  // 🚨 The defect: `--cost-log` wins the fork unconditionally, so
  // `--budget 60 --cost-log /tmp/x` ran UNBOUNDED and said nothing. An
  // explicitly-passed, documented flag must never be silently inert.
  it('refuses an explicit budget alongside --cost-log', () => {
    expect(() => requireSupervisableFlags({
      costLog: A_COST_LOG, budgetRaw: '60', budgetSecs: 60,
    })).toThrow(/--cost-log/);
  });

  it('allows --cost-log on its own — that is the child the parent spawns', () => {
    // ⚠️ The real spawn path. `childArgs` appends `--cost-log` and does NOT
    // forward `--budget`, so the supervised lane must survive this guard.
    expect(() => requireSupervisableFlags({
      costLog: A_COST_LOG, budgetRaw: undefined, budgetSecs: 300,
    })).not.toThrow();
  });

  it('allows --budget 0 with --cost-log: both say "no supervision"', () => {
    expect(() => requireSupervisableFlags({
      costLog: A_COST_LOG, budgetRaw: '0', budgetSecs: 0,
    })).not.toThrow();
  });

  it('allows a budget with no cost log — the ordinary supervised run', () => {
    expect(() => requireSupervisableFlags({
      costLog: undefined, budgetRaw: '60', budgetSecs: 60,
    })).not.toThrow();
  });
});

describe('resolveChildEnding', () => {
  it('reports a clean exit with the code the child chose', () => {
    expect(resolveChildEnding({ code: 1, signal: null, killed: false }))
      .toStrictEqual({ kind: 'completed', code: 1 });
  });

  it('reports the watchdog kill as KILLED', () => {
    expect(resolveChildEnding({ code: null, signal: 'SIGKILL', killed: true }))
      .toStrictEqual({ kind: 'killed' });
  });

  it('reports a signal death nobody asked for as ABNORMAL, naming the signal', () => {
    // 🚨 The critical defect this closes. `close` fires with `(code, signal)`,
    // and a process that dies from a signal has `code === null`. The handler
    // read only the code and coerced it with `?? 0`, so EVERY signal death
    // became `{ outcome: 'completed', code: 0 }` — an empty document and
    // `process.exit(0)`. A CI gate reads that as a clean pass.
    //
    // This is not hypothetical and needs no external actor: a check whose
    // statement materialises an unbounded result set makes Node abort on its
    // heap limit (SIGABRT), which is exactly the runaway shape the budget
    // exists to catch. Before the supervisor existed the same input exited 134.
    expect(resolveChildEnding({ code: null, signal: ABORTED, killed: false }))
      .toStrictEqual({ kind: 'abnormal', death: { kind: 'signal', signal: ABORTED } });
  });

  it('reports a missing exit code with no signal as abnormal too', () => {
    // Neither a code nor a signal is not a shape Node documents, and `?? 0` is
    // exactly the wrong reading of it: "I cannot tell how this ended" must not
    // become "it succeeded".
    expect(resolveChildEnding({ code: null, signal: null, killed: false }))
      .toStrictEqual({ kind: 'abnormal', death: { kind: 'no-status' } });
  });

  it('reports a child that could not be SPAWNED as abnormal, naming the binary', () => {
    // Without an `error` listener Node throws `Unhandled 'error' event` and dies
    // with a stack dump. It fails closed, so this is legibility — but a stack
    // dump is not a report.
    expect(resolveChildEnding({
      code: null,
      signal: null,
      killed: false,
      spawnError: { binary: MISSING_BIN, detail: MISSING_BIN_DETAIL },
    })).toStrictEqual({
      kind: 'abnormal',
      death: NOT_INSTALLED,
    });
  });

  it('honours a NORMAL exit that beat the watchdog\'s SIGKILL', () => {
    // 🪤 A narrow ordering race, and it fails CLOSED — but it discards a correct
    // answer. libuv runs timers BEFORE the poll phase that reaps the child, so
    // the watchdog can set `killed` in the same loop turn as a child that has
    // already exited 0. The kill only counts if it LANDED: a non-null code with
    // a null signal means the child finished on its own terms, whatever the
    // supervisor believes it did.
    expect(resolveChildEnding({ code: 0, signal: null, killed: true }))
      .toStrictEqual({ kind: 'completed', code: 0 });
  });
});

describe('the document a run that DIED publishes', () => {
  it('fails the run rather than publishing an empty pass', () => {
    // ⛔ The whole point of the critical fix: an abnormal death must reach the
    // same fail-closed document a watchdog kill does, never `exit(0)`.
    expect(buildCheckOutputData(died(ABORTED))['status']).toBe('error');
  });

  it('reports it under the non-overridable run-integrity code', () => {
    const [finding] = died(ABORTED).issues;

    expect(finding?.code).toBe('RESOURCE_CHECK_BROKEN');
    expect(finding?.severity).toBe('error');
  });

  it('names the SIGNAL and the check that was in flight', () => {
    const [finding] = died(ABORTED).issues;

    expect(finding?.message).toContain('SIGABRT');
    expect(finding?.message).toContain('runaway');
  });

  it('tells a SIGABRT reader to narrow the statement, not to raise the budget', () => {
    // 🔑 The two signals point at different remedies and a message that
    // conflated them would waste the reader's time. SIGABRT is Node's own heap
    // abort — the run materialised too many rows.
    const [finding] = died(ABORTED).issues;

    expect(finding?.message).toMatch(/heap|memory/i);
    expect(finding?.message).toMatch(/LIMIT|narrower/);
  });

  it('tells a SIGKILL reader an OOM KILLER or a container limit did it', () => {
    // An OOM killer on a memory-capped runner picks the big CHILD, not the idle
    // parent. Telling that operator to raise `--budget` makes it worse.
    //
    // 🚨 This asserted `/outside|OOM/i` and was a BLIND instrument: deleting the
    // whole SIGKILL branch falls through to "The cause is OUTSIDE anything this
    // command can observe", which matches. The single most operationally
    // valuable sentence the feature has was therefore unguarded. Assert the
    // phrase only this branch can produce, and assert the fall-through's phrase
    // is ABSENT.
    const [finding] = died('SIGKILL').issues;

    expect(finding?.message).toContain('OOM killer');
    expect(finding?.message).toMatch(/more memory/i);
    expect(finding?.message).not.toContain(NO_INFORMATION);
  });

  it('never tells an abnormal death to raise the budget', () => {
    // ⛔ The budget did not end this run, and the watchdog wording ("no progress
    // within the budget") would be a false diagnosis.
    for (const signal of [ABORTED, 'SIGKILL', 'SIGSEGV']) {
      expect(died(signal).issues[0]?.message).not.toMatch(/Raise it with `--budget/);
    }
  });

  it('still tells a WATCHDOG kill to raise the budget', () => {
    // The other half of the same distinction, pinned so the abnormal wording
    // cannot swallow the one case where raising the bound IS the remedy.
    //
    // 🪤 `/--budget/` alone was satisfied by the "`--budget 0` to remove it"
    // half of the same sentence, so half the advice could vanish unnoticed.
    expect(killed().issues[0]?.message).toMatch(/Raise it with `--budget/);
  });

  it('refuses a document when the child died before its population', () => {
    expect(() => died(ABORTED, [])).toThrow(/SIGABRT/);
  });

  it('does not blame the budget in that refusal either', () => {
    // 🪤 The name promises an ABSENCE and the assertion was a presence, so a
    // refusal that said both things would have passed. Both halves now.
    expect(() => died(ABORTED, [])).toThrow(/died|terminated/i);
    expect(() => died(ABORTED, [])).not.toThrow(/Raise it with `--budget/);
  });

  it('names the binary when the child could not be spawned at all', () => {
    const input = buildInterruptedCheckInput({
      entries: [POPULATION, FIRST_COST, HUNG_START],
      root: '/corpus',
      ending: {
        kind: 'abnormal',
        death: NOT_INSTALLED,
      },
      durationMs: 12,
    });

    expect(input.issues[0]?.message).toContain(MISSING_BIN);
  });
});

describe('unitInFlight — the reporting phase', () => {
  it('says the run was BUILDING ITS DOCUMENT once the checks are done', () => {
    // 🚨 The defect: after the last check files its cost the child still
    // resolves severities and serialises the document — a 5,000-issue document
    // is 639 KB of YAML — and it emitted NO progress line during that phase, so
    // exceeding the budget there SIGKILLed a run that already had its answer.
    // The child now files one line when the checks are done, which both gives
    // serialisation a fresh budget window and names the phase honestly.
    const entries: ProgressEntry[] = [POPULATION, FIRST_COST, CHECKS_DONE];

    expect(unitInFlight(entries)).toStrictEqual({ kind: 'reporting' });
  });

  it('still says idle between the population and the first statement', () => {
    // Different state, different sentence: nothing had started yet, as against
    // everything having finished.
    expect(unitInFlight([POPULATION])).toStrictEqual({ kind: 'idle' });
  });

  it('says the run was building its document in the finding it publishes', () => {
    // 🪤 The assertion was `/document/i` first, and it was a BLIND instrument:
    // every one of these messages already says "this document is not a verdict",
    // so collapsing `reporting` back into `idle` left it green. The phrase that
    // actually distinguishes the two phases is the one asserted on.
    const [finding] = killed([POPULATION, FIRST_COST, CHECKS_DONE]).issues;

    expect(finding?.message).toContain('after the last check had finished');
    expect(finding?.message).not.toContain('no check was running');
  });
});

describe('resolveChildEnding — a kill the kernel REFUSED', () => {
  // 🚨 The defect: `child.on('error')` is NOT only a spawn-failure listener.
  // Node emits `error` on the ChildProcess when `subprocess.kill()` itself
  // fails — the shipped function ends `else { /* Other error, almost certainly
  // EPERM. */ this.emit('error', new ErrnoException(err, 'kill')); }`. So a
  // watchdog breach whose SIGKILL was refused set `spawnError` and resolved,
  // the supervisor cleared its own timer, and the parent exited 1 reporting
  // that the child "could not be started at all" and that "the watchdog never
  // fired" — while the runaway it exists to bound was still executing.
  it('reports a refused kill as its OWN ending, never as a failed spawn', () => {
    expect(resolveChildEnding({
      code: null,
      signal: null,
      killed: true,
      killFailure: { detail: KILL_REFUSED, pid: ORPHAN_PID },
    })).toStrictEqual({
      kind: 'abnormal',
      death: { kind: 'kill-failed', detail: KILL_REFUSED, pid: ORPHAN_PID },
    });
  });

  it('consults what the WATCHDOG did before it consults a spawn error', () => {
    // Belt and braces on the ordering the defect turned on: `spawnError` was
    // tested first, so `killed` was never reached on that branch and a run whose
    // kill was refused claimed the watchdog had not fired. The combination
    // cannot arise now that the handler routes a post-kill error elsewhere —
    // which is exactly why the ordering needs a test rather than an argument.
    expect(resolveChildEnding({
      code: null,
      signal: null,
      killed: true,
      spawnError: { binary: MISSING_BIN, detail: MISSING_BIN_DETAIL },
    })).toStrictEqual({ kind: 'killed' });
  });

  it('still honours a child that exited normally while the kill was failing', () => {
    // The race {@link resolveChildEnding} already documents, now with a kill
    // failure in play: a real exit code with no signal is a real answer.
    expect(resolveChildEnding({
      code: 0,
      signal: null,
      killed: true,
      killFailure: { detail: KILL_REFUSED, pid: ORPHAN_PID },
    })).toStrictEqual({ kind: 'completed', code: 0 });
  });
});

describe('the document a run whose KILL was refused publishes', () => {
  /** The recovered payload for a breach whose SIGKILL the kernel refused. */
  const refused = (): CheckPayloadInput =>
    diedOf({ kind: 'kill-failed', detail: KILL_REFUSED, pid: ORPHAN_PID });

  it('says the kill was refused, and hands over the pid still running', () => {
    const [finding] = refused().issues;

    expect(finding?.message).toContain('refused');
    expect(finding?.message).toContain(String(ORPHAN_PID));
  });

  it('names the refusal in the WHERE clause too, not only in the remedy', () => {
    // 🪤 Found by mutation, and it is the same class as the SIGKILL defect one
    // function over: deleting `deathPhrase`'s kill-failed clause left the whole
    // suite GREEN, because the remedy beside it also says "refused" and also
    // carries the pid. Two sentences are composed here and each needs its own
    // guard. Without the clause the message falls back to the `no-status`
    // phrase, so that is the absence counterpart.
    const [finding] = refused().issues;

    expect(finding?.message).toContain('the budget was blown');
    expect(finding?.message).not.toContain('neither an exit code nor a signal');
  });

  it('never tells the operator the child could not be STARTED', () => {
    // It started, ran past the budget, and would not die. "Nothing ran at all"
    // is the opposite of the truth and sends them to check their PATH.
    const [finding] = refused().issues;

    expect(finding?.message).not.toContain('could not be started');
    expect(finding?.message).not.toContain('PATH');
  });

  it('never claims the watchdog did not fire — it fired and was rebuffed', () => {
    expect(refused().issues[0]?.message).not.toContain('watchdog never fired');
  });
});

describe('a spawn that failed — the RUNNER, or the installation', () => {
  /**
   * The recovered payload for a child that never started.
   *
   * @param detail - What `spawn` reported
   * @returns The input the document is built from
   */
  const spawnFailed = (detail: string): CheckPayloadInput =>
    diedOf({ kind: 'spawn-failed', binary: MISSING_BIN, detail });

  it('sends an out-of-resources spawn to the runner, not to PATH', () => {
    // 🚨 EAGAIN (no free process slot) and ENOMEM arrive on a saturated,
    // memory-pressured runner — which is precisely the environment this whole
    // feature is about. Telling that operator it is "an installation or PATH
    // problem" is a wrong diagnosis handed out at the worst moment.
    const [finding] = spawnFailed(SATURATED_DETAIL).issues;

    expect(finding?.message).toMatch(/EAGAIN/);
    expect(finding?.message).not.toContain('PATH');
  });

  it('still sends a binary that is not there to the installation', () => {
    expect(spawnFailed(MISSING_BIN_DETAIL).issues[0]?.message).toContain('PATH');
  });
});

describe('the remedy each ending earns', () => {
  // 🚨 The defect: `deathRemedy` partitioned on spawn-failed, SIGABRT and
  // SIGKILL and fell through to a sentence written for `no-status`. A real
  // `kill -TERM` therefore produced "terminated by SIGTERM … The cause is
  // outside anything this command can observe; the child left no exit code to
  // report" — it names the signal, then says it knows nothing about it. SIGTERM
  // is how CI kills a process: `timeout(1)`, job cancellation, container stop.
  it('tells a SIGTERM reader something ASKED the run to stop', () => {
    const [finding] = died('SIGTERM').issues;

    expect(finding?.message).toMatch(/timeout|cancel/i);
    expect(finding?.message).not.toContain(NO_INFORMATION);
  });

  it('tells a SIGSEGV reader the child CRASHED in native code', () => {
    const [finding] = died('SIGSEGV').issues;

    expect(finding?.message).toMatch(/crash/i);
    expect(finding?.message).not.toContain(NO_INFORMATION);
  });

  it('never claims to know nothing about a signal it has just NAMED', () => {
    // The fallback is allowed to have no specific advice. It is not allowed to
    // say the cause is unobservable in a sentence that names the cause.
    for (const signal of ['SIGHUP', 'SIGXCPU', 'SIGBUS', 'SIGPIPE']) {
      const [finding] = died(signal).issues;

      expect(finding?.message).toContain(signal);
      expect(finding?.message).not.toContain(NO_INFORMATION);
    }
  });

  it('keeps that sentence for the genuinely status-less ending', () => {
    // Where it is TRUE: neither a code nor a signal, so there is nothing to
    // name and nothing to advise.
    expect(diedOf({ kind: 'no-status' }).issues[0]?.message).toContain(NO_INFORMATION);
  });
});

describe('a budget kill during the REPORTING phase', () => {
  /** The recovered payload for a run killed after every check had finished. */
  const reporting = (): CheckPayloadInput =>
    killed([POPULATION, FIRST_COST, CHECKS_DONE]);

  // 🚨 The defect: creating the `reporting` state adapted the WHERE clause and
  // left the body, so a run whose ten checks all completed and whose enormous
  // document blew the budget was told "the checks after it never executed" and
  // "a statement that will not finish cannot be stopped from inside the process
  // — the query is synchronous and holds the event loop". There were no checks
  // after it and no statement was running. Measured: 2,000,000 issues take
  // ~17 s to serialise after `checks-complete`, so this is easy to reach.
  it('blames the DOCUMENT, not a statement that would not finish', () => {
    const [finding] = reporting().issues;

    expect(finding?.message).toMatch(/size of the document|too large/i);
    expect(finding?.message).not.toContain('holds the event loop');
  });

  it('never says the checks after it failed to run — there were none', () => {
    const [finding] = reporting().issues;

    expect(finding?.message).not.toContain('the checks after it never executed');
    expect(finding?.message).toContain('Every declared check had already finished');
  });

  it('still offers the budget, because raising it IS a remedy here', () => {
    expect(reporting().issues[0]?.message).toContain('--budget');
  });
});

describe('parseBudgetSeconds — a value that is ZERO without saying so', () => {
  // 🚨 The blank guard closed `Number('')`, but the hazard underneath it is
  // `Number(raw) === 0` for a raw string that is not a zero anybody typed on
  // purpose. `--budget 1e-400` underflows to 0 and `--budget -0` is negative
  // zero, which passes `seconds < 0`; both ran COMPLETELY UNBOUNDED, in
  // process, silently — on the one flag whose purpose is to stop a hang.
  it.each([
    ['an exponent that underflows', '1e-400'],
    ['negative zero', '-0'],
    ['a zero written another way', '0.0'],
    ['hexadecimal zero', '0x0'],
  ])('refuses %s rather than silently removing the bound', (_label, raw) => {
    expect(() => parseBudgetSeconds(raw)).toThrow(/--budget/);
  });

  it('accepts the zero the operator plainly meant, surrounding space and all', () => {
    // The escape hatch stays reachable — it just has to be written as `0`.
    expect(parseBudgetSeconds('0')).toBe(0);
    expect(parseBudgetSeconds(' 0 ')).toBe(0);
  });

  it('leaves non-zero hex working', () => {
    // The decision recorded above this file's hex case is unchanged: `0x10` is
    // 16 and stays 16. Only a value that MEANS zero without saying so is
    // refused.
    expect(parseBudgetSeconds('0x10')).toBe(16);
  });
});
