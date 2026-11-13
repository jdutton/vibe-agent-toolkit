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

import { RunContentCache } from '../src/projection/content-cache.js';
import { ContributorRegistry } from '../src/projection/contributor.js';
import { DEFAULT_CONTENT_DEMAND, FilesystemExtentContributor } from '../src/projection/contributors/filesystem-extent.js';
import { crawlSourceFor } from '../src/projection/crawl-source.js';
import { populate } from '../src/projection/merge.js';
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
 * @param contentCache - The run cache the enumeration shares with the derivation stage. Omitted,
 *   each stage gets a fresh cache of its own, so the derivation-time read is a genuine second read
 *   — the lane of a key the run recorded without reading the bytes
 * @returns A builder carrying the base stratum and nothing else
 */
export async function baseBuilderForRoot(
  rootDir: string,
  order: RealizationOrder = IN_CRAWL_ORDER,
  contentCache?: RunContentCache,
): Promise<ProjectionBuilder> {
  const freshBuilder = (): ProjectionBuilder => new ProjectionBuilder({ root: rootDir, contentCache: new RunContentCache() });
  const enumerator = contentCache === undefined ? freshBuilder() : new ProjectionBuilder({ root: rootDir, contentCache });
  const builder = contentCache === undefined ? freshBuilder() : enumerator;
  const contribution = await new FilesystemExtentContributor((at) => crawlSourceFor(at, []), DEFAULT_CONTENT_DEMAND).contribute(enumerator.base(), null);
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
  await writeFile(safePath.join(rootDir, relativePath), bytes);
}

/**
 * Run the filesystem-only projection driver over a fixture root.
 *
 * These suites assert on the projection's rows — what a user is told is read
 * from them, on a store hit as on a derive.
 *
 * @param rootDir - The suite's temp root, treated as the corpus root
 * @returns The whole projection
 */
export async function populateFixtureRoot(rootDir: string): Promise<{ projection: Projection }> {
  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor((at) => crawlSourceFor(at, []), DEFAULT_CONTENT_DEMAND));

  const { projection } = await populate({ root: rootDir, registry });
  return { projection };
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
