/**
 * The content-parsing gate — `PopulateOptions.contentParsing`.
 *
 * ## Why the fixture writes real files
 *
 * A corpus with no keyed realization derives no blobs under EITHER setting, so a
 * fixture built from stub contributors could not tell "the stage was skipped"
 * from "there was nothing to derive" — it would pass against a driver that
 * ignored the option entirely. Every assertion here is therefore taken against a
 * corpus that provably produces blob rows on the `derive` arm, which is the
 * negative control: the same population, the same contributors, one option
 * moved.
 */

import { mkdir, writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ContributorRegistry } from '../src/projection/contributor.js';
import type { ExtentContribution, ExtentContributor } from '../src/projection/contributor.js';
import { ClosureExtentContributor } from '../src/projection/contributors/closure-extent.js';
import { FilesystemExtentContributor } from '../src/projection/contributors/filesystem-extent.js';
import { CONTENT_PARSING_SKIP, DISCARD_BLOB_POPULATION, populate } from '../src/projection/merge.js';
import type { Projection } from '../src/projection/projection.js';
import type { JsonValue } from '../src/schemas/projection-shared.js';

import { setupSubdirTestSuite } from './test-helpers.js';

const suite = setupSubdirTestSuite('blob-derivation-');

const ROOT_DOC = 'root.md';
const LINKED_DOC = 'docs/linked.md';
const SKILL_KIND = 'skill';
const EXTENT_NAME = 'fixture';

/** A blob reader that is NOT a closure contributor, so the gate cannot be passing on stratum. */
const BASE_READER_ID = 'test:base-blob-reader';

beforeAll(suite.beforeAll);
afterAll(suite.afterAll);
beforeEach(async () => {
  await suite.beforeEach();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture directory beneath a mkdtemp root
  await mkdir(safePath.join(suite.tempDir, 'docs'), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture path beneath a mkdtemp root
  await writeFile(
    safePath.join(suite.tempDir, ROOT_DOC),
    `# Root\n\nSee [the linked doc](${LINKED_DOC}).\n`,
    'utf-8',
  );
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture path beneath a mkdtemp root
  await writeFile(safePath.join(suite.tempDir, LINKED_DOC), '# Linked\n\nLeaf.\n', 'utf-8');
});

/** The filesystem extent alone — a population nothing reads blob tables from. */
function filesystemOnly(): ContributorRegistry {
  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor());
  return registry;
}

/** A base-stratum contributor that declares it reads blobs, contributing nothing. */
function baseBlobReader(): ExtentContributor {
  return {
    id: BASE_READER_ID,
    kind: 'test',
    stratum: 'base',
    readsBlobs: true,
    contribute: async (): Promise<ExtentContribution> => ({
      contexts: [],
      resources: [],
      realizations: [],
      memberships: [],
      tags: [],
      conditions: [],
    }),
  };
}

/** The declaration the closure contributor runs under. */
const CLOSURE_DECLARATION: Record<string, JsonValue> = {
  [`closure:${EXTENT_NAME}`]: {
    kind: SKILL_KIND,
    closureFrom: ROOT_DOC,
    follow: ['markdown-link'],
    maxDepth: 'full',
  },
};

/**
 * Populate the fixture corpus.
 *
 * @param registry - The contributors to run
 * @param contentParsing - The `contentParsing` option, omitted to take the default
 * @returns The projection
 */
async function populateFixture(
  registry: ContributorRegistry,
  contentParsing?: typeof CONTENT_PARSING_SKIP,
): Promise<Projection> {
  return populate({
    root: suite.tempDir,
    registry,
    parameters: CLOSURE_DECLARATION,
    onBlobPopulation: DISCARD_BLOB_POPULATION,
    ...(contentParsing === undefined ? {} : { contentParsing }),
  });
}

describe('populate blob derivation', () => {
  it('derives blob rows by default — the control every skip assertion is read against', async () => {
    const projection = await populateFixture(filesystemOnly());

    expect(projection.blobs.length).toBeGreaterThan(0);
    expect(projection.blobReferences.length).toBeGreaterThan(0);
    expect(projection.blobSections.length).toBeGreaterThan(0);
  });

  it('derives no blob rows when asked to skip, while the realizations are unchanged', async () => {
    const derived = await populateFixture(filesystemOnly());
    const skipped = await populateFixture(filesystemOnly(), CONTENT_PARSING_SKIP);

    expect(skipped.blobs).toStrictEqual([]);
    expect(skipped.blobReferences).toStrictEqual([]);
    expect(skipped.blobSections).toStrictEqual([]);
    expect(skipped.blobConditions).toStrictEqual([]);
    // The population itself is what this lane consumes, and it must not move —
    // skipping derivation is a decision about facts, never about membership.
    // `contentKey` is deliberately included: the realization stratum still keys
    // its bytes, so a skip that quietly stopped keying would be caught here.
    expect(skipped.resourceRealizations).toStrictEqual(derived.resourceRealizations);
  });

  it('does not call onBlobPopulation when the stage did not run', async () => {
    const reports: unknown[] = [];

    await populate({
      root: suite.tempDir,
      registry: filesystemOnly(),
      contentParsing: CONTENT_PARSING_SKIP,
      onBlobPopulation: (report) => reports.push(report),
    });

    // Never a zeroed report: "did not run" and "ran and derived nothing" are
    // different facts and a zeroed object cannot tell them apart.
    expect(reports).toStrictEqual([]);
  });

  it('refuses to skip while a closure contributor is registered, naming it', async () => {
    const registry = filesystemOnly();
    registry.register(new ClosureExtentContributor(EXTENT_NAME, SKILL_KIND));

    await expect(populateFixture(registry, CONTENT_PARSING_SKIP)).rejects.toThrow(`closure:${EXTENT_NAME}`);
  });

  it('refuses to skip for a BASE contributor that reads blobs, so the gate is not stratum in disguise', async () => {
    const registry = filesystemOnly();
    registry.register(baseBlobReader());

    await expect(populateFixture(registry, CONTENT_PARSING_SKIP)).rejects.toThrow(BASE_READER_ID);
  });

  it('still populates a closure extent under the default, so the refusal is not the only path', async () => {
    const registry = filesystemOnly();
    registry.register(new ClosureExtentContributor(EXTENT_NAME, SKILL_KIND));

    const projection = await populateFixture(registry);
    const members = projection.resourceExtents.filter((row) => row.extentId.includes(EXTENT_NAME));

    // Two: the declared root and the document it links to. This is the assertion
    // that would fail if the stage were skipped under a closure contributor —
    // the extent would collapse to its root alone.
    expect(members).toHaveLength(2);
  });
});
