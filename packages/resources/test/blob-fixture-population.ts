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

import { ContributorRegistry } from '../src/projection/contributor.js';
import { FilesystemExtentContributor } from '../src/projection/contributors/filesystem-extent.js';
import { populate, type BlobPopulationReport } from '../src/projection/merge.js';
import type { Projection } from '../src/projection/projection.js';

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
