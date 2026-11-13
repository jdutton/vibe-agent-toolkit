/**
 * I0 over a pinned slice of VAT's own repository: store-off and cold answer one query identically.
 *
 * The subject is a clone of this checkout's HEAD holding only `SUBJECT_PATHS`,
 * committed, taken once (`clonedSubject`): the docs tree, the
 * shipped skills, a package's docs and READMEs, and the root config and schemas
 * that bind them, so real-world markdown, frontmatter, links and skill layout are
 * the subject without the whole tree's cost. The query returns every row of the relations the
 * absence-cause census classifies (`CLASSIFIED_RELATIONS`), and per relation its row count and its rows'
 * ordered concatenation (as a `#<relation>` row), so one document carries the
 * whole projection. Each arm's document is digested with sha256 (SQLite has no
 * hash function, so the digest is taken here) and the digests must agree, as
 * must the two arms' refusal censuses.
 *
 * The run's cost is the two cold derivations of the subject, which the claim
 * needs; it grows with the subject, so `MAX_SUBJECT_FILES` caps the subject and
 * growth past it fails loudly instead of creeping toward the tier's per-file
 * budget. Measured serially on Node 22.16: 14.4 s for this file over the whole
 * tree, 4.4 s over this slice, of which about 3 s is fixed cost a one-file subject also pays.
 *
 * The document is larger than the collector's default buffer, so this file
 * states the size it allows (`MAX_BUFFER`).
 */

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { quoteIdentifier } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CLASSIFIED_RELATIONS } from '../helpers/absence-causes.js';
import {
  censusOf,
  clonedSubject,
  DUMPED_RELATIONS,
  expectSeed,
  queryVerb,
  relationRowsSql,
  removeCells,
  rowObjectSql,
  runDifferential,
  type DifferentialResult,
  type I0Seed,
} from '../helpers/cache-differential.js';

import { createSuiteContext } from './test-common.js';

/** The root-relative paths the subject keeps; everything else in the clone is removed. */
const SUBJECT_PATHS: readonly string[] = [
  'docs',
  'packages/vat-development-agents/resources',
  'packages/cli/docs',
  'packages/cli/README.md',
  'packages/resources/README.md',
  'packages/agent-skills/README.md',
  'schemas',
  'vibe-agent-toolkit.config.yaml',
  'package.json',
  'README.md',
  'CLAUDE.md',
];

/** The most files the subject may track: about one and a half times the 144 it held when pinned. */
const MAX_SUBJECT_FILES = 210;

/** Relations dumped row by row: the ones the census classifies, so every absence cause the subject holds is classified. */
const LISTED: ReadonlySet<string> = new Set(CLASSIFIED_RELATIONS);

/**
 * Every listed relation's rows, then one `#<relation>` row per relation: its count and ordered rows.
 * Ordered by both columns, so the document is one text per tree.
 */
const VAT_TREE_SQL = [
  ...DUMPED_RELATIONS.filter((relation) => LISTED.has(relation.name)).map((relation) => relationRowsSql(relation)),
  ...DUMPED_RELATIONS.map((relation) => {
    const table = quoteIdentifier(relation.name);
    const rows = `(SELECT group_concat(r, char(10) ORDER BY r) FROM (SELECT ${rowObjectSql(relation)} AS r FROM ${table}))`;
    return `SELECT '#${relation.name}' AS relation, json_object('count', (SELECT count(*) FROM ${table}), 'rows', ${rows}) AS row`;
  }),
].join(' UNION ALL ') + ' ORDER BY relation, row';

const QUERY = queryVerb(VAT_TREE_SQL);

/**
 * The stdout the collector allows each run. The document measured 3.3 MB on this
 * subject; 16 MB covers a subject grown to its cap with room to spare.
 */
const MAX_BUFFER = 16 * 1024 * 1024;

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
let tracked: number;

function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe("the projection store answers a slice of VAT's own repository as store-off does", () => {
  beforeAll(async () => {
    context.setup();
    const here = safePath.resolve(fileURLToPath(new URL('.', import.meta.url)));
    const source = runGitOrThrow(['rev-parse', '--show-toplevel'], { cwd: here }).trim();
    const cloned = clonedSubject(source, safePath.join(context.createTempDir(), 'corpus'), SUBJECT_PATHS);
    tracked = cloned.tracked;
    const subject = cloned.subject;
    result = await runDifferential({ binPath: context.binPath, subject, verbRows: { query: QUERY }, maxBuffer: MAX_BUFFER }, VAT_TREE);
  });

  afterAll(() => {
    removeCells();
    context.cleanup();
  });

  it('keeps the subject under its cap, so its cost cannot creep toward the budget', () => {
    expect(tracked).toBeGreaterThan(0);
    expect(tracked).toBeLessThanOrEqual(MAX_SUBJECT_FILES);
  });

  it('digests the same document in both arms, with the same refusal census', () => {
    const storeOff = result.measured.storeOff.query;
    const cold = result.measured.cold.query;
    if (storeOff === undefined || cold === undefined) throw new Error('a query did not run');
    expect(storeOff.status).toBe(0);
    const normalized = (document: Record<string, unknown>): string => JSON.stringify(QUERY.normalize(document));
    expect(digestOf(normalized(cold.document))).toBe(digestOf(normalized(storeOff.document)));
    expectSeed(VAT_TREE, result);
    const census = censusOf(result);
    expect(census.cold.query).toEqual(census.storeOff.query);
  });
});
