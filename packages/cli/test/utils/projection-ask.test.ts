/**
 * The in-process query seam over an empty projection: what a run hydrates and evaluates from its
 * statements, and how each kind of statement is answered or refused. No file is read: the
 * projection is built in memory and the run database lives in memory.
 */

import {
  NO_GIT_MEMBERS,
  isProjectionTable,
  PROJECTION_STATEMENT_REFUSED_CODE,
  storedRelationSpecs,
  withPopulationRun,
  type Projection,
  type QueryProjection,
  type QueryReferenceSource,
} from '@vibe-agent-toolkit/resources';
import { queryProjectionOf } from '@vibe-agent-toolkit/resources/testing';
import { isVatError } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { createLogger } from '../../src/utils/logger.js';
import { askPopulatedProjection, RelationRefusedError } from '../../src/utils/projection-query.js';
import { hydrateRunDatabase } from '../../src/utils/projection-store.js';

/** A projection with one root and no other row. */
function emptyProjection(): QueryProjection {
  const tables = Object.fromEntries(storedRelationSpecs().filter(isProjectionTable).map((spec) => [spec.key, []]));
  return queryProjectionOf({ ...tables, roots: [{ id: 'root-1' }] } as unknown as Projection);
}

/** The empty projection's `blob_references`: its own rows, none. */
const NO_REFERENCES: QueryReferenceSource = { rows: [] };

/** Run `work` over the empty projection with `statements` declared. */
function askEmpty<T>(statements: readonly string[], work: Parameters<typeof askPopulatedProjection<T>>[1]): Promise<T> {
  return withPopulationRun(NO_GIT_MEMBERS, (populationRun) => askPopulatedProjection(
    {
      projection: emptyProjection(),
      blobReferences: NO_REFERENCES,
      outcome: { population: 'derived' },
      root: '/nowhere',
      logger: createLogger(),
      statements,
      base: undefined,
      cache: undefined,
      populationRun,
      populationStart: performance.now(),
      attempt: 1,
    },
    work,
  ));
}

/** What one call threw, or undefined. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('askPopulatedProjection over an empty projection', () => {
  it('answers a statement naming no relation, evaluating no lens', async () => {
    const outcome = await askEmpty(['SELECT 1 AS x'], (ask, provenance, extent, _projection, columnsOf) => ({
      rows: ask('SELECT 1 AS x'),
      columns: columnsOf('SELECT 1 AS x'),
      provenance,
      extent,
    }));
    expect(outcome.rows).toEqual([{ x: 1 }]);
    expect(outcome.columns).toStrictEqual(['x']);
    expect(outcome.provenance.lensesEvaluated).toStrictEqual([]);
    expect(outcome.provenance.lensMs).toBe(0);
    expect(outcome.extent.membersEnumerated).toBe(0);
  });

  it('evaluates the lens a statement names and answers from the relation it wrote', async () => {
    const sql = 'SELECT COUNT(*) AS n FROM edges';
    const outcome = await askEmpty([sql], (ask, provenance) => ({ rows: ask(sql), evaluated: provenance.lensesEvaluated }));
    expect(outcome.rows).toEqual([{ n: 0 }]);
    expect(outcome.evaluated.length).toBeGreaterThan(0);
  });

  it('refuses a statement naming a relation whose lens refused, before it runs', async () => {
    const sql = 'SELECT COUNT(*) AS n FROM changed_files';
    const refused = await askEmpty([sql], (ask, provenance) => ({ refused: thrownBy(() => ask(sql)), evaluated: provenance.lensesEvaluated }));
    expect(refused.refused).toBeInstanceOf(RelationRefusedError);
    expect(String(refused.refused)).toMatch(/could not be evaluated for this run/u);
    expect(refused.evaluated).toStrictEqual([]);
  });

  it('refuses a statement over a relation the run did not hydrate, saying so', async () => {
    const refused = await askEmpty(['SELECT 1 AS x'], (ask) => thrownBy(() => ask('SELECT COUNT(*) AS n FROM blobs')));
    expect(isVatError(refused, PROJECTION_STATEMENT_REFUSED_CODE), String(refused)).toBe(true);
    expect(String(refused)).toMatch(/blobs, which this run did not hydrate/u);
  });
});

describe('hydrateRunDatabase refuses what it cannot file', () => {
  it('a projection with no root row', async () => {
    await expect(hydrateRunDatabase({ projection: { ...emptyProjection(), roots: [] }, blobReferences: NO_REFERENCES, rowSets: new Map() }, { relations: [] })).rejects.toThrow(/no root row/u);
  });

  it('a planned relation that is not a stored relation', async () => {
    await expect(hydrateRunDatabase({ projection: emptyProjection(), blobReferences: NO_REFERENCES, rowSets: new Map() }, { relations: ['edges'] })).rejects.toThrow(/"edges" is not a stored relation/u);
  });
});
