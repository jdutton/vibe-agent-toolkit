/**
 * The decisions the apply, the file helpers and the copy make from what they read — each a pure
 * function of values, so every branch is pinned here with no filesystem.
 */

import { describe, expect, it } from 'vitest';

import { FS_FAULT_CODE } from '../src/errors/fs-fault.js';
import { relativeEscapesRoot, safePath } from '../src/path-core.js';
import {
  changedDestinationFault,
  changedSincePlan,
  fillFaultIsDestinations,
  finalizeThrows,
  madeDirectoryPath,
  madeParentStep,
  RENAME_TRIES,
  renameRetryDelay,
  TEMP_DIR_OUTSIDE_TMPDIR_CODE,
  tempDirRefusal,
} from '../src/tree-change/apply-decisions.js';
import { aliasFault, foldedNameIsTwin, mayTakeOver, nameOf, parentOf, sameNameWhereFolded } from '../src/tree-change/copy-decisions.js';
import type { EntryKind, Ownership, PlannedChange } from '../src/tree-change/plan.js';

const at = (...segments: string[]): string => safePath.resolve('/vat-decisions', ...segments);
const OUT = at('out');

function planned(existing: EntryKind, ownership: Ownership['kind'] = 'force'): PlannedChange {
  const owner = ownership === 'vat-made' ? { kind: ownership, recognise: () => ({ owned: true }) } as const : { kind: ownership };
  return { change: { op: 'replace-file', dest: OUT, ownership: owner, contents: '', label: 'the output' }, existing, action: existing === 'absent' ? 'create' : 'replace' };
}

describe('fillFaultIsDestinations', () => {
  const sideOf = (path: string): 'destination' | undefined => (relativeEscapesRoot(safePath.relative(at('staged'), path)) ? undefined : 'destination');

  it.each([
    ['the path the OS named is under the staged tree', { path: at('staged', 'a.md'), dest: undefined }, true],
    ['the second path of a two-path call is', { path: at('in', 'a.md'), dest: at('staged', 'a.md') }, true],
    ['it names an input beside the destination', { path: at('in', 'a.md'), dest: undefined }, false],
    ['the OS named no path at all', { path: undefined, dest: undefined }, false],
  ])('%s → %s', (_label, facts, expected) => {
    expect(fillFaultIsDestinations(facts, sideOf)).toBe(expected);
  });
});

describe('changedSincePlan', () => {
  it.each<[string, PlannedChange, { kind: EntryKind; emptyDirectory: boolean }, string | undefined]>([
    ['still absent', planned('absent'), { kind: 'absent', emptyDirectory: false }, undefined],
    ['something appeared where nothing was', planned('absent'), { kind: 'file', emptyDirectory: false }, 'was absent'],
    ['what was there is gone', planned('directory'), { kind: 'absent', emptyDirectory: false }, 'is absent now'],
    ['a directory became a file', planned('directory'), { kind: 'file', emptyDirectory: false }, 'is a file now'],
    ['a directory taken as empty was filled', planned('directory', 'must-be-free'), { kind: 'directory', emptyDirectory: false }, 'holds entries now'],
    ['a directory taken as empty is still empty', planned('directory', 'must-be-free'), { kind: 'directory', emptyDirectory: true }, undefined],
    ['a forced directory that gained entries is still the directory the user gave up', planned('directory', 'force'), { kind: 'directory', emptyDirectory: false }, undefined],
  ])('%s', (_label, plan, now, expected) => {
    const changed = changedSincePlan(plan, now);
    if (expected === undefined) expect(changed).toBeUndefined();
    else expect(changed).toContain(expected);
  });

  it('is refused as the destination\'s occupied fault, naming the path and what changed', () => {
    const fault = changedDestinationFault(planned('absent'), 'it was absent and is a file now');
    expect(fault).toMatchObject({ code: FS_FAULT_CODE, side: 'destination', faultClass: 'occupied', path: OUT });
    expect(fault.message).toContain('the output');
    expect(fault.message).toContain('it was absent and is a file now');
  });
});

describe('finalizeThrows', () => {
  it('throws for the first parked entry of a REMOVE that would not go, and warns for a replace\'s', () => {
    expect(finalizeThrows([{ op: 'replace' }, { op: 'remove' }, { op: 'remove' }])).toBe(1);
    expect(finalizeThrows([{ op: 'replace' }, { op: 'replace-file' }])).toBeUndefined();
    expect(finalizeThrows([])).toBeUndefined();
  });
});

describe('madeParentStep', () => {
  const top = at('made');

  it.each([
    ['the first directory staging made', top, 'last'],
    ['a directory under it', at('made', 'a', 'b'), 'continue'],
    ['its parent, which staging did not make', at(), 'stop'],
    ['a sibling', at('other'), 'stop'],
  ])('%s → %s', (_label, dir, expected) => {
    expect(madeParentStep(top, dir)).toBe(expected);
  });
});

describe('madeDirectoryPath', () => {
  const BACKSLASH = String.fromCodePoint(0x5c);
  const win = (...segments: string[]): string => segments.join(BACKSLASH);

  // Held against a plain `C:\…` destination, a namespaced report reads as another root: the walk that
  // removes the parents a failed create made would stop before removing any (Windows CI left `.claude`).
  it('gives a win32-namespaced report the spelling the caller\'s own paths have', () => {
    const made = win('C:', 'Users', 'me', '.claude');
    expect(madeDirectoryPath(`${BACKSLASH.repeat(2)}?${BACKSLASH}${made}`)).toBe(made);
    expect(madeDirectoryPath(`${BACKSLASH.repeat(2)}?${BACKSLASH}UNC${BACKSLASH}${win('server', 'share', 'x')}`)).toBe(`${BACKSLASH.repeat(2)}${win('server', 'share', 'x')}`);
  });

  it('leaves every other path as it is', () => {
    for (const path of ['/tmp/a/b', win('C:', 'a', 'b'), `${BACKSLASH.repeat(2)}${win('server', 'share')}`, 'relative/dir']) {
      expect(madeDirectoryPath(path)).toBe(path);
    }
  });

  it('lets the made-parent walk reach a directory under what mkdir reported, once normalised', () => {
    const top = safePath.resolve('/vat-decisions/home/.claude');
    expect(madeParentStep(top, safePath.join(top, 'plugins', 'cache'))).toBe('continue');
  });
});

describe('renameRetryDelay', () => {
  it('retries only contention, only under win32, doubling the wait from 50 ms', () => {
    expect(renameRetryDelay('win32', 0, true)).toBe(50);
    expect(renameRetryDelay('win32', 3, true)).toBe(400);
    expect(renameRetryDelay('win32', 0, false)).toBeUndefined();
    expect(renameRetryDelay('linux', 0, true)).toBeUndefined();
    expect(renameRetryDelay('darwin', 0, true)).toBeUndefined();
  });

  it('gives up once the last try failed', () => {
    expect(renameRetryDelay('win32', RENAME_TRIES - 2, true)).toBe(50 * 2 ** (RENAME_TRIES - 2));
    expect(renameRetryDelay('win32', RENAME_TRIES - 1, true)).toBeUndefined();
  });
});

describe('tempDirRefusal', () => {
  it('refuses only a directory OUTSIDE the temp directory, as a defect naming both', () => {
    const refusal = tempDirRefusal(at('project'), at('tmp'), 'outside');
    expect(refusal).toMatchObject({ code: TEMP_DIR_OUTSIDE_TMPDIR_CODE });
    expect(refusal?.message).toContain(at('project'));
    expect(refusal?.message).toContain(at('tmp'));
    expect(tempDirRefusal(at('tmp', 'x'), at('tmp'), 'inside')).toBeUndefined();
    expect(tempDirRefusal(at('tmp', 'gone'), at('tmp'), 'absent')).toBeUndefined();
  });
});

describe('the copy\'s decisions', () => {
  it('names an entry\'s directory and its name', () => {
    expect([parentOf('a/b/c.md'), nameOf('a/b/c.md')]).toEqual(['a/b', 'c.md']);
    expect([parentOf('top.md'), nameOf('top.md')]).toEqual(['', 'top.md']);
  });

  it.each([
    ['NOTES', 'notes', true],
    [`caf${String.fromCodePoint(0xe9)}`, `cafe${String.fromCodePoint(0x301)}`, true],
    ['notes', 'notes.md', false],
  ])('sameNameWhereFolded(%s, %s) → %s', (a, b, expected) => {
    expect(sameNameWhereFolded(a, b)).toBe(expected);
  });

  it.each([
    ['a fresh tree refuses whatever is there', 'fresh', 'leaf', false, 'refuse'],
    ['a fresh tree refuses a directory there too', 'fresh', 'directory', true, 'refuse'],
    ['a merge adopts a real directory', 'merge', 'directory', true, 'adopt'],
    ['a merge replaces a file or a link', 'merge', 'leaf', false, 'replace'],
    ['a merge never deletes a directory for a file', 'merge', 'leaf', true, 'refuse'],
    ['a merge never takes a file (or a link) for a directory', 'merge', 'directory', false, 'refuse'],
  ] as const)('%s', (_label, onto, kind, thereIsDirectory, expected) => {
    expect(mayTakeOver(onto, kind, thereIsDirectory)).toBe(expected);
  });

  it('refuses two source entries with one destination name as the SOURCE\'s layout, naming both', () => {
    const first = { path: at('src', 'NOTES'), relative: 'NOTES' };
    const second = { path: at('src', 'notes'), relative: 'notes' };
    const fault = aliasFault(first, second, new Error('EEXIST'));
    expect(fault).toMatchObject({ code: FS_FAULT_CODE, side: 'source', origin: 'content', faultClass: 'occupied', path: second.path });
    expect(fault.message).toContain(first.path);
    expect(fault.message).toContain(second.path);
  });
});

// N3: a sibling whose name folds to the colliding one is the alias only while the OS has not proved
// them two entries. On a case-sensitive tree `README.md` and `readme.md` are two files, and the
// second create's EEXIST under a merge is the PREVIOUS build's file — to replace, not to refuse.
describe('foldedNameIsTwin', () => {
  it('is not the twin when both entries are there and the OS says they are different entries', () => {
    expect(foldedNameIsTwin('different', true)).toBe(false);
  });

  it.each([
    ['the colliding name holds nothing the copy can examine (the collision is all there is to go on)', 'different', false],
    ['the OS could not say (a filesystem with no identities)', 'unknown', true],
    ['the OS could not say and nothing can be examined there', 'unknown', false],
  ] as const)('is the twin when %s', (_label, sameness, present) => {
    expect(foldedNameIsTwin(sameness, present)).toBe(true);
  });
});
