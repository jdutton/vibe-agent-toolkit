/**
 * `fsBoundary` when no root claims the path a fault names: the caller's fallback side decides,
 * a value that is not a filesystem fault is never dressed up as one, and `run` / `runSync`
 * classify exactly what their work threw. No root is declared here, so nothing is examined on
 * disk (the containment half is covered against real trees in the integration tier).
 */

import { describe, expect, it } from 'vitest';

import { fsBoundary } from '../../src/errors/fs-boundary.js';
import { isFsFaultError } from '../../src/errors/fs-fault.js';

const errno = (code: string, extra: Record<string, unknown> = {}): Error => Object.assign(new Error(`${code}: refused`), { code, ...extra });
const caught = (work: () => unknown): unknown => {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
};

describe('fsBoundary with no root claiming the path', () => {
  it('owns no path', () => {
    expect(fsBoundary({}).sideOf('/anywhere/at/all')).toBeUndefined();
  });

  it('classifies a fault on the fallback side, whether or not it names a path', () => {
    const boundary = fsBoundary({});
    expect(boundary.classify(errno('EACCES', { path: '/x/y', syscall: 'open' }), 'read the input', 'source')).toMatchObject({ side: 'source', faultClass: 'refused', errno: 'EACCES', path: '/x/y' });
    expect(boundary.classify(errno('ENOSPC'), 'write the output', 'destination')).toMatchObject({ side: 'destination', faultClass: 'exhausted' });
  });

  it('hands back a value that is not a filesystem fault untouched', () => {
    const defect = new TypeError('undefined is not a function');
    expect(fsBoundary({}).classify(defect, 'read', 'source')).toBe(defect);
    expect(fsBoundary({}).classify('a string', 'read', 'source')).toBe('a string');
  });

  it('records the origin and the layout promotion the boundary was made with', () => {
    const content = fsBoundary({}, { origin: 'content' }).classify(errno('EACCES', { path: '/x' }), 'read', 'source');
    expect(content).toMatchObject({ origin: 'content' });
    // A layout fault (a file in the way) raised while writing a bundle the source's config shaped is the source's.
    const promoted = fsBoundary({}, { shapeFromSource: true }).classify(errno('ENOTDIR', { path: '/out/a/b' }), 'write the bundle', 'destination');
    expect(promoted).toMatchObject({ side: 'source', errno: 'ENOTDIR' });
    const plain = fsBoundary({}).classify(errno('ENOTDIR', { path: '/out/a/b' }), 'write the bundle', 'destination');
    expect(plain).toMatchObject({ side: 'destination' });
  });
});

describe('fsBoundary.run / runSync', () => {
  it('pass a result through', async () => {
    const boundary = fsBoundary({});
    await expect(boundary.run('read', 'source', async () => 42)).resolves.toBe(42);
    expect(boundary.runSync('read', 'source', () => 'ok')).toBe('ok');
  });

  it('rethrow a filesystem fault classified on the fallback side, naming the action', async () => {
    const boundary = fsBoundary({});
    const asyncFault = await boundary.run('list the staging directory', 'environment', async () => {
      throw errno('EMFILE');
    }).then(() => undefined, (error: unknown) => error);
    expect(isFsFaultError(asyncFault)).toBe(true);
    expect(asyncFault).toMatchObject({ side: 'environment', faultClass: 'exhausted' });
    expect((asyncFault as Error).message).toContain('list the staging directory');

    const syncFault = caught(() => boundary.runSync('examine the output', 'destination', () => {
      throw errno('EPERM', { path: '/out' });
    }));
    expect(syncFault).toMatchObject({ side: 'destination', faultClass: 'refused', path: '/out' });
  });

  it('rethrow anything else as it was', async () => {
    const boundary = fsBoundary({});
    const defect = new RangeError('bad length');
    await expect(boundary.run('read', 'source', async () => {
      throw defect;
    })).rejects.toBe(defect);
    expect(caught(() => boundary.runSync('read', 'source', () => {
      throw defect;
    }))).toBe(defect);
  });
});
