/**
 * The counters of `git_content` and the `tsconfig_*` family over the I0 corpus
 * (`../helpers/tsconfig-rows.ts`; spec 7.6 "Counters"):
 * - **no snapshot beyond the crawl's:** `git.snapshots` equal, per arm (store off, cold, warm),
 *   between the same run with and without a statement naming `git_content` and `tsconfig_*`
 *   relations, on the default git crawl source; 1 on store off, the crawl's;
 * - **one listing between them:** `git.listings` one higher on the warm arm that demands them (its
 *   one `assertListable`, which `git_content` and the tsconfig step share), equal elsewhere;
 * - **the step's own counters:** `resolve.tsconfig.configs` the demanded configs, `entriesListed`
 *   the git content handed to the parse, `reachesOutsideGit` the corpus's two such conditions.
 */

import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { answeredRows, countedQuery, freshDataArm, type CountedQuery } from '../helpers/data-rows.js';
import { writeTsconfigCorpus } from '../helpers/tsconfig-rows.js';

import { createSuiteContext } from './test-common.js';

const context = createSuiteContext('vat-tsconfig-counters-', import.meta.url);
let corpus = '';

beforeAll(() => {
  context.setup();
  corpus = context.createTempDir();
  writeTsconfigCorpus(corpus, (args) => runGitOrThrow(['-c', 'user.name=VAT Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: corpus }));
});
afterAll(() => context.cleanup());

/** The three arms of one question: store off, then a store's cold run and its warm run. */
async function storeOffColdWarm(sql: string): Promise<{ storeOff: CountedQuery; cold: CountedQuery; warm: CountedQuery }> {
  const storeOff = await countedQuery(context, corpus, freshDataArm(context, true), sql);
  const arm = freshDataArm(context, false);
  const cold = await countedQuery(context, corpus, arm, sql);
  const warm = await countedQuery(context, corpus, arm, sql);
  return { storeOff, cold, warm };
}

/** The same run's question without the family, and with `git_content` and three `tsconfig_*` relations. */
const WITHOUT_SQL = 'SELECT COUNT(*) AS n FROM resource_realizations';
const WITH_SQL = [
  'SELECT (SELECT COUNT(*) FROM resource_realizations) AS n,',
  '(SELECT COUNT(*) FROM git_content) AS content,',
  '(SELECT COUNT(*) FROM tsconfig_files) AS files,',
  '(SELECT COUNT(*) FROM tsconfig_configs) AS configs,',
  '(SELECT COUNT(*) FROM tsconfig_conditions WHERE code = \'TSCONFIG_REACHES_OUTSIDE_GIT\') AS reaches',
].join(' ');

const ARMS = ['storeOff', 'cold', 'warm'] as const;

/**
 * Red, seeded once and reverted: `gitContentListing` taking `freshGitTreeSnapshot` in place of the
 * memoized snapshot: "storeOff: no snapshot beyond the crawl's" failed, 2 against 1, 1 failure.
 */
describe('git_content and the tsconfig_* family spend no snapshot of their own (system test)', () => {
  it('git.snapshots equal with and without them per arm, git.listings one higher on the warm arm, and the step\'s counters', async () => {
    const withThem = await storeOffColdWarm(WITH_SQL);
    const without = await storeOffColdWarm(WITHOUT_SQL);
    expect((withThem.warm.document['data'] as Record<string, unknown>)['population'], 'premise: the warm run is served from the store').toBe('store');

    for (const arm of ARMS) {
      const [answer] = answeredRows(withThem[arm]);
      expect(withThem[arm].counters['git.snapshots'], `${arm}: no snapshot beyond the crawl's`).toBe(without[arm].counters['git.snapshots']);
      expect({
        configs: withThem[arm].counters['resolve.tsconfig.configs'],
        entriesListed: withThem[arm].counters['resolve.tsconfig.entriesListed'],
        reachesOutsideGit: withThem[arm].counters['resolve.tsconfig.reachesOutsideGit'],
      }, `${arm}: the step's counters`).toEqual({ configs: answer?.['configs'], entriesListed: answer?.['content'], reachesOutsideGit: answer?.['reaches'] });
      expect(answer?.['reaches'], `${arm}: premise: the corpus reaches outside git`).toBe(2);
    }
    expect(withThem.storeOff.counters['git.snapshots'], 'one per repository on a store-off run: the crawl\'s').toBe(1);
    // The warm demand's one listability check, shared by git_content and the tsconfig step.
    const listings = (runs: typeof withThem): number[] => ARMS.map((arm) => runs[arm].counters['git.listings']);
    expect({ with: listings(withThem), without: listings(without) }).toEqual({ with: [0, 0, 1], without: [0, 0, 0] });
  });
});
