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
 * WAS needed returns an empty relation — a silent wrong answer, and the "check
 * that cannot fail" drift class exactly. So the selector is written to over- not
 * under-select (a name inside a CTE or an alias still selects), a run that
 * declares no statements at all evaluates everything, and
 * `withQueriedProjection` refuses a statement naming a relation nothing
 * evaluated rather than answering it from an empty table.
 */

import { describe, expect, it } from 'vitest';

import {
  AUTHORED_LINK_LENS,
  CLAUDE_CONTEXT_LENS,
  PROJECTION_LENSES,
  lensRelationNames,
  lensesNamedBy,
  unevaluatedRelationsNamed,
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
});

describe('unevaluatedRelationsNamed', () => {
  it('names the relation a statement reaches for that nothing evaluated', () => {
    // Evaluated: the statement can be answered, so nothing is missing.
    expect(unevaluatedRelationsNamed('SELECT * FROM edges', [AUTHORED_LINK_LENS]))
      .toStrictEqual([]);
    // NOT evaluated: `edges` exists in the schema and is empty, which is the
    // silent wrong answer the query lane refuses on the strength of this.
    expect(unevaluatedRelationsNamed('SELECT * FROM edges', [CLAUDE_CONTEXT_LENS]))
      .toStrictEqual(['edges']);
  });

  it('returns nothing for a statement that names no lens relation', () => {
    expect(unevaluatedRelationsNamed('SELECT 1', PROJECTION_LENSES)).toStrictEqual([]);
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
