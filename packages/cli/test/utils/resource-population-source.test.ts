/**
 * The run's population source (`withRunContext`'s `run.population.source`) — the
 * one source every verb's registry crawls through, whether or not it goes
 * through `loadResourcesWithConfig`.
 *
 * `vat skills build`, `vat skills validate` and `vat claude plugin build` each
 * build their own view of the run's registry, so they reach the population only
 * through this source: same store, same git-ignore oracle.
 *
 * The assertions here are about the SOURCE'S ANSWER, never about the
 * environment: a source that reports itself from the env it read rather than
 * from what it did is the exact failure this seam keeps hitting.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import type { ResourcePopulationSource } from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NO_HOME_SETTLED_LISTENER, withRunContext } from '../../src/utils/resource-loader.js';

/** The two fixture members, named once so the writes and the expectation agree. */
const GUIDE_REL = 'docs/guide.md';
const ASSET_REL = 'docs/asset.txt';

/** A crawl that admits every file: the source answers with exactly the members asked for. */
const ALL_FILES = { include: ['**/*'], exclude: [], ignoredRefusals: 'record' } as const;

let root: string;

beforeEach(() => {
  root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-population-source-'));
  // Both fixture members sit under one directory, so it is made once here and
  // each write below is a plain `writeFileSync` rather than a local helper.
  mkdirSyncReal(safePath.join(root, 'docs'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Run `work` against the population source of a run rooted at the fixture.
 *
 * @param work - What to do with the source, inside the run
 * @returns Whatever `work` returned
 */
function withSource<T>(work: (source: ResourcePopulationSource) => Promise<T>): Promise<T> {
  return withRunContext({ projectionStore: 'on-demand', root, tree: 'read-only', outputs: [], homeSettledListener: NO_HOME_SETTLED_LISTENER }, (run) => work(run.population.source));
}

describe('the run\'s population source', () => {
  it('enumerates every member the crawl asks for', async () => {
    writeFileSync(safePath.join(root, GUIDE_REL), '# guide\n', 'utf-8');
    writeFileSync(safePath.join(root, ASSET_REL), 'asset', 'utf-8');

    const paths = await withSource(async (source) => [...(await source.enumerate(root, [], 'refuse', ALL_FILES)).paths]);

    // Every file the crawl's globs admit, of every kind: a no-store root is
    // listed to the crawl's members, and these members are every file.
    expect(
      paths.map((p) => safePath.relative(root, p)).sort((left, right) => left.localeCompare(right)),
    ).toEqual([ASSET_REL, GUIDE_REL]);
  });

  it('carries the enumeration\'s own outcome and enumerator out with its paths', async () => {
    writeFileSync(safePath.join(root, GUIDE_REL), '# guide\n', 'utf-8');

    const enumeration = await withSource((source) => source.enumerate(root, [], 'refuse', ALL_FILES));

    // A temp tree outside any repository has no store, so the run derived, on
    // the filesystem enumerator — told by the enumeration, not by a side channel.
    expect(enumeration.outcome).toEqual({ population: 'derived', stored: 'no-store' });
    expect(enumeration.extentSource).toBe('filesystem');
  });

  it('says nothing about a binary it declined: membership verbs stay quiet', async () => {
    writeFileSync(safePath.join(root, GUIDE_REL), '# guide\n', 'utf-8');
    writeFileSync(
      safePath.join(root, 'docs', 'logo.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
    );
    // Every byte this process writes to stderr or stdout, so a report routed
    // through any logger — or none — is seen.
    const written: string[] = [];
    const capture = (chunk: unknown): boolean => {
      written.push(String(chunk));
      return true;
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(capture);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(capture);

    try {
      const paths = await withSource(async (source) => (await source.enumerate(root, [], 'refuse', ALL_FILES)).paths);
      // The premise: the binary really was in the population.
      expect(paths.map((p) => safePath.relative(root, p))).toContain('docs/logo.png');
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }

    expect(written.join('')).not.toContain('blob derivation');
  });
});
