/**
 * `vat resources check`'s three pure pieces: the document it emits, the loop
 * that runs the declared checks, and the guard on `--check <name>`.
 *
 * Exported for this reason and no other — the command itself spawns a crawl,
 * opens a database and calls `process.exit`, so a system test can prove it runs
 * but is a poor place to pin field names, a loop's completeness, or the exact
 * wording an operator is shown. These take a fake `ask` and touch no disk.
 *
 * ## What the system suite could not see, and why these exist
 *
 * Every one of the six spawned cases declares ONE check (the `--check` case
 * declares two and filters to one, which is the same thing to the loop). So
 * `checksRun` was never observed above 1, and a `break` at the end of
 * `runChecks` would have left the whole suite green. The two-check cases below
 * are the mutation guard for that.
 *
 * ## Why a fake clock rather than a real one
 *
 * The per-rule costs are the point of the `checks` list, and a real clock can
 * only be asserted against loosely — `toBeGreaterThanOrEqual(0)` passes on a
 * timer that never started. {@link fakeClock} advances a known amount per
 * READING, so a duration is an exact value and "the population's cost leaked
 * into a rule's" is a red rather than a shrug.
 */

import { describe, expect, it, vi } from 'vitest';

import type { ProgressEntry } from '../../src/commands/resources/check-progress.js';
import {
  buildCheckOutputData,
  requireDeclaredCheck,
  runDeclaredChecks,
  type CheckCost,
  type CheckPayloadInput,
} from '../../src/commands/resources/check.js';
import type { AskProjection } from '../../src/utils/projection-query.js';

/** The two check keys the loop cases use, and the codes their findings carry. */
const FIRST = 'no-markdown';
const SECOND = 'no-orphans';
const FIRST_SQL = 'SELECT path FROM a';
const SECOND_SQL = 'SELECT path FROM b';
const FIRST_CODE = `CUSTOM:${FIRST}`;
const SECOND_CODE = `CUSTOM:${SECOND}`;

/** Two checks that both select a violating row, so the loop must complete. */
const TWO_VIOLATED = {
  [FIRST]: { description: 'No markdown allowed', sql: FIRST_SQL },
  [SECOND]: { description: 'No orphan skills', sql: SECOND_SQL },
} as const;

/** One check whose statement names a column the projection does not have. */
const BROKEN_CHECK = {
  broken: { description: 'names a dead column', sql: 'SELECT contentHash FROM blobs' },
} as const;

/**
 * A corpus that is not empty — the state every case here assumes unless it is
 * asserting something about emptiness.
 *
 * Named rather than repeated as a literal: `membersEnumerated` is now an input
 * to every call, and a bare number at each site reads as data the case cares
 * about when in almost all of them it is only "not zero".
 */
const POPULATED = 12;

/** An `ask` that answers every statement with one violating row. */
const ASK_ONE_ROW: AskProjection = (sql) => [{ path: 'docs/a.md', sql }];

/**
 * How many rows each declared statement selects: NON-ZERO, and different from
 * each other.
 *
 * 🚨 **Both of those properties are load-bearing, and their absence was a blind
 * spot.** Every case that reached a published `rows` used to answer with
 * `ASK_NO_ROWS` or a hand-built cost record, so every expected count was `0` —
 * and a reviewer who replaced the published value with the literal `0` got the
 * whole file green. Nothing proved the count came from the statement at all.
 * Unequal counts add the second half: a payload that paired each rule with
 * ANOTHER rule's count also has to red.
 */
const ROWS_BY_SQL: Readonly<Record<string, number>> = {
  [FIRST_SQL]: 3,
  [SECOND_SQL]: 7,
};

/**
 * An `ask` that answers each statement with its own row count from
 * {@link ROWS_BY_SQL}.
 *
 * Refuses a statement it was not told about rather than answering zero: a
 * silent `0` here would restore exactly the blindness this fake exists to close.
 *
 * @param sql - The statement the loop is running
 * @returns That statement's violating rows
 */
const ASK_DISTINCT_ROWS: AskProjection = (sql) => {
  const count = ROWS_BY_SQL[sql];
  if (count === undefined) throw new Error(`This fake declares no row count for: ${sql}`);
  return Array.from({ length: count }, (_unused, index) => ({ path: `docs/${index}.md` }));
};

/**
 * An `ask` that answers every statement with no rows — a clean pass over a
 * populated corpus, and also what an EMPTY corpus looks like to a check.
 *
 * 🪤 That the two are indistinguishable at this seam is the whole defect: the
 * size of the population has to be told, because no answer can reveal it.
 */
const ASK_NO_ROWS: AskProjection = () => [];

/** An `ask` that fails the way a renamed projection column fails. */
const ASK_BROKEN: AskProjection = () => {
  throw new Error('no such column: contentHash');
};

/**
 * A clock that advances a fixed amount on every READING.
 *
 * The loop reads it twice per check — once before the statement and once after
 * — so every check's measured duration is exactly `stepMs`, whatever order the
 * checks run in and however many precede it. That makes a duration assertable
 * as an equality rather than as a range, which is what lets the "the population
 * was charged to a rule" mutation go red.
 *
 * @param stepMs - How far the clock moves per reading
 * @returns The clock
 */
function fakeClock(stepMs: number): () => number {
  let reading = 0;
  return () => {
    const at = reading;
    reading += stepMs;
    return at;
  };
}

/**
 * The smallest array length this runtime REFUSES to spread into an argument
 * list, found by doubling.
 *
 * 🪤 **Measured, never hardcoded, because the limit is not a constant.** It is
 * whatever fits in the REMAINING stack, so it moves with the stack the code is
 * running on: a plain `node -e` on the main thread throws at about 125,000,
 * while this unit suite runs in a worker thread with a larger stack and does not
 * throw until 800,000. A literal picked from the first of those numbers is a
 * test that passes on the BROKEN code here — which is how this guard was nearly
 * written, and exactly the vacuous-guard class the defect it covers belongs to.
 *
 * Returning the first FAILING length rather than the last passing one is what
 * makes the case above red on a spread: the real call sits a few frames deeper
 * than this probe, so it has less stack, not more.
 *
 * @returns A length this runtime cannot spread
 * @throws When no length up to 16M fails, which would mean the case above is
 *   asserting nothing and must be rethought rather than quietly skipped
 */
function firstUnspreadableLength(): number {
  for (let length = 100_000; length <= 16_000_000; length *= 2) {
    const sink: number[] = [];
    try {
      sink.push(...Array.from<number>({ length }));
    } catch {
      return length;
    }
    // Read, so the probe is a real spread of a real array and not something a
    // compiler or a linter is free to treat as dead.
    if (sink.length !== length) throw new Error('The probe did not spread what it built.');
  }

  throw new Error(
    'No array length up to 16,000,000 exceeded this runtime\'s argument limit, so the'
    + ' huge-result-set case cannot distinguish a spread from an append. Rewrite it'
    + ' rather than deleting it.',
  );
}

/**
 * `count` cost records, for a payload case whose subject is the DENOMINATOR
 * rather than any one rule's price.
 *
 * @param count - How many checks the run should look like it executed
 * @returns One trivial record each
 */
function costsOf(count: number): CheckCost[] {
  return Array.from({ length: count }, (_unused, index) => ({
    name: `check-${index}`,
    durationMs: 1,
    // 🪤 Not `rows: 0`. These records exist for the DENOMINATOR cases, which do
    // not read the count — and a file in which every expected count is zero is
    // a file that cannot tell a published count from a hardcoded one.
    rows: index + 1,
  }));
}

/** Findings, minus the provenance the payload builder also wants. */
function payloadInput(overrides: Partial<CheckPayloadInput> = {}): CheckPayloadInput {
  return {
    issues: [],
    costs: [],
    population: 'derived',
    // Non-zero, for the same reason `membersEnumerated` is: a case that sets it
    // to something else is visibly asserting about the population's cost rather
    // than inheriting a placeholder.
    populationMs: 40,
    // A NON-ZERO default on purpose: every case that does not care about the
    // corpus is a case that ran over one, so a case that sets this to 0 is
    // visibly asserting something about emptiness rather than inheriting it.
    membersEnumerated: 12,
    root: '/corpus',
    durationMs: 5,
    ...overrides,
  };
}

/**
 * Run the loop with a fake clock, on the checks and answers a case cares about.
 *
 * Every cost case needs the same four uninteresting arguments; naming them once
 * keeps what each case is actually varying visible, and keeps the file under the
 * duplication gate.
 *
 * @param options - The run
 * @param options.checks - The declared checks
 * @param options.ask - How the projection answers
 * @param options.only - A `--check` filter, or undefined for all
 * @param options.stepMs - How far the fake clock moves per reading
 * @returns Whatever the loop returned
 */
function runWithClock(options: {
  checks: Parameters<typeof runDeclaredChecks>[0]['checks'];
  ask: AskProjection;
  only?: string;
  stepMs?: number;
}): ReturnType<typeof runDeclaredChecks> {
  return runDeclaredChecks({
    checks: options.checks,
    only: options.only,
    ask: options.ask,
    validation: undefined,
    membersEnumerated: POPULATED,
    now: fakeClock(options.stepMs ?? 1),
  });
}

/** One entry of the document's `checks` list, as a reader sees it. */
type PublishedCheck = { name: string; durationSecs: number; rows?: number; broken?: true };

/**
 * The `checks` list of the document built from a real run of the loop.
 *
 * Deliberately goes loop → payload rather than hand-feeding cost records: the
 * two numbers that must agree (`checksRun` and the length of this list) can only
 * be shown to agree on output the loop actually produced.
 *
 * @param options - Passed through to {@link runWithClock}
 * @returns The document, and its `checks` list already narrowed
 */
function documentFor(options: Parameters<typeof runWithClock>[0]): {
  payload: Record<string, unknown>;
  checks: PublishedCheck[];
} {
  const { issues, costs } = runWithClock(options);
  const payload = buildCheckOutputData(payloadInput({ issues, costs }));
  return { payload, checks: payload['checks'] as PublishedCheck[] };
}

describe('runDeclaredChecks — the loop', () => {
  it('runs EVERY declared check, not just the first', () => {
    // 🔑 The `break` mutation guard. Insert `break` at the end of the loop in
    // `runChecks` and this is the test that reds: one cost record survives and
    // `no-orphans` vanishes. Nothing in the spawned system suite could tell,
    // because no spawned case ever ran two checks.
    const { issues, costs } = runDeclaredChecks({
      checks: TWO_VIOLATED,
      only: undefined,
      ask: ASK_ONE_ROW,
      validation: undefined,
      membersEnumerated: POPULATED,
    });

    expect(costs).toHaveLength(2);
    expect(issues.map((i) => i.code)).toStrictEqual([FIRST_CODE, SECOND_CODE]);
  });

  it('asks the projection once per check, with that check\'s own statement', () => {
    // The denominator's other half: two cost records from a loop that ran one
    // statement twice would be a lie the count could not expose.
    const ask = vi.fn<AskProjection>(() => []);

    const { costs } = runDeclaredChecks({
      checks: TWO_VIOLATED, only: undefined, ask, validation: undefined,
      membersEnumerated: POPULATED,
    });

    expect(costs).toHaveLength(2);
    expect(ask.mock.calls.map(([sql]) => sql)).toStrictEqual([FIRST_SQL, SECOND_SQL]);
  });

  it('runs only the named check under `only`, and counts only that one', () => {
    const { issues, costs } = runDeclaredChecks({
      checks: TWO_VIOLATED, only: SECOND, ask: ASK_ONE_ROW, validation: undefined,
      membersEnumerated: POPULATED,
    });

    expect(costs).toHaveLength(1);
    expect(issues.map((i) => i.code)).toStrictEqual([SECOND_CODE]);
  });

  it('reports a broken check as a finding, never as a skip', () => {
    const { issues, costs } = runDeclaredChecks({
      checks: BROKEN_CHECK,
      only: undefined,
      ask: ASK_BROKEN,
      validation: undefined,
      membersEnumerated: POPULATED,
    });

    // It RAN — the count must not pretend otherwise — and it produced an error.
    expect(costs).toHaveLength(1);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('error');
    // Names WHICH check, and WHY, or the operator has a red build and no lead.
    expect(issues[0]?.message).toContain('broken');
    expect(issues[0]?.message).toContain('no such column: contentHash');
  });

  it('keeps going after a broken check, so one bad statement cannot hide the rest', () => {
    let calls = 0;
    const ask: AskProjection = (sql) => {
      calls += 1;
      if (calls === 1) throw new Error('no such table: a');
      return [{ path: 'docs/b.md', sql }];
    };

    const { issues, costs } = runDeclaredChecks({
      checks: TWO_VIOLATED, only: undefined, ask, validation: undefined,
      membersEnumerated: POPULATED,
    });

    expect(costs).toHaveLength(2);
    expect(issues.map((i) => i.code)).toStrictEqual(['RESOURCE_CHECK_BROKEN', SECOND_CODE]);
  });
});

/**
 * The per-rule price, which is the whole reason a cost record exists.
 *
 * A SQL surface is an unbounded cost: a project can declare a rule that scans
 * every row of every table, and until this list shipped the document said only
 * how long the WHOLE run took. "Which rule is expensive" was unanswerable
 * without editing the config and re-running, one check at a time.
 */
describe('runDeclaredChecks — what each rule cost', () => {
  it('measures each statement on the injected clock, exactly', () => {
    // 🔑 Exact, not a range. Swap `performance.now()` for a constant, drop the
    // second reading, or measure the wrong span and this reds — where
    // `toBeGreaterThanOrEqual(0)` would pass on a timer that never started.
    const { costs } = runWithClock({ checks: TWO_VIOLATED, ask: ASK_ONE_ROW, stepMs: 7 });

    expect(costs.map((cost) => cost.name)).toStrictEqual([FIRST, SECOND]);
    // Two readings per check, `stepMs` apart, so BOTH are 7 — a second check
    // whose duration came out 21 would mean the span started at the run.
    expect(costs.map((cost) => cost.durationMs)).toStrictEqual([7, 7]);
  });

  it('counts the rows EACH statement selected, and 0 is a count', () => {
    // 🔑 Two checks whose statements return different, non-zero counts, so this
    // reds on a hardcoded count AND on a count paired with the wrong rule —
    // neither of which the all-zero cases this replaced could see.
    const { costs } = runWithClock({ checks: TWO_VIOLATED, ask: ASK_DISTINCT_ROWS });

    expect(costs.map((cost) => [cost.name, cost.rows]))
      .toStrictEqual([[FIRST, ROWS_BY_SQL[FIRST_SQL]], [SECOND, ROWS_BY_SQL[SECOND_SQL]]]);
    // A rule that selected nothing still has a price and still ran. `rows: 0`
    // says "asked, found nothing"; an absent key would say "did not complete",
    // which is a different and much worse fact.
    expect(runWithClock({ checks: BROKEN_CHECK, ask: ASK_NO_ROWS }).costs[0]?.rows).toBe(0);
  });

  it('turns a huge result set into findings, never into a "could not run" report', () => {
    // 🔑 Reachable, not theoretical. The loop used to do `issues.push(...rows)`,
    // which spreads an array into an ARGUMENT LIST and throws `RangeError:
    // Maximum call stack size exceeded` once the array is long enough. That
    // throw landed in the `catch` written for a statement that would not
    // COMPILE, so a rule that ran perfectly and selected a lot of rows was
    // reported as `broken: true` — "could not run, so it is asserting nothing" —
    // which is false, and sends the operator to read the SQL instead of the
    // corpus. The sizes are not hypothetical: VAT's own `blob_references` table
    // holds 29,645 rows today, and `SELECT * FROM blob_references` on a repo a
    // few times this one's size crosses the limit on the main thread.
    const rowCount = firstUnspreadableLength();
    // Every row is the SAME object, so a million of them cost one allocation:
    // nothing here reads a row twice or mutates one, and the subject is the
    // COUNT.
    const row = { path: 'docs/a.md' };
    const askHuge: AskProjection = () => Array.from({ length: rowCount }, () => row);

    const { issues, costs } = runWithClock({ checks: BROKEN_CHECK, ask: askHuge });

    // A real price and a real row count — NOT `broken`, and not an absent count.
    expect(costs).toStrictEqual([{ name: 'broken', durationMs: 1, rows: rowCount }]);
    expect(issues).toHaveLength(rowCount);
    expect(issues.filter((issue) => issue.code === 'RESOURCE_CHECK_BROKEN')).toStrictEqual([]);
  });

  it('marks a check that threw as broken, with NO row count at all', () => {
    // 🪤 `rows: 0` on a statement that never returned would read as a clean
    // pass. The key is absent, and `broken` is what is there instead.
    const { issues, costs } = runWithClock({ checks: BROKEN_CHECK, ask: ASK_BROKEN, stepMs: 3 });

    expect(costs).toStrictEqual([{ name: 'broken', durationMs: 3, broken: true }]);
    expect(Object.hasOwn(costs[0] ?? {}, 'rows')).toBe(false);
    // The finding is unchanged — the cost record is an addition, not a swap.
    expect(issues.map((issue) => issue.code)).toStrictEqual(['RESOURCE_CHECK_BROKEN']);
  });

  it('records one entry per check that RAN, so a --check filter shrinks the list', () => {
    expect(runWithClock({ checks: TWO_VIOLATED, ask: ASK_ONE_ROW, only: SECOND }).costs)
      .toStrictEqual([{ name: SECOND, durationMs: 1, rows: 1 }]);
    expect(runWithClock({ checks: {}, ask: ASK_NO_ROWS }).costs).toStrictEqual([]);
  });
});

/**
 * The property the whole verb rests on, and the one that fixing the config
 * schema put at risk.
 *
 * A check's severity override is about how bad a VIOLATION is. It says nothing
 * about how bad it is that the check cannot run — and while both wore the code
 * `CUSTOM:<name>`, one config line answered both questions.
 */
describe('a check severity override does not silence a BROKEN check', () => {
  it('still reports the breakage at error when the check is set to ignore', () => {
    // 🔑 Revert the separate code (put `customCheckCode(name)` back on the
    // broken finding) and this reds: `resolveIssueSeverity` drops it and the
    // command exits 0 over a check that asserted nothing.
    const { issues, costs } = runDeclaredChecks({
      checks: BROKEN_CHECK,
      only: undefined,
      ask: ASK_BROKEN,
      validation: { severity: { 'CUSTOM:broken': 'ignore' } },
      membersEnumerated: POPULATED,
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('RESOURCE_CHECK_BROKEN');
    expect(issues[0]?.severity).toBe('error');
    // And the document derived from it fails the run.
    expect(buildCheckOutputData(payloadInput({ issues, costs }))['status']).toBe('error');
  });

  it('still reports it at error when the check is merely DEMOTED to warning', () => {
    // The quieter half of the same defect. `warning` does not drop the finding,
    // it drops it below the exit threshold — so the gate returns 0 and the
    // document says `status: warning` over a check that ran nothing.
    const { issues, costs } = runDeclaredChecks({
      checks: BROKEN_CHECK,
      only: undefined,
      ask: ASK_BROKEN,
      validation: { severity: { 'CUSTOM:broken': 'warning' } },
      membersEnumerated: POPULATED,
    });

    expect(issues[0]?.severity).toBe('error');
    expect(buildCheckOutputData(payloadInput({ issues, costs }))['status']).toBe('error');
  });

  it('still applies the override to the check\'s own VIOLATIONS', () => {
    // The other direction, or the guard above would be satisfied by a fix that
    // simply stopped honouring overrides — which is a documented feature.
    const { issues } = runDeclaredChecks({
      checks: { soft: { description: 'prefer no markdown', sql: 'SELECT path FROM a' } },
      only: undefined,
      ask: ASK_ONE_ROW,
      validation: { severity: { 'CUSTOM:soft': 'ignore' } },
      membersEnumerated: POPULATED,
    });

    expect(issues).toStrictEqual([]);
  });
});

describe('requireDeclaredCheck — an unknown --check name', () => {
  it('throws, rather than filtering everything out and reporting success', () => {
    // 🔑 `vat resources check --check orphan-skills` is the example in our own
    // help text. Rename or delete that check and the old code filtered every
    // declared check away, ran nothing, and exited 0 with `issues: []` — a CI
    // step that passes forever while asserting nothing.
    expect(() => requireDeclaredCheck(TWO_VIOLATED, 'orphan-skills')).toThrow(/orphan-skills/);
  });

  it('names the checks that ARE declared, so the operator sees the typo', () => {
    // A refusal that does not name the valid set makes the operator go read the
    // config to find out what they meant to type.
    let message = '';
    try {
      requireDeclaredCheck(TWO_VIOLATED, 'no-markdow');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('no-markdow');
    expect(message).toContain(FIRST);
    expect(message).toContain(SECOND);
  });

  it('says the project declares none, when it declares none', () => {
    // Otherwise the refusal reads "did you mean: (nothing)" and the operator
    // hunts a typo that is not there.
    expect(() => requireDeclaredCheck({}, 'anything')).toThrow(/resources\.checks/);
  });

  it('permits a declared name, and permits no --check at all', () => {
    expect(() => requireDeclaredCheck(TWO_VIOLATED, SECOND)).not.toThrow();
    expect(() => requireDeclaredCheck(TWO_VIOLATED, undefined)).not.toThrow();
  });

  it('does not treat an inherited Object property as a declared check', () => {
    // 🪤 `only in checks` would accept `--check toString` and run nothing, which
    // is exactly the silent green this guard exists to close.
    expect(() => requireDeclaredCheck(TWO_VIOLATED, 'toString')).toThrow(/toString/);
    expect(() => requireDeclaredCheck(TWO_VIOLATED, '__proto__')).toThrow();
  });
});

describe('the check payload', () => {
  it('publishes checksRun as the denominator, above one', () => {
    // The field the docstring calls load-bearing, at a value the system suite
    // never produced. Zero findings from two checks and zero findings from NO
    // checks are the same document without it.
    const ran = buildCheckOutputData(payloadInput({ costs: costsOf(2) }));
    const none = buildCheckOutputData(payloadInput({ costs: [] }));

    expect(ran['checksRun']).toBe(2);
    expect(none['checksRun']).toBe(0);
    expect(ran['status']).toBe('success');
    // Two documents that differ ONLY in the denominator. Drop the field and
    // these become equal, which is the ambiguity it exists to remove.
    expect(ran).not.toStrictEqual(none);
  });

  it('reports where the population came from, which is the only cache tell', () => {
    expect(buildCheckOutputData(payloadInput({ population: 'store' }))['population'])
      .toBe('store');
    expect(buildCheckOutputData(payloadInput({ population: 'derived' }))['population'])
      .toBe('derived');
  });

  it('renders each finding as code, severity, message and an optional path', () => {
    const payload = buildCheckOutputData(payloadInput({
      costs: costsOf(1),
      issues: [
        { code: 'CUSTOM:a', severity: 'error', message: 'bad', location: 'docs/a.md' },
        { code: 'CUSTOM:b', severity: 'warning', message: 'meh' },
      ],
    }));

    expect(payload['issues']).toStrictEqual([
      { code: 'CUSTOM:a', severity: 'error', message: 'bad', path: 'docs/a.md' },
      // 🪤 The key is ABSENT, not `path: undefined`. An aggregate check has no
      // file to name, and a `path: null` in YAML would read as one it could not
      // resolve.
      { code: 'CUSTOM:b', severity: 'warning', message: 'meh' },
    ]);
    expect(payload['status']).toBe('error');
    expect(payload['issueCounts']).toStrictEqual({ errors: 1, warnings: 1, info: 0 });
  });

  it('leaves an already-relative location alone', () => {
    // 🪤 Every other payload builder re-bases its paths; this one must not.
    // These arrive project-relative from a projection column, and resolving them
    // against the root again would silently corrupt them.
    const payload = buildCheckOutputData(payloadInput({
      root: '/corpus',
      costs: costsOf(1),
      issues: [{ code: 'CUSTOM:a', severity: 'error', message: 'bad', location: 'docs/a.md' }],
    }));

    const [issue] = payload['issues'] as { path?: string }[];
    expect(issue?.path).toBe('docs/a.md');
  });

  it('reports success with a formatted duration when nothing was found', () => {
    const payload = buildCheckOutputData(payloadInput({ costs: costsOf(3), durationMs: 1500 }));

    expect(payload['status']).toBe('success');
    expect(payload['root']).toBe('/corpus');
    expect(payload['issueCounts']).toStrictEqual({ errors: 0, warnings: 0, info: 0 });
    expect(payload['durationSecs']).toBeDefined();
  });
});

/**
 * Publishing what the run SPENT, and on which rule.
 *
 * Jeff's framing: a SQL surface is an unbounded cost black box, and you cannot
 * bound what you cannot attribute. `durationSecs` alone attributes nothing — a
 * ten-second run is a slow rule, a slow population, or twenty cheap rules, and
 * the document could not tell them apart.
 */
describe('the check payload publishes what each rule cost', () => {
  it('lists one entry per check, with its own name, duration and row count', () => {
    const { checks } = documentFor({
      checks: TWO_VIOLATED, ask: ASK_DISTINCT_ROWS, stepMs: 400,
    });

    // 🔑 The counts are the statements' OWN, and they differ. Publish a literal
    // `rows: 0` and this reds; publish each rule beside another rule's count and
    // it reds too. Both mutations used to leave the whole file green, because
    // every case that reached this field expected the same value: zero.
    // 3 significant figures, so a sub-millisecond rule does NOT round to zero.
    expect(checks).toStrictEqual([
      { name: FIRST, durationSecs: 0.4, rows: ROWS_BY_SQL[FIRST_SQL] },
      { name: SECOND, durationSecs: 0.4, rows: ROWS_BY_SQL[SECOND_SQL] },
    ]);
  });

  it('keeps a sub-millisecond rule visible rather than rounding it to zero', () => {
    // 🔑 The reason this is not `Date.now()`. Rules here are routinely faster
    // than a millisecond; a 1 ms-granularity clock reports every one of them as
    // 0 and the whole attribution says nothing.
    const { checks } = documentFor({ checks: BROKEN_CHECK, ask: ASK_NO_ROWS, stepMs: 0.4 });

    expect(checks[0]?.durationSecs).toBe(0.0004);
  });

  it('publishes broken instead of rows for a check that threw', () => {
    const { checks, payload } = documentFor({ checks: BROKEN_CHECK, ask: ASK_BROKEN, stepMs: 2 });

    expect(checks).toStrictEqual([{ name: 'broken', durationSecs: 0.002, broken: true }]);
    // The run still fails on the finding, which the cost record does not replace.
    expect(payload['status']).toBe('error');
  });

  it('derives checksRun from the very list it publishes, so the two cannot drift', () => {
    // 🔑 Two numbers that must agree are a drift bug waiting to happen. Give
    // `checksRun` a second source — carry it alongside the costs again — and
    // this is the guard that reds when they disagree.
    for (const only of [undefined, SECOND]) {
      const { payload, checks } = documentFor({
        checks: TWO_VIOLATED, ask: ASK_NO_ROWS, ...(only === undefined ? {} : { only }),
      });

      expect(payload['checksRun']).toBe(checks.length);
      expect(checks.map((check) => check.name))
        .toStrictEqual(only === undefined ? [FIRST, SECOND] : [SECOND]);
    }
  });

  it('publishes an empty list and a zero denominator when nothing ran', () => {
    const { payload, checks } = documentFor({ checks: {}, ask: ASK_NO_ROWS });

    expect(checks).toStrictEqual([]);
    expect(payload['checksRun']).toBe(0);
  });

  it('charges the shared population to NOBODY, and publishes it beside them', () => {
    // 🚨 The measurement trap this whole block turns on. The git tracker, the
    // projection build and the load happen ONCE for all N checks. Fold that into
    // each rule's duration and every rule looks expensive and they sum to N×
    // the truth — the same class as the pooled arm this repo reported backwards
    // because its estimate was thread-summed.
    const { issues, costs } = runWithClock({
      checks: TWO_VIOLATED, ask: ASK_NO_ROWS, stepMs: 5,
    });
    const payload = buildCheckOutputData(payloadInput({ issues, costs, populationMs: 1230 }));

    expect(payload['populationSecs']).toBe(1.23);
    // Untouched by the population, and not summed with it.
    expect((payload['checks'] as PublishedCheck[]).map((check) => check.durationSecs))
      .toStrictEqual([0.005, 0.005]);
  });

  it('places each cost beside what it explains', () => {
    // Field order is the whole readability argument: origin then its price,
    // total then its breakdown. A reader who has to scroll to pair them will
    // not pair them.
    const keys = Object.keys(buildCheckOutputData(payloadInput({ costs: costsOf(1) })));

    expect(keys.indexOf('populationSecs')).toBe(keys.indexOf('population') + 1);
    expect(keys.indexOf('checks')).toBe(keys.indexOf('durationSecs') + 1);
    expect(keys.indexOf('checks')).toBeLessThan(keys.indexOf('issues'));
  });
});

/**
 * The defect this block exists for, reproduced before it was written.
 *
 * A scratch repository whose `.gitignore` was `*`, with two declared checks,
 * produced `checksRun: 2`, `status: success`, exit 0 and empty stderr **over a
 * corpus of zero files.** The rule reported nothing because there was nothing to
 * report on, and no field in the document said so: `checksRun` is the
 * denominator of RULES, never of ROWS, so "4 checks passed over 8,000 files" and
 * "4 checks passed over 0 files" were byte-identical documents.
 *
 * Anything that empties the enumeration turned the whole gate green — a broad
 * `.gitignore`, a shallow or sparse CI checkout, a root that resolved somewhere
 * else, an extent source that enumerated nothing.
 *
 * The precedent is one layer up: `population-wiring.ts` makes `onBlobPopulation`
 * mandatory because "a tree whose every document was declined as binary
 * otherwise populates as empty and reports success". That guard covers blob
 * refusals only, and never an empty EXTENT.
 */
describe('a corpus of zero members is a failure, not a pass', () => {
  it('fails the run when checks ran over an empty population', () => {
    // 🔑 The reproduced case. Delete the guard and this reds: `issues` is empty,
    // `status` is `success`, and the command exits 0 having asserted nothing.
    const { issues, costs } = runDeclaredChecks({
      checks: TWO_VIOLATED,
      only: undefined,
      ask: ASK_NO_ROWS,
      validation: undefined,
      membersEnumerated: 0,
    });

    // The checks DID run — the count must not pretend otherwise. They just had
    // nothing to run over, which is the whole finding.
    expect(costs).toHaveLength(2);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('error');
    expect(buildCheckOutputData(payloadInput({ issues, costs, membersEnumerated: 0 }))['status'])
      .toBe('error');
  });

  it('carries the non-overridable run-integrity code, not a check\'s own code', () => {
    // Same reasoning as a broken statement, and the same code: `CUSTOM:<name>`
    // would let `severity: { 'CUSTOM:foo': 'ignore' }` silence "the gate ran
    // over nothing", and `RESOURCE_CHECK_BROKEN` is refused as a severity key by
    // `ValidationConfigSchema` precisely so no config line can reach it.
    const { issues } = runDeclaredChecks({
      checks: TWO_VIOLATED,
      only: undefined,
      ask: ASK_NO_ROWS,
      validation: { severity: { [FIRST_CODE]: 'ignore', [SECOND_CODE]: 'ignore' } },
      membersEnumerated: 0,
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('RESOURCE_CHECK_BROKEN');
    expect(issues[0]?.severity).toBe('error');
  });

  it('tells the operator WHAT happened and WHERE to look', () => {
    // "empty population" is not actionable. The count, the consequence, and the
    // three things that actually empty an enumeration are.
    const { issues } = runDeclaredChecks({
      checks: TWO_VIOLATED, only: undefined, ask: ASK_NO_ROWS, validation: undefined,
      membersEnumerated: 0,
    });
    const [message = ''] = issues.map((issue) => issue.message);

    expect(message).toContain('0 members');
    expect(message).toContain('.gitignore');
    // Names the count of checks that consequently asserted nothing, so the
    // operator can see the blast radius without re-reading the config.
    expect(message).toContain('2');
  });

  it('stays silent over a populated corpus, however few findings it produced', () => {
    // 🔑 The over-correction guard. Make the condition fire on a non-empty
    // corpus — drop the `> 0` test, compare the wrong number — and this reds:
    // an ordinary clean run starts reporting an error.
    const { issues, costs } = runDeclaredChecks({
      checks: TWO_VIOLATED, only: undefined, ask: ASK_NO_ROWS, validation: undefined,
      membersEnumerated: 1,
    });

    expect(costs).toHaveLength(2);
    expect(issues).toStrictEqual([]);
    expect(buildCheckOutputData(payloadInput({ issues, costs, membersEnumerated: 1 }))['status'])
      .toBe('success');
  });

  it('does not double-report when the project declares no checks at all', () => {
    // 🪤 A DIFFERENT condition, already handled by a loud stderr warning and a
    // deliberate exit 0 — declaring no checks is legitimate. A run with neither
    // checks nor corpus must not turn that legitimate state into an error, or
    // the operator gets two reports about one situation and the wrong verdict.
    const { issues, costs } = runDeclaredChecks({
      checks: {}, only: undefined, ask: ASK_NO_ROWS, validation: undefined,
      membersEnumerated: 0,
    });

    expect(costs).toStrictEqual([]);
    expect(issues).toStrictEqual([]);
  });

  it('reports the empty corpus BEFORE the checks\' own findings', () => {
    // A check can still yield rows over an empty extent — an aggregate
    // (`SELECT COUNT(*) … HAVING …`) selects a row whatever the corpus is, which
    // is exactly what the reproduced repository declared. The run-integrity
    // report is the headline; the derived findings are noise until it is fixed.
    const { issues } = runDeclaredChecks({
      checks: TWO_VIOLATED, only: undefined, ask: ASK_ONE_ROW, validation: undefined,
      membersEnumerated: 0,
    });

    expect(issues.map((issue) => issue.code))
      .toStrictEqual(['RESOURCE_CHECK_BROKEN', FIRST_CODE, SECOND_CODE]);
  });
});

describe('the check payload publishes the corpus it ran over', () => {
  it('publishes membersEnumerated, so "passed over nothing" is falsifiable', () => {
    // 🔑 The cache tell's discipline applied to the corpus. `population:
    // derived|store` exists because a store hit cannot be inferred from the
    // rows; `membersEnumerated` exists because a gate that ran over nothing
    // cannot be told from one that ran over the repository.
    const over = buildCheckOutputData(payloadInput({
      costs: costsOf(2), membersEnumerated: 8000,
    }));
    const none = buildCheckOutputData(payloadInput({ costs: costsOf(2), membersEnumerated: 0 }));

    expect(over['membersEnumerated']).toBe(8000);
    expect(none['membersEnumerated']).toBe(0);
    // Two documents that differ ONLY in the corpus size. Drop the field and
    // these become equal, which is precisely the ambiguity that shipped.
    expect(over).not.toStrictEqual(none);
  });
});

/**
 * The statement itself, recorded on the SAME timeline as the progress entries.
 *
 * 🚨 **Without this the ordering guard is vacuous, and that was measured.**
 * Moving the `start` emit to AFTER `ask` returns left the whole file green,
 * because a fake `ask` that emits nothing produces the identical
 * `[start, check]` sequence either way. The interleaved marker is what makes
 * "announced BEFORE the statement" a property of the timeline rather than of
 * two adjacent lines. The real `ask` this stands in for never returns at all,
 * which is the case the whole design exists for.
 */
type Timeline = (ProgressEntry | { kind: 'asked'; sql: string })[];

/**
 * Run the loop with a sink and an `ask` that both write to one timeline.
 *
 * @param options - The run
 * @param options.checks - The declared checks
 * @param options.ask - How the projection answers
 * @returns Everything that happened, in the order it happened
 */
function progressOf(options: {
  checks: Parameters<typeof runDeclaredChecks>[0]['checks'];
  ask: AskProjection;
}): Timeline {
  const seen: Timeline = [];
  runDeclaredChecks({
    checks: options.checks,
    only: undefined,
    ask: (sql, ...parameters) => {
      seen.push({ kind: 'asked', sql });
      return options.ask(sql, ...parameters);
    },
    validation: undefined,
    membersEnumerated: POPULATED,
    now: fakeClock(1),
    onProgress: (entry) => seen.push(entry),
  });
  return seen;
}

/**
 * The progress the loop reports as it goes, so a run that never returns can
 * still be reported ON.
 *
 * ## Why the loop has to emit at all
 *
 * `vat resources check` runs adopter-authored SQL as an unattended CI gate. An
 * accidental cross join or a `WITH RECURSIVE` with no termination runs forever,
 * and nothing in-process can stop it: the query is synchronous, it blocks the
 * event loop, and `node:sqlite` exposes no interrupt. The only lever is an
 * external `SIGKILL`, and a killed process publishes nothing — so whatever the
 * operator is going to learn has to have been written down BEFORE the statement
 * that hangs was entered.
 *
 * That is what `start` is for, and why its ORDER is the property under test: a
 * `start` filed after the statement returned would be filed by every check
 * except the one that matters.
 */
describe('runDeclaredChecks — progress emitted for an outside observer', () => {
  it('announces each check BEFORE its statement runs, and prices it after', () => {
    // 🔑 The ordering is the whole guard. Move the `start` emit below the
    // statement and the log of a killed run names every check except the one
    // that hung — which is the only fact the operator needed.
    const entries = progressOf({ checks: TWO_VIOLATED, ask: ASK_DISTINCT_ROWS });

    expect(entries).toStrictEqual([
      { kind: 'start', name: FIRST },
      { kind: 'asked', sql: FIRST_SQL },
      { kind: 'check', name: FIRST, durationMs: 1, rows: 3 },
      { kind: 'start', name: SECOND },
      { kind: 'asked', sql: SECOND_SQL },
      { kind: 'check', name: SECOND, durationMs: 1, rows: 7 },
    ]);
  });

  it('announces and prices a check whose statement THREW, on the same path', () => {
    // 🪤 The broken arm `continue`s, which is exactly where an emission gets
    // forgotten. A run killed while the NEXT check hangs would then attribute
    // the hang to the broken one, because its cost line never arrived.
    const entries = progressOf({ checks: BROKEN_CHECK, ask: ASK_BROKEN });

    expect(entries).toStrictEqual([
      { kind: 'start', name: 'broken' },
      { kind: 'asked', sql: 'SELECT contentHash FROM blobs' },
      { kind: 'check', name: 'broken', durationMs: 1, broken: true },
    ]);
  });

  it('emits the same cost records it returns, so the two accounts cannot drift', () => {
    // The recovered document is built from these lines; a completed run's is
    // built from the returned `costs`. Two shapes would be two payload builders
    // waiting to disagree.
    const seen: ProgressEntry[] = [];
    const { costs } = runDeclaredChecks({
      checks: TWO_VIOLATED,
      only: undefined,
      ask: ASK_DISTINCT_ROWS,
      validation: undefined,
      membersEnumerated: POPULATED,
      now: fakeClock(1),
      onProgress: (entry) => seen.push(entry),
    });

    const priced = seen
      .filter((entry) => entry.kind === 'check')
      .map(({ kind: _kind, ...cost }) => cost);
    expect(priced).toStrictEqual(costs);
  });

  it('runs unchanged when nobody is listening', () => {
    // `--budget 0` and the in-process lane pass no sink. A loop that required
    // one would turn the documented escape hatch into a crash.
    const { costs } = runDeclaredChecks({
      checks: TWO_VIOLATED, only: undefined, ask: ASK_DISTINCT_ROWS, validation: undefined,
      membersEnumerated: POPULATED,
    });

    expect(costs).toHaveLength(2);
  });
});
