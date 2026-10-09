/**
 * `fsBoundary` decides a fault's side from the path the OS named, by containment
 * against declared roots. Containment is the filesystem's judgement (`isUnderRoot`
 * canonicalises with lstat/realpath), so these run on a real tree.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fsBoundary, type FsRoots } from '../../src/errors/fs-boundary.js';
import type { FsSide } from '../../src/errors/fs-fault.js';
import { mkdirSyncReal } from '../../src/fs.js';
import { safePath } from '../../src/path-core.js';
import { tempDirTracker } from '../../src/testing/temp-dir.js';

const scratch = tempDirTracker('fs-fault-boundary-');

interface Tree { source: string; destination: string; environment: string; base: string }

function plant(): Tree {
  const base = scratch.create();
  const tree = { base, source: safePath.join(base, 'agent'), destination: safePath.join(base, 'out'), environment: safePath.join(base, 'stage') };
  mkdirSyncReal(tree.source);
  mkdirSyncReal(tree.destination);
  mkdirSyncReal(tree.environment);
  return tree;
}

function rootsOf(tree: Tree): FsRoots {
  return { source: [tree.source], destination: [tree.destination], environment: [tree.environment] };
}

function errno(code: string, fields: Record<string, string> = {}): Error & { code: string } {
  return Object.assign(new Error(`${code}: simulated`), { code }, fields);
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

/** Run `raw` through a boundary built from the tree, wrapped by a call declaring `fallback`. */
function classified(tree: Tree, raw: Error, fallback: FsSide, options?: { shapeFromSource?: boolean }): unknown {
  const boundary = fsBoundary(rootsOf(tree), options);
  return thrownBy(() => boundary.runSync('copy', fallback, () => { throw raw; }));
}

describe('fsBoundary', () => {
  let tree: Tree;
  beforeEach(() => { tree = plant(); });
  afterEach(() => { scratch.cleanupAll(); });

  it('picks source for an error under the source root even when the call says destination (R7 c-I2)', () => {
    expect(classified(tree, errno('EACCES', { path: safePath.join(tree.source, 'skills', 'a.md') }), 'destination')).toMatchObject({ side: 'source' });
  });

  it.each([
    ['source', 'destination'],
    ['destination', 'source'],
    ['environment', 'source'],
  ] as const)('a fault ON the %s root itself is that side, not the wrapper\'s %s', (side, fallback) => {
    expect(classified(tree, errno('EACCES', { path: tree[side] }), fallback)).toMatchObject({ side });
  });

  it('a fault on a declared root that does not exist yet is still that side', () => {
    const missing = fsBoundary({ destination: [safePath.join(tree.base, 'not-yet')] });
    expect(missing.sideOf(safePath.join(tree.base, 'not-yet'))).toBe('destination');
    expect(missing.sideOf(safePath.join(tree.base, 'not-yet', 'x'))).toBe('destination');
  });

  it('decides the side from the named path, then from dest', () => {
    expect(classified(tree, errno('ENOSPC', { path: safePath.join(tree.destination, 'a') }), 'source')).toMatchObject({ side: 'destination' });
    expect(classified(tree, errno('EXDEV', { path: safePath.join(tree.base, 'elsewhere', 'x'), dest: safePath.join(tree.environment, 'b') }), 'source'))
      .toMatchObject({ side: 'environment' });
  });

  it('falls back to the declared side when the error names no path or an unrooted one', () => {
    expect(classified(tree, errno('EIO'), 'destination')).toMatchObject({ side: 'destination' });
    expect(classified(tree, errno('EIO', { path: safePath.join(tree.base, 'unrelated', 'x') }), 'destination')).toMatchObject({ side: 'destination' });
  });

  it('a sibling that merely shares the root as a name prefix is not under it', () => {
    expect(fsBoundary({ destination: [tree.destination] }).sideOf(`${tree.destination}side`)).toBeUndefined();
  });

  it('the most specific root wins when one side nests inside another', () => {
    const nested = fsBoundary({ destination: [tree.destination], environment: [safePath.join(tree.destination, '.staging')] });
    expect(nested.sideOf(safePath.join(tree.destination, '.staging', 'x'))).toBe('environment');
    expect(nested.sideOf(safePath.join(tree.destination, '.staging'))).toBe('environment');
    expect(nested.sideOf(safePath.join(tree.destination, 'y'))).toBe('destination');
  });

  it('applies shapeFromSource to the side the path decided, and a source fault is then content', () => {
    const options = { shapeFromSource: true };
    expect(classified(tree, errno('EEXIST', { path: safePath.join(tree.environment, 'a') }), 'environment', options))
      .toMatchObject({ side: 'source', origin: 'content' });
    expect(classified(tree, errno('ENOSPC', { path: safePath.join(tree.environment, 'a') }), 'environment', options))
      .toMatchObject({ side: 'environment' });
    // already under the source root: not promoted, still content
    expect(classified(tree, errno('EACCES', { path: safePath.join(tree.source, 'a') }), 'environment', options))
      .toMatchObject({ side: 'source', origin: 'content' });
  });

  it('a root the OS refuses to examine owns nothing, and the fault is still classified', () => {
    const unexaminable = fsBoundary({ source: [safePath.join(tree.base, 'a'.repeat(5000))] });
    const raw = errno('EACCES', { path: safePath.join(tree.source, 'a') });
    const out = thrownBy(() => unexaminable.runSync('read', 'destination', () => { throw raw; }));
    expect(out).toMatchObject({ side: 'destination', errno: 'EACCES', cause: raw });
  });

  it('a defect while examining a root is loud and carries both errors', () => {
    const poisoned = fsBoundary({ source: [`${tree.source}${String.fromCodePoint(0)}x`] });
    const raw = errno('EACCES', { path: safePath.join(tree.source, 'a') });
    const out = thrownBy(() => poisoned.runSync('read', 'destination', () => { throw raw; }));
    expect(out).toBeInstanceOf(AggregateError);
    const { errors } = out as AggregateError;
    expect(errors).toHaveLength(2);
    expect(errors[1]).toBe(raw);
    expect(errors[0]).not.toBe(raw);
  });

  it('classify() decides a caught error by the path it names, and passes a non-fs error through', () => {
    const boundary = fsBoundary(rootsOf(tree));
    expect(boundary.classify(errno('EACCES', { path: safePath.join(tree.environment, 'x') }), 'extract', 'source')).toMatchObject({ side: 'environment', action: 'extract' });
    expect(boundary.classify(errno('EACCES'), 'extract', 'destination')).toMatchObject({ side: 'destination' });
    const bug = new TypeError('x');
    expect(boundary.classify(bug, 'extract', 'source')).toBe(bug);
  });

  it('run() classifies an async rejection and passes a non-fs error through', async () => {
    const boundary = fsBoundary(rootsOf(tree));
    await expect(boundary.run('read', 'destination', () => Promise.reject(errno('EACCES', { path: safePath.join(tree.source, 'a') }))))
      .rejects.toMatchObject({ side: 'source' });
    const bug = new TypeError('x');
    await expect(boundary.run('read', 'source', () => Promise.reject(bug))).rejects.toBe(bug);
  });
});
