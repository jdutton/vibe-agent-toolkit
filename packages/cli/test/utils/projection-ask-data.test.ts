/**
 * The query lane's wiring of the `data` instance's stage, in process and store off: whether the
 * stage runs at all, and the refusal it hands the statement guard. The routed files are
 * realizations the population could not key, under a root that does not exist: the stage reads
 * neither an oversize one nor an unreadable one, whose recorded fault (the file gone) decides it.
 */

import { readWorkCounters, type WorkCounter } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { RelationRefusedError } from '../../src/utils/projection-query.js';
import { askOverRealized, type Realized } from '../helpers/data-stage-ask.js';

/** The row-set tier's counters: none moves in a run whose statements name no data relation. */
const ROW_SET_COUNTERS: readonly WorkCounter[] = ['rowSet.extracted', 'rowSet.storeServed', 'rowSet.refused', 'rowSet.rows.decoded'];

/** Run `work` over `realized` under a root with no config: the default routing. */
function askOver<T>(options: { readonly realized: Realized; readonly statements: readonly string[] }, work: Parameters<typeof askOverRealized<T>>[1]): Promise<T> {
  return askOverRealized({ root: '/nowhere', ...options }, work);
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

/** How far each row-set counter moved across `act`. */
async function rowSetMovement(act: () => Promise<unknown>): Promise<Record<string, number>> {
  const before = readWorkCounters();
  await act();
  const after = readWorkCounters();
  return Object.fromEntries(ROW_SET_COUNTERS.map((counter) => [counter, after[counter] - before[counter]]));
}

const UNREADABLE: Realized = [['package.json', 'unreadable']];
const OVERSIZE_AND_UNREADABLE: Realized = [['package.json', 'oversize'], ['tsconfig.json', 'unreadable']];

describe('the data stage in the query lane', () => {
  it('does not run when no statement names a data relation, and runs when one does', async () => {
    const idle = await rowSetMovement(() => askOver({ realized: UNREADABLE, statements: ['SELECT 1 AS x'] }, (ask) => ask('SELECT 1 AS x')));
    expect(idle).toStrictEqual({ 'rowSet.extracted': 0, 'rowSet.storeServed': 0, 'rowSet.refused': 0, 'rowSet.rows.decoded': 0 });
    const sql = 'SELECT path, state FROM data__routes';
    const ran = await rowSetMovement(() => askOver({ realized: UNREADABLE, statements: [sql] }, (ask) => ask(sql)));
    expect(ran['rowSet.refused']).toBe(1);
  });

  it('refuses a statement naming data__nodes over every pair, and answers one naming only data__routes', async () => {
    const nodes = 'SELECT COUNT(*) AS n FROM data__nodes';
    const routes = 'SELECT path, state FROM data__routes ORDER BY path';
    const outcome = await askOver({ realized: OVERSIZE_AND_UNREADABLE, statements: [nodes, routes] }, (ask) => ({
      refused: thrownBy(() => ask(nodes)),
      routes: ask(routes),
    }));
    expect(outcome.refused).toBeInstanceOf(RelationRefusedError);
    const refused = outcome.refused as RelationRefusedError;
    expect(refused.message).toMatch(/reads data__nodes, a stored row-set table/u);
    expect(refused.message).toMatch(/package\.json/u);
    expect(refused.message).toMatch(/tsconfig\.json/u);
    expect(refused.pairs.map((pair) => [pair.path, pair.state])).toStrictEqual([['package.json', 'defective'], ['tsconfig.json', 'refused']]);
    expect(outcome.routes).toEqual([{ path: 'package.json', state: 'defective' }, { path: 'tsconfig.json', state: 'refused' }]);
  });

  it('names data__values a derived relation when it refuses', async () => {
    const sql = 'SELECT COUNT(*) AS n FROM data__values';
    const refused = await askOver({ realized: UNREADABLE, statements: [sql] }, (ask) => thrownBy(() => ask(sql)));
    expect(String(refused)).toMatch(/reads data__values, a derived relation/u);
  });

  it('refuses INPUT_UNREADABLE when any pair is defective, RUN_INCOMPLETE when every one is refused', async () => {
    const sql = 'SELECT COUNT(*) AS n FROM data__files';
    const defective = await askOver({ realized: OVERSIZE_AND_UNREADABLE, statements: [sql] }, (ask) => thrownBy(() => ask(sql)));
    const incomplete = await askOver({ realized: UNREADABLE, statements: [sql] }, (ask) => thrownBy(() => ask(sql)));
    expect((defective as RelationRefusedError).refusal).toBe('INPUT_UNREADABLE');
    expect((incomplete as RelationRefusedError).refusal).toBe('RUN_INCOMPLETE');
  });

  it('refuses a CTE that takes a data relation\'s name', async () => {
    const sql = 'WITH data__nodes AS (SELECT 1 AS x) SELECT x FROM data__nodes';
    const refused = await askOver({ realized: [], statements: [sql] }, (ask) => thrownBy(() => ask(sql)));
    expect((refused as RelationRefusedError).refusal).toBe('USAGE_INVALID');
    expect(String(refused)).toMatch(/`data__nodes` is a reserved relation name/u);
  });
});
