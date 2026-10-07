/**
 * `copyDirectory` over a tree holding a named pipe. `copyFile` of a pipe opens it
 * for reading, which blocks until a writer appears — so a FIFO in a built agent
 * bundle hung `vat agent install` forever. A pipe (or a link to one) has no bytes
 * to copy: it is refused, coded as the source's, without being opened.
 *
 * System tier: the fixture is a real FIFO, made by spawning `mkfifo`. POSIX only.
 */
import { mkdir } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { COPY_SOURCE_NOT_REGULAR_CODE, copyDirectory } from '../../src/fs-utils.js';
import { safePath } from '../../src/path.js';
import { createSymlinkAsync, symlinkCapability } from '../../src/test-helpers.js';

import { outcomeOrHang, setupFifoSuite } from './fifo-race.js';

describe.skipIf(process.platform === 'win32')('copyDirectory — a named pipe in the source', () => {
  // Inside the source: a link out of it would be refused as an escape first.
  const suite = setupFifoSuite('vat-copy-fifo-', 'src/pipe');

  it('refuses a named pipe, coded as the source\'s, without blocking on it', async () => {
    const outcome = await outcomeOrHang(copyDirectory(safePath.join(suite.dir(), 'src'), safePath.join(suite.dir(), 'dest')));
    expect(outcome).toMatchObject({ code: COPY_SOURCE_NOT_REGULAR_CODE, message: expect.stringContaining(suite.fifo()) as unknown });
  });

  // The listing order decides whether the pipe or the link to it is reached first,
  // so only the code is pinned: what matters is that neither is opened.
  it('refuses a link to a named pipe the same way', async ({ skip }) => {
    const src = safePath.join(suite.dir(), 'src');
    await mkdir(safePath.join(src, 'scripts'));
    await createSymlinkAsync(symlinkCapability() ?? skip(), suite.fifo(), safePath.join(src, 'scripts', 'link'));

    const outcome = await outcomeOrHang(copyDirectory(src, safePath.join(suite.dir(), 'dest')));
    expect(outcome).toMatchObject({ code: COPY_SOURCE_NOT_REGULAR_CODE });
  });
});
