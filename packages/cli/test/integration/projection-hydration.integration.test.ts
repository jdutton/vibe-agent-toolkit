/**
 * What one run hydrates: the projection tables its statements name, with its own rows, and nothing
 * else — and, in a run holding more than one root, not a relation whose rows could not say which
 * root their path is under.
 *
 * In-process over one small projection built once from a temp directory: no store, no spawned `vat`.
 * What the planner decides from statements alone is unit-tested beside it, in
 * `test/utils/projection-lenses.test.ts`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import {
  buildResourceProjection,
  PROJECTION_STATEMENT_REFUSED_CODE,
  type Projection,
  queryableRelationNames,
  withPopulationRun,
} from '@vibe-agent-toolkit/resources';
import { isVatError, safePath } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal, normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runProjectChecks } from '../../src/commands/resources/check.js';
import { createLogger } from '../../src/utils/logger.js';
import { planHydration } from '../../src/utils/projection-lenses.js';
import { askPopulatedProjection, withQueriedProjection } from '../../src/utils/projection-query.js';
import { hydrateRunDatabase } from '../../src/utils/projection-store.js';

const NAMES_BLOBS = 'SELECT COUNT(*) AS n FROM blobs';
const NAMES_REALIZATIONS = 'SELECT path FROM resource_realizations';

let root: string;
let projection: Projection;

beforeAll(async () => {
  root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-hydration-'));
  mkdirSyncReal(safePath.join(root, 'docs'));
  writeFileSync(safePath.join(root, 'docs', 'a.md'), '# A\n\nSee [b](./b.md).\n');
  writeFileSync(safePath.join(root, 'docs', 'b.md'), '# B\n');
  ({ projection } = await withPopulationRun((run) => buildResourceProjection({ root, run })));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** What one call threw, or undefined. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('hydrateRunDatabase: a statement naming only blobs', () => {
  it('hydrates exactly the run\'s blob rows, and no other relation exists', async () => {
    expect(projection.blobs.length, 'the fixture holds no blob, so the count below is vacuous').toBeGreaterThan(0);
    const database = await hydrateRunDatabase(projection, planHydration({ statements: [NAMES_BLOBS], roots: projection.roots }));
    try {
      expect(database.query(NAMES_BLOBS)[0]?.['n']).toBe(projection.blobs.length);
      for (const name of queryableRelationNames().filter((relation) => relation !== 'blobs')) {
        expect(() => database.query(`SELECT 1 FROM "${name}"`), name).toThrow(/no such table/u);
      }
    } finally {
      await database.close();
    }
  });

  it('refuses a projection with no root row, since there is no id to file it under', async () => {
    await expect(hydrateRunDatabase({ ...projection, roots: [] }, { relations: [] })).rejects.toThrow(/no root row/u);
  });
});

describe('a run holding two roots', () => {
  it('refuses a statement over a withheld relation, naming why and listing none of its columns; blobs answers', async () => {
    const [first] = projection.roots;
    if (first === undefined) throw new Error('the fixture projection has no root row');
    const twoRoots: Projection = { ...projection, roots: [...projection.roots, { ...first, id: 'root-2', path: '/b' }] };
    const outcome = await withPopulationRun((populationRun) => askPopulatedProjection(
      {
        projection: twoRoots,
        outcome: { population: 'derived' },
        root,
        logger: createLogger(),
        statements: [NAMES_REALIZATIONS, NAMES_BLOBS],
        base: undefined,
        cache: undefined,
        populationRun,
        populationStart: performance.now(),
      },
      (ask) => ({ blobs: ask(NAMES_BLOBS), refused: thrownBy(() => ask(NAMES_REALIZATIONS)) }),
    ));

    expect(outcome.blobs[0]?.['n']).toBe(projection.blobs.length);
    expect(isVatError(outcome.refused, PROJECTION_STATEMENT_REFUSED_CODE), String(outcome.refused)).toBe(true);
    const message = String((outcome.refused as Error).message);
    expect(message).toMatch(/resource_realizations, which this run withheld/u);
    expect(message).toMatch(/more than one root/u);
    expect(message, 'a withheld relation\'s columns were listed').not.toMatch(/pathLower/u);
  });
});

/** The issues one run of these checks raises, every check's statement declared to the run. */
async function issuesOf(checks: Readonly<Record<string, { description: string; sql: string }>>): Promise<readonly { message: string }[]> {
  return withPopulationRun((populationRun) => askPopulatedProjection(
    {
      projection,
      outcome: { population: 'derived' },
      root,
      logger: createLogger(),
      statements: Object.values(checks).map((check) => check.sql),
      base: undefined,
      cache: undefined,
      populationRun,
      populationStart: performance.now(),
    },
    (ask, _provenance, _extent, _projection, columnsOf) => runProjectChecks({
      builtins: [],
      checks,
      only: undefined,
      ask,
      columnsOf,
      validation: undefined,
      membersEnumerated: projection.blobs.length,
      warn: () => undefined,
    }).issues,
  ));
}

describe('a check reads only the relations it names itself', () => {
  // SQLite reads `FROM 'blobs'` as the table when one exists. Check A spells it that way; check B
  // names it. A run hydrates every relation SOME declared statement names, so before the gate A
  // answered (passed) beside B and failed `no such table` alone: its verdict was B's doing.
  const CHECK_A = { description: 'spells blobs as a string', sql: "SELECT 1 AS x FROM 'blobs' WHERE 0" };
  const CHECK_B = { description: 'names blobs', sql: 'SELECT 1 AS x FROM blobs WHERE 0' };
  /** What both refusals of A tell its author. */
  const STRING_NOT_A_NAME = /A single-quoted 'blobs' is a string/u;

  it('refuses A beside B, which names the relation A reads', async () => {
    const issues = await issuesOf({ a: CHECK_A, b: CHECK_B });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/reads the table blobs through the single-quoted name 'blobs'/u);
    expect(issues[0]?.message).toMatch(STRING_NOT_A_NAME);
  });

  it('refuses A alone — the run holds no blobs, since nothing names it — and says why the same way', async () => {
    const issues = await issuesOf({ a: CHECK_A });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/reads blobs, which this run did not hydrate/u);
    expect(issues[0]?.message).toMatch(STRING_NOT_A_NAME);
  });

  it('passes B, which names it', async () => {
    expect(await issuesOf({ b: CHECK_B })).toStrictEqual([]);
  });
});

describe('vat resources query\'s path: one statement reaching blobs only through a single-quoted name', () => {
  // The query verb compiles its one statement first, on a probe holding every relation, so the
  // refusal comes from the preflight and must make sense for a run of exactly one statement.
  it('is refused at preflight, naming the string and the identifier spellings, and nothing about other statements', async () => {
    const sql = "SELECT COUNT(*) AS n FROM 'blobs'";
    const refused = await withQueriedProjection(
      { root, logger: createLogger(), preflight: [{ sql, parameters: [] }], statements: [sql], base: undefined },
      (ask) => ask(sql),
    ).then(() => undefined, (error: unknown) => error);
    expect(isVatError(refused, PROJECTION_STATEMENT_REFUSED_CODE), String(refused)).toBe(true);
    const message = String((refused as Error).message);
    expect(message).toMatch(/reads the table blobs through the single-quoted name 'blobs'/u);
    expect(message).toContain('blobs, "blobs", [blobs], `blobs`');
    expect(message).not.toMatch(/other statements/u);
  });
});
