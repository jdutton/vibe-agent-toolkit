/**
 * A `preserve` copy creates each link with an explicit type read off the chain VAT walked — never
 * an untyped `symlink`. On Windows, Node's `fs.symlink(target, path)` with no `type` asks the KERNEL
 * to `stat` the target to pick `file` or `dir` (`lib/internal/fs/promises.js`: `isWindows && type ==
 * null` awaits `stat(resolve(path, '..', target))`), and the kernel's follow of a `\\host\share` text
 * is itself the leak: an SMB session offering the operator's NTLM credentials. So a link text no walk
 * read never reaches that `stat`, and a network or device text is refused before anything is made.
 *
 * Node's Windows branch is emulated on every host by a spy on `fs/promises.symlink` that does what
 * Node does when `type` is absent, recording each target it asks the kernel about; the host flavor
 * is bound to `win32`, so the walk reads every text by Windows rules.
 */
import fsPromises from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LINK_CHAIN_REFUSED_CODE } from '../../src/errors/errno-table.js';
import { safePath, toForwardSlash } from '../../src/path-core.js';
import { createSymlink, symlinkCapability } from '../../src/test-helpers.js';
import { copyTree } from '../../src/tree-change/copy-tree.js';

import { plant, present, treeChangeSuite } from './tree-change-test-kit.js';

vi.mock('../../src/tree-change/link-chain.js', async (importOriginal) => ({ ...(await importOriginal<object>()), HOST_PATH_FLAVOR: 'win32' }));

const suite = treeChangeSuite('copy-tree-link-type-');
const UNC = String.raw`\\attacker\share\y`;

/** Every `symlink` the copy made (its type as passed), and every target Node's Windows branch would have `stat`-ed. */
function spyOnSymlink(): { made: Array<{ link: string; type: string | null | undefined }>; statted: string[] } {
  const made: Array<{ link: string; type: string | null | undefined }> = [];
  const statted: string[] = [];
  const realSymlink = fsPromises.symlink;
  vi.spyOn(fsPromises, 'symlink').mockImplementation(async (target, link, type) => {
    made.push({ link: toForwardSlash(String(link)), type });
    if (type === undefined || type === null) {
      // Node on Windows: the kernel follows the target to pick a type.
      statted.push(safePath.resolve(String(link), '..', String(target)));
    }
    await realSymlink(target, link, type);
  });
  return { made, statted };
}

describe('a preserve copy types every link it makes from the chain it walked (win32 semantics)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(String.raw`refuses x -> \\attacker\share\y before anything asks the kernel about the target`, async ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const root = suite.root();
    const source = safePath.join(root, 'source');
    plant(source, { 'a.txt': 'a' });
    createSymlink(cap, UNC, safePath.join(source, 'x'), 'file');
    const spy = spyOnSymlink();

    // Settled, not `rejectionOf`: a copy that went through must still say what it asked the kernel.
    const error: unknown = await copyTree(source, safePath.join(root, 'dest'), 'copy', { links: 'preserve', side: 'source', onto: 'fresh' })
      .then(() => undefined, (rejected: unknown) => rejected);

    expect(spy.statted, 'targets Node would have asked the kernel to follow').toEqual([]);
    expect(spy.made, 'links made').toEqual([]);
    expect(error).toMatchObject({ side: 'source', faultClass: 'refused', errno: LINK_CHAIN_REFUSED_CODE });
    expect(present(safePath.join(root, 'dest', 'copy', 'x'))).toBe(false);
  });

  it('makes a link to a directory as `dir`, to a file and a dangle as `file`, each verbatim', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const root = suite.root();
    const source = safePath.join(root, 'source');
    plant(source, { 'a.txt': 'a', 'sub/b.txt': 'b' });
    createSymlink(cap, 'sub', safePath.join(source, 'd'), 'dir');
    createSymlink(cap, 'a.txt', safePath.join(source, 'f'), 'file');
    createSymlink(cap, 'missing', safePath.join(source, 'gone'), 'file');
    const spy = spyOnSymlink();
    const copied = safePath.join(root, 'dest', 'copy');

    await copyTree(source, safePath.join(root, 'dest'), 'copy', { links: 'preserve', side: 'source', onto: 'fresh' });

    expect(spy.statted).toEqual([]);
    expect(spy.made.toSorted((a, b) => a.link.localeCompare(b.link))).toEqual([
      { link: safePath.join(copied, 'd'), type: 'dir' },
      { link: safePath.join(copied, 'f'), type: 'file' },
      { link: safePath.join(copied, 'gone'), type: 'file' },
    ]);
    expect(await fsPromises.readlink(safePath.join(copied, 'd'))).toBe('sub');
  });
});
