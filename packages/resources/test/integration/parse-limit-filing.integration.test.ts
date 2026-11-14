/**
 * What a parse run under limits other than the defaults files in the shared parse cache (ADR I6).
 *
 * A cache entry is served to every later run as an admission, so a run under looser limits may
 * admit a document but never file what a default run would refuse; a run under tighter ones
 * refuses it and files nothing; and a document past the default caps is parsed again on every
 * run. The refusal each crawl lane reports is `parse-limit-lanes.integration.test.ts`.
 */

import { writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ParseCache } from '../../src/parse-cache.js';
import type { ParsePoolOptions } from '../../src/parse-pool.js';
import { ResourceRegistry } from '../../src/resource-registry.js';
import { countFilesUnder, setupSubdirTestSuite } from '../test-helpers.js';

import { type Dispatched, overDefaultRows, recordingPolicy } from './recording-parse-policy.js';

const suite = setupSubdirTestSuite('vat-parse-limit-filing-');

/** Items in the long frontmatter list: past the ~130,000 arguments a spread fits on Node's default stack. */
const LONG_LIST_ITEMS = 200_000;

/** Limits loose enough for the long list's own rows, which count against `outputRows`. */
const LONG_LIST_LIMITS: NonNullable<ParsePoolOptions['limits']> = { outputRows: 1_000_000, outputBytes: 64 * 1024 * 1024 };

describe('a frontmatter list of 200,000 items, decoded on the parent thread', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  // Past the DEFAULT `outputRows`, so no run files it (`ParseCache.setByKey`): each
  // run parses it again under the looser limits, and the parent rebuilds the
  // whole list from the worker's encoding every time. A hit's decode at this size
  // is the codec's own round-trip test.
  it('is admitted with every item on every run, and never filed past the default caps', async () => {
    const items = Array.from({ length: LONG_LIST_ITEMS }, (_, index) => String(index % 10));
    const file = safePath.join(suite.tempDir, 'long.md');
    await writeFile(file, `---\nitems: [${items.join(', ')}]\n---\n\n# Long\n`, 'utf-8');
    const cacheDir = safePath.join(suite.suiteDir, `cache-long-${String(Date.now())}`);

    const runOnce = async (dispatched: Dispatched): Promise<{ admitted: number; listed: unknown; refused: number }> => {
      const registry = new ResourceRegistry({
        baseDir: suite.tempDir,
        parseCache: new ParseCache({ cacheDir, enabled: true }),
        parsePool: recordingPolicy(dispatched, LONG_LIST_LIMITS),
      });
      const admitted = await registry.addResources([file]);
      const refused = (await registry.validate()).issues.filter((issue) => issue.code.startsWith('RESOURCE_PARSE_')).length;
      const listed = admitted[0]?.frontmatter?.['items'];
      return { admitted: admitted.length, listed: Array.isArray(listed) ? listed.length : listed, refused };
    };

    const first: Dispatched = { firstLines: [] };
    expect(await runOnce(first)).toStrictEqual({ admitted: 1, listed: LONG_LIST_ITEMS, refused: 0 });
    expect(first.firstLines).toHaveLength(1);
    expect(await countFilesUnder(cacheDir)).toBe(0);

    const second: Dispatched = { firstLines: [] };
    expect(await runOnce(second)).toStrictEqual({ admitted: 1, listed: LONG_LIST_ITEMS, refused: 0 });
    expect(second.firstLines).toHaveLength(1);
  });
});

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

    const capped = new ResourceRegistry({
      baseDir: suite.tempDir,
      parseCache: new ParseCache({ cacheDir, enabled: true }),
      parsePool: recordingPolicy({ firstLines: [] }, FEW_ROWS),
    });
    expect(await capped.addResources([file])).toHaveLength(0);
    expect(capped.getParseRefusedResources().map((entry) => entry.reason)).toStrictEqual([
      expect.stringContaining('outputRows'),
    ]);
    expect(await countFilesUnder(cacheDir)).toBe(0);

    // The same links are well under the DEFAULT cap, so a default run admits
    // every link and files the entry: the refusal above was the cap, not the file.
    const defaults = new ResourceRegistry({
      baseDir: suite.tempDir,
      parseCache: new ParseCache({ cacheDir, enabled: true }),
      parsePool: recordingPolicy({ firstLines: [] }, {}),
    });
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

    const loose = new ResourceRegistry({
      baseDir: suite.tempDir,
      parseCache: new ParseCache({ cacheDir, enabled: true }),
      parsePool: { ...recordingPolicy({ firstLines: [] }, { outputRows: 1_000_000 }), transport },
    });
    expect(await loose.addResources([file])).toHaveLength(1);
    expect(await countFilesUnder(cacheDir)).toBe(0);

    const strict = new ResourceRegistry({
      baseDir: suite.tempDir,
      parseCache: new ParseCache({ cacheDir, enabled: true }),
      parsePool: recordingPolicy({ firstLines: [] }, {}),
    });
    expect(await strict.addResources([file])).toHaveLength(0);
    expect(strict.getParseRefusedResources().map((entry) => entry.reason)).toStrictEqual([
      expect.stringContaining('outputRows'),
    ]);
  });
});
