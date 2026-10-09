/**
 * The pure halves of the tree-change primitive: the names it gives what it stages and parks,
 * the sameness / containment decision over identities already read, and the wording of a
 * rollback that could not finish. No filesystem: every input is a value.
 */

import { describe, expect, it } from 'vitest';

import { classifyFsFault } from '../src/errors/fs-fault.js';
import { isVatError } from '../src/errors/vat-error.js';
import { identityOf, identityOracleOver, insideBy, sameBy, type Examiner, type Identity } from '../src/tree-change/identity-compare.js';
import { TREE_ROLLBACK_INCOMPLETE_CODE, TreeRollbackIncompleteError } from '../src/tree-change/rollback-error.js';
import { isParkedTreeEntry, isTreeChangeResidue, PARKED_SUFFIX, stagingName, stagingPrefix } from '../src/tree-change/staging-names.js';

describe('isTreeChangeResidue', () => {
  it.each([
    ['.mp.vat-staged-a1B2c3', true],
    ['.mp.vat-staged-a1B2c3.previous', true],
    ['.registry.json.vat-staged-0f0f0f0f', true],
    ['mp', false],
    ['.mp', false],
    ['mp.vat-staged-a1B2c3', false],
  ])('%s → %s', (name, residue) => {
    expect(isTreeChangeResidue(name)).toBe(residue);
  });
});

describe('isParkedTreeEntry', () => {
  it.each([
    ['.mp.vat-staged-a1B2c3.previous', true],
    ['.mp.vat-staged-a1B2c3', false],
    ['mp.previous', false],
    ['.mp.previous', false],
  ])('%s → %s', (name, parked) => {
    expect(isParkedTreeEntry(name)).toBe(parked);
  });
});

describe('stagingPrefix / stagingName', () => {
  it('sits beside the destination, dot-led, so a listing of the parent can tell it from a sibling', () => {
    expect(stagingPrefix('/home/u/.claude/skills/my-skill')).toBe('/home/u/.claude/skills/.my-skill.vat-staged-');
  });

  it('a staging name is the prefix plus eight hex digits, is residue, and is not parked until suffixed', () => {
    const name = stagingName('/out/pkg');
    expect(name).toMatch(/^\/out\/\.pkg\.vat-staged-[0-9a-f]{8}$/);
    const base = name.slice('/out/'.length);
    expect(isTreeChangeResidue(base)).toBe(true);
    expect(isParkedTreeEntry(base)).toBe(false);
    expect(isParkedTreeEntry(`${base}${PARKED_SUFFIX}`)).toBe(true);
  });

  it('two names for one destination differ', () => {
    expect(stagingName('/out/pkg')).not.toBe(stagingName('/out/pkg'));
  });
});

/** An examiner over a fixed table: a path it does not list is absent (`[]`); `undefined` is a refused examination. */
const examinerOver = (table: Readonly<Record<string, readonly Identity[] | undefined>>): Examiner =>
  (entry) => (entry in table ? table[entry] : []);

describe('sameBy', () => {
  const id = (value: string): Identity => ({ id: value });
  const fold = (value: string): Identity => ({ foldedRealPath: value });

  it('is same when any identity is shared: a link answers to itself and to its target', () => {
    const examine = examinerOver({ '/a/link': [id('1:10'), id('1:20')], '/a/target': [id('1:20')] });
    expect(sameBy(examine, '/a/link', '/a/target')).toBe('same');
  });

  it('is different for two filesystem ids that do not match, and for an absent entry', () => {
    const examine = examinerOver({ '/a/x': [id('1:10')], '/a/y': [id('1:11')] });
    expect(sameBy(examine, '/a/x', '/a/y')).toBe('different');
    expect(sameBy(examine, '/a/x', '/a/gone')).toBe('different');
  });

  it('is unknown when a fold does not match: a fold cannot prove two names apart', () => {
    const examine = examinerOver({ '/a/Old': [fold('/a/old')], '/a/new': [fold('/a/new')], '/a/id': [id('1:10')] });
    expect(sameBy(examine, '/a/Old', '/a/new')).toBe('unknown');
    expect(sameBy(examine, '/a/Old', '/a/id')).toBe('unknown');
  });

  it('is same for two folds that match (a case alias on a filesystem reporting no inode)', () => {
    const examine = examinerOver({ '/a/Old': [fold('/a/old')], '/a/old': [fold('/a/old')] });
    expect(sameBy(examine, '/a/Old', '/a/old')).toBe('same');
  });

  it('is unknown when the OS refuses to examine either entry', () => {
    const examine = examinerOver({ '/a/x': [id('1:10')], '/a/refused': undefined });
    expect(sameBy(examine, '/a/x', '/a/refused')).toBe('unknown');
    expect(sameBy(examine, '/a/refused', '/a/x')).toBe('unknown');
  });
});

describe('insideBy', () => {
  const id = (value: string): Identity => ({ id: value });

  it('is inside when a directory on the way up is the ancestor under another spelling', () => {
    const examine = examinerOver({ '/real/plugins': [id('1:5')], '/alias': [id('1:5')], '/alias/x': [id('1:6')] });
    expect(insideBy(examine, '/alias/x/file', '/real/plugins')).toBe('inside');
  });

  it('is outside when every directory up to the root was examined and none is the ancestor', () => {
    const examine = examinerOver({ '/real/plugins': [id('1:5')], '/other': [id('1:7')], '/': [id('1:2')] });
    expect(insideBy(examine, '/other/file', '/real/plugins')).toBe('outside');
  });

  it('is not inside itself: only a strict ancestor counts', () => {
    const examine = examinerOver({ '/real/plugins': [id('1:5')], '/real': [id('1:4')], '/': [id('1:2')] });
    expect(insideBy(examine, '/real/plugins', '/real/plugins')).toBe('outside');
  });

  it('is unknown when the ancestor cannot be examined, or a directory on the way up cannot and none matched', () => {
    expect(insideBy(examinerOver({ '/anc': undefined }), '/x/y', '/anc')).toBe('unknown');
    const examine = examinerOver({ '/anc': [id('1:5')], '/x': undefined, '/': [id('1:2')] });
    expect(insideBy(examine, '/x/y', '/anc')).toBe('unknown');
  });

  it('a match above an unexaminable directory still answers inside', () => {
    const examine = examinerOver({ '/anc': [id('1:5')], '/anc/sub': undefined });
    expect(insideBy(examine, '/anc/sub/file', '/anc')).toBe('inside');
  });
});

describe('TreeRollbackIncompleteError', () => {
  it('keeps the original failure as its cause and message head, coded TREE_ROLLBACK_INCOMPLETE', () => {
    const original = new Error('ENOSPC: no space left on device');
    const error = new TreeRollbackIncompleteError(original, [{ dest: '/d/skills', parked: '/d/.skills.vat-staged-ab.previous', why: 'EACCES' }]);

    expect(isVatError(error, TREE_ROLLBACK_INCOMPLETE_CODE)).toBe(true);
    expect(error.cause).toBe(original);
    expect(error.message).toBe('ENOSPC: no space left on device; and the change could not be undone: the previous content of /d/skills is at /d/.skills.vat-staged-ab.previous (EACCES)');
  });

  it('names a parked path only for a destination that had a previous entry', () => {
    const error = new TreeRollbackIncompleteError('swap failed', [
      { dest: '/d/a', parked: '/d/.a.previous', why: 'EBUSY' },
      { dest: '/d/settings.json', parked: undefined, why: 'EPERM' },
    ]);

    expect(error.parked).toEqual(['/d/.a.previous']);
    expect(error.stranded).toHaveLength(2);
    expect(error.message).toContain('swap failed; and the change could not be undone: ');
    expect(error.message).toContain('the new content at /d/settings.json could not be undone (EPERM)');
  });
});

describe('identityOf', () => {
  it('is the filesystem id when it reports a device and an inode, and never computes the fold then', () => {
    const fold = (): Identity => {
      throw new Error('the fold costs a realpath: it must not be asked for');
    };
    expect(identityOf({ dev: 16777234n, ino: 4242n }, fold)).toEqual({ id: '16777234:4242' });
  });

  it.each([
    ['no inode (FAT, some network mounts)', { dev: 5n, ino: 0n }],
    ['no device', { dev: 0n, ino: 7n }],
  ])('falls back to the fold on a filesystem reporting %s', (_label, stats) => {
    expect(identityOf(stats, () => ({ foldedRealPath: '/vol/plugins/old' }))).toEqual({ foldedRealPath: '/vol/plugins/old' });
  });
});

describe('identityOracleOver', () => {
  const refusal = (entry: string): unknown => classifyFsFault(Object.assign(new Error('EACCES'), { code: 'EACCES', path: entry }), { side: 'destination', action: 'examine the entry', path: entry });

  it('examines each entry once, however many questions are asked about it', () => {
    const reads: string[] = [];
    const oracle = identityOracleOver((entry) => {
      reads.push(entry);
      return [{ id: entry === '/a/link' || entry === '/a/target' ? '1:9' : `1:${entry.length}` }];
    });

    expect(oracle.sameEntry('/a/link', '/a/target')).toBe('same');
    expect(oracle.sameEntry('/a/link', '/a/target')).toBe('same');
    expect(oracle.identities('/a/link')).toEqual([{ id: '1:9' }]);
    expect(reads).toEqual(['/a/link', '/a/target']);
  });

  it('remembers a refusal: the same fault is thrown again without asking the OS twice, and every decision reads it as unknown', () => {
    let reads = 0;
    const fault = refusal('/a/locked');
    const oracle = identityOracleOver((entry) => {
      reads += 1;
      if (entry === '/a/locked') throw fault;
      return [{ id: '1:5' }];
    });

    expect(oracle.refuses('/a/locked')).toBe(true);
    expect(() => oracle.identities('/a/locked')).toThrow(fault as Error);
    expect(oracle.sameEntry('/a/locked', '/a/x')).toBe('unknown');
    expect(oracle.isInside('/a/x/y', '/a/locked')).toBe('unknown');
    expect(oracle.refuses('/a/x')).toBe(false);
    // '/a/locked' once, '/a/x' once: the containment question about an unexaminable ancestor reads nothing more.
    expect(reads).toBe(2);
  });

  it('answers containment from the same memo', () => {
    const oracle = identityOracleOver((entry) => (entry === '/real' || entry === '/alias' ? [{ id: '1:5' }] : [{ id: `2:${entry.length}` }]));
    expect(oracle.isInside('/alias/sub/file', '/real')).toBe('inside');
    expect(oracle.isInside('/elsewhere/file', '/real')).toBe('outside');
  });

  it('never takes a defect for a refusal: it is thrown, from every question, and not remembered', () => {
    let reads = 0;
    const defect = new TypeError('cannot read properties of undefined');
    const oracle = identityOracleOver(() => {
      reads += 1;
      throw defect;
    });

    expect(() => oracle.identities('/a')).toThrow(defect);
    expect(() => oracle.refuses('/a')).toThrow(defect);
    expect(() => oracle.sameEntry('/a', '/b')).toThrow(defect);
    expect(reads).toBe(3);
  });
});
