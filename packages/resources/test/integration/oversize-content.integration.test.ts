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
import { ParseCache } from '../../src/parse-cache.js';
import { ParseDispatcher, parseFileCached } from '../../src/parse-dispatcher.js';
import { ParseLimitError } from '../../src/parse-limits.js';
import { describeBlobRefusals, notAdmittedRealizations } from '../../src/projection/blob-refusals.js';
import { POPULATION_PARSE_LIMITS, RunContentCache } from '../../src/projection/content-cache.js';
import { ContributorRegistry } from '../../src/projection/contributor.js';
import { DEFAULT_CONTENT_DEMAND, FilesystemExtentContributor } from '../../src/projection/contributors/filesystem-extent.js';
import { crawlSourceFor } from '../../src/projection/crawl-source.js';
import { populate } from '../../src/projection/merge.js';
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
    const error = await thrownBy(() => readContentWithKey(file, 'none', null));
    expect(isVatError(error, TextTooLargeError.code)).toBe(true);
  });

  it('throws the same error past 2 GiB, where a read would have failed differently', async () => {
    const file = await sparse(HUGE, PAST_READFILE_LIMIT);
    const error = await thrownBy(() => readContentWithKey(file, 'none', null));
    expect(isVatError(error, TextTooLargeError.code)).toBe(true);
  });
});

describe('readContentWithKey holds a parsed kind to the input cap at its boundary', () => {
  // The read lane's cap is the pool's: a document of exactly the cap is admitted and one byte more
  // is refused (`size > cap`), so a file the read admits is never one the pool then refuses.
  const CAP = 16;

  it('admits a document of exactly the cap', async () => {
    const file = safePath.join(root, NOTES);
    await writeFile(file, '#'.repeat(CAP));
    const keyed = await readContentWithKey(file, 'markdown', CAP);
    expect(keyed.content).toHaveLength(CAP);
  });

  it('refuses a document one byte past the cap, before reading it', async () => {
    const file = safePath.join(root, NOTES);
    await writeFile(file, '#'.repeat(CAP + 1));
    const error = await thrownBy(() => readContentWithKey(file, 'markdown', CAP));
    // The read lane names the cap alone, as the projection's oversize realization does: neither has
    // read the bytes it refuses, so one sentence serves both.
    expect(error).toMatchObject({ code: 'PARSE_LIMIT_EXCEEDED', limit: 'inputBytes', bound: new ParseLimitError('inputBytes', CAP).bound });
  });
});

/**
 * A dispatcher whose pool records being asked for, and is never built.
 *
 * @param inputBytes - The input cap, or the default
 * @returns The dispatcher and how many pools it asked for
 */
function capOnlyDispatcher(inputBytes?: number): { dispatcher: ParseDispatcher; poolsAsked: () => number } {
  let asked = 0;
  const dispatcher = new ParseDispatcher(new ParseCache({ enabled: false }), {
    createPool: () => {
      asked += 1;
      throw new Error('the input cap must refuse before any pool is asked for');
    },
    ...(inputBytes !== undefined && { limits: { inputBytes } }),
  });
  return { dispatcher, poolsAsked: () => asked };
}

describe('parseFileCached holds a file to the input cap by its size, before reading it', () => {
  it('refuses a file past the cap and never asks for a pool', async () => {
    const file = safePath.join(root, 'big.md');
    await writeFile(file, '#'.repeat(64));
    const { dispatcher, poolsAsked } = capOnlyDispatcher(16);

    try {
      await expect(parseFileCached(file, 'markdown', { dispatcher })).rejects.toMatchObject({
        code: 'PARSE_LIMIT_EXCEEDED', limit: 'inputBytes', bound: new ParseLimitError('inputBytes', 16).bound,
      });
    } finally {
      await dispatcher.shutdown();
    }
    expect(poolsAsked()).toBe(0);
  });

  it('refuses a sparse file past 2 GiB as the input cap, where a read would have failed differently', async () => {
    const file = await sparse('huge.md', PAST_READFILE_LIMIT);
    const { dispatcher, poolsAsked } = capOnlyDispatcher();

    try {
      await expect(parseFileCached(file, 'markdown', { dispatcher })).rejects.toMatchObject({
        code: 'PARSE_LIMIT_EXCEEDED', limit: 'inputBytes', bound: new ParseLimitError('inputBytes', dispatcher.inputBytes).bound,
      });
    } finally {
      await dispatcher.shutdown();
    }
    expect(poolsAsked()).toBe(0);
  });
});

describe('ResourceRegistry over an undecodable file', () => {
  it('records one nothing parses as a RESOURCE_UNREADABLE finding coded TEXT_TOO_LARGE, not a crash', async () => {
    const file = await sparse(HUGE, MAX_DECODABLE_BYTES + 1);
    const registry = new ResourceRegistry({ baseDir: root });

    await registry.addResources([file]);
    const result = await registry.validate({ skipGitIgnoreCheck: true });

    const issue = result.issues.find((candidate) => candidate.code === 'RESOURCE_UNREADABLE');
    expect(issue?.message).toContain(`(${TextTooLargeError.code})`);
  });

  it('refuses a document a parser would read by the input cap, by its size, before reading it', async () => {
    const file = await sparse('huge.md', MAX_DECODABLE_BYTES + 1);
    const registry = new ResourceRegistry({ baseDir: root });

    await registry.addResources([file]);
    const result = await registry.validate({ skipGitIgnoreCheck: true });
    const codes = result.issues.map((issue) => issue.code);

    expect(codes).toContain('RESOURCE_PARSE_LIMIT_EXCEEDED');
    expect(codes).not.toContain('RESOURCE_UNREADABLE');
  });
});

describe('demand promotion of a deferred undecodable file', () => {
  it('rewrites the row to oversize, not unreadable, and records no unreadable condition', async () => {
    await sparse(HUGE, MAX_DECODABLE_BYTES + 1);
    const cache = new RunContentCache({ inputBytes: null });
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
    registry.register(new FilesystemExtentContributor(() => crawlSourceFor(root, []), DEFAULT_CONTENT_DEMAND));
    const { projection } = await populate({ root, registry });

    const rowAt = (name: string) =>
      projection.resourceRealizations.find((row) => toForwardSlash(row.path) === name);
    const huge = rowAt(HUGE);
    expect(huge?.contentKey).toBeNull();
    expect(huge?.contentState).toBe('oversize');
    expect(() => ResourceRealizationRowSchema.parse(huge)).not.toThrow();
    // The control: the ordinary file beside it is still keyed.
    expect(rowAt(NOTES)?.contentState).toBe('keyed');

    expect(projection.resourceRealizations.filter((row) => row.contentState === 'oversize')).toHaveLength(1);
    expect(describeBlobRefusals(projection)).toContain('could not key 1 realization(s) (1 refused by size)');
  });
});

describe('populate over a tree holding a document past the parse input cap', () => {
  it('refuses the document by its size, as the registry lane does, and keys a kind nothing parses at the same size', async () => {
    // Decodable, so only the run's input cap can refuse it; sparse, so a read would cost nothing.
    const pastCap = POPULATION_PARSE_LIMITS.inputBytes + 1;
    await sparse('big.md', pastCap);
    await sparse('big.csv', pastCap);

    const registry = new ContributorRegistry();
    registry.register(new FilesystemExtentContributor(() => crawlSourceFor(root, []), DEFAULT_CONTENT_DEMAND));
    const { projection } = await populate({ root, registry });

    const stateAt = (name: string) =>
      projection.resourceRealizations.find((row) => toForwardSlash(row.path) === name)?.contentState;
    expect(stateAt('big.md')).toBe('oversize');
    // The control: the cap is a parse's, so a file no parser reads is keyed at the same size.
    expect(stateAt('big.csv')).toBe('keyed');
    expect(notAdmittedRealizations(projection, root).parseRefused.map(({ code }) => code))
      .toStrictEqual(['RESOURCE_PARSE_LIMIT_EXCEEDED']);
  });
});
