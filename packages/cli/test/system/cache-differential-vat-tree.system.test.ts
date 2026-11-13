/**
 * I0 over VAT's own tree: store-off and cold answer one query identically.
 *
 * The subject is a `git clone --local --shared` of this checkout's HEAD, taken
 * once. The query returns every `blob_conditions` and `realization_conditions`
 * row, and per relation its row count and its rows' ordered concatenation (as a
 * `#<relation>` row), so one document carries the whole projection. Each arm's
 * document is digested with sha256 (SQLite has none) and the digests must agree,
 * as must the two arms' refusal censuses.
 *
 * The document is larger than the collector's default buffer, so this file
 * states the measured size it allows (`MAX_BUFFER`).
 */

import { createHash } from 'node:crypto';

import { quoteIdentifier } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  censusOf,
  DUMPED_RELATIONS,
  expectSeed,
  queryVerb,
  removeCells,
  rowObjectSql,
  runDifferential,
  VERBS,
  type DifferentialResult,
  type I0Seed,
} from '../helpers/cache-differential.js';

import { createSuiteContext } from './test-common.js';

/** Relations dumped row by row: the ones a refusal or a realization failure lands in. */
const LISTED: ReadonlySet<string> = new Set(['blob_conditions', 'realization_conditions']);

/**
 * Every listed relation's rows, then one `#<relation>` row per relation: its count and ordered rows.
 * Ordered by both columns, so the document is one text per tree.
 */
const VAT_TREE_SQL = [
  ...DUMPED_RELATIONS.filter((relation) => LISTED.has(relation.name)).map(
    (relation) => `SELECT '${relation.name}' AS relation, ${rowObjectSql(relation)} AS row FROM ${quoteIdentifier(relation.name)}`,
  ),
  ...DUMPED_RELATIONS.map((relation) => {
    const table = quoteIdentifier(relation.name);
    const rows = `(SELECT group_concat(r, char(10) ORDER BY r) FROM (SELECT ${rowObjectSql(relation)} AS r FROM ${table}))`;
    return `SELECT '#${relation.name}' AS relation, json_object('count', (SELECT count(*) FROM ${table}), 'rows', ${rows}) AS row`;
  }),
].join(' UNION ALL ') + ' ORDER BY relation, row';

const QUERY = queryVerb(VAT_TREE_SQL);

/**
 * The stdout the collector allows each run. Measured at 29.7 MB (each arm's
 * query 9 to 10 s) on this tree; twice that leaves room for the tree to grow.
 */
const MAX_BUFFER = 64 * 1024 * 1024;

/** No plant: two arms over a fixed tree, the one query, diverging nowhere. */
const VAT_TREE: I0Seed = {
  name: 'vatTree',
  arms: ['storeOff', 'cold'],
  verbs: ['query'],
  expect: { diverges: { relations: [], verbs: [] } },
  consumed: { runs: [], check: () => undefined },
};

const context = createSuiteContext('vat-i0-vat-tree-', import.meta.url);

let result: DifferentialResult;

function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe("the projection store answers VAT's own tree as store-off does", () => {
  beforeAll(async () => {
    context.setup();
    const source = runGitOrThrow(['rev-parse', '--show-toplevel'], { cwd: safePath.resolve(context.binPath, '..') }).trim();
    const corpus = safePath.join(context.createTempDir(), 'corpus');
    runGitOrThrow(['clone', '-q', '--local', '--shared', source, corpus]);
    result = await runDifferential({
      binPath: context.binPath,
      subject: { corpus, write: undefined },
      verbRows: { query: QUERY },
      maxBuffer: MAX_BUFFER,
    }, VAT_TREE);
  });

  afterAll(() => {
    removeCells();
    context.cleanup();
  });

  it('digests the same document in both arms, with the same refusal census', () => {
    const storeOff = result.measured.storeOff.query;
    const cold = result.measured.cold.query;
    if (storeOff === undefined || cold === undefined) throw new Error('a query did not run');
    expect(storeOff.status).toBe(0);
    const normalized = (document: Record<string, unknown>): string => JSON.stringify(QUERY.normalize(document));
    expect(digestOf(normalized(cold.document))).toBe(digestOf(normalized(storeOff.document)));
    expectSeed(VAT_TREE, result);
    const census = censusOf(result, { ...VERBS, query: QUERY });
    expect(census.cold.query).toEqual(census.storeOff.query);
  });
});
