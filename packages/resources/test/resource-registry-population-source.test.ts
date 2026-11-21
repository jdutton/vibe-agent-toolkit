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

import { compareCodeUnits, safePath } from '@vibe-agent-toolkit/utils';
import { setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ResourcePopulationSource } from '../src/projection/resource-population.js';
import { ResourceRegistry } from '../src/resource-registry.js';

import { noStoredDocument } from './helpers/population-run.js';

/** The fixture members every test in this file writes. */
const FIXTURE_NAMES = ['a.md', 'b.md', 'notes.txt'] as const;

/** Write this file's fixture members into `root`. */
async function writeFixture(root: string): Promise<void> {
  await Promise.all(FIXTURE_NAMES.map((name) =>
    writeFile(safePath.join(root, name), `# ${name}\n`, 'utf-8')));
}

/** What every stub enumeration reports about itself. */
const STUB_PROVENANCE = { outcome: { population: 'derived', stored: 'no-store' }, extentSource: 'filesystem' } as const;

/**
 * A source that offers `names` under whatever root it is ASKED for, and records
 * every root it was asked about.
 */
function stubSource(
  names: readonly string[] = FIXTURE_NAMES,
): { source: ResourcePopulationSource; offeredRoots: string[] } {
  const offeredRoots: string[] = [];
  return {
    offeredRoots,
    source: {
      storedDocument: noStoredDocument,
      enumerate: (root: string) => {
        offeredRoots.push(root);
        return Promise.resolve({
          paths: names.map((name) => safePath.join(root, name)),
          conditions: [],
          ...STUB_PROVENANCE,
          stored: null,
        });
      },
    },
  };
}

/** Registry members as root-relative paths, in a stable order. */
function memberPaths(root: string, resources: readonly { filePath: string }[]): string[] {
  return resources.map((r) => safePath.relative(root, r.filePath)).sort(compareCodeUnits);
}

/** Crawl `baseDir`'s markdown from `populationSource`, with `exclude` when given. */
async function crawlMarkdown(baseDir: string, populationSource: ResourcePopulationSource, exclude?: string[]): Promise<{ filePath: string }[]> {
  const registry = new ResourceRegistry({ baseDir });
  const { resources } = await registry.crawl({
    ignoredRefusals: 'record',
    unreadable: 'refuse',
    outputs: [],
    baseDir,
    include: ['**/*.md'],
    ...(exclude === undefined ? {} : { exclude }),
    populationSource,
  });
  return resources;
}

describe('ResourceRegistry.crawl with a populationSource', () => {
  const suite = setupAsyncTempDirSuite('registry-population-source');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
    await writeFixture(tempDir);
  });

  it('takes its paths from the source, not from the tree', async () => {
    // A path the source never offers, proving nothing else enumerated: `b.md` is
    // on disk and a real crawl would find it.
    const resources = await crawlMarkdown(tempDir, stubSource(['a.md']).source);

    expect(resources.map((r) => safePath.relative(tempDir, r.filePath))).toEqual(['a.md']);
  });

  it('still applies include patterns to what the source offered', async () => {
    const resources = await crawlMarkdown(tempDir, stubSource().source);

    // `notes.txt` was offered and refused HERE. A source that pre-filtered would
    // make this assertion pass without the registry doing anything.
    expect(memberPaths(tempDir, resources)).toEqual(['a.md', 'b.md']);
  });

  it('still applies exclude patterns to what the source offered', async () => {
    const resources = await crawlMarkdown(tempDir, stubSource().source, ['**/b.md']);

    expect(resources.map((r) => safePath.relative(tempDir, r.filePath))).toEqual(['a.md']);
  });

  it('asks the source about the resolved base, and hands its provenance back beside what it admitted', async () => {
    const registry = new ResourceRegistry({ baseDir: tempDir });
    const { source, offeredRoots } = stubSource(['a.md']);

    const { resources, population } = await registry.crawl({ ignoredRefusals: 'record', unreadable: 'refuse', outputs: [], baseDir: tempDir, include: ['**/*.md'], populationSource: source });

    expect(offeredRoots).toEqual([safePath.resolve(tempDir)]);
    expect(population).toEqual(STUB_PROVENANCE);
    expect(memberPaths(tempDir, resources)).toEqual(['a.md']);
  });
});
