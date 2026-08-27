/**
 * Running the projection's blob stage over a directory of **exact bytes**.
 *
 * Two suites need this and they need it for the same reason: the properties they
 * test — "is this binary", "what encoding is this" — are properties of bytes, and
 * a fixture helper that takes a `string` cannot express them. `writeCorpusFiles`
 * in `test-helpers.ts` writes `Buffer.from(text, 'utf-8')`, so it can place
 * neither a lone `0x89` nor a UTF-16 BOM on disk; both are byte sequences that no
 * string's UTF-8 encoding contains.
 *
 * Extracted here rather than copied into the second suite. The duplication would
 * have been ~40 lines of identical driver setup, which this repository's
 * zero-tolerance duplication gate rejects — and, more usefully, two copies of a
 * populate driver drift: one gains a contributor or an option and the suite
 * reading the other quietly stops testing the same pipeline.
 */

import { writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { expect } from 'vitest';

import type { RunContentCache } from '../src/projection/content-cache.js';
import { ContributorRegistry } from '../src/projection/contributor.js';
import { FilesystemExtentContributor } from '../src/projection/contributors/filesystem-extent.js';
import { populate, type BlobPopulationReport } from '../src/projection/merge.js';
import { ProjectionBuilder, type Projection } from '../src/projection/projection.js';
import type { ResourceRealizationRow } from '../src/schemas/projection-resources.js';

/** Reorders the realizations before they reach the builder. */
export type RealizationOrder = (
  rows: readonly ResourceRealizationRow[],
) => readonly ResourceRealizationRow[];

/** Enumeration order, as the crawl produced it. */
export const IN_CRAWL_ORDER: RealizationOrder = (rows) => rows;

/**
 * A builder holding only what the filesystem extent contributed.
 *
 * The base stratum, run by hand so a caller can drive `populateBlobs` itself —
 * which is what a suite needs when it must inspect the builder after the stage
 * **threw**, a state `populate()` gives no seam to reach, or disturb the corpus
 * between enumeration and derivation.
 *
 * `contentCache` is omitted by default on purpose: a builder with no cache is
 * the configuration in which the derivation-time read is genuinely a second
 * read, so it is the only one that can exercise the stage's disagreement
 * branches at all.
 *
 * @param rootDir - The corpus root to enumerate
 * @param order - How to reorder the realizations before recording them
 * @param contentCache - The run cache to share with the derivation stage, if any
 * @returns A builder carrying the base stratum and nothing else
 */
export async function baseBuilderForRoot(
  rootDir: string,
  order: RealizationOrder = IN_CRAWL_ORDER,
  contentCache?: RunContentCache,
): Promise<ProjectionBuilder> {
  const builder = new ProjectionBuilder({ root: rootDir, contentCache });
  const contribution = await new FilesystemExtentContributor().contribute(builder.base(), null);
  for (const row of contribution.contexts) builder.addContext(row);
  for (const row of contribution.resources) builder.addResource(row);
  for (const row of order(contribution.realizations)) builder.addRealization(row);
  return builder;
}

/**
 * Write raw bytes to a fixture beneath a suite root, bypassing string encoding
 * entirely.
 *
 * @param rootDir - The suite's temp root
 * @param relativePath - Fixture path beneath it
 * @param bytes - The exact bytes to land on disk
 */
export async function writeBinaryFixture(
  rootDir: string,
  relativePath: string,
  bytes: Uint8Array,
): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture path beneath a mkdtemp root
  await writeFile(safePath.join(rootDir, relativePath), bytes);
}

/** Only reachable if the assertion inside {@link populateFixtureRoot} stopped asserting. */
function unreachableReport(): BlobPopulationReport {
  throw new Error('populate() did not report blob-population counts');
}

/**
 * Run the filesystem-only projection driver over a fixture root.
 *
 * The report is taken through `onBlobPopulation` — the same observer a CLI lane
 * passes — rather than recomputed, so what these suites assert is exactly what a
 * user's run would be told.
 *
 * @param rootDir - The suite's temp root, treated as the corpus root
 * @returns The blob-population report and the whole projection
 */
export async function populateFixtureRoot(rootDir: string): Promise<{
  report: BlobPopulationReport;
  projection: Projection;
}> {
  let report: BlobPopulationReport | undefined;
  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor());

  const projection = await populate({
    root: rootDir,
    registry,
    onBlobPopulation: (result) => {
      report = result;
    },
  });

  expect(report).toBeDefined();
  return { report: report ?? unreachableReport(), projection };
}

/**
 * The `blob_conditions` rows carrying one code.
 *
 * @param projection - A populated projection
 * @param code - The condition code to select
 * @returns Every matching row, in projection order
 */
export function conditionsWithCode(
  projection: Projection,
  code: string,
): readonly { blob: string; code: string; message: string }[] {
  return projection.blobConditions.filter((row) => row.code === code);
}
