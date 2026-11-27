/**
 * The query lane's wiring of the `data` instance's stage, in process and store off: whether the
 * stage runs at all, what a statement over pairs with no rows answers, and the findings it hands the caller. The routed files are
 * realizations the population could not key, under a root that does not exist: the stage reads
 * neither an oversize one nor an unreadable one, whose recorded fault (the file gone) decides it.
 */

import { readWorkCounters, type WorkCounter } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { askOverRealized, type Realized } from '../helpers/data-stage-ask.js';

/** The row-set tier's counters: none moves in a run whose statements name no data relation. */
const ROW_SET_COUNTERS: readonly WorkCounter[] = ['rowSet.extracted', 'rowSet.storeServed', 'rowSet.refused', 'rowSet.rows.decoded'];

/** Run `work` over `realized` under a root with no config: the default routing. */
function askOver<T>(options: { readonly realized: Realized; readonly statements: readonly string[] }, work: Parameters<typeof askOverRealized<T>>[1]): Promise<T> {
  return askOverRealized({ root: '/nowhere', ...options }, work);
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

  it('answers a statement naming data__nodes without the pairs that have no rows, and hands the caller one finding per pair', async () => {
    const nodes = 'SELECT COUNT(*) AS n FROM data__nodes';
    const routes = 'SELECT path, state FROM data__routes ORDER BY path';
    const outcome = await askOver({ realized: OVERSIZE_AND_UNREADABLE, statements: [nodes, routes] }, (ask, _provenance, _extent, _projection, _columnsOf, dataFindings) => ({
      nodes: ask(nodes),
      routes: ask(routes),
      dataFindings,
    }));
    expect(outcome.nodes).toEqual([{ n: 0 }]);
    expect(outcome.routes).toEqual([{ path: 'package.json', state: 'defective' }, { path: 'tsconfig.json', state: 'refused' }]);
    expect(outcome.dataFindings.map(({ code, severity, location }) => ({ code, severity, location }))).toStrictEqual([
      { code: 'DATA_FILE_NO_ROWS', severity: 'error', location: 'package.json' },
      { code: 'DATA_FILE_NO_ROWS', severity: 'error', location: 'tsconfig.json' },
    ]);
    expect(outcome.dataFindings[0]?.message).toContain('defective PARSE_LIMIT_EXCEEDED');
    expect(outcome.dataFindings[1]?.message).toContain('refused BLOB_UNREADABLE');
  });

  it('answers data__values and data__files over a corpus whose every pair has no rows', async () => {
    const values = 'SELECT COUNT(*) AS n FROM data__values';
    const files = 'SELECT COUNT(*) AS n FROM data__files';
    const answered = await askOver({ realized: UNREADABLE, statements: [values, files] }, (ask) => [ask(values), ask(files)]);
    expect(answered).toEqual([[{ n: 0 }], [{ n: 0 }]]);
  });

  it('hands no data finding to a run whose statements name no data relation', async () => {
    const findings = await askOver({ realized: UNREADABLE, statements: ['SELECT 1 AS x'] }, (_ask, _provenance, _extent, _projection, _columnsOf, dataFindings) => dataFindings);
    expect(findings).toStrictEqual([]);
  });

  it('lets a CTE take a data relation\'s name: no data relation is refused, so none is reserved', async () => {
    const sql = 'WITH data__nodes AS (SELECT 1 AS x) SELECT x FROM data__nodes';
    expect(await askOver({ realized: [], statements: [sql] }, (ask) => ask(sql))).toEqual([{ x: 1 }]);
  });
});
