/**
 * The query lane's wiring of the `ts` instance, in process and store off: a statement naming a `ts`
 * relation stages the instance and hydrates its tables, a routed pair with no rows is the caller's
 * `TS_FILE_NO_ROWS` finding, and a root git gives no answer for refuses every statement naming a
 * `ts` relation with the snapshot's coded error while `data__*` statements still answer.
 */

import { VatError } from '@vibe-agent-toolkit/utils';
import { GIT_NO_ANSWER_CODE } from '@vibe-agent-toolkit/utils/git';
import { afterAll, describe, expect, it } from 'vitest';

import { RelationRefusedError, rowSetRefusals, TS_RELATIONS } from '../../src/utils/projection-query.js';
import { askOverRealized, type Realized } from '../helpers/data-stage-ask.js';
import { createTempDirTracker } from '../system/test-common.js';
import { initTestGitRepo } from '../test-helpers.js';


const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-projection-ask-ts-');
afterAll(() => cleanupTempDirs());

/** A source file the population found gone, beside a data file found gone. */
const UNREADABLE: Realized = [['src/a.ts', 'unreadable'], ['package.json', 'unreadable']];

const IMPORTS_SQL = 'SELECT COUNT(*) AS n FROM ts__imports';
const ROUTES_SQL = 'SELECT path, variant, state FROM ts__routes ORDER BY path';
const DATA_ROUTES_SQL = 'SELECT path, state FROM data__routes ORDER BY path';

/** @returns What `ask` threw, or undefined */
function thrownBy(ask: () => unknown): unknown {
  try {
    ask();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('the ts instance in the query lane', () => {
  it('hydrates ts__imports and hands the caller one TS_FILE_NO_ROWS finding per routed pair with no rows', async () => {
    const root = createTempDir();
    initTestGitRepo(root);
    const outcome = await askOverRealized({ root, realized: UNREADABLE, statements: [IMPORTS_SQL, ROUTES_SQL] }, (ask, _provenance, _extent, _projection, _columnsOf, rowSetFindings) => ({
      imports: ask(IMPORTS_SQL),
      routes: ask(ROUTES_SQL),
      rowSetFindings,
    }));
    expect(outcome.imports).toEqual([{ n: 0 }]);
    expect(outcome.routes).toEqual([{ path: 'src/a.ts', variant: 'ts', state: 'refused' }]);
    expect(outcome.rowSetFindings.map(({ code, severity, location }) => ({ code, severity, location }))).toStrictEqual([
      { code: 'TS_FILE_NO_ROWS', severity: 'error', location: 'src/a.ts' },
    ]);
  });

  it('refuses a statement naming a ts relation outside a work tree, with the snapshot\'s code, and answers data__* in the same run', async () => {
    const root = createTempDir();
    const outcome = await askOverRealized({ root, realized: UNREADABLE, statements: [IMPORTS_SQL, 'SELECT * FROM ts_imports', DATA_ROUTES_SQL] }, (ask, _provenance, _extent, _projection, _columnsOf, rowSetFindings) => ({
      imports: thrownBy(() => ask(IMPORTS_SQL)),
      joined: thrownBy(() => ask('SELECT * FROM ts_imports')),
      data: ask(DATA_ROUTES_SQL),
      rowSetFindings,
    }));
    for (const refused of [outcome.imports, outcome.joined]) {
      expect(refused).toBeInstanceOf(RelationRefusedError);
      expect((refused as RelationRefusedError).refusal).toBe('INPUT_UNREADABLE');
      expect((refused as Error).message).toContain('not a git repository');
    }
    expect(outcome.data).toEqual([{ path: 'package.json', state: 'refused' }]);
    expect(outcome.rowSetFindings.map(({ code }) => code)).toStrictEqual(['DATA_FILE_NO_ROWS']);
  });

  it('reserves every ts relation\'s name: a CTE taking one is refused, since the instance can be refused', async () => {
    const sql = 'WITH ts__imports AS (SELECT 1 AS x) SELECT x FROM ts__imports';
    const refused = await askOverRealized({ root: createTempDir(), realized: [], statements: [sql] }, (ask) => thrownBy(() => ask(sql)));
    expect(refused).toBeInstanceOf(RelationRefusedError);
    expect((refused as RelationRefusedError).refusal).toBe('USAGE_INVALID');
  });
});

describe('rowSetRefusals', () => {
  it('refuses every ts table and derived ts relation under the instance\'s refusal, and nothing of data', () => {
    const refusals = rowSetRefusals(new Map([['ts', new VatError(GIT_NO_ANSWER_CODE, 'no answer')]]));
    expect([...refusals.keys()]).toStrictEqual([...TS_RELATIONS]);
    expect(TS_RELATIONS).toStrictEqual(['ts__files', 'ts__imports', 'ts__import_names', 'ts__exports', 'ts__routes', 'ts_imports']);
  });

  it('refuses nothing when no instance is refused', () => {
    expect(rowSetRefusals(new Map()).size).toBe(0);
  });
});
