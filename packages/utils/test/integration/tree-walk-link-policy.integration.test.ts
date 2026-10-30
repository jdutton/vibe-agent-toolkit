/**
 * The walk's link policy holds for its ROOT as for every entry under it, and `refuse` is a
 * policy: a tree that may hold no link (one VAT extracted from an archive) is walked with it.
 *
 * The root used to be listed and `stat`-ed, so `links: 'preserve'` protected every entry except
 * the one the caller named — a root that was a link was followed wherever it led.
 */
import { lstatSync, readdirSync, readlinkSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { isFsFaultError } from '../../src/errors/fs-fault.js';
import { safePath } from '../../src/path-core.js';
import { createSymlink, symlinkCapability } from '../../src/test-helpers.js';
import { copyTree } from '../../src/tree-change/copy-tree.js';
import { proveTreeReadable } from '../../src/tree-change/readable-tree.js';

import { plant, present, readText, rejectionOf, treeChangeSuite } from './tree-change-test-kit.js';

const suite = treeChangeSuite('tree-walk-link-policy-');

/** A real directory holding one file, and a link to it beside it. */
function linkedRoot(skip: () => never): { root: string; real: string; link: string } {
  const capability = symlinkCapability() ?? skip();
  const root = suite.root();
  const real = safePath.join(root, 'real');
  plant(real, { 'PRIVATE.txt': 'the target\'s own file' });
  const link = safePath.join(root, 'link');
  createSymlink(capability, real, link, 'dir');
  return { root, real, link };
}

describe('a walk whose root is a link', () => {
  it('preserve: the root is copied as the link it is, never as what it points at', async ({ skip }) => {
    const { root, real, link } = linkedRoot(skip);
    const dest = safePath.join(root, 'dest');

    await copyTree(link, dest, 'copy', { links: 'preserve', side: 'source', onto: 'fresh' });

    const copied = safePath.join(dest, 'copy');
    expect(lstatSync(copied).isSymbolicLink()).toBe(true);
    expect(readlinkSync(copied)).toBe(readlinkSync(link));
    // Nothing of the target was read into the destination.
    expect(readdirSync(dest)).toEqual(['copy']);
    expect(present(safePath.join(real, 'PRIVATE.txt'))).toBe(true);
  });

  it('refuse: the copy is refused on the tree\'s side, and nothing is written', async ({ skip }) => {
    const { root, link } = linkedRoot(skip);
    const dest = safePath.join(root, 'dest');

    const error = await rejectionOf(() => copyTree(link, dest, 'copy', { links: 'refuse', side: 'environment', onto: 'fresh' }));

    expect(isFsFaultError(error), String(error)).toBe(true);
    expect(error).toMatchObject({ side: 'environment', faultClass: 'wrong-type', path: link });
    expect(present(dest)).toBe(false);
  });

  it('refuse: the proof is refused too', async ({ skip }) => {
    const { link } = linkedRoot(skip);
    expect(await rejectionOf(() => proveTreeReadable(link, { links: 'refuse', side: 'environment' }))).toMatchObject({ side: 'environment', faultClass: 'wrong-type' });
  });

  it('follow-contained: the root is what it points at, as before', async ({ skip }) => {
    const { root, link } = linkedRoot(skip);
    const dest = safePath.join(root, 'dest');

    await copyTree(link, dest, 'copy', { links: 'follow-contained', side: 'source', onto: 'fresh' });

    expect(readText(safePath.join(dest, 'copy', 'PRIVATE.txt'))).toBe('the target\'s own file');
  });
});

describe('links: refuse', () => {
  it('refuses a link anywhere in the tree, naming it', async ({ skip }) => {
    const capability = symlinkCapability() ?? skip();
    const root = suite.root();
    const source = safePath.join(root, 'source');
    plant(source, { 'a.md': 'a', 'sub/b.md': 'b' });
    createSymlink(capability, safePath.join(source, 'a.md'), safePath.join(source, 'sub', 'alias.md'), 'file');

    const error = await rejectionOf(() => proveTreeReadable(source, { links: 'refuse', side: 'environment' }));

    expect(error).toMatchObject({ side: 'environment', faultClass: 'wrong-type', path: safePath.join(source, 'sub', 'alias.md') });
    expect((error as Error).message).toContain('symbolic link');
  });

  it('walks a tree that holds none', async () => {
    const source = safePath.join(suite.root(), 'source');
    plant(source, { 'a.md': 'a', 'sub/b.md': 'b' });
    await expect(proveTreeReadable(source, { links: 'refuse', side: 'environment' })).resolves.toBeUndefined();
  });
});
