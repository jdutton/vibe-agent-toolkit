/**
 * What a store HIT on the resources lane serves, held against what a miss
 * derived: the refusal line read from the rows, the stored conditions, and the membership
 * backstops that only a stored row can exercise.
 */
import { mkdir, writeFile } from 'node:fs/promises';
// `dirname` only — `join`/`resolve`/`relative` are ESLint-banned in favour of `safePath`.
import { dirname } from 'node:path';

import { compareCodeUnits, readWorkCounters, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CONDITION_WITHOUT_REFERENCE } from '../src/index.js';
import { describeBlobRefusals } from '../src/projection/blob-refusals.js';
import { ContributorRegistry, type ExtentContribution, type ExtentContributor } from '../src/projection/contributor.js';
import { extentContextId } from '../src/projection/contributors/context-id.js';
import { DEFAULT_CONTENT_DEMAND, FilesystemExtentContributor } from '../src/projection/contributors/filesystem-extent.js';
import { crawlSourceFor, type CrawlSource } from '../src/projection/crawl-source.js';
import {
  populate,
  readStoredMembership,
  requestedContributors,
  type PopulationCache,
} from '../src/projection/merge.js';
import type { ProjectionBase } from '../src/projection/projection.js';
import {
  __internal,
  buildResourcePopulation,
  buildResourceProjection,
  resourceContributors,
} from '../src/projection/resource-population.js';
import type { ExtentKey, ExtentScopedRows } from '../src/projection/store.js';
import type { RealizationConditionRow } from '../src/schemas/projection-resources.js';

import { FakeFactStore } from './fake-fact-store.js';
import { setupSubdirTestSuite } from './test-helpers.js';

const DOC = 'a.md';
/** NUL bytes after a PNG signature: declined by the blob stage as not text. */
// Binary bytes at a path typed as TEXT — the refusal worth a line. A `.png` is
// declined too but deliberately not reported (see blob-refusals.ts).
const BINARY = 'data/settings.json';
const BINARY_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const CLASSIFIER_CODE = 'TEST_CLASSIFIER_CONDITION';

const suite = setupSubdirTestSuite('resource-population-hit-');

async function write(relativePath: string, content: string | Buffer): Promise<void> {
  const absolute = safePath.join(suite.tempDir, relativePath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

function freshCache(store = new FakeFactStore()): PopulationCache {
  return { store, treeUnchanged: () => true, treeHash: 'fixture-tree' };
}

function relative(paths: readonly string[]): string[] {
  return paths.map((absolute) => toForwardSlash(safePath.relative(suite.tempDir, absolute)));
}

describe('the resources lane on a store hit', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('buildResourceProjection describes a binary refusal identically on a miss and a hit', async () => {
    await write(DOC, '# A\n');
    await write(BINARY, BINARY_BYTES);
    const options = { root: suite.tempDir, cache: freshCache() };

    const miss = await buildResourceProjection(options);
    expect(miss.outcome.stored).toBe('written');
    const line = describeBlobRefusals(miss.projection);
    expect(line).toContain('1 not text');

    // A hit derives nothing, so a report built from the run went silent here.
    // Built from the stored rows, it cannot tell the two apart.
    const hit = await buildResourceProjection(options);
    expect(hit.outcome.stored).toBe('hit');
    expect(describeBlobRefusals(hit.projection)).toBe(line);
  });

  it('serves the conditions it derived, with no symlink involved', async () => {
    // Two collections typing one file differently: a condition every platform
    // can produce, unlike the dangling-link fixtures.
    await write('docs/guide.md', '# Guide\n');
    const collections = {
      prose: { include: ['docs/**'], mimeType: 'text/markdown' },
      data: { include: ['docs/**'], mimeType: 'application/json' },
    };
    const options = { root: suite.tempDir, outputs: [], cache: freshCache(), collections };

    const written = await buildResourcePopulation(options);
    const hit = await buildResourcePopulation(options);

    expect(written.conditions.map((row) => row.code)).toContain('COLLECTION_MIME_CONFLICT');
    expect(hit.outcome.stored).toBe('hit');
    expect(hit.conditions).toEqual(written.conditions);
  });

  it('admits neither a gitignored row nor an absent one, even when a store serves them', async () => {
    // Neither row can reach a stored extent through this lane's own write
    // (`DECLINE_IGNORED` drops the first; the second needs a path to vanish
    // mid-run), so the store hands them back itself.
    await write(DOC, '# A\n');
    const options = { root: suite.tempDir, outputs: [], cache: freshCache(new UnreachableRowsStore()) };

    const written = await buildResourcePopulation(options);
    const hit = await buildResourcePopulation(options);

    expect(hit.outcome.stored).toBe('hit');
    expect(relative(hit.paths)).toEqual([DOC]);
    expect(hit.paths).toEqual(written.paths);
  });
});

/** Serves every stored extent with a gitignored copy and an absent copy of its first file row. */
class UnreachableRowsStore extends FakeFactStore {
  override async readExtent(key: ExtentKey): Promise<ExtentScopedRows | undefined> {
    const held = await super.readExtent(key);
    const file = held?.resourceRealizations.find((row) => !row.isDirectory);
    if (held === undefined || file === undefined) return held;
    const copy = (path: string): typeof file => ({ ...file, path, pathLower: path, basenameLower: path });
    return {
      ...held,
      resourceRealizations: [
        ...held.resourceRealizations,
        { ...copy('ignored.md'), gitignored: true },
        { ...copy('vanished.md'), exists: false },
      ],
    };
  }
}

/** A base classifier that reports one condition against every file it sees. */
class ConditioningClassifier implements ExtentContributor {
  readonly id = 'test:conditioning';
  readonly kind = 'test-conditioning';
  readonly stratum = 'base' as const;
  readonly readsBlobs = false;

  contribute(base: ProjectionBase): Promise<ExtentContribution> {
    const { rootId } = base.identities;
    const extentId = extentContextId(this.kind, rootId);
    const conditions: RealizationConditionRow[] = base.resourceRealizations
      .filter((row) => !row.isDirectory)
      .map((row) => ({
        extentId, path: row.path, code: CLASSIFIER_CODE, severity: 'warning',
        message: `classified ${row.path}`, resourceId: null, ...CONDITION_WITHOUT_REFERENCE,
      }));
    return Promise.resolve({
      contexts: [{ contextId: extentId, species: 'extent', kind: this.kind, rootId, extentContextId: null, role: null }],
      resources: [], realizations: [], memberships: [], tags: [], conditions, claudeRulePatterns: [],
    });
  }
}

describe('readStoredMembership', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('counts a warm read as one extent served and none derived', async () => {
    await write(DOC, '# A\n');
    const registry = new ContributorRegistry();
    registry.register(new FilesystemExtentContributor((at) => crawlSourceFor(at, []), DEFAULT_CONTENT_DEMAND));
    const options = { root: suite.tempDir, registry, cache: freshCache() };
    await populate(options);
    const before = readWorkCounters();

    const stored = await readStoredMembership(options, requestedContributors(options));

    expect(stored).toBeDefined();
    expect(readWorkCounters()['extent.served'] - before['extent.served']).toBe(1);
    expect(readWorkCounters()['extent.derived'] - before['extent.derived']).toBe(0);
  });

  it('serves every requested contributor\'s conditions, a classifier\'s included', async () => {
    await write(DOC, '# A\n');
    const registry = new ContributorRegistry();
    registry.register(new FilesystemExtentContributor((at) => crawlSourceFor(at, []), DEFAULT_CONTENT_DEMAND));
    registry.register(new ConditioningClassifier());
    const options = { root: suite.tempDir, registry, cache: freshCache() };

    const { projection } = await populate(options);
    const stored = await readStoredMembership(options, requestedContributors(options));

    const codes = (rows: readonly RealizationConditionRow[]): string[] => rows.map((row) => `${row.code}\t${row.path}`).sort(compareCodeUnits);
    expect(codes(projection.realizationConditions)).toContain(`${CLASSIFIER_CODE}\t${DOC}`);
    expect(codes(stored?.realizationConditions ?? [])).toEqual(codes(projection.realizationConditions));
  });
});

describe('buildResourcePopulation with a classifier that reports a condition', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('serves on a hit every condition the derive found, the classifier\'s included', async () => {
    await write(DOC, '# A\n');
    const withClassifier = (source: CrawlSource): ReturnType<typeof resourceContributors> => {
      const contributors = resourceContributors(() => source);
      contributors.registry.register(new ConditioningClassifier());
      return contributors;
    };
    const options = { root: suite.tempDir, outputs: [], cache: freshCache() };

    const written = await __internal.membershipThrough(options, withClassifier);
    const hit = await __internal.membershipThrough(options, withClassifier);

    expect(written.conditions.map((row) => row.code)).toContain(CLASSIFIER_CODE);
    expect(hit.outcome.stored).toBe('hit');
    expect(hit.conditions).toEqual(written.conditions);
  });
});
