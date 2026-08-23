/**
 * Comparing two `parse` reports.
 *
 * The comparator's job is not "did it get slower" — that is `perf`'s question,
 * answered over a median-of-N wall clock, and asking it twice would produce two
 * gates that can disagree. This one answers **where did the time go, and did the
 * shape of the parse change**, so the tests below are about three things:
 *
 * 1. **A row with no breakdown is never subtracted from one that has one.** A
 *    warm run charges no passes at all, so a warm baseline against a cold
 *    candidate would render as "every pass got slower by its entire cost" — the
 *    single most convincing wrong finding this facet could produce. Each empty
 *    state gets its own refusal reason, and the fixtures prove they are told
 *    apart rather than lumped together.
 * 2. **Work migrating between passes is a change**, even when the total does not
 *    move. A comparator that only subtracted the total would call a rewritten
 *    pipeline unchanged, which is exactly the regression class this facet was
 *    built to catch.
 * 3. **The verdict strings are a contract with the CLI.** `vat-lab.ts` keys its
 *    exit codes on the literals `changed` and `unmeasurable`, so those are
 *    asserted as strings rather than through a helper that could rename them.
 */

import { describe, expect, it } from 'vitest';

import { compareParse, type ParseComparisonResult } from '../src/facets/parse/compare.js';
import {
  PARSE_FACET_VERSION,
  type ParseCommandStats,
  type ParsePassStats,
} from '../src/facets/parse/types.js';

import {
  ATTRIBUTED_MS,
  compareOneParseCommand,
  DOCUMENTS,
  MARKDOWN_TOTAL_MS,
  PASSES,
  parseBody,
  parseCommand,
  parseReport,
  TOTAL_MS,
  withMarkdown,
} from './parse-fixtures.js';
import { BUSY_LOAD, makeReport, makeReportAt } from './report-fixtures.js';

/** The pass every "one thing moved" case moves. */
const LEXER = 'remark-parse';

/** How many passes the HTML group contributes to a movement list. */
const HTML_PASS_COUNT = 4;

/** Where the lexer's time goes when a case migrates it. */
const REFERENCES = 'lexical-references';

/**
 * The default passes with one of them's elapsed time replaced.
 *
 * @param pass - Which pass to change
 * @param elapsedMs - Its new duration
 * @returns The full pass list
 */
function passesWith(pass: string, elapsedMs: number): readonly ParsePassStats[] {
  return PASSES.map((each) => (each.pass === pass ? { ...each, elapsedMs } : each));
}

/**
 * The verdict for the single command of a one-command comparison.
 *
 * @param comparison - A completed comparison of exactly one command
 * @returns That command's verdict
 * @throws When the comparison produced no rows, which no caller expects
 */
function onlyVerdict(comparison: ParseComparisonResult): ParseComparisonResult['commands'][number]['verdict'] {
  const row = comparison.commands[0];
  if (row === undefined) throw new Error('comparison produced no command rows');
  return row.verdict;
}

/**
 * Compare the default row against one varied field, and read the verdict kind.
 *
 * @param over - What the compared side varies
 * @returns The verdict kind
 */
function verdictKindFor(over: Partial<ParseCommandStats>): string {
  return onlyVerdict(compareOneParseCommand(parseCommand(), parseCommand(over))).kind;
}

describe('compareParse — refusals come before any subtraction', () => {
  it('refuses two reports of different facets', () => {
    const result = compareParse(parseReport([parseCommand()]), makeReport({ facet: 'io' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toMatch(/different facets/);
  });

  it('refuses reports whose body schema versions disagree with each other', () => {
    const older = parseReport([parseCommand()], { facetVersion: PARSE_FACET_VERSION + 1 });
    const result = compareParse(parseReport([parseCommand()]), older);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toMatch(/body schema moved/);
  });

  it('refuses a matched PAIR of reports whose version this build does not read', () => {
    // The sharp case: two pre-change reports agree with each other perfectly,
    // and every row in them means what the older build meant. The envelope's
    // gate cannot see that; this one has to.
    const version = PARSE_FACET_VERSION + 1;
    const result = compareParse(
      parseReport([parseCommand()], { facetVersion: version }),
      parseReport([parseCommand()], { facetVersion: version }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toMatch(/this build reads/);
  });

  it('refuses a body that is not a parse body', () => {
    const result = compareParse(
      parseReport([parseCommand()]),
      makeReport({ facet: 'parse', facetVersion: PARSE_FACET_VERSION, body: { commands: [] } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toMatch(/is not a 'parse' body/);
  });

  it('refuses when more than one axis moved', () => {
    const elsewhere = makeReportAt({
      subject: { id: 'other', source: 'other' },
      instrument: { version: '9.9.9', commit: null, dirty: null },
    });
    const result = compareParse(parseReport([parseCommand()]), {
      ...elsewhere,
      facet: 'parse',
      facetVersion: PARSE_FACET_VERSION,
      body: parseReport([parseCommand()]).body,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toMatch(/^REFUSED:/);
  });
});

describe('compareParse — a row with no breakdown is never subtracted', () => {
  it.for([
    { state: 'all-cache-hits', says: /parse cache/ },
    { state: 'uninstrumented-only', says: /cannot attribute/ },
    { state: 'nothing-parsed', says: /never reached the parse path/ },
  ] as const)('refuses to diff a $state row, saying which state it was', ({ state, says }) => {
    const empty = parseCommand({ attribution: state, kinds: [] });
    const verdict = onlyVerdict(compareOneParseCommand(empty, parseCommand()));

    // The literal the CLI keys its exit code on.
    expect(verdict.kind).toBe('unmeasurable');
    if (verdict.kind !== 'unmeasurable') throw new Error('unreachable');
    expect(verdict.reason).toMatch(says);
    expect(verdict.reason).toContain('baseline');
  });

  it('CONTROL: the same empty row against another empty row still refuses, naming BOTH', () => {
    // A reason that stopped at the baseline would send a reader to re-capture
    // one report and leave them puzzled when the second refused identically.
    const empty = parseCommand({ attribution: 'all-cache-hits', kinds: [] });
    const verdict = onlyVerdict(compareOneParseCommand(empty, empty));

    expect(verdict.kind).toBe('unmeasurable');
    if (verdict.kind !== 'unmeasurable') throw new Error('unreachable');
    expect(verdict.reason).toContain('baseline');
    expect(verdict.reason).toContain('compared side');
  });

  it('CONTROL: two measured rows of the identical shape are compared, not refused', () => {
    // Proof the assertions above are about the attribution state rather than
    // about every pair refusing: same fixture, `measured` on both sides.
    expect(verdictKindFor({})).toBe('unchanged');
  });

  it('refuses a failed row before it looks at anything else', () => {
    // Order matters: a failed row's attribution is `not-measured` by
    // construction, and reporting "no breakdown" for a build that crashed would
    // name the wrong cause.
    const verdict = onlyVerdict(
      compareOneParseCommand(
        parseCommand({ failed: true, failure: 'no dumps', attribution: 'not-measured' }),
        parseCommand(),
      ),
    );

    expect(verdict.kind).toBe('unmeasurable');
    if (verdict.kind !== 'unmeasurable') throw new Error('unreachable');
    expect(verdict.reason).toContain('no dumps');
  });

  it('refuses a warm row against a cold one', () => {
    // Warm parses nothing at all, so the delta would be the whole measurement.
    const verdict = onlyVerdict(
      compareOneParseCommand(parseCommand({ cache: 'warm' }), parseCommand()),
    );
    expect(verdict.kind).toBe('unmeasurable');
    if (verdict.kind !== 'unmeasurable') throw new Error('unreachable');
    expect(verdict.reason).toMatch(/cache mode differs/);
  });
});

describe('compareParse — what counts as a change', () => {
  it('calls a big move in one pass changed, and says which pass', () => {
    const verdict = onlyVerdict(
      compareOneParseCommand(
        parseCommand(),
        parseCommand({
          kinds: withMarkdown({
            passes: passesWith(LEXER, 302.7),
            totalMs: MARKDOWN_TOTAL_MS - 100,
            unattributedMs: MARKDOWN_TOTAL_MS - ATTRIBUTED_MS,
          }),
        }),
      ),
    );

    expect(verdict.kind).toBe('changed');
    if (verdict.kind !== 'changed') throw new Error('unreachable');
    const moved = verdict.movement.passes.filter((pass) => pass.elapsedMs.significant);
    expect(moved.map((pass) => pass.label)).toEqual([`markdown/${LEXER}`]);
    expect(moved[0]?.elapsedMs.delta).toBeCloseTo(-100, 6);
    expect(moved[0]?.elapsedMs.ratio).toBeCloseTo(302.7 / 402.7, 6);
  });

  it('calls work MIGRATING between passes changed, though the total never moved', () => {
    // The regression class this facet exists for. A comparator that only
    // subtracted the total calls a rewritten pipeline unchanged — and every
    // number in the report would agree with it.
    const migrated = PASSES.map((pass) => {
      if (pass.pass === LEXER) return { ...pass, elapsedMs: pass.elapsedMs - 100 };
      if (pass.pass === REFERENCES) return { ...pass, elapsedMs: pass.elapsedMs + 100 };
      return pass;
    });
    const verdict = onlyVerdict(
      compareOneParseCommand(
        parseCommand(),
        parseCommand({ kinds: withMarkdown({ passes: migrated }) }),
      ),
    );

    expect(verdict.kind).toBe('changed');
    if (verdict.kind !== 'changed') throw new Error('unreachable');
    expect(verdict.movement.total.delta).toBe(0);
    expect(verdict.movement.total.significant).toBe(false);
    expect(
      verdict.movement.passes.filter((pass) => pass.elapsedMs.significant).map((p) => p.label),
    ).toEqual(
      [`markdown/${LEXER}`, `markdown/${REFERENCES}`].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('calls a move in the unattributed remainder changed on its own', () => {
    // Deliberately arithmetically inconsistent — passes and total held still
    // while only the remainder moves — because that is the only way to isolate
    // this gate. A real capture cannot produce it, and a comparator that
    // derived the remainder from the passes instead of reading the published
    // field would report nothing here.
    const verdict = onlyVerdict(
      compareOneParseCommand(parseCommand(), parseCommand({ unattributedMs: 116.65 })),
    );

    expect(verdict.kind).toBe('changed');
    if (verdict.kind !== 'changed') throw new Error('unreachable');
    expect(verdict.movement.unattributedMs.significant).toBe(true);
  });

  it('calls a pass that appeared a change, whatever its size', () => {
    // The instrument's shape moved. Every share below it now means something
    // different, and a reader must know that before reading any of them.
    const verdict = onlyVerdict(
      compareOneParseCommand(
        parseCommand(),
        parseCommand({
          kinds: withMarkdown({
            passes: [...PASSES, { pass: 'new-pass', calls: DOCUMENTS, elapsedMs: 0.2 }],
          }),
        }),
      ),
    );

    expect(verdict.kind).toBe('changed');
    if (verdict.kind !== 'changed') throw new Error('unreachable');
    const added = verdict.movement.passes.find((pass) => pass.label === 'markdown/new-pass');
    expect(added?.kind).toBe('added');
    // Below both gates, and still reported: the appearance is the finding.
    expect(added?.elapsedMs.significant).toBe(false);
  });

  it('leaves a small move alone rather than manufacturing a regression', () => {
    // 8.4ms on a 921.6ms total clears the 2ms floor and fails the 10% gate.
    expect(verdictKindFor({ totalMs: TOTAL_MS + 8.4 })).toBe('unchanged');
  });

  it('CONTROL: the same move at a lowered threshold IS a change', () => {
    // Proves the test above is about the gates rather than about the field
    // being ignored — the identical pair, read with a different rule.
    const result = compareParse(
      parseReport([parseCommand()]),
      parseReport([parseCommand({ totalMs: TOTAL_MS + 8.4 })]),
      { minRelative: 0.001 },
    );
    if (!result.ok) throw new Error(result.refusal);
    expect(onlyVerdict(result).kind).toBe('changed');
  });

  it('keeps every pass in the movement, moved or not', () => {
    // The shape of the parse is the subject. A list of only the movers makes one
    // shifted pass look like the whole pipeline.
    const verdict = onlyVerdict(
      compareOneParseCommand(
        parseCommand(),
        parseCommand({ kinds: withMarkdown({ passes: passesWith(LEXER, 302.7) }) }),
      ),
    );
    if (verdict.kind !== 'changed') throw new Error('expected a change');
    // Every pass of every kind, qualified by the kind it belongs to.
    expect(verdict.movement.passes).toHaveLength(PASSES.length + HTML_PASS_COUNT);
  });
});

describe('compareParse — what qualifies a comparison', () => {
  it('carries a caveat when the two sides parsed different corpora', () => {
    // Not a refusal: a corpus that grew is exactly what a reader may be looking
    // for. But a pass that got slower per run may be unchanged per document, and
    // silence there reads as comparability.
    const verdict = onlyVerdict(
      compareOneParseCommand(
        parseCommand(),
        parseCommand({ kinds: withMarkdown({ documents: DOCUMENTS + 200 }) }),
      ),
    );
    if (verdict.kind !== 'changed' && verdict.kind !== 'unchanged') {
      throw new Error(`expected a comparison, got ${verdict.kind}`);
    }
    expect(verdict.movement.caveat).toMatch(/different numbers of documents/);
    expect(verdict.movement.documents.delta).toBe(200);
  });

  it('has no caveat when the corpora match', () => {
    const verdict = onlyVerdict(compareOneParseCommand(parseCommand(), parseCommand()));
    if (verdict.kind !== 'unchanged') throw new Error('expected no change');
    expect(verdict.movement.caveat).toBeNull();
  });

  it('surfaces contamination from EITHER side at the top level', () => {
    // These are durations, so a busy machine moves every one of them. Surfaced
    // at the top rather than buried per row: a caller that has to dig for it
    // will not.
    const busy = parseReport([parseCommand()], { body: parseBody([parseCommand()], BUSY_LOAD) });
    const result = compareParse(parseReport([parseCommand()]), busy);
    if (!result.ok) throw new Error(result.refusal);

    expect(result.contaminated).toBe(true);
    // CONTROL: the same comparison between two clean captures is not flagged.
    expect(compareOneParseCommand(parseCommand(), parseCommand()).contaminated).toBe(false);
  });

  it('reports a command present on only one side without inventing a delta', () => {
    const result = compareParse(
      parseReport([parseCommand({ name: 'audit' })]),
      parseReport([parseCommand({ name: 'validate' })]),
    );
    if (!result.ok) throw new Error(result.refusal);
    expect(result.commands.map((row) => [row.name, row.verdict.kind])).toEqual([
      ['audit', 'removed'],
      ['validate', 'added'],
    ]);
  });
});
