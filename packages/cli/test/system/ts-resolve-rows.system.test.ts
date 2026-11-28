/**
 * The resolved import graph through the built CLI: `ts_import_targets`, `ts_program_files` and `ts_import_conditions` over the clean
 * corpus of `../helpers/ts-resolve-rows.ts`, which holds every fixture.
 *
 * - **I0:** store-off, cold, warm and with half the blob tier evicted, the dump of every relation
 *   answers a census of the three identically; each holds rows, every `targetKind` occurs, and the
 *   rows are each fixture's expected rows. The corpus routes a TS18003 `tsconfig.json` no script
 *   invokes, so this is also demand narrowing's first half: it refuses nothing.
 * - **Demand narrowing, second half:** the same config invoked by a root script refuses with
 *   `TSCONFIG_PARSE_ERRORS`, store off, cold and warm.
 * - **Excluded reached file:** a file only a `referencePath` reaches, `exclude`d from the `ts` instance, refuses each of
 *   the three relations with `DATA_REQUEST_UNROUTED`, naming the config and the file; store off,
 *   cold and warm for one, store off for the other two.
 *
 * Reds, each seeded once in `ts-resolve-step.ts`, rebuilt, run and reverted:
 * - the output map off (`outputMaps.combined([])`): the clean seed failed on store-off at the
 *   corpus's `ts_import_targets` (every `member` row through `exports` naming an output became
 *   `unresolved`), 1 failure;
 * - mode forced to the file's implied format: the clean seed failed on store-off at the corpus's
 *   `ts_import_targets` (the dynamic `import()` and the `resolution-mode` rows answered `require`),
 *   1 failure.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ROOT_PACKAGE_INVOKING_BROKEN } from '../../../resources/test/helpers/ts-resolve-corpus.js';
import { seedRunner, seedTitle, treeSeedSuite, type I0Seed } from '../helpers/cache-differential.js';
import { refusalOf, storeOffColdWarm, type CountedQuery, countedQuery, freshDataArm, EVERY_ARM } from '../helpers/data-rows.js';
import {
  expectTsResolveCensus,
  REACHED_ONLY_FILE,
  TS_RESOLVE_FILES,
  TS_RESOLVE_RELATIONS,
  TS_RESOLVE_TREE,
} from '../helpers/ts-resolve-rows.js';
import { tsBlockConfig } from '../helpers/ts-rows.js';
import { commitTestFixture, writeCorpus } from '../test-helpers.js';

import { createSuiteContext } from './test-common.js';

/** No plant: every arm over the clean corpus. */
const CLEAN: I0Seed = {
  name: 'cleanTsResolveCorpus',
  needs: null,
  arms: EVERY_ARM,
  verbs: ['query'],
  expect: { agrees: { because: 'the clean ts resolve corpus, unplanted', storeDeclines: null } },
  consumed: { runs: EVERY_ARM.map((arm) => `${arm}:measured` as const), check: (runs) => expectTsResolveCensus(runs) },
};

describe('the resolved import graph answers alike in every arm (system test)', () => {
  const run = seedRunner(treeSeedSuite(TS_RESOLVE_TREE, import.meta.url));
  it(seedTitle(CLEAN), async () => expect(await run(CLEAN)).toEqual(CLEAN.arms));
});

/** The clean corpus with `overrides`, committed, in a temp directory of `context`. */
function corpusWith(context: { readonly createTempDir: () => string }, overrides: Readonly<Record<string, string>>): string {
  const root = safePath.join(context.createTempDir(), 'corpus');
  writeCorpus(root, { ...TS_RESOLVE_FILES, ...overrides });
  commitTestFixture(root);
  return root;
}

/** Every run refused with `code`, its message naming each of `named`. */
function expectRefused(runs: readonly CountedQuery[], code: string, named: readonly string[]): void {
  for (const run of runs) {
    const { message } = refusalOf(run);
    expect(message, run.stderr).toContain(`${code}:`);
    for (const text of named) expect(message).toContain(text);
  }
}

describe('the resolved import graph refuses (system test)', () => {
  const context = createSuiteContext('vat-ts-resolve-rows-', import.meta.url);
  beforeAll(() => context.setup());
  afterAll(() => context.cleanup());

  it('a TS18003 config a root script invokes refuses with TSCONFIG_PARSE_ERRORS, store off, cold and warm', async () => {
    const root = corpusWith(context, { 'package.json': ROOT_PACKAGE_INVOKING_BROKEN });
    const runs = await storeOffColdWarm(context, root, 'SELECT * FROM ts_import_targets');
    expectRefused([runs.storeOff, runs.cold, runs.warm], 'TSCONFIG_PARSE_ERRORS', ["'fixtures/broken/tsconfig.json'", 'TS18003']);
  });

  it('an excluded file a config reaches refuses each of the three relations with DATA_REQUEST_UNROUTED', async () => {
    const root = corpusWith(context, { 'vibe-agent-toolkit.config.yaml': tsBlockConfig(['exclude:', `  - "${REACHED_ONLY_FILE}"`]) });
    const named = ["'packages/refs/tsconfig.json'", `'${REACHED_ONLY_FILE}'`, 'resources.extractors.ts.exclude'];
    const [first, ...rest] = TS_RESOLVE_RELATIONS;
    const runs = await storeOffColdWarm(context, root, `SELECT * FROM ${first}`);
    const others = await Promise.all(rest.map((relation) => countedQuery(context, root, freshDataArm(context, true), `SELECT * FROM ${relation}`)));
    expectRefused([runs.storeOff, runs.cold, runs.warm, ...others], 'DATA_REQUEST_UNROUTED', named);
  });
});
