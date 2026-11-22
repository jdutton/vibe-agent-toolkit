/**
 * Which roots of a run the full population is paid for, and which are listed.
 *
 * The full population reads and keys every file under a root so that one stored
 * extent answers every resources lane next time; it pays off only where a store
 * keeps it. Every other root of the run — another root, the home with no store —
 * is listed: the crawl's members alone, no other file read or keyed. And the
 * home is the filesystem's answer, so a second spelling of it is served by its
 * store, while another root never touches the store at all.
 */

import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, readWorkCounters, safePath } from '@vibe-agent-toolkit/utils';
import { GitTracker } from '@vibe-agent-toolkit/utils/git';
import { createSymlink, symlinkCapability } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, describe, expect, it } from 'vitest';

import {
  emptyBlobRows,
  type BlobScopedRows,
  type ExtentKey,
  type ExtentScopedRows,
  type FactStore,
} from '../../src/index.js';
import type { PopulationCache } from '../../src/projection/merge.js';
import { IGNORE_HOME_SETTLEMENT, type RunPopulation, withRunPopulation } from '../../src/projection/run-population.js';
import { ResourceRegistry } from '../../src/resource-registry.js';
import { git, nestedRepository } from '../helpers/git-fixture.js';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Files no markdown crawl admits: each one the full population would read and key. */
const GENERATED = 40;

/** A home tree with one document, and a nested root with one document beside {@link GENERATED} sources. */
function fixture(): { home: string; nested: string } {
  const home = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-run-population-scope-'));
  roots.push(home);
  const files: Record<string, string> = {
    'README.md': '# Home\n',
    'nested/guide.md': '# Nested\n',
  };
  for (let index = 0; index < GENERATED; index++) files[`nested/src/f${String(index)}.ts`] = `export const n = ${String(index)};\n`;
  for (const [relative, content] of Object.entries(files)) {
    const path = safePath.join(home, relative);
    mkdirSyncReal(safePath.join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return { home, nested: safePath.join(home, 'nested') };
}

/**
 * A store that records the extent keys it is asked about and holds nothing, so
 * every read misses and the population always derives and writes: "no key was
 * touched" is then a statement about which roots reach the store.
 */
function recordingStore(): FactStore & { touchedRootIds: string[] } {
  const touchedRootIds: string[] = [];
  return {
    touchedRootIds,
    writeBlobFacts: () => Promise.resolve(),
    readBlobFacts: (): Promise<BlobScopedRows> => Promise.resolve(emptyBlobRows()),
    writeExtent: (key: ExtentKey) => {
      touchedRootIds.push(key.rootId);
      return Promise.resolve();
    },
    readExtent: (key: ExtentKey): Promise<ExtentScopedRows | undefined> => {
      touchedRootIds.push(key.rootId);
      return Promise.resolve(undefined);
    },
    close: () => Promise.resolve(),
  };
}

/** A run homed at `home`, over `store` when one is given. */
function inRun<T>(home: string, store: FactStore | undefined, work: (population: RunPopulation) => Promise<T>): Promise<T> {
  const cache: PopulationCache | undefined = store === undefined
    ? undefined
    : { store, treeHash: 'test-tree-hash', treeUnchanged: () => true };
  return withRunPopulation(
    {
      root: home,
      outputs: [],
      gitTracker: new GitTracker(home),
      cacheOf: () => Promise.resolve(cache),
      questionCacheOf: () => Promise.resolve(cache),
      holdsStore: true,
      collectionsFor: () => Promise.resolve(undefined),
      onHomeSettled: IGNORE_HOME_SETTLEMENT,
    },
    work,
  );
}

/** Crawl `baseDir`'s markdown (or `include`) through the run, and count the content reads it made. */
async function crawlMarkdown(
  population: RunPopulation,
  baseDir: string,
  include: readonly string[] = ['**/*.md'],
): Promise<{ members: string[]; reads: number }> {
  const before = readWorkCounters()['content.read'];
  const registry = ResourceRegistry.forRun(population, { baseDir }).view({ baseDir });
  await registry.crawl({ ignoredRefusals: 'record', baseDir, include: [...include], outputs: [], unreadable: 'refuse', populationSource: population.source });
  const members = registry.getAllResources().map((resource) => safePath.relative(baseDir, resource.filePath)).toSorted((left, right) => left.localeCompare(right));
  return { members, reads: readWorkCounters()['content.read'] - before };
}

describe('a root with no store is listed: the crawl reads its members and nothing else', () => {
  it('another root of the run', async () => {
    const { home, nested } = fixture();
    const { members, reads } = await inRun(home, recordingStore(), (population) => crawlMarkdown(population, nested));
    expect(members).toEqual(['guide.md']);
    expect(reads, 'one read: the one member').toBe(1);
  });

  it('the home root, when the run has no store', async () => {
    const { home } = fixture();
    const { members, reads } = await inRun(home, undefined, (population) => crawlMarkdown(population, home));
    expect(members).toEqual(['nested/guide.md', 'README.md']);
    expect(reads, 'one read per member').toBe(2);
  });

  it('positive control: the home root with a store is the full population, every file read', async () => {
    const { home } = fixture();
    const { members, reads } = await inRun(home, recordingStore(), (population) => crawlMarkdown(population, home));
    expect(members).toEqual(['nested/guide.md', 'README.md']);
    expect(reads).toBe(2 + GENERATED);
  });
});

describe('only the home root reaches the store, by the filesystem\'s answer to which root it is', () => {
  it('another root opens no store and touches no key', async () => {
    const { home, nested } = fixture();
    const store = recordingStore();
    await inRun(home, store, (population) => crawlMarkdown(population, nested));
    expect(store.touchedRootIds).toEqual([]);
  });

  it('positive control: the home root does touch the store', async () => {
    const { home } = fixture();
    const store = recordingStore();
    await inRun(home, store, (population) => crawlMarkdown(population, home));
    expect(store.touchedRootIds.length).toBeGreaterThan(0);
  });

  const symlinks = symlinkCapability();
  (symlinks === null ? it.skip : it)('a symlinked spelling of the home root is the home: served by its store, its paths in the spelling asked', async () => {
    if (symlinks === null) return;
    const { home } = fixture();
    const alias = `${home}-alias`;
    roots.push(alias);
    createSymlink(symlinks, home, alias, 'dir');
    const store = recordingStore();
    const { members, reads } = await inRun(home, store, (population) => crawlMarkdown(population, alias));
    expect(store.touchedRootIds.length).toBeGreaterThan(0);
    expect(members).toEqual(['nested/guide.md', 'README.md']);
    // The home's full population, plus each member admitted under the alias's
    // spelling: the run's content cache is keyed by the path asked.
    expect(reads).toBe(2 + GENERATED + 2);
  });
});

/**
 * A repository with a tracked document deleted from the working tree, an ignored one, and an
 * untracked nested repository git names as one entry.
 */
function repository(): string {
  const { home } = fixture();
  writeFileSync(safePath.join(home, '.gitignore'), 'ignored.md\n');
  writeFileSync(safePath.join(home, 'ignored.md'), '# Ignored\n');
  writeFileSync(safePath.join(home, 'gone.md'), '# Gone\n');
  git(home, 'init', '-q');
  git(home, 'add', 'gone.md');
  unlinkSync(safePath.join(home, 'gone.md'));
  nestedRepository(home, 'vendor/sub', false);
  return home;
}

describe('in a repository a listing is git\'s names, never a snapshot', () => {
  it('lists what git names and drops a deleted tracked file', async () => {
    const home = repository();
    const { members, reads } = await inRun(home, undefined, (population) => crawlMarkdown(population, home));
    // Not `gone.md` (deleted), not `ignored.md`, and not `vendor/sub/README.md`: git names the
    // nested repository as one entry, so the ignore oracle calls its files ignored, as it does
    // for a stored population.
    expect(members).toEqual(['nested/guide.md', 'README.md']);
    expect(reads, 'one read per member').toBe(2);
  });

  it('lists a root once per run: a second crawl with other globs asks git nothing', async () => {
    const home = repository();
    const calls = await inRun(home, undefined, async (population) => {
      await crawlMarkdown(population, home);
      const before = readWorkCounters()['git.calls'];
      const { members } = await crawlMarkdown(population, home, ['nested/**/*.md']);
      expect(members).toEqual(['nested/guide.md']);
      return readWorkCounters()['git.calls'] - before;
    });
    expect(calls).toBe(0);
  });
});
