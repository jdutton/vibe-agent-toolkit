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
 * CTE or an alias still selects). The refusal itself is SQLite's (`no such
 * table`) and does not depend on this scan — see `projection-lens-laziness`.
 */

import {
  checkStatements,
  DERIVED_TABLES,
  isProjectionTable,
  type PopulationRun,
  type QueryProjection,
  queryableRelationSpecs,
} from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import { createLogger } from '../../src/utils/logger.js';
import {
  AUTHORED_LINK_LENS,
  CHANGED_FILES_LENS,
  CLAUDE_CONTEXT_LENS,
  PROJECTION_LENSES,
  evaluateLens,
  lensPopulationOf,
  lensRelationNames,
  planHydration,
  type LensEvaluation,
  type LensRows,
  type ProjectionLens,
} from '../../src/utils/projection-lenses.js';

/** Lens names, for an assertion that reads as a set rather than as objects. */
function namesOf(lenses: readonly { readonly name: string }[]): string[] {
  return lenses.map((lens) => lens.name).toSorted((left, right) => left.localeCompare(right));
}

/** One root row: a run without the multi-root withholding. */
const ONE_ROOT: readonly unknown[] = [{ id: 'root-1', path: '/root' }];

/** Two root rows: a run that withholds a relation whose rows cannot say which root they are under. */
const TWO_ROOTS: readonly unknown[] = [...ONE_ROOT, { id: 'root-2', path: '/b' }];

const NAMES_BLOBS = 'SELECT COUNT(*) AS n FROM blobs';
const NAMES_REALIZATIONS = 'SELECT path FROM resource_realizations';

/**
 * The lenses one run's plan evaluates.
 *
 * @param statements - The statements the run declared
 * @returns The planned lenses
 */
function plannedLenses(statements: readonly string[]): readonly ProjectionLens[] {
  return planHydration({ statements, roots: ONE_ROOT }).lenses;
}

describe('planHydration: the lenses', () => {
  it('selects NOTHING for a statement that names no relation', () => {
    expect(plannedLenses(['SELECT 1 AS x'])).toStrictEqual([]);
  });

  it('selects the authored-link lens for a statement naming `edges`', () => {
    expect(namesOf(plannedLenses(['SELECT COUNT(*) FROM edges']))).toStrictEqual([
      AUTHORED_LINK_LENS.name,
    ]);
  });

  it('selects the authored-link lens through any ONE of its relations', () => {
    // The positive control on the negative above: the lens owns three relations
    // and naming the least obvious of them must select it too.
    for (const relation of lensRelationNames(AUTHORED_LINK_LENS)) {
      expect(namesOf(plannedLenses([`SELECT * FROM ${relation}`]))).toStrictEqual([
        AUTHORED_LINK_LENS.name,
      ]);
    }
  });

  it('selects the claude-context lens, and ONLY it, for a chain statement', () => {
    expect(namesOf(plannedLenses(['SELECT chainId FROM claude_context_loads']))).toStrictEqual([
      CLAUDE_CONTEXT_LENS.name,
    ]);
  });

  it('selects the changed-files lens, and ONLY it, for a statement naming changed_files', () => {
    expect(namesOf(plannedLenses(["SELECT path FROM changed_files WHERE status = 'added'"]))).toStrictEqual([
      CHANGED_FILES_LENS.name,
    ]);
  });

  it('selects a lens whose relation only a check\'s `examined` statement names', () => {
    // 🪤 The gap this pins: a run that fed the selector only `sql` would skip the
    // lens, leave the relation absent, and refuse a check whose violations
    // statement never read it — its examined count unanswerable for no reason.
    const statements = checkStatements({
      description: 'specs touched by this change carry a status',
      sql: 'SELECT path FROM resource_realizations WHERE 0',
      examined: 'SELECT path FROM changed_files',
    });

    expect(namesOf(plannedLenses(statements))).toStrictEqual([CHANGED_FILES_LENS.name]);
  });

  it('selects both when one run declares statements naming both', () => {
    expect(namesOf(plannedLenses([
      'SELECT COUNT(*) FROM edges',
      'SELECT COUNT(*) FROM claude_context_chains',
    ]))).toStrictEqual([AUTHORED_LINK_LENS.name, CLAUDE_CONTEXT_LENS.name]);
  });

  it('does not select on a name that only appears in a comment or a string literal', () => {
    expect(plannedLenses(['SELECT 1 -- edges'])).toStrictEqual([]);
    expect(plannedLenses(['SELECT 1 /* edges */'])).toStrictEqual([]);
    expect(plannedLenses(["SELECT 'edges' AS label"])).toStrictEqual([]);
  });

  it('does not select on a name that is only a SUBSTRING of an identifier', () => {
    // `my_edges` is somebody's own CTE. Matching it would evaluate a lens for a
    // statement that cannot read it.
    expect(plannedLenses(['WITH my_edges AS (SELECT 1) SELECT * FROM my_edges'])).toStrictEqual([]);
  });

  it('selects on a quoted identifier, which is the same table spelled differently', () => {
    expect(namesOf(plannedLenses(['SELECT * FROM "edges"']))).toStrictEqual([
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
    expect(namesOf(plannedLenses([sql]))).toStrictEqual([AUTHORED_LINK_LENS.name]);
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
 * @param rows - The rows `evaluate` returns
 * @param population - Where its own population came from, `null` for none
 * @returns The lens
 */
function lensReturning(rows: LensRows, population: LensEvaluation['population'] = null): ProjectionLens {
  return { name: 'stub', relations: ['edges', 'edgeResolutions'], evaluate: () => ({ rows, population }) };
}

describe('evaluateLens', () => {
  const input = {
    projection: {} as QueryProjection,
    root: '/corpus',
    base: undefined,
    cache: undefined,
    populationRun: {} as PopulationRun,
    logger: createLogger(),
  };

  it('hands back rows that are exactly the declared relations', async () => {
    const rows: LensRows = { edges: [], edgeResolutions: [] };
    await expect(evaluateLens(lensReturning(rows, 'store'), input)).resolves.toEqual({ rows, population: 'store' });
  });

  it('refuses rows that omit a declared relation', async () => {
    await expect(evaluateLens(lensReturning({ edges: [] }), input)).rejects.toThrow(/missing \[edgeResolutions\]/);
  });

  it('hands back a lens\'s refusal as it is, with no rows to check', async () => {
    const refusing: ProjectionLens = { name: 'stub', relations: ['edges'], evaluate: () => ({ refused: 'no base', refusal: 'USAGE_INVALID' }) };
    await expect(evaluateLens(refusing, input)).resolves.toStrictEqual({ refused: 'no base', refusal: 'USAGE_INVALID' });
  });

  it('refuses rows carrying a relation the lens does not own', async () => {
    const rows: LensRows = { edges: [], edgeResolutions: [], lensContexts: [] };
    await expect(evaluateLens(lensReturning(rows), input)).rejects.toThrow(/undeclared \[lensContexts\]/);
  });
});

describe('lensPopulationOf', () => {
  it('is none when no evaluated lens populated anything', () => {
    expect(lensPopulationOf([])).toBe('none');
    expect(lensPopulationOf([null])).toBe('none');
  });

  it('is store only when every lens that populated was served from the store', () => {
    expect(lensPopulationOf([null, 'store'])).toBe('store');
  });

  it('is derived when any lens that populated derived', () => {
    expect(lensPopulationOf(['store', 'derived'])).toBe('derived');
    expect(lensPopulationOf(['derived', null])).toBe('derived');
  });
});

describe('planHydration: the relations', () => {
  it('plans exactly the projection tables a statement names', () => {
    const plan = planHydration({ statements: [NAMES_BLOBS], roots: ONE_ROOT });
    expect(plan.relations).toStrictEqual(['blobs']);
    expect(plan.lenses).toStrictEqual([]);
    expect([...plan.withheld]).toStrictEqual([]);
  });

  it('adds no table for a lens relation: no lens reads the run database', () => {
    const plan = planHydration({ statements: ['SELECT COUNT(*) FROM edges'], roots: ONE_ROOT });
    expect(plan.relations).toStrictEqual([]);
    expect(plan.lenses).toStrictEqual([AUTHORED_LINK_LENS]);
  });

  it('plans both halves of a statement joining a lens relation to a table', () => {
    const plan = planHydration({
      statements: ['SELECT r.path FROM edges e JOIN resource_realizations r ON r.path = e.src'],
      roots: ONE_ROOT,
    });
    expect(plan.relations).toStrictEqual(['resource_realizations']);
    expect(plan.lenses).toStrictEqual([AUTHORED_LINK_LENS]);
  });

  it('plans nothing for a statement naming no relation', () => {
    expect(planHydration({ statements: ['SELECT 1 AS x'], roots: ONE_ROOT }).relations).toStrictEqual([]);
  });

  it('can plan every projection table, each from the statement naming it, in registry order', () => {
    const tables = queryableRelationSpecs().filter((spec) => isProjectionTable(spec)).map((spec) => spec.name);
    const statements = tables.toReversed().map((name) => `SELECT COUNT(*) AS n FROM "${name}"`);
    expect(planHydration({ statements, roots: ONE_ROOT }).relations).toStrictEqual(tables);
  });
});

describe('planHydration: a run holding more than one root', () => {
  it('withholds a relation with a root-relative path column and no root column, with why', () => {
    const plan = planHydration({ statements: [NAMES_REALIZATIONS, NAMES_BLOBS], roots: TWO_ROOTS });
    expect(plan.relations).toStrictEqual(['blobs']);
    expect(plan.withheld.get('resource_realizations')).toMatch(/root-relative path column and no `root` column/u);
  });

  it('does not evaluate a lens that owns a withheld relation, and withholds every relation of it named', () => {
    // `edges` has no path column; its lens also produces `edge_resolutions`, whose `dstKey` is one.
    const plan = planHydration({ statements: ['SELECT COUNT(*) FROM edges', 'SELECT chainId FROM claude_context_loads'], roots: TWO_ROOTS });
    expect(plan.lenses).toStrictEqual([]);
    expect(plan.withheld.get('edges')).toMatch(/its lens is not evaluated, because it also produces edge_resolutions/u);
    expect(plan.withheld.get('claude_context_loads')).toMatch(/root-relative path column/u);
  });

  it('withholds nothing in a run holding one root', () => {
    const plan = planHydration({ statements: [NAMES_REALIZATIONS], roots: ONE_ROOT });
    expect(plan.relations).toStrictEqual(['resource_realizations']);
    expect([...plan.withheld]).toStrictEqual([]);
  });
});
