/**
 * A named pipe has no content to decode, and opening one for reading blocks
 * until a writer appears — so a FIFO a parse or packaging lane reached through
 * `readDecodableBytes` hung the whole run. It is refused unread, coded `EFTYPE`
 * (an environmental errno, so every lane's own refusal convention applies).
 *
 * System tier: the fixture is a real FIFO, made by spawning `mkfifo`. POSIX only.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, open, rm } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isFilesystemAccessError } from '../../src/errors/errno.js';
import { normalizedTmpdir } from '../../src/path-utils.js';
import { safePath } from '../../src/path.js';
import { readDecodableBytes, readTextContent, readTextContentSync } from '../../src/text-file.js';

/** How long a read may take before the test calls it hung on the pipe. */
const HANG_MS = 3000;

describe.skipIf(process.platform === 'win32')('text-file readers — a named pipe', () => {
  let dir = '';
  let fifo = '';

  beforeEach(async () => {
    dir = await mkdtemp(safePath.join(normalizedTmpdir(), 'vat-text-fifo-'));
    fifo = safePath.join(dir, 'pipe.md');
    execFileSync('mkfifo', [fifo]);
  });

  afterEach(async () => {
    // Release a reader a failing implementation left blocked: opening read-write never blocks, and is a writer.
    await (await open(fifo, 'r+')).close();
    await rm(dir, { recursive: true, force: true });
  });

  it.for([
    ['readDecodableBytes', (path: string) => readDecodableBytes(path)],
    ['readTextContent', (path: string) => readTextContent(path)],
  ] as const)('%s refuses it unopened-for-content, as an environmental EFTYPE', async ([, read]) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const hung = new Promise((resolve) => { timer = setTimeout(() => resolve('hung on the pipe'), HANG_MS); });
      const outcome = await Promise.race([read(fifo).then(() => 'read', (error: unknown) => error), hung]);
      expect(outcome).toMatchObject({ code: 'EFTYPE', path: fifo });
      expect(isFilesystemAccessError(outcome)).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  it('readTextContentSync refuses it the same way', () => {
    // Synchronous, so no race can bound it: a blocking open would hang the worker itself.
    expect(() => readTextContentSync(fifo)).toThrow(expect.objectContaining({ code: 'EFTYPE' }) as unknown as Error);
  });
});
