/**
 * A frontmatter list too long for the default caps, under a run's looser limits (ADR I6).
 *
 * A cache entry is served to every later run as an admission, so a run under looser limits may
 * admit a document but never file what a default run would refuse. This document is past the
 * default `outputRows`, so it is parsed again on every run. The other filing cases are
 * `parse-limit-filing.integration.test.ts`.
 */

import { writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { countFilesUnder, setupSubdirTestSuite } from '../test-helpers.js';

import { type Dispatched, recordingPolicy, registryOverCache } from './recording-parse-policy.js';

const suite = setupSubdirTestSuite('vat-parse-limit-long-list-');

/** Items in the long frontmatter list: past the ~130,000 arguments a spread fits on Node's default stack. */
const LONG_LIST_ITEMS = 200_000;

/** Limits loose enough for the long list's own rows, which count against `outputRows`. */
const LONG_LIST_LIMITS = { outputRows: 1_000_000, outputBytes: 64 * 1024 * 1024 } as const;

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
      const registry = registryOverCache(suite.tempDir, cacheDir, recordingPolicy(dispatched, LONG_LIST_LIMITS));
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
