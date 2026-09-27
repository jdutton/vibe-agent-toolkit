/**
 * A file too large to decode into a JS string is a fact about the corpus, not an
 * abort — reported as `contentState: 'oversize'`, never folded into `unreadable`.
 *
 * The defect this pins: one 966 MB CSV in a non-git corpus made `vat claude
 * context --all` exit 2 with `Cannot create a string longer than 0x1fffffe8
 * characters`, because `keyOrState` converts only filesystem refusals into a
 * row and the decoder's refusal is not one.
 *
 * The fixtures are sparse — `truncate` sets a length without writing a byte — so
 * a file past V8's string-length limit costs no disk on APFS/ext4 and no read.
 * Past 2 GiB is the proof that the refusal comes from a `stat`: `readFile`
 * refuses that size with its own `ERR_FS_FILE_TOO_LARGE`, which a read-first
 * implementation would surface instead.
 */

import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';

import { isVatError, normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { MAX_DECODABLE_BYTES, TextTooLargeError } from '@vibe-agent-toolkit/utils/fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readContentWithKey } from '../../src/content-key.js';
import { describeBlobRefusals } from '../../src/projection/blob-refusals.js';
import { RunContentCache } from '../../src/projection/content-cache.js';
import { ContributorRegistry } from '../../src/projection/contributor.js';
import { FilesystemExtentContributor } from '../../src/projection/contributors/filesystem-extent.js';
import { crawlSourceFor } from '../../src/projection/crawl-source.js';
import { populate, type BlobPopulationReport } from '../../src/projection/merge.js';
import { ProjectionBuilder, REALIZATION_PROMOTION_UNREADABLE } from '../../src/projection/projection.js';
import { collectRealization } from '../../src/projection/realizations.js';
import { ResourceRegistry } from '../../src/resource-registry.js';
import { ResourceRealizationRowSchema } from '../../src/schemas/projection-resources.js';

/** Past `readFile`'s own 2 GiB ceiling — see the module docstring. */
const PAST_READFILE_LIMIT = 2 ** 31 + 1;
const HUGE = 'data/huge.csv';
const NOTES = 'notes.md';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(safePath.join(normalizedTmpdir(), 'vat-oversize-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Plant a sparse file of `size` bytes at a root-relative path. */
async function sparse(relativePath: string, size: number): Promise<string> {
  const file = safePath.join(root, relativePath);
  await mkdir(safePath.join(file, '..'), { recursive: true });
  const handle = await open(file, 'w');
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
  return file;
}

/** What `run` threw, or undefined. */
async function thrownBy(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('readContentWithKey refuses an undecodable size by stat, before any read', () => {
  it('throws TextTooLargeError one byte past the limit', async () => {
    const file = await sparse(HUGE, MAX_DECODABLE_BYTES + 1);
    const error = await thrownBy(() => readContentWithKey(file, 'none'));
    expect(isVatError(error, TextTooLargeError.code)).toBe(true);
  });

  it('throws the same error past 2 GiB, where a read would have failed differently', async () => {
    const file = await sparse(HUGE, PAST_READFILE_LIMIT);
    const error = await thrownBy(() => readContentWithKey(file, 'none'));
    expect(isVatError(error, TextTooLargeError.code)).toBe(true);
  });
});

describe('ResourceRegistry over an undecodable document', () => {
  it('records it as a RESOURCE_UNREADABLE finding coded TEXT_TOO_LARGE, not a crash', async () => {
    const file = await sparse('huge.md', MAX_DECODABLE_BYTES + 1);
    const registry = new ResourceRegistry({ baseDir: root });

    await registry.addResources([file]);
    const result = await registry.validate({ skipGitIgnoreCheck: true });

    const issue = result.issues.find((candidate) => candidate.code === 'RESOURCE_UNREADABLE');
    expect(issue?.message).toContain(`(${TextTooLargeError.code})`);
  });
});

describe('demand promotion of a deferred undecodable file', () => {
  it('rewrites the row to oversize, not unreadable, and records no unreadable condition', async () => {
    await sparse(HUGE, MAX_DECODABLE_BYTES + 1);
    const cache = new RunContentCache();
    const builder = new ProjectionBuilder({ root, contentCache: cache });
    builder.addRealization(await collectRealization(safePath.join(root, HUGE), 'res-huge', {
      root,
      extentId: 'ctx-filesystem',
      contentCache: cache,
      contentDemand: 'deferred',
    }));

    expect(await builder.ensureContentKey(HUGE)).toBeNull();

    const built = builder.build();
    expect(built.resourceRealizations.map((row) => row.contentState)).toEqual(['oversize']);
    expect(built.realizationConditions.map((row) => row.code)).not.toContain(REALIZATION_PROMOTION_UNREADABLE);
  });
});

describe('populate over a tree holding one undecodable file', () => {
  it('completes, marks that file oversize, keys its neighbour, and says so in the refusal line', async () => {
    await writeFile(safePath.join(root, NOTES), '# Notes\n\nmarker: oversize suite\n');
    await sparse(HUGE, MAX_DECODABLE_BYTES + 1);

    const registry = new ContributorRegistry();
    registry.register(new FilesystemExtentContributor(() => crawlSourceFor(root)));
    const reports: BlobPopulationReport[] = [];
    const projection = await populate({ root, registry, onBlobPopulation: (r) => reports.push(r) });

    const rowAt = (name: string) =>
      projection.resourceRealizations.find((row) => toForwardSlash(row.path) === name);
    const huge = rowAt(HUGE);
    expect(huge?.contentKey).toBeNull();
    expect(huge?.contentState).toBe('oversize');
    expect(() => ResourceRealizationRowSchema.parse(huge)).not.toThrow();
    // The control: the ordinary file beside it is still keyed.
    expect(rowAt(NOTES)?.contentState).toBe('keyed');

    const [report] = reports;
    expect(report?.realizationsSkippedOversize).toBe(1);
    expect(report?.realizationsSkippedUnkeyed).toBe(0);
    expect(report === undefined ? undefined : describeBlobRefusals(report)).toContain('1 too large to decode');
  });
});
