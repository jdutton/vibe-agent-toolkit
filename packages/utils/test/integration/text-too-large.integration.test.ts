/**
 * A file too large to become a JS string is refused BEFORE its bytes are read.
 *
 * The fixtures are sparse: `truncate` on an empty file sets its length without
 * writing a byte, so a file past V8's string-length limit costs no disk on
 * APFS/ext4 and no time anywhere.
 *
 * The two sizes prove two different things. One byte past the limit is the
 * boundary itself. Past 2 GiB is the proof that the refusal comes from a `stat`
 * and not from a read: `readFile` refuses that size with its own
 * `ERR_FS_FILE_TOO_LARGE`, so a read-first implementation cannot produce
 * `TextTooLargeError` there — and a file above the limit but under 2 GiB would be
 * read in full (half a gigabyte) before any decode could complain.
 */

import { mkdtemp, open, rm } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isVatError } from '../../src/errors/vat-error.js';
import { normalizedTmpdir } from '../../src/path-utils.js';
import { safePath } from '../../src/path.js';
import { TextTooLargeError } from '../../src/text-content.js';
import { MAX_DECODABLE_BYTES, readTextContent, readTextContentSync } from '../../src/text-file.js';

/** Past `readFile`'s own 2 GiB ceiling — see the module docstring. */
const PAST_READFILE_LIMIT = 2 ** 31 + 1;

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(safePath.join(normalizedTmpdir(), 'vat-text-too-large-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Plant a sparse file of `size` bytes and return its path. */
async function sparse(name: string, size: number): Promise<string> {
  const file = safePath.join(dir, name);
  const handle = await open(file, 'w');
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
  return file;
}

/** What `run` threw, or undefined. */
async function thrownBy(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('readTextContent refuses an undecodable size without reading it', () => {
  it('refuses one byte past the limit, asynchronously', async () => {
    const file = await sparse('huge.csv', MAX_DECODABLE_BYTES + 1);
    const error = await thrownBy(() => readTextContent(file));
    expect(isVatError(error, TextTooLargeError.code)).toBe(true);
  });

  it('refuses one byte past the limit, synchronously', async () => {
    const file = await sparse('huge-sync.csv', MAX_DECODABLE_BYTES + 1);
    const error = await thrownBy(() => readTextContentSync(file));
    expect(isVatError(error, TextTooLargeError.code)).toBe(true);
  });

  it('refuses past 2 GiB with the same error — the stat decided, not a read', async () => {
    const file = await sparse('huger.csv', PAST_READFILE_LIMIT);
    const error = await thrownBy(() => readTextContent(file));
    expect(isVatError(error, TextTooLargeError.code)).toBe(true);
    expect((error as TextTooLargeError).byteLength).toBe(PAST_READFILE_LIMIT);
  });
});
