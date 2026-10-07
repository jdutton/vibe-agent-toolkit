/**
 * `copyDirectory` over a tree holding a named pipe. `copyFile` of a pipe opens it
 * for reading, which blocks until a writer appears — so a FIFO in a built agent
 * bundle hung `vat agent install` forever. A pipe (or a link to one) has no bytes
 * to copy: it is refused, coded as the source's, without being opened.
 *
 * System tier: the fixture is a real FIFO, made by spawning `mkfifo`. POSIX only.
 */
import type { Dirent } from 'node:fs';
import fs, { mkdir } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { COPY_SOURCE_NOT_REGULAR_CODE, copyDirectory } from '../../src/fs-utils.js';
import { safePath } from '../../src/path.js';
import { createSymlinkAsync, symlinkCapability } from '../../src/test-helpers.js';

import { outcomeOrHang, setupFifoSuite } from './fifo-race.js';

/**
 * Run `body` with `copyDirectory`'s listing of `dir` passed through `edit` — the
 * one listing the walk acts on, so a test can choose what it sees.
 */
async function withListing<T>(dir: string, edit: (entries: Dirent[]) => Dirent[], body: () => Promise<T>): Promise<T> {
  const realReaddir = fs.readdir.bind(fs) as (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>;
  const spy = vi.spyOn(fs, 'readdir').mockImplementation((async (path: string, options: { withFileTypes: true }) => {
    const entries = await realReaddir(path, options);
    return path === dir ? edit(entries) : entries;
  }) as unknown as typeof fs.readdir);
  try {
    return await body();
  } finally {
    spy.mockRestore();
  }
}

describe.skipIf(process.platform === 'win32')('copyDirectory — a named pipe in the source', () => {
  // Inside the source: a link out of it would be refused as an escape first.
  const suite = setupFifoSuite('vat-copy-fifo-', 'src/pipe');

  it('refuses a named pipe, coded as the source\'s, without blocking on it', async () => {
    const outcome = await outcomeOrHang(copyDirectory(safePath.join(suite.dir(), 'src'), safePath.join(suite.dir(), 'dest')));
    expect(outcome).toMatchObject({ code: COPY_SOURCE_NOT_REGULAR_CODE, message: expect.stringContaining(suite.fifo()) as unknown });
  });

  // The suite's pipe sits beside the link, and whichever is listed first would be
  // refused first — so the listing of `src` is narrowed to `scripts`, leaving the
  // link the ONLY way to the pipe. The refusal must then name the link.
  it('refuses a link to a named pipe, naming the link', async ({ skip }) => {
    const src = safePath.join(suite.dir(), 'src');
    const link = safePath.join(src, 'scripts', 'link');
    await mkdir(safePath.join(src, 'scripts'));
    await createSymlinkAsync(symlinkCapability() ?? skip(), suite.fifo(), link);

    const outcome = await withListing(src, (entries) => entries.filter((entry) => entry.name === 'scripts'), () =>
      outcomeOrHang(copyDirectory(src, safePath.join(suite.dir(), 'dest'))),
    );
    expect(outcome).toMatchObject({ code: COPY_SOURCE_NOT_REGULAR_CODE, message: expect.stringContaining(link) as unknown });
  });

  // A regular file swapped for a pipe between the listing and the copy: the
  // listing still says "file", so only the handle the copy opens can tell. The
  // swap is simulated by a listing that reports the pipe as a regular file.
  it('refuses an entry that is a named pipe by the time it is opened, without blocking on it', async () => {
    const src = safePath.join(suite.dir(), 'src');
    const asRegularFile = (entry: Dirent): Dirent =>
      Object.assign(Object.create(entry) as Dirent, { isFile: () => true, isFIFO: () => false });
    const outcome = await withListing(src, (entries) => entries.map((entry) => (entry.name === 'pipe' ? asRegularFile(entry) : entry)), () =>
      outcomeOrHang(copyDirectory(src, safePath.join(suite.dir(), 'dest'))),
    );
    expect(outcome).toMatchObject({ code: COPY_SOURCE_NOT_REGULAR_CODE, message: expect.stringContaining(suite.fifo()) as unknown });
  });
});
