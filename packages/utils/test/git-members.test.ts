/**
 * `gitMembersOf` over hand-made tree keys and a scripted object reader: which entries are members,
 * their key kind, and how sizes and bytes are asked. The real repositories are in the integration
 * suite.
 */

import { describe, expect, it } from 'vitest';

import { isVatError } from '../src/errors/vat-error.js';
import { gitMembersOf } from '../src/git-members.js';
import { GitObjectMissingError, type GitObjectReaders } from '../src/git-object-reader.js';
import type { GitSnapshotEntry, GitTreeKey } from '../src/git-snapshot.js';

const ROOT = '/repo';
const SHA1 = (digit: string): string => digit.repeat(40);
const SHA256 = (digit: string): string => digit.repeat(64);

/** One snapshot entry at `relative`, of `mode`. */
function entry(relative: string, oid: string, mode = '100644'): GitSnapshotEntry {
  return { absolutePath: `${ROOT}/${relative}`, gitPath: relative, oid, mode, isSymlink: mode === '120000', isSubmodule: mode === '160000' };
}

/** A tree key holding `entries`, with the absent and LFS paths given. */
function keyOf(entries: GitSnapshotEntry[], extra: { absent?: string[]; lfs?: string[] } = {}): GitTreeKey {
  return {
    ok: true,
    hash: SHA1('0'),
    repositoryRoot: ROOT,
    entries,
    absent: new Set((extra.absent ?? []).map((relative) => `${ROOT}/${relative}`)),
    lfs: {
      pointers: (extra.lfs ?? []).map((relative) => ({ absolutePath: `${ROOT}/${relative}`, lfsOid: SHA256('9'), pulled: true, extended: false })),
      filter: extra.lfs === undefined ? 'not-asked' : 'configured',
    },
  };
}

/** A reader that guards lazy fetches, answering from `sizes` (a name not there is missing) and recording what it is asked. */
function scripted(sizes: ReadonlyMap<string, number> = new Map()): GitObjectReaders & { asked: string[][]; reads: string[] } {
  const asked: string[][] = [];
  const reads: string[] = [];
  return {
    asked,
    reads,
    read: async (_root, oid) => {
      reads.push(oid);
      return Buffer.from(oid);
    },
    sizes: async (_root, oids) => {
      asked.push([...oids]);
      return new Map(oids.flatMap((oid) => {
        const size = sizes.get(oid);
        return size === undefined ? [] : [[oid, size] as const];
      }));
    },
    guardsLazyFetch: () => true,
    close: async () => undefined,
  };
}

describe('gitMembersOf', () => {
  it('takes regular and executable files, and leaves symlinks, submodules, absent and LFS paths to disk', () => {
    const key = keyOf([
      entry('a.md', SHA1('1')),
      entry('run.sh', SHA1('2'), '100755'),
      entry('link', SHA1('3'), '120000'),
      entry('sub', SHA1('4'), '160000'),
      entry('gone.md', SHA1('5')),
      entry('big.bin', SHA1('6')),
    ], { absent: ['gone.md'], lfs: ['big.bin'] });
    const members = gitMembersOf(key, scripted());
    if (members === null) throw new Error('no members');
    expect(members.repositoryRoot).toBe(ROOT);
    expect(members.memberAt(`${ROOT}/a.md`)).toStrictEqual({ oid: SHA1('1'), keyKind: 'git-sha1' });
    expect(members.memberAt(`${ROOT}/run.sh`)).toStrictEqual({ oid: SHA1('2'), keyKind: 'git-sha1' });
    for (const relative of ['link', 'sub', 'gone.md', 'big.bin', 'A.md', 'missing.md']) {
      expect(members.memberAt(`${ROOT}/${relative}`), relative).toBeUndefined();
    }
  });

  it('keys a SHA-256 repository\'s members git-sha256', () => {
    const members = gitMembersOf(keyOf([entry('a.md', SHA256('1'))]), scripted());
    expect(members?.memberAt(`${ROOT}/a.md`)).toStrictEqual({ oid: SHA256('1'), keyKind: 'git-sha256' });
  });

  it.for([
    ['mixed lengths', [entry('a.md', SHA1('1')), entry('b.md', SHA256('2'))]],
    ['a length that is neither', [entry('a.md', 'a'.repeat(50))]],
  ] as const)('refuses %s as VAT\'s own fault', ([, entries]) => {
    let thrown: unknown;
    try {
      gitMembersOf(keyOf([...entries]), scripted());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(isVatError(thrown)).toBe(false);
  });

  it('sizes every member through one ask, on the first size asked, each object once', async () => {
    const objects = scripted(new Map([[SHA1('1'), 5], [SHA1('2'), 7]]));
    const members = gitMembersOf(keyOf([entry('a.md', SHA1('1')), entry('b.md', SHA1('2')), entry('c.md', SHA1('1'))]), objects);
    if (members === null) throw new Error('no members');
    expect(objects.asked).toStrictEqual([]);
    const a = members.memberAt(`${ROOT}/a.md`);
    const b = members.memberAt(`${ROOT}/b.md`);
    if (a === undefined || b === undefined) throw new Error('not members');
    expect(await Promise.all([members.sizeOf(a), members.sizeOf(b), members.sizeOf(a)])).toStrictEqual([5, 7, 5]);
    expect(objects.asked).toStrictEqual([[SHA1('1'), SHA1('2')]]);
  });

  it('refuses only the member whose object is missing', async () => {
    const objects = scripted(new Map([[SHA1('2'), 3]]));
    const members = gitMembersOf(keyOf([entry('a.md', SHA1('1')), entry('b.md', SHA1('2'))]), objects);
    const a = members?.memberAt(`${ROOT}/a.md`);
    const b = members?.memberAt(`${ROOT}/b.md`);
    if (members === null || a === undefined || b === undefined) throw new Error('not members');
    const refused = await members.sizeOf(a).then(() => undefined, (error: unknown) => error);
    expect(isVatError(refused, GitObjectMissingError.code)).toBe(true);
    expect(await members.sizeOf(b)).toBe(3);
  });

  it('refuses a size for an object that is not a member as VAT\'s own fault', async () => {
    const members = gitMembersOf(keyOf([entry('a.md', SHA1('1'))]), scripted());
    const refused = await members?.sizeOf({ oid: SHA1('7'), keyKind: 'git-sha1' }).then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(Error);
    expect(isVatError(refused)).toBe(false);
  });

  it('reads a member\'s bytes through the reader it was given', async () => {
    const objects = scripted();
    const members = gitMembersOf(keyOf([entry('a.md', SHA1('1'))]), objects);
    const a = members?.memberAt(`${ROOT}/a.md`);
    if (members === null || a === undefined) throw new Error('not a member');
    expect(Buffer.from(await members.bytesOf(a)).toString()).toBe(SHA1('1'));
    expect(objects.reads).toStrictEqual([SHA1('1')]);
  });
});
