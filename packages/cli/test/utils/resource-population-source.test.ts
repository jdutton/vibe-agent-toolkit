/* eslint-disable security/detect-non-literal-fs-filename -- every path here is under a per-test temp directory */
/**
 * `withResourcePopulationSource` — the one seam that puts a command which does
 * NOT go through `loadResourcesWithConfig` onto the projection lane.
 *
 * `vat skills build`, `vat skills validate` and `vat claude plugin build` all
 * build their own registry, so they cannot reach the lane through the resource
 * loader. This helper is the shared answer: same selector, same store, same
 * git-ignore oracle, handed back as a source the caller threads into whichever
 * builder it owns.
 *
 * The assertions here are about the SELECTOR and the SOURCE'S ANSWER, never
 * about the environment being set — an opt-in that reports itself from the env
 * it read rather than from what it did is the exact failure this lane keeps
 * hitting.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RESOURCES_CRAWL_ENV,
  RESOURCES_CRAWL_PROJECTION,
  withResourcePopulationSource,
} from '../../src/utils/resource-loader.js';

/** The two fixture members, named once so the writes and the expectation agree. */
const GUIDE_REL = 'docs/guide.md';
const ASSET_REL = 'docs/asset.txt';

let root: string;

beforeEach(() => {
  root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-population-source-'));
  // Both fixture members sit under one directory, so it is made once here and
  // each write below is a plain `writeFileSync` rather than a local helper.
  mkdirSyncReal(safePath.join(root, 'docs'), { recursive: true });
});

afterEach(() => {
  delete process.env[RESOURCES_CRAWL_ENV];
  rmSync(root, { recursive: true, force: true });
});

describe('withResourcePopulationSource', () => {
  it('hands back no source when the selector is unset', async () => {
    const received = await withResourcePopulationSource({ root }, async (source) => source);

    expect(received).toBeUndefined();
  });

  it('hands back a source that enumerates the tree when the selector chose the projection lane', async () => {
    writeFileSync(safePath.join(root, GUIDE_REL), '# guide\n', 'utf-8');
    writeFileSync(safePath.join(root, ASSET_REL), 'asset', 'utf-8');
    process.env[RESOURCES_CRAWL_ENV] = RESOURCES_CRAWL_PROJECTION;

    const paths = await withResourcePopulationSource({ root }, async (source) => {
      expect(source).toBeDefined();
      return [...(await source?.(root) ?? [])];
    });

    // The source enumerates; it does NOT narrow. Narrowing to the caller's own
    // globs is `ResourceRegistry.crawl`'s job, and asserting the unnarrowed
    // answer here is what keeps the two responsibilities distinguishable.
    expect(
      paths.map((p) => safePath.relative(root, p)).sort((left, right) => left.localeCompare(right)),
    ).toEqual([ASSET_REL, GUIDE_REL]);
  });

  it('reports the enumerator that actually ran', async () => {
    writeFileSync(safePath.join(root, GUIDE_REL), '# guide\n', 'utf-8');
    process.env[RESOURCES_CRAWL_ENV] = RESOURCES_CRAWL_PROJECTION;

    const seen: string[] = [];
    await withResourcePopulationSource(
      { root, observeExtentSource: (kind) => seen.push(kind) },
      async (source) => source?.(root),
    );

    expect(seen).toEqual(['filesystem']);
  });
});
