/**
 * A VAT install with no parse worker is a broken install, and it says so.
 *
 * The seed is the real thing, not the test seam: the BUILT package is copied
 * and its `parse-worker.js` deleted, so the pool's own entry resolution runs
 * its real existence check and finds nothing (`resolveWorkerEntry` in
 * `parse-pool.ts`). `__setParseWorkerEntryForTest` is deliberately not used —
 * it bypasses exactly the check this suite is about.
 *
 * What must hold (ADR I1, I6):
 * - the run fails loud with a parser-unavailable error, never a per-document
 *   `BLOB_PARSE_FAILED` that blames every file in the corpus;
 * - nothing is filed — a broken install is a fact about this run, not about
 *   any bytes, so no `blob_conditions` row may record it;
 * - the moment the worker is back, the next run parses normally: nothing the
 *   failed run did outlives it.
 */

import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { removeScratchDir } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type * as ResourcesSurface from '../../src/index.js';

/** The slice of the built package's public surface this suite drives. */
type BuiltResources = typeof ResourcesSurface;

const PACKAGE_DIR = safePath.resolve(import.meta.dirname, '..', '..');
const SCRATCH_PREFIX = '.vat-missing-worker-';
/** A scratch copy this old belongs to no live run of this suite. */
const STALE_SCRATCH_MS = 60 * 60 * 1000;

let scratch = '';
let pkgScratch = '';
let copiedWorker: string;
let corpus: string;
let built: BuiltResources;

beforeAll(async () => {
  scratch = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'vat-missing-worker-'));
  // The copy lives INSIDE the package's own `node_modules` (gitignored), so its
  // dependencies resolve by the plain upward walk a real install uses — this
  // package's `node_modules`, then the workspace's — with no link in the path.
  // Junctions to those directories resolve on POSIX but not for a worker thread
  // on Windows, where the copy could not find `zod` once the worker was back.
  const scratchParent = safePath.join(PACKAGE_DIR, 'node_modules');
  await fs.mkdir(scratchParent, { recursive: true });
  // No OS reclaims a source-tree dir, so a run killed before its teardown leaves its copy here:
  // sweep those, older than any live run, so they cannot pile up across runs.
  const now = Date.now();
  for (const name of await fs.readdir(scratchParent)) {
    if (!name.startsWith(SCRATCH_PREFIX)) continue;
    const stale = safePath.join(scratchParent, name);
    if (now - (await fs.stat(stale)).mtimeMs > STALE_SCRATCH_MS) await removeScratchDir(stale);
  }
  pkgScratch = await fs.mkdtemp(safePath.join(scratchParent, SCRATCH_PREFIX));
  const pkg = safePath.join(pkgScratch, 'pkg');
  await fs.cp(safePath.join(PACKAGE_DIR, 'dist'), safePath.join(pkg, 'dist'), { recursive: true });
  await fs.copyFile(safePath.join(PACKAGE_DIR, 'package.json'), safePath.join(pkg, 'package.json'));

  copiedWorker = safePath.join(pkg, 'dist', 'parse-worker.js');
  await fs.rm(copiedWorker);

  corpus = safePath.join(scratch, 'corpus');
  await fs.mkdir(corpus);
  await fs.writeFile(safePath.join(corpus, 'a.md'), '# A\n\nSee [b](./b.md).\n', 'utf-8');
  await fs.writeFile(safePath.join(corpus, 'b.md'), '# B\n', 'utf-8');

  built = (await import(pathToFileURL(safePath.join(pkg, 'dist', 'index.js')).href)) as BuiltResources;
});

afterAll(async () => {
  await removeScratchDir(scratch);
  // The same bounded removal as the temp dir: a 646-file copy on a loaded Windows runner is the
  // teardown `removeScratchDir` exists for. `''` (beforeAll threw first) is a no-op.
  await removeScratchDir(pkgScratch);
});

/**
 * One population of the corpus's blobs, through the copied package.
 *
 * @returns What the run threw, or `undefined`, and the projection it left
 */
async function populateOnce(): Promise<{ thrown: unknown; projection: ReturnType<InstanceType<BuiltResources['ProjectionBuilder']>['build']> }> {
  const builder = new built.ProjectionBuilder({ root: corpus, contentCache: new built.RunContentCache() });
  const contribution = await new built.FilesystemExtentContributor(
    (at) => built.crawlSourceFor(at, []),
    built.DEFAULT_CONTENT_DEMAND,
  ).contribute(builder.base(), null);
  for (const row of contribution.contexts) builder.addContext(row);
  for (const row of contribution.resources) builder.addResource(row);
  for (const row of contribution.realizations) builder.addRealization(row);

  let thrown: unknown;
  try {
    await built.populateBlobs(builder, { parseCache: new built.ParseCache({ enabled: false }) });
  } catch (error) {
    thrown = error;
  }
  return { thrown, projection: builder.build() };
}

describe('an install with no parse worker', () => {
  it('fails the run as parser-unavailable and files nothing', async () => {
    const { thrown, projection } = await populateOnce();

    expect(built.isParserUnavailable(thrown)).toBe(true);
    expect(projection.blobConditions).toEqual([]);
  });

  it('parses normally on the next run once the worker is back', async () => {
    await fs.copyFile(safePath.join(PACKAGE_DIR, 'dist', 'parse-worker.js'), copiedWorker);

    const { thrown, projection } = await populateOnce();

    expect(thrown).toBeUndefined();
    expect(projection.blobConditions).toEqual([]);
    expect(projection.blobSections.map((row) => row.title)).toEqual(expect.arrayContaining(['A', 'B']));
    expect(projection.blobSections).toHaveLength(2);
  });
});
