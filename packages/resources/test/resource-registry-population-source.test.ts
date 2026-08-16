/**
 * The `populationSource` seam on `ResourceRegistry.crawl`.
 *
 * The seam splits one question into two that used to be welded together:
 * **which paths exist** (the source's job) and **which of them this project's
 * globs admit** (still the registry's). These tests pin that split, because a
 * lane that filtered in its source as well would put the project's include and
 * exclude patterns in two places — and the whole reason a second crawler is
 * reviewable is that a difference in its output is a difference in the
 * POPULATION, not in what the globs were taken to mean.
 *
 * The source is a stub rather than the real projection on purpose: the real one
 * enumerates the filesystem, and a test that crawls to decide what the crawl
 * returns cannot show a path being offered and refused.
 */
import { writeFile } from 'node:fs/promises';

import { compareCodeUnits, safePath, setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ResourceRegistry } from '../src/resource-registry.js';

describe('ResourceRegistry.crawl with a populationSource', () => {
  const suite = setupAsyncTempDirSuite('registry-population-source');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
    await Promise.all(['a.md', 'b.md', 'notes.txt'].map((name) =>
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture beneath a mkdtemp root
      writeFile(safePath.join(tempDir, name), `# ${name}\n`, 'utf-8')));
  });

  /** Every fixture file, as the projection would offer them: absolute, unfiltered. */
  const offerEverything = (root: string): Promise<readonly string[]> =>
    Promise.resolve(['a.md', 'b.md', 'notes.txt'].map((name) => safePath.join(root, name)));

  it('takes its paths from the source instead of walking the tree', async () => {
    const registry = new ResourceRegistry({ baseDir: tempDir });

    const resources = await registry.crawl({
      baseDir: tempDir,
      include: ['**/*.md'],
      // A path the source never offers, proving the walk did not run: `b.md` is
      // on disk and a real crawl would find it.
      populationSource: (root) => Promise.resolve([safePath.join(root, 'a.md')]),
    });

    expect(resources.map((r) => safePath.relative(tempDir, r.filePath))).toEqual(['a.md']);
  });

  it('still applies include patterns to what the source offered', async () => {
    const registry = new ResourceRegistry({ baseDir: tempDir });

    const resources = await registry.crawl({
      baseDir: tempDir,
      include: ['**/*.md'],
      populationSource: offerEverything,
    });

    // `notes.txt` was offered and refused HERE. A source that pre-filtered would
    // make this assertion pass without the registry doing anything.
    expect(resources.map((r) => safePath.relative(tempDir, r.filePath)).sort(compareCodeUnits))
      .toEqual(['a.md', 'b.md']);
  });

  it('still applies exclude patterns to what the source offered', async () => {
    const registry = new ResourceRegistry({ baseDir: tempDir });

    const resources = await registry.crawl({
      baseDir: tempDir,
      include: ['**/*.md'],
      exclude: ['**/b.md'],
      populationSource: offerEverything,
    });

    expect(resources.map((r) => safePath.relative(tempDir, r.filePath))).toEqual(['a.md']);
  });
});
