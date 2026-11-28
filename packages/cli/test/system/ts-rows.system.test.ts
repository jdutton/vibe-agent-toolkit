/**
 * The `ts` instance through the built CLI (`vat resources query` and `vat resources check`): the
 * row-set stage routes git content by extension, extracts on the run's dispatcher, and answers
 * `ts__routes`, `ts__files`, `ts__imports`, `ts__import_names`, `ts__exports` and `ts_imports`.
 *
 * Proved here, over the corpus of `../helpers/ts-rows.ts`:
 * - **the answer**, store off, cold and warm identically, and the corpus's own answer; the warm run
 *   is served its row sets from the store and extracts nothing;
 * - **a check** naming `ts_imports` reads it, store off and warm;
 * - **a defective file** (`TS_PARSE_ERROR`) is one `TS_FILE_NO_ROWS` finding, exit 1, every other
 *   file's rows still present;
 * - **`allowEmpty`**: a declared `ts` block that routes nothing refuses (`CONFIG_INVALID`) unless it
 *   sets `allowEmpty: true`;
 * - **git content only**: with the filesystem crawl forced the instance takes the run's memoized
 *   git snapshot and answers as on the git crawl, the gitignored `.ts` file never routed; outside a
 *   work tree a `ts` statement is refused with the snapshot's `GIT_NO_ANSWER` (published
 *   `INPUT_UNREADABLE`) while a `data__*` statement answers.
 *
 * The resources population declines ignored members on both crawl lanes, so the ignored file never
 * reaches the stage here; the stage's own exclusion of a member git does not hold is proved on
 * `gitContentPathsOf` itself (`resources` `git-content-paths.integration.test.ts`).
 */

import { existsSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { answeredRows, countedQuery, freshDataArm, refusalOf, storeOffColdWarm, type DataArm } from '../helpers/data-rows.js';
import {
  BROKEN_SOURCE,
  CLEAN_TS_ANSWER,
  IGNORED_SOURCE,
  TS_CHECK_CONFIG,
  TS_DUMP_SQL,
  tsAnswerOf,
  tsBlockConfig,
  writeTsCorpus,
} from '../helpers/ts-rows.js';
import { writeCorpus } from '../test-helpers.js';

import { createSuiteContext, executeCli, isolatedScratchEnv } from './test-common.js';

const context = createSuiteContext('vat-ts-rows-', import.meta.url);

/** The clean corpus, with a check over `ts_imports`. */
let clean = '';

beforeAll(() => {
  context.setup();
  clean = safePath.join(context.createTempDir(), 'clean');
  writeTsCorpus(clean, { config: TS_CHECK_CONFIG });
});
afterAll(() => context.cleanup());

/** A fresh corpus under the suite's temp root. */
function corpusWith(options: Parameters<typeof writeTsCorpus>[1]): string {
  const root = safePath.join(context.createTempDir(), 'corpus');
  writeTsCorpus(root, options);
  return root;
}

const ROUTES_SQL = 'SELECT path FROM ts__routes ORDER BY path';

describe('the ts relations through vat resources query (system test)', () => {
  it('answer store off, cold and warm identically, the warm run extracting nothing', async () => {
    const runs = await storeOffColdWarm(context, clean, TS_DUMP_SQL);
    const answers = [runs.storeOff, runs.cold, runs.warm].map((run) => {
      answeredRows(run);
      return tsAnswerOf(run.document);
    });
    expect(answers[0]).toStrictEqual(CLEAN_TS_ANSWER);
    expect(answers[1]).toStrictEqual(answers[0]);
    expect(answers[2]).toStrictEqual(answers[0]);
    const pairs = CLEAN_TS_ANSWER['ts__routes']?.length;
    expect([runs.storeOff, runs.cold, runs.warm].map((run) => run.counters['rowSet.extracted'])).toStrictEqual([pairs, pairs, 0]);
    expect(runs.warm.counters['rowSet.storeServed']).toBe(pairs);
  });

  it('a check naming ts_imports reads it, store off and warm', async () => {
    const scratch = context.createTempDir();
    for (const dir of ['home/.claude', 'tmp']) mkdirSyncReal(safePath.join(scratch, dir), { recursive: true });
    const env = isolatedScratchEnv(scratch);
    const runCheck = async (arm: DataArm): Promise<unknown[]> => {
      const result = await executeCli(context.binPath, ['resources', 'check', '--format', 'json'], {
        cwd: clean,
        env: { ...env, VAT_CACHE_DIR: arm.cacheDir, ...(arm.storeOff && { VAT_PROJECTION_STORE: 'off' }) },
      });
      const document = JSON.parse(result.stdout) as { findings?: Array<Record<string, unknown>> };
      return (document.findings ?? []).filter((finding) => finding['check'] === 'builtin-imports').map((finding) => finding['location']);
    };
    const storeOn = freshDataArm(context, false);
    // The store-on cold run is an answer too, not only the warm-up of the warm one.
    for (const located of [await runCheck(storeOn), await runCheck(freshDataArm(context, true)), await runCheck(storeOn)]) {
      expect(located).toStrictEqual(['lib/util.js', 'src/b.ts']);
    }
  });

  it('reports a file TypeScript refuses as one TS_FILE_NO_ROWS finding, exit 1, and answers from every other file', async () => {
    const broken = corpusWith({ config: TS_CHECK_CONFIG, broken: true });
    const runs = await storeOffColdWarm(context, broken, TS_DUMP_SQL);
    for (const run of [runs.storeOff, runs.cold, runs.warm]) {
      expect(run.status, run.stderr).toBe(1);
      const findings = (run.document['findings'] as Array<Record<string, unknown>>).map(({ code, severity, location }) => ({ code, severity, location }));
      expect(findings).toStrictEqual([{ code: 'TS_FILE_NO_ROWS', severity: 'error', location: BROKEN_SOURCE }]);
      const answer = tsAnswerOf(run.document);
      expect(answer['ts__routes']).toStrictEqual([...(CLEAN_TS_ANSWER['ts__routes'] ?? []), `${BROKEN_SOURCE}|ts|defective|TS_PARSE_ERROR`].toSorted((left, right) => left.localeCompare(right)));
      expect({ ...answer, ts__routes: [] }).toStrictEqual({ ...CLEAN_TS_ANSWER, ts__routes: [] });
    }
  });

  it('refuses a declared ts block that routes nothing, unless it sets allowEmpty', async () => {
    const nothing = corpusWith({ config: tsBlockConfig(['exclude: ["**"]']) });
    const refused = await countedQuery(context, nothing, freshDataArm(context, true), ROUTES_SQL);
    expect(refusalOf(refused)).toStrictEqual({ code: 'CONFIG_INVALID', message: expect.stringContaining('resources.extractors.ts is declared, but it routed no file') });

    const allowed = corpusWith({ config: tsBlockConfig(['exclude: ["**"]', 'allowEmpty: true']) });
    expect(answeredRows(await countedQuery(context, allowed, freshDataArm(context, true), ROUTES_SQL))).toStrictEqual([]);
  });
});

describe('the ts instance reads git content only (system test)', () => {
  it('answers as on the git crawl with the filesystem crawl forced, never routing the gitignored source file', async () => {
    const forced = { VAT_EXTENT_SOURCE: 'filesystem' };
    const planted = await countedQuery(context, clean, freshDataArm(context, true), 'SELECT path FROM git_content WHERE path LIKE \'ignored/%\'', forced);
    expect(existsSync(safePath.join(clean, IGNORED_SOURCE)), 'premise: the ignored file is on disk').toBe(true);
    expect(answeredRows(planted), `premise: ${IGNORED_SOURCE} is planted and is not git content`).toStrictEqual([]);
    const runs = await storeOffColdWarm(context, clean, TS_DUMP_SQL, forced);
    for (const run of [runs.storeOff, runs.cold, runs.warm]) {
      answeredRows(run);
      expect(tsAnswerOf(run.document)).toStrictEqual(CLEAN_TS_ANSWER);
    }
  });

  it.each([{ name: 'store off', storeOff: true }, { name: 'store on', storeOff: false }])('outside a work tree, $name: a ts statement is refused with GIT_NO_ANSWER, a data__* statement answers', async ({ storeOff }) => {
    const outside = writeCorpus(safePath.join(context.createTempDir(), 'plain'), { 'README.md': '# Readme\n', 'src/a.ts': 'export const a = 1;\n', 'package.json': '{"name": "plain"}\n' });
    const refused = await countedQuery(context, outside, freshDataArm(context, storeOff), 'SELECT path FROM ts_imports');
    expect(refusalOf(refused)).toStrictEqual({ code: 'INPUT_UNREADABLE', message: expect.stringContaining('it is not a git repository, or git could not read it') });
    const data = await countedQuery(context, outside, freshDataArm(context, storeOff), 'SELECT path, state FROM data__routes');
    expect(answeredRows(data)).toStrictEqual([{ path: 'package.json', state: 'facts' }]);
  });
});
