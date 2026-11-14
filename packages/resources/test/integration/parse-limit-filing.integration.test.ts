/**
 * What a parse run under limits other than the defaults files in the shared parse cache (ADR I6).
 *
 * A cache entry is served to every later run as an admission, so a run under looser limits may
 * admit a document but never file what a default run would refuse, and a run under tighter ones
 * refuses it and files nothing. The refusal each crawl lane reports is
 * `parse-limit-lanes.integration.test.ts`; a list past the default caps, parsed again on every
 * run, is `parse-limit-long-list.integration.test.ts`.
 */

import { writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ParsePoolOptions } from '../../src/parse-pool.js';
import { countFilesUnder, setupSubdirTestSuite } from '../test-helpers.js';

import { overDefaultRows, recordingPolicy, registryOverCache } from './recording-parse-policy.js';

const suite = setupSubdirTestSuite('vat-parse-limit-filing-');

/** Body links past {@link FEW_ROWS}: a link-only document, so the rows that breach are link rows. */
const OVER_FEW_ROWS_LINKS = 20;

/** An `outputRows` cap a handful of links can pass, so a link-row breach costs milliseconds. */
const FEW_ROWS: NonNullable<ParsePoolOptions['limits']> = { outputRows: 10 };

describe('body links counted as output rows', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('refuses a document whose links pass the cap and files nothing; a default run admits and files it', async () => {
    const links = Array.from({ length: OVER_FEW_ROWS_LINKS }, (_, index) => `[l${String(index)}](./t.md)`);
    const file = safePath.join(suite.tempDir, 'links.md');
    await writeFile(file, `${links.join('\n')}\n`, 'utf-8');
    const cacheDir = safePath.join(suite.suiteDir, `cache-link-rows-${String(Date.now())}`);

    const capped = registryOverCache(suite.tempDir, cacheDir, recordingPolicy({ firstLines: [] }, FEW_ROWS));
    expect(await capped.addResources([file])).toHaveLength(0);
    expect(capped.getParseRefusedResources().map((entry) => entry.reason)).toStrictEqual([
      expect.stringContaining('outputRows'),
    ]);
    expect(await countFilesUnder(cacheDir)).toBe(0);

    // The same links are well under the DEFAULT cap, so a default run admits
    // every link and files the entry: the refusal above was the cap, not the file.
    const defaults = registryOverCache(suite.tempDir, cacheDir, recordingPolicy({ firstLines: [] }, {}));
    const [admitted] = await defaults.addResources([file]);
    expect(admitted?.links).toHaveLength(OVER_FEW_ROWS_LINKS);
    expect(await countFilesUnder(cacheDir)).toBe(1);
  });
});

describe('a bounded run under limits looser than the defaults', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  // Both transports: on `wire` the parent files the entry, on `cache` the worker
  // does. Either way an entry past the DEFAULT caps would be served to a later
  // default run as an admission that run would have refused.
  it.each(['wire', 'cache'] as const)('admits the file over %s but files nothing a default run would serve', async (transport) => {
    const file = safePath.join(suite.tempDir, `loose-${transport}.md`);
    await writeFile(file, overDefaultRows(), 'utf-8');
    const cacheDir = safePath.join(suite.suiteDir, `cache-loose-${transport}-${String(Date.now())}`);

    const loose = registryOverCache(suite.tempDir, cacheDir, { ...recordingPolicy({ firstLines: [] }, { outputRows: 1_000_000 }), transport });
    expect(await loose.addResources([file])).toHaveLength(1);
    expect(await countFilesUnder(cacheDir)).toBe(0);

    const strict = registryOverCache(suite.tempDir, cacheDir, recordingPolicy({ firstLines: [] }, {}));
    expect(await strict.addResources([file])).toHaveLength(0);
    expect(strict.getParseRefusedResources().map((entry) => entry.reason)).toStrictEqual([
      expect.stringContaining('outputRows'),
    ]);
  });
});
