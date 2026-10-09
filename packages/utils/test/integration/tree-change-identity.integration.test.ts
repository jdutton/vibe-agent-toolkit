/**
 * Entry identity on a real filesystem: `sameEntry` answers whether two names are
 * one entry, `isInsideByIdentity` whether one entry sits under another, both by
 * dev:ino where the filesystem has it and by a case-folded real path where it does
 * not. Case aliasing is simulated through a stat rewrite so it runs on every OS;
 * the APFS / NTFS case runs only where the temp directory really folds case.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { isFsFaultError } from '../../src/errors/fs-fault.js';
import { safePath } from '../../src/path-core.js';
import { mkdirSyncReal } from '../../src/path-utils.js';
import { createSymlink, symlinkCapability } from '../../src/test-helpers.js';
import { installFaultFs, type FaultFsSession, type StatRewrite } from '../../src/testing/fault-fs.js';
import { tmpdirFoldsCase } from '../../src/testing/platform-gates.js';
import { tempDirTracker } from '../../src/testing/temp-dir.js';
import { entryIdentities, isInsideByIdentity, sameEntry } from '../../src/tree-change/identity.js';

const scratch = tempDirTracker('tree-change-identity-');
let session: FaultFsSession | undefined;
afterEach(() => {
  session?.restore();
  session = undefined;
  scratch.cleanupAll();
});

/** A clone that keeps the Stats prototype, with dev and ino replaced. */
const withIdentity = (dev: bigint, ino: bigint): StatRewrite['rewrite'] => (stats) =>
  Object.assign(Object.create(Object.getPrototypeOf(stats) as object) as typeof stats, stats, { dev, ino });

const rewriteLstat = (paths: readonly string[], dev: bigint, ino: bigint): StatRewrite => ({
  op: 'lstat',
  path: (p) => paths.includes(p),
  rewrite: withIdentity(dev, ino),
});

function makeDir(root: string, ...parts: string[]): string {
  const dir = safePath.join(root, ...parts);
  mkdirSyncReal(dir, { recursive: true });
  return dir;
}

/** A link to `target`, or a skip when the host cannot create one. */
function linkTo(target: string, link: string, skip: () => never): void {
  const cap = symlinkCapability();
  if (cap === null) skip();
  createSymlink(cap, target, link, 'dir');
}

/** `entryIdentities(entry, side)` throws a classified, refused (`EACCES`) fault on `side`. */
function expectRefusedOn(entry: string, side: 'source' | 'destination' | 'environment'): void {
  let thrown: unknown;
  try {
    entryIdentities(entry, side);
  } catch (error: unknown) {
    thrown = error;
  }
  expect(isFsFaultError(thrown)).toBe(true);
  expect(thrown).toMatchObject({ side, faultClass: 'refused', errno: 'EACCES' });
}

describe('sameEntry', () => {
  it.runIf(tmpdirFoldsCase())('answers same for one directory through two case spellings on a case-folding filesystem', () => {
    const root = scratch.create();
    const upper = makeDir(root, 'Plugin');
    expect(sameEntry(upper, safePath.join(root, 'plugin'))).toBe('same');
  });

  it('answers same for two names the filesystem reports with one dev:ino (simulated case aliasing, any OS)', () => {
    const root = scratch.create();
    const oldName = makeDir(root, 'x', 'Old');
    const lowerName = makeDir(root, 'x', 'old-other');
    session = installFaultFs({ within: root, rewrites: [rewriteLstat([oldName, lowerName], 9n, 77n)] });
    expect(sameEntry(oldName, lowerName)).toBe('same');
  });

  it('answers different for two real directories', () => {
    const root = scratch.create();
    expect(sameEntry(makeDir(root, 'a'), makeDir(root, 'b'))).toBe('different');
  });

  it('answers different when either entry is absent', () => {
    const root = scratch.create();
    const a = makeDir(root, 'a');
    expect(sameEntry(a, safePath.join(root, 'missing'))).toBe('different');
    expect(sameEntry(safePath.join(root, 'missing'), safePath.join(root, 'also-missing'))).toBe('different');
  });

  it('answers same for a link and its target', ({ skip }) => {
    const root = scratch.create();
    const target = makeDir(root, 'target');
    const link = safePath.join(root, 'link');
    linkTo(target, link, skip);
    expect(sameEntry(link, target)).toBe('same');
    expect(entryIdentities(link, 'destination').length).toBeGreaterThan(1);
  });

  it('answers same for two links to one target', ({ skip }) => {
    const root = scratch.create();
    const target = makeDir(root, 'target');
    const first = safePath.join(root, 'first');
    const second = safePath.join(root, 'second');
    linkTo(target, first, skip);
    linkTo(target, second, skip);
    expect(sameEntry(first, second)).toBe('same');
  });

  it('answers different for a dangling link and an unrelated directory', ({ skip }) => {
    const root = scratch.create();
    const link = safePath.join(root, 'dangling');
    linkTo(safePath.join(root, 'nowhere'), link, skip);
    expect(sameEntry(link, makeDir(root, 'other'))).toBe('different');
  });

  describe('where the filesystem reports ino 0', () => {
    it('folds to the case-folded path: same for case variants', () => {
      const root = scratch.create();
      const upper = makeDir(root, 'Plugins', 'Old');
      const lower = makeDir(root, 'plugins', 'old');
      session = installFaultFs({ within: root, rewrites: [{ op: 'lstat', path: () => true, rewrite: withIdentity(0n, 0n) }] });
      const [only, ...rest] = entryIdentities(upper, 'destination');
      expect(rest).toEqual([]);
      expect(only).toEqual({ foldedRealPath: expect.stringMatching(/\/plugins\/old$/u) as string });
      expect(sameEntry(upper, lower)).toBe('same');
    });

    it('answers unknown for different names, because the fold cannot prove them apart', () => {
      const root = scratch.create();
      const a = makeDir(root, 'a');
      const b = makeDir(root, 'b');
      session = installFaultFs({ within: root, rewrites: [{ op: 'lstat', path: () => true, rewrite: withIdentity(0n, 0n) }] });
      expect(sameEntry(a, b)).toBe('unknown');
    });
  });

  it('folds a dev of 0 with a nonzero ino, so it answers unknown for different names', () => {
    const root = scratch.create();
    const a = makeDir(root, 'a');
    const b = makeDir(root, 'b');
    session = installFaultFs({ within: root, rewrites: [{ op: 'lstat', path: () => true, rewrite: withIdentity(0n, 5n) }] });
    expect(entryIdentities(a, 'destination')).toEqual([{ foldedRealPath: expect.stringMatching(/\/a$/u) as string }]);
    expect(sameEntry(a, b)).toBe('unknown');
  });

  it('answers unknown for a pair where one side has a filesystem id and the other only a fold', () => {
    const root = scratch.create();
    const a = makeDir(root, 'a');
    const b = makeDir(root, 'b');
    session = installFaultFs({ within: root, rewrites: [{ op: 'lstat', path: (p) => p === b, rewrite: withIdentity(0n, 0n) }] });
    expect(sameEntry(a, b)).toBe('unknown');
  });

  it('answers unknown when the stat of a link target is refused', ({ skip }) => {
    const root = scratch.create();
    const target = makeDir(root, 'target');
    const link = safePath.join(root, 'link');
    linkTo(target, link, skip);
    session = installFaultFs({ within: root, faults: [{ family: 'meta', op: 'stat', path: (p) => p === link, errno: 'EACCES' }] });
    expect(sameEntry(link, target)).toBe('unknown');
    expect(session.fired).toHaveLength(1);
  });

  describe('where the realpath of the fold is refused', () => {
    /** Every lstat and stat under the scratch root reports ino 0 (so identity folds), and the realpath `refused` names fails EACCES. */
    const refuseRealpath = (refused: (p: string) => boolean): void => {
      session = installFaultFs({
        within: scratchRoot,
        rewrites: [
          { op: 'lstat', path: () => true, rewrite: withIdentity(0n, 0n) },
          { op: 'stat', path: () => true, rewrite: withIdentity(0n, 0n) },
        ],
        faults: [{ family: 'meta', op: 'realpath', path: refused, errno: 'EACCES' }],
      });
    };
    let scratchRoot = '';

    it('answers unknown from sameEntry', () => {
      scratchRoot = scratch.create();
      const a = makeDir(scratchRoot, 'a');
      const b = makeDir(scratchRoot, 'b');
      refuseRealpath((p) => p === scratchRoot);
      expect(sameEntry(a, b)).toBe('unknown');
      expect(session?.fired.map((c) => c.op)).toEqual(['realpath']);
    });

    it.each(['source', 'destination', 'environment'] as const)('throws a classified fault on the caller side (%s) from entryIdentities', (side) => {
      scratchRoot = scratch.create();
      const a = makeDir(scratchRoot, 'a');
      refuseRealpath((p) => p === scratchRoot);
      expectRefusedOn(a, side);
    });

    it('answers unknown for a link whose target fold is refused', ({ skip }) => {
      scratchRoot = scratch.create();
      const target = makeDir(scratchRoot, 'target');
      const link = safePath.join(scratchRoot, 'link');
      linkTo(target, link, skip);
      // The link's own fold resolves its parent; only the target's fold resolves the link itself.
      refuseRealpath((p) => p === link);
      expect(sameEntry(link, target)).toBe('unknown');
      expect(session?.fired.map((c) => c.path)).toEqual([link]);
    });
  });

  it('answers unknown when an EACCES lstat makes one side unexaminable', () => {
    const root = scratch.create();
    const a = makeDir(root, 'a');
    const b = makeDir(root, 'b');
    session = installFaultFs({ within: root, faults: [{ family: 'meta', op: 'lstat', path: (p) => p === b, errno: 'EACCES' }] });
    expect(sameEntry(a, b)).toBe('unknown');
    expect(session.fired).toHaveLength(1);
  });
});

describe('entryIdentities', () => {
  it('answers an empty list for an absent entry', () => {
    expect(entryIdentities(safePath.join(scratch.create(), 'missing'), 'destination')).toEqual([]);
  });

  it.each(['source', 'destination', 'environment'] as const)(
    'throws a classified fault on the caller side (%s) for an entry the OS refuses to examine',
    (side) => {
      const root = scratch.create();
      const target = makeDir(root, 'target');
      session = installFaultFs({ within: root, faults: [{ family: 'meta', op: 'lstat', path: (p) => p === target, errno: 'EACCES' }] });
      expectRefusedOn(target, side);
    },
  );

  // An lstat answering ENOENT while the entry IS there read as "nothing there": one decision of a plan
  // saw no identity (not inside, not the same), the next a real one — and the planner refused its own
  // plan as overlapping. Absent is believed only when the parent's listing agrees.
  it('throws, never answers "absent", for an entry its parent lists whose lstat answers ENOENT', () => {
    const root = scratch.create();
    const target = makeDir(root, 'target');
    session = installFaultFs({ within: root, faults: [{ family: 'meta', op: 'lstat', path: (p) => p === target, errno: 'ENOENT' }] });
    let thrown: unknown;
    try {
      entryIdentities(target, 'destination');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ side: 'destination', errno: 'ENOENT', path: target });
  });
});

describe('isInsideByIdentity', () => {
  it('answers inside for a descendant and outside for an unrelated entry', () => {
    const root = scratch.create();
    const ancestor = makeDir(root, 'plugins');
    expect(isInsideByIdentity(makeDir(root, 'plugins', 'a', 'b'), ancestor)).toBe('inside');
    expect(isInsideByIdentity(makeDir(root, 'elsewhere'), ancestor)).toBe('outside');
  });

  it('answers outside for the ancestor itself: inside is strict', () => {
    const root = scratch.create();
    const dir = makeDir(root, 'plugins');
    expect(isInsideByIdentity(dir, dir)).toBe('outside');
  });

  it('answers inside for a path that does not exist yet under an existing ancestor', () => {
    const root = scratch.create();
    const ancestor = makeDir(root, 'plugins');
    expect(isInsideByIdentity(safePath.join(ancestor, 'not', 'yet'), ancestor)).toBe('inside');
  });

  it('answers inside through a linked ancestor', ({ skip }) => {
    const root = scratch.create();
    const real = makeDir(root, 'real');
    const child = makeDir(root, 'real', 'sub', 'child');
    const link = safePath.join(root, 'link');
    linkTo(real, link, skip);
    expect(isInsideByIdentity(safePath.join(link, 'sub', 'child'), real)).toBe('inside');
    expect(isInsideByIdentity(child, link)).toBe('inside');
  });

  it('answers inside through a case alias reported by dev:ino (simulated, any OS)', () => {
    const root = scratch.create();
    const real = makeDir(root, 'Plugins');
    const alias = makeDir(root, 'plugins-alias');
    const child = makeDir(root, 'plugins-alias', 'old');
    session = installFaultFs({ within: root, rewrites: [rewriteLstat([real, alias], 5n, 500n)] });
    expect(isInsideByIdentity(child, real)).toBe('inside');
  });

  it('answers unknown when an ancestor cannot be examined and none proved inside', () => {
    const root = scratch.create();
    const ancestor = makeDir(root, 'plugins');
    const middle = makeDir(root, 'other', 'middle');
    const child = makeDir(root, 'other', 'middle', 'child');
    session = installFaultFs({ within: root, faults: [{ family: 'meta', op: 'lstat', path: (p) => p === middle, errno: 'EACCES' }] });
    expect(isInsideByIdentity(child, ancestor)).toBe('unknown');
  });
});
