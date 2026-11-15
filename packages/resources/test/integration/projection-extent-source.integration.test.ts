/**
 * `buildResourcePopulation` reports the enumerator that RAN, not the one requested. Moved out of the
 * unit tier: the repository case spawns git, which is integration-shaped work.
 */
import { writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { EXTENT_SOURCE_ENV, EXTENT_SOURCE_GIT, type CrawlSourceKind } from '../../src/projection/crawl-source.js';
import { buildResourcePopulation } from '../../src/projection/resource-population.js';
import { setupSubdirTestSuite } from '../test-helpers.js';

const suite = setupSubdirTestSuite('resource-extent-source-');

/** One markdown file in a fresh tree, a repository around it or not, then the enumerator the run used. */
async function extentSourceOver(tree: { repository: boolean }): Promise<CrawlSourceKind> {
  await writeFile(safePath.join(suite.tempDir, 'a.md'), '# A\n', 'utf-8');
  if (tree.repository) runGitOrThrow(['init', '--quiet'], { cwd: suite.tempDir });
  const { extentSource } = await buildResourcePopulation({ outputs: [], root: suite.tempDir });
  return extentSource;
}

describe('buildResourcePopulation reports which enumerator ran', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);
  afterEach(() => {
    delete process.env[EXTENT_SOURCE_ENV];
  });

  // ⚠️ Not "when nothing selects git" any more — git IS what nothing selects.
  // This fixture is a bare temp directory with no repository above it, so what
  // it pins is the FALLBACK, and the title has to say so or the next reader
  // takes it as evidence the default is still the walk.
  it('reports the filesystem enumerator on a tree with no repository above it', async () => {
    expect(await extentSourceOver({ repository: false })).toBe('filesystem');
  });

  it('reports git when git is selected inside a repository', async () => {
    process.env[EXTENT_SOURCE_ENV] = EXTENT_SOURCE_GIT;

    expect(await extentSourceOver({ repository: true })).toBe('git');
  });

  it('reports the walk when git is selected OUTSIDE a repository', async () => {
    // Deliberately no `git init`. `crawlSourceFor` declines git here and hands
    // back the walk WITHOUT saying so anywhere else, which is the whole reason
    // this field exists: an A/B varying only this variable would otherwise run
    // one enumerator twice, agree with itself, and read as "safe to flip".
    process.env[EXTENT_SOURCE_ENV] = EXTENT_SOURCE_GIT;

    // The request was `git`; the answer is what RAN. If this ever reports
    // `git`, the report has become a copy of the environment and every
    // comparison built on it is void.
    expect(await extentSourceOver({ repository: false })).toBe('filesystem');
  });
});
