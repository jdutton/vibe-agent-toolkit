/**
 * Which lenses a run has to evaluate, decided from the statements it declared.
 *
 * ## The cost this selection exists to stop paying
 *
 * Every lens used to be evaluated on every run. Measured through `vat resources
 * query` on this repository, `SELECT 1 AS x` — a statement that names no
 * relation at all — reported `lensSecs 0.16` on top of its population, and the
 * claude-context lens is far more expensive than that: it needs its own
 * discovery population before it can produce a row.
 *
 * ## 🚨 The direction that matters is the FALSE NEGATIVE
 *
 * A lens selected when it was not needed costs time. A lens *skipped* when it
 * WAS needed leaves its relation absent, and a statement that had an answer is
 * refused. So the selector is written to over- not under-select (a name inside a
 * CTE or an alias still selects), and a run that declares no statements at all
 * evaluates everything. The refusal itself is SQLite's (`no such table`) and
 * does not depend on this scan — see `projection-lens-laziness`.
 */

import { DERIVED_TABLES, type Projection } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import { createLogger } from '../../src/utils/logger.js';
import {
  AUTHORED_LINK_LENS,
  CLAUDE_CONTEXT_LENS,
  PROJECTION_LENSES,
  evaluateLens,
  lensRelationNames,
  lensesNamedBy,
  type LensRows,
  type ProjectionLens,
} from '../../src/utils/projection-lenses.js';

/** Lens names, for an assertion that reads as a set rather than as objects. */
function namesOf(lenses: readonly { readonly name: string }[]): string[] {
  return lenses.map((lens) => lens.name).toSorted((left, right) => left.localeCompare(right));
}

describe('lensesNamedBy', () => {
  it('selects NOTHING for a statement that names no relation', () => {
    expect(lensesNamedBy(['SELECT 1 AS x'])).toStrictEqual([]);
  });

  it('selects the authored-link lens for a statement naming `edges`', () => {
    expect(namesOf(lensesNamedBy(['SELECT COUNT(*) FROM edges']))).toStrictEqual([
      AUTHORED_LINK_LENS.name,
    ]);
  });

  it('selects the authored-link lens through any ONE of its relations', () => {
    // The positive control on the negative above: the lens owns three relations
    // and naming the least obvious of them must select it too.
    for (const relation of lensRelationNames(AUTHORED_LINK_LENS)) {
      expect(namesOf(lensesNamedBy([`SELECT * FROM ${relation}`]))).toStrictEqual([
        AUTHORED_LINK_LENS.name,
      ]);
    }
  });

  it('selects the claude-context lens, and ONLY it, for a chain statement', () => {
    expect(namesOf(lensesNamedBy(['SELECT chainId FROM claude_context_loads']))).toStrictEqual([
      CLAUDE_CONTEXT_LENS.name,
    ]);
  });

  it('selects both when one run declares statements naming both', () => {
    expect(namesOf(lensesNamedBy([
      'SELECT COUNT(*) FROM edges',
      'SELECT COUNT(*) FROM claude_context_chains',
    ]))).toStrictEqual(namesOf(PROJECTION_LENSES));
  });

  it('selects EVERY lens when the caller declared no statements at all', () => {
    // ⛔ The fail-safe direction, and it is not a convenience. A caller that
    // cannot enumerate what it will ask must get correct rows, not cheap ones —
    // the alternative is an empty relation answering a question nobody knows was
    // asked.
    expect(namesOf(lensesNamedBy(undefined))).toStrictEqual(namesOf(PROJECTION_LENSES));
  });

  it('does not select on a name that only appears in a comment or a string literal', () => {
    expect(lensesNamedBy(['SELECT 1 -- edges'])).toStrictEqual([]);
    expect(lensesNamedBy(['SELECT 1 /* edges */'])).toStrictEqual([]);
    expect(lensesNamedBy(["SELECT 'edges' AS label"])).toStrictEqual([]);
  });

  it('does not select on a name that is only a SUBSTRING of an identifier', () => {
    // `my_edges` is somebody's own CTE. Matching it would evaluate a lens for a
    // statement that cannot read it.
    expect(lensesNamedBy(['WITH my_edges AS (SELECT 1) SELECT * FROM my_edges'])).toStrictEqual([]);
  });

  it('selects on a quoted identifier, which is the same table spelled differently', () => {
    expect(namesOf(lensesNamedBy(['SELECT * FROM "edges"']))).toStrictEqual([
      AUTHORED_LINK_LENS.name,
    ]);
  });

  it.each([
    // ⚠️ Each case needs the CLOSING marker a real statement supplies, or the
    // span never opens and the case passes for the wrong reason: a lone
    // apostrophe with no second quote matches no literal at all.
    ['an apostrophe', `SELECT COUNT(*) AS "won't" FROM edges WHERE kind = 'link'`],
    ['a line-comment marker', `SELECT COUNT(*) AS "a--b" FROM edges`],
    ['a block-comment opener', `SELECT COUNT(*) AS "a/*b" FROM edges /* note */`],
    ['an apostrophe, bracket-quoted', `SELECT COUNT(*) AS [won't] FROM edges WHERE kind = 'link'`],
    ['an apostrophe, backtick-quoted', "SELECT COUNT(*) AS `won't` FROM edges WHERE kind = 'link'"],
  ])('still selects when a quoted identifier contains %s', (_what, sql) => {
    // ⛔ THE UNDER-SELECT DIRECTION, and it is the dangerous one. SQLite gives
    // `'`, `--` and `/*` no meaning inside a quoted identifier, so a blanker that
    // honours them there desynchronises and blanks a span of REAL SQL — taking
    // the relation name with it. The lens is then skipped, its relation is
    // absent, and a declared check that had an answer is refused instead.
    // Over-selecting only costs time; this costs the answer.
    expect(namesOf(lensesNamedBy([sql]))).toStrictEqual([AUTHORED_LINK_LENS.name]);
  });
});

describe('PROJECTION_LENSES', () => {
  it('gives every lens a distinct name and disjoint relations', () => {
    const names = new Set(PROJECTION_LENSES.map((lens) => lens.name));
    expect(names.size).toBe(PROJECTION_LENSES.length);

    const seen = new Set<string>();
    for (const lens of PROJECTION_LENSES) {
      for (const relation of lensRelationNames(lens)) {
        // Two lenses claiming one relation would make "was it evaluated"
        // ambiguous, and the second write would clear the first's rows.
        expect(seen.has(relation)).toBe(false);
        seen.add(relation);
      }
    }
  });
});

describe('the lens registry against DERIVED_TABLES', () => {
  it('has every derived relation claimed by exactly one lens, and nothing else', () => {
    // An unclaimed relation is never filled, so it never exists in a run's
    // database and every statement naming it is refused.
    const byName = (left: string, right: string): number => left.localeCompare(right);
    const claimed = PROJECTION_LENSES.flatMap((lens) => lens.relations).toSorted(byName);
    expect(claimed).toEqual(Object.keys(DERIVED_TABLES).toSorted(byName));
  });

  it('names every relation as one identifier word, which is all the selector can see', () => {
    for (const lens of PROJECTION_LENSES) {
      for (const relation of lensRelationNames(lens)) expect(relation).toMatch(/^[a-z0-9_]+$/);
    }
  });
});

/**
 * A lens over two relations that returns whatever it is given.
 *
 * @param rows - What `evaluate` returns
 * @returns The lens
 */
function lensReturning(rows: LensRows): ProjectionLens {
  return { name: 'stub', relations: ['edges', 'edgeResolutions'], evaluate: () => rows };
}

describe('evaluateLens', () => {
  const input = {
    projection: {} as Projection,
    root: '/corpus',
    logger: createLogger({}),
    cache: undefined,
  };

  it('hands back rows that are exactly the declared relations', async () => {
    const rows: LensRows = { edges: [], edgeResolutions: [] };
    await expect(evaluateLens(lensReturning(rows), input)).resolves.toBe(rows);
  });

  it('refuses rows that omit a declared relation', async () => {
    await expect(evaluateLens(lensReturning({ edges: [] }), input)).rejects.toThrow(/missing \[edgeResolutions\]/);
  });

  it('refuses rows carrying a relation the lens does not own', async () => {
    const rows: LensRows = { edges: [], edgeResolutions: [], lensContexts: [] };
    await expect(evaluateLens(lensReturning(rows), input)).rejects.toThrow(/undeclared \[lensContexts\]/);
  });
});
