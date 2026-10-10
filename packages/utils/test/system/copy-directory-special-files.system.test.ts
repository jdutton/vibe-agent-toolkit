/**
 * `copyTree` and `proveTreeReadable` over a tree holding a named pipe. `copyFile`
 * of a pipe opens it for reading, which blocks until a writer appears — so a FIFO
 * in a built agent bundle hung `vat agent install` forever. A pipe (or a link to
 * one) has no bytes to copy: it is refused as a `source` fault of class
 * `wrong-type` (`EFTYPE`), naming it, without being opened.
 *
 * System tier: the fixture is a real FIFO, made by spawning `mkfifo`. POSIX only.
 */
import type { Dirent } from 'node:fs';
import fs, { mkdir } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { FS_FAULT_CODE } from '../../src/errors/fs-fault.js';
import { safePath } from '../../src/path.js';
import { createSymlinkAsync, symlinkCapability } from '../../src/test-helpers.js';
import { installFaultFs } from '../../src/testing/fault-fs.js';
import { copyTree } from '../../src/tree-change/copy-tree.js';
import { proveTreeReadable } from '../../src/tree-change/readable-tree.js';

import { outcomeOrHang, setupFifoSuite } from './fifo-race.js';

/** The refusal of a special file at `path`: the source's, its type wrong, named. */
const refusedSpecial = (path: string): Record<string, unknown> => ({
  code: FS_FAULT_CODE, side: 'source', faultClass: 'wrong-type', errno: 'EFTYPE', path,
});

const FOLLOW = { links: 'follow-contained', side: 'source', onto: 'fresh' } as const;

/** Run `body` traced under `within`: its outcome, and whether anything opened `fifo`. */
async function tracingOpens(within: string, fifo: string, body: () => Promise<unknown>): Promise<{ outcome: unknown; opened: boolean }> {
  const session = installFaultFs({ within });
  try {
    const outcome = await body();
    return { outcome, opened: session.calls.some((call) => call.op === 'open' && call.path === fifo) };
  } finally {
    session.restore();
  }
}

/**
 * Run `body` with the walk's listing of `dir` passed through `edit` — the
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

describe.skipIf(process.platform === 'win32')('copyTree — a named pipe in the source', () => {
  // Inside the source: a link out of it would be refused as an escape first.
  const suite = setupFifoSuite('vat-copy-fifo-', 'src/pipe');

  it('refuses a named pipe, coded as the source\'s, without opening it', async () => {
    const { outcome, opened } = await tracingOpens(suite.dir(), suite.fifo(), () =>
      outcomeOrHang(copyTree(safePath.join(suite.dir(), 'src'), safePath.join(suite.dir(), 'dest'), FOLLOW)));
    expect(outcome).toMatchObject(refusedSpecial(suite.fifo()));
    expect(opened).toBe(false);
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
      outcomeOrHang(copyTree(src, safePath.join(suite.dir(), 'dest'), FOLLOW)),
    );
    // The path is the LINK's: the walk reached the link, not the pipe beside it (R7 d-M-3).
    expect(outcome).toMatchObject(refusedSpecial(link));
  });

  // A regular file swapped for a pipe between the listing and the copy: the
  // listing still says "file", so only the handle the copy opens can tell. The
  // swap is simulated by a listing that reports the pipe as a regular file.
  it('refuses an entry that is a named pipe by the time it is opened, without blocking on it', async () => {
    const src = safePath.join(suite.dir(), 'src');
    const asRegularFile = (entry: Dirent): Dirent =>
      Object.assign(Object.create(entry) as Dirent, { isFile: () => true, isFIFO: () => false });
    const outcome = await withListing(src, (entries) => entries.map((entry) => (entry.name === 'pipe' ? asRegularFile(entry) : entry)), () =>
      outcomeOrHang(copyTree(src, safePath.join(suite.dir(), 'dest'), FOLLOW)),
    );
    expect(outcome).toMatchObject(refusedSpecial(suite.fifo()));
  });
});

describe.skipIf(process.platform === 'win32')('proveTreeReadable — a named pipe in the tree', () => {
  const suite = setupFifoSuite('vat-prove-fifo-', 'src/pipe');

  it.for(['follow-contained', 'preserve'] as const)('refuses a named pipe under links: %s, without opening it', async (links) => {
    const { outcome, opened } = await tracingOpens(suite.dir(), suite.fifo(), () =>
      outcomeOrHang(proveTreeReadable(safePath.join(suite.dir(), 'src'), { links, side: 'source' })));
    expect(outcome).toMatchObject(refusedSpecial(suite.fifo()));
    expect(opened).toBe(false);
  });

  it('refuses a root that is a named pipe by its listing, without blocking on it', async () => {
    const outcome = await outcomeOrHang(proveTreeReadable(suite.fifo(), { links: 'preserve', side: 'source' }));
    expect(outcome).toMatchObject({ code: FS_FAULT_CODE, side: 'source', errno: 'ENOTDIR', path: suite.fifo() });
  });
});
