/**
 * A classified fault is named, and sided, by the path the failing SYSCALL acted on.
 *
 * Node puts a two-path call's first argument in `error.path` and its second in `error.dest`. For
 * `symlink(target, link)` that makes `path` the link's TARGET TEXT — a string, often relative,
 * that names nothing the call touched — and `dest` the entry it was creating; for
 * `rename(from, to)` it makes `path` the entry being moved and `dest` the place it could not
 * land. Reading `path` first named a refused link by its target, and sided a failed write by
 * wherever that text happened to resolve from the working directory.
 *
 * The errors here are the OS's own, raised on a real tree, so the field layout under test is
 * Node's and not this file's idea of it.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fsBoundary } from '../../src/errors/fs-boundary.js';
import { classifyFsFault, type FsFaultError, isFsFaultError } from '../../src/errors/fs-fault.js';
import { mkdirSyncReal } from '../../src/fs.js';
import { safePath, toForwardSlash } from '../../src/path-core.js';
import { createSymlink, symlinkCapability } from '../../src/test-helpers.js';
import { tempDirTracker } from '../../src/testing/temp-dir.js';

const scratch = tempDirTracker('fs-fault-syscall-path-');

interface Tree { source: string; destination: string }

function plant(): Tree {
  const base = scratch.create();
  const tree = { source: safePath.join(base, 'agent'), destination: safePath.join(base, 'out') };
  mkdirSyncReal(tree.source);
  mkdirSyncReal(tree.destination);
  return tree;
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

function asFault(error: unknown): FsFaultError {
  if (!isFsFaultError(error)) throw new Error(`expected a classified fault, got ${String(error)}`);
  return error;
}

/** `symlink(target, link)` refused because `link` is already there: the OS names both. */
function refusedLink(tree: Tree, target: string, skip: () => never): { raw: unknown; link: string } {
  const capability = symlinkCapability() ?? skip();
  const link = safePath.join(tree.destination, 'taken');
  writeFileSync(link, 'already here');
  return { raw: thrownBy(() => { createSymlink(capability, target, link); }), link };
}

/** A `rename(from, to)` the OS refused as absent, classified through a boundary over the tree's two roots. */
function refusedRename(tree: Tree, from: string, to: string): FsFaultError {
  const raw = thrownBy(() => { renameSync(from, to); });
  expect(raw).toMatchObject({ code: 'ENOENT', syscall: 'rename' });
  const fault = asFault(fsBoundary({ source: [tree.source], destination: [tree.destination] }).classify(raw, 'swap in the staged entry', 'environment'));
  // Whichever end it is sided by, the message names both.
  expect(fault.message).toContain(toForwardSlash(from));
  expect(fault.message).toContain(toForwardSlash(to));
  return fault;
}

describe('a fault is named and sided by the path its syscall acted on', () => {
  let tree: Tree;
  beforeEach(() => { tree = plant(); });
  afterEach(() => { scratch.cleanupAll(); });

  it('names a refused symlink by the LINK it could not create, never by its target text', ({ skip }) => {
    const { raw, link } = refusedLink(tree, '../shared/x', skip);
    // The premise, read off the OS's own error: `path` is the target text, `dest` the link. On
    // win32 Node rewrites a relative target's `/` to `\` before the call, and reports that text.
    expect(raw).toMatchObject({ code: 'EEXIST', syscall: 'symlink' });
    expect(toForwardSlash(String((raw as { path?: unknown }).path))).toBe('../shared/x');

    const fault = asFault(classifyFsFault(raw, { side: 'destination', action: 'create the link' }));

    expect(fault.path).toBe(toForwardSlash(link));
    expect(fault.message).toContain(toForwardSlash(link));
    expect(fault.message).not.toContain('../shared/x');
    expect(fault.message).not.toContain(String.raw`..\shared\x`);
  });

  it('sides a refused symlink by the link, when its target text points into another side\'s root', ({ skip }) => {
    // An absolute target under the SOURCE root; the write that failed is in the DESTINATION.
    const { raw } = refusedLink(tree, safePath.join(tree.source, 'shared', 'x'), skip);
    const boundary = fsBoundary({ source: [tree.source], destination: [tree.destination] });

    expect(asFault(boundary.classify(raw, 'create the link', 'environment')).side).toBe('destination');
  });

  it('names a refused rename by BOTH ends, and sides it by where the entry could not land', () => {
    const from = safePath.join(tree.source, 'staged');
    const to = safePath.join(tree.destination, 'missing-parent', 'landed');
    writeFileSync(from, 'payload');

    const fault = refusedRename(tree, from, to);

    expect(fault.side).toBe('destination');
    expect(fault.path).toBe(toForwardSlash(to));
    expect(fault.movedFrom).toBe(toForwardSlash(from));
  });

  // The other way a rename is `ENOENT`: the entry being moved is not there. That is the SOURCE
  // end's absence — where the entry was to land exists, and nothing is wrong with it.
  it('sides a rename whose SOURCE is the absent end by the source, still naming both ends', () => {
    const from = safePath.join(tree.source, 'never-staged');
    const to = safePath.join(tree.destination, 'landed');

    expect(refusedRename(tree, from, to).side).toBe('source');
  });

  // The control: a one-path call is named by its one path, as before, and carries no second end.
  it('names a one-path call by its path, with no second end', () => {
    const absent = safePath.join(tree.source, 'absent.md');
    const raw = thrownBy(() => readFileSync(absent));
    expect(raw).toMatchObject({ code: 'ENOENT', syscall: 'open' });

    const fault = asFault(classifyFsFault(raw, { side: 'source', action: 'read the file' }));

    expect(fault.path).toBe(toForwardSlash(absent));
    expect(fault.movedFrom).toBeUndefined();
  });
});
