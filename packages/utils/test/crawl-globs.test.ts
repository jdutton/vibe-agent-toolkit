import { writeFileSync } from 'node:fs';

import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';

import {
  BUILD_OUTPUT_GLOBS,
  crawlDirectorySync,
  NEVER_CRAWL_GLOBS,
} from '../src/file-crawler.js';
import { mkdirSyncReal, safePath, toForwardSlash } from '../src/path-utils.js';
import { setupSyncTempDirSuite } from '../src/test-helpers.js';

/**
 * `.turbo` — turborepo's per-package task-log and cache directory.
 *
 * **Which list it belongs on, and why it is `NEVER_CRAWL_GLOBS`.** The line
 * between the two lists is not "who produced it" — `coverage/` is tool output
 * too, and it sits in `NEVER_CRAWL_GLOBS`. The line is *does any VAT lane exist
 * precisely to look at it*. `dist/` is in `BUILD_OUTPUT_GLOBS` because skill
 * discovery must walk it to classify source vs. built skills, and `vat verify`
 * validates the dist artifacts. Nothing in VAT ever walks `.turbo`: it holds
 * `turbo-<task>.log` telemetry and, when `cacheDir` points inside it,
 * hash-keyed cache entries that are *copies* of package outputs — the same
 * duplicate-file failure `**\/.worktrees/**` is on the never-crawl list to
 * prevent.
 *
 * Putting it in `BUILD_OUTPUT_GLOBS` would have it backwards: a lane that
 * spreads only `NEVER_CRAWL_GLOBS` is by definition a lane that *wants* to see
 * built output, and that is exactly the lane that must not descend into a
 * hash-keyed cache of copies.
 *
 * Note this only bites on the manual-walk path — but that is the only path it
 * could ever bite on, since `.turbo` is gitignored, so `git ls-files` never
 * reports it. Same as every other entry on the never-crawl list.
 */
const TURBO_GLOB = '**/.turbo/**';

describe('the canonical crawl-exclusion lists', () => {
  it('never-crawls .turbo — turborepo logs and cache, no lane wants them', () => {
    expect(NEVER_CRAWL_GLOBS).toContain(TURBO_GLOB);
  });

  // Placement IS the decision here, so pin both halves: a later "tidy-up" that
  // moves it to the other list has to argue with this line.
  it('does not classify .turbo as build output', () => {
    expect([...BUILD_OUTPUT_GLOBS]).not.toContain(TURBO_GLOB);
  });
});

describe('.turbo is excluded by the crawler that ships, not just by the list', () => {
  const suite = setupSyncTempDirSuite('crawl-globs');

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  /**
   * Exercised through `crawlDirectorySync` rather than through a hand-rolled
   * picomatch call: `.turbo` is a DOT-directory, and whether a leading-dot
   * segment is traversable is decided by the crawler's own `dot: true` option.
   * A test that recompiles the pattern itself would be asserting against its own
   * matcher configuration, not the shipped one.
   *
   * `respectGitignore: false` because a `mkdtemp` fixture is not a git repo —
   * and because the manual walk is the only path these globs are consulted on.
   */
  it('a default crawl walks past .turbo and still finds real content', () => {
    const tempDir = suite.getTempDir();
    /* eslint-disable security/detect-non-literal-fs-filename -- tempDir is a controlled mkdtemp directory */
    mkdirSyncReal(safePath.join(tempDir, '.turbo'), { recursive: true });
    writeFileSync(safePath.join(tempDir, '.turbo', 'turbo-build.log'), 'cache hit');
    mkdirSyncReal(safePath.join(tempDir, '.turbo', 'cache', 'abc123'), { recursive: true });
    writeFileSync(safePath.join(tempDir, '.turbo', 'cache', 'abc123', 'SKILL.md'), '# copy');
    mkdirSyncReal(safePath.join(tempDir, 'docs'), { recursive: true });
    writeFileSync(safePath.join(tempDir, 'docs', 'guide.md'), '# Guide');
    /* eslint-enable security/detect-non-literal-fs-filename */

    const found = crawlDirectorySync({ baseDir: tempDir, respectGitignore: false }).map((p) =>
      toForwardSlash(p),
    );

    expect(found.filter((p) => p.includes('/.turbo/'))).toEqual([]);
    // Negative control: the crawl really ran and really can see this fixture,
    // so the assertion above cannot pass by finding nothing at all.
    expect(found.some((p) => p.endsWith('/docs/guide.md'))).toBe(true);
  });
});
