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
 */

import { describe, expect, it, vi } from 'vitest';

import {
  buildCheckOutputData,
  requireDeclaredCheck,
  runDeclaredChecks,
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

/** Findings, minus the provenance the payload builder also wants. */
function payloadInput(overrides: Partial<CheckPayloadInput> = {}): CheckPayloadInput {
  return {
    issues: [],
    checksRun: 0,
    population: 'derived',
    // A NON-ZERO default on purpose: every case that does not care about the
    // corpus is a case that ran over one, so a case that sets this to 0 is
    // visibly asserting something about emptiness rather than inheriting it.
    membersEnumerated: 12,
    root: '/corpus',
    durationMs: 5,
    ...overrides,
  };
}

describe('runDeclaredChecks — the loop', () => {
  it('runs EVERY declared check, not just the first', () => {
    // 🔑 The `break` mutation guard. Insert `break` at the end of the loop in
    // `runChecks` and this is the test that reds: `checksRun` drops to 1 and
    // `no-orphans` vanishes. Nothing in the spawned system suite could tell,
    // because no spawned case ever ran two checks.
    const { issues, checksRun } = runDeclaredChecks({
      checks: TWO_VIOLATED,
      only: undefined,
      ask: ASK_ONE_ROW,
      validation: undefined,
      membersEnumerated: POPULATED,
    });

    expect(checksRun).toBe(2);
    expect(issues.map((i) => i.code)).toStrictEqual([FIRST_CODE, SECOND_CODE]);
  });

  it('asks the projection once per check, with that check\'s own statement', () => {
    // The denominator's other half: `checksRun: 2` from a loop that ran one
    // statement twice would be a lie the count could not expose.
    const ask = vi.fn<AskProjection>(() => []);

    const { checksRun } = runDeclaredChecks({
      checks: TWO_VIOLATED, only: undefined, ask, validation: undefined,
      membersEnumerated: POPULATED,
    });

    expect(checksRun).toBe(2);
    expect(ask.mock.calls.map(([sql]) => sql)).toStrictEqual([FIRST_SQL, SECOND_SQL]);
  });

  it('runs only the named check under `only`, and counts only that one', () => {
    const { issues, checksRun } = runDeclaredChecks({
      checks: TWO_VIOLATED, only: SECOND, ask: ASK_ONE_ROW, validation: undefined,
      membersEnumerated: POPULATED,
    });

    expect(checksRun).toBe(1);
    expect(issues.map((i) => i.code)).toStrictEqual([SECOND_CODE]);
  });

  it('reports a broken check as a finding, never as a skip', () => {
    const { issues, checksRun } = runDeclaredChecks({
      checks: BROKEN_CHECK,
      only: undefined,
      ask: ASK_BROKEN,
      validation: undefined,
      membersEnumerated: POPULATED,
    });

    // It RAN — the count must not pretend otherwise — and it produced an error.
    expect(checksRun).toBe(1);
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

    const { issues, checksRun } = runDeclaredChecks({
      checks: TWO_VIOLATED, only: undefined, ask, validation: undefined,
      membersEnumerated: POPULATED,
    });

    expect(checksRun).toBe(2);
    expect(issues.map((i) => i.code)).toStrictEqual(['RESOURCE_CHECK_BROKEN', SECOND_CODE]);
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
    const { issues } = runDeclaredChecks({
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
    expect(buildCheckOutputData(payloadInput({ issues, checksRun: 1 }))['status']).toBe('error');
  });

  it('still reports it at error when the check is merely DEMOTED to warning', () => {
    // The quieter half of the same defect. `warning` does not drop the finding,
    // it drops it below the exit threshold — so the gate returns 0 and the
    // document says `status: warning` over a check that ran nothing.
    const { issues } = runDeclaredChecks({
      checks: BROKEN_CHECK,
      only: undefined,
      ask: ASK_BROKEN,
      validation: { severity: { 'CUSTOM:broken': 'warning' } },
      membersEnumerated: POPULATED,
    });

    expect(issues[0]?.severity).toBe('error');
    expect(buildCheckOutputData(payloadInput({ issues, checksRun: 1 }))['status']).toBe('error');
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
    const ran = buildCheckOutputData(payloadInput({ checksRun: 2 }));
    const none = buildCheckOutputData(payloadInput({ checksRun: 0 }));

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
      checksRun: 1,
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
      checksRun: 1,
      issues: [{ code: 'CUSTOM:a', severity: 'error', message: 'bad', location: 'docs/a.md' }],
    }));

    const [issue] = payload['issues'] as { path?: string }[];
    expect(issue?.path).toBe('docs/a.md');
  });

  it('reports success with a formatted duration when nothing was found', () => {
    const payload = buildCheckOutputData(payloadInput({ checksRun: 3, durationMs: 1500 }));

    expect(payload['status']).toBe('success');
    expect(payload['root']).toBe('/corpus');
    expect(payload['issueCounts']).toStrictEqual({ errors: 0, warnings: 0, info: 0 });
    expect(payload['durationSecs']).toBeDefined();
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
    const { issues, checksRun } = runDeclaredChecks({
      checks: TWO_VIOLATED,
      only: undefined,
      ask: ASK_NO_ROWS,
      validation: undefined,
      membersEnumerated: 0,
    });

    // The checks DID run — the count must not pretend otherwise. They just had
    // nothing to run over, which is the whole finding.
    expect(checksRun).toBe(2);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('error');
    expect(buildCheckOutputData(payloadInput({ issues, checksRun, membersEnumerated: 0 }))['status'])
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
    const { issues, checksRun } = runDeclaredChecks({
      checks: TWO_VIOLATED, only: undefined, ask: ASK_NO_ROWS, validation: undefined,
      membersEnumerated: 1,
    });

    expect(checksRun).toBe(2);
    expect(issues).toStrictEqual([]);
    expect(buildCheckOutputData(payloadInput({ issues, checksRun, membersEnumerated: 1 }))['status'])
      .toBe('success');
  });

  it('does not double-report when the project declares no checks at all', () => {
    // 🪤 A DIFFERENT condition, already handled by a loud stderr warning and a
    // deliberate exit 0 — declaring no checks is legitimate. A run with neither
    // checks nor corpus must not turn that legitimate state into an error, or
    // the operator gets two reports about one situation and the wrong verdict.
    const { issues, checksRun } = runDeclaredChecks({
      checks: {}, only: undefined, ask: ASK_NO_ROWS, validation: undefined,
      membersEnumerated: 0,
    });

    expect(checksRun).toBe(0);
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
    const over = buildCheckOutputData(payloadInput({ checksRun: 2, membersEnumerated: 8000 }));
    const none = buildCheckOutputData(payloadInput({ checksRun: 2, membersEnumerated: 0 }));

    expect(over['membersEnumerated']).toBe(8000);
    expect(none['membersEnumerated']).toBe(0);
    // Two documents that differ ONLY in the corpus size. Drop the field and
    // these become equal, which is precisely the ambiguity that shipped.
    expect(over).not.toStrictEqual(none);
  });
});
