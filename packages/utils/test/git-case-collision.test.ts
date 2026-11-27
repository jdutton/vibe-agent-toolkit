/**
 * The case-collision rule a tree key declines by: two snapshot paths that fold alike
 * (`foldedSegment`, per segment) AND name one file on this volume (`lstat` of both spellings answers
 * one `dev` and `ino`). The lstat is injected, so each branch is driven on any host.
 */

import { describe, expect, it } from 'vitest';

import { caseCollisionOf, type FileIdentity } from '../src/git-case-collision.js';

const ROOT = '/repo';

/** A snapshot entry at `gitPath`. */
function entry(gitPath: string): { absolutePath: string; gitPath: string } {
  return { absolutePath: `${ROOT}/${gitPath}`, gitPath };
}

/** An lstat answering `identities` by absolute path, and recording every path asked. */
function lstatOf(identities: Readonly<Record<string, FileIdentity | undefined>>): {
  identity: (absolutePath: string) => FileIdentity | undefined;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    identity: (absolutePath) => {
      asked.push(absolutePath);
      return identities[absolutePath];
    },
    asked,
  };
}

const ONE = { dev: 1n, ino: 7n };

describe('caseCollisionOf', () => {
  it('names two paths that fold alike and that the volume holds as one file', () => {
    const { identity } = lstatOf({ [`${ROOT}/Docs/A.md`]: ONE, [`${ROOT}/docs/a.md`]: ONE });
    expect(caseCollisionOf([entry('Docs/A.md'), entry('docs/a.md')], identity)).toStrictEqual(['Docs/A.md', 'docs/a.md']);
  });

  it('is no collision when the two spellings are two files (a case-sensitive volume)', () => {
    const { identity } = lstatOf({ [`${ROOT}/A.md`]: ONE, [`${ROOT}/a.md`]: { dev: 1n, ino: 8n } });
    expect(caseCollisionOf([entry('A.md'), entry('a.md')], identity)).toBeUndefined();
  });

  it('is no collision when either spelling names nothing on disk', () => {
    const { identity } = lstatOf({ [`${ROOT}/A.md`]: ONE });
    expect(caseCollisionOf([entry('A.md'), entry('a.md')], identity)).toBeUndefined();
  });

  it('folds Unicode normalisation as a volume that normalises does', () => {
    const composed = 'café.md';
    const decomposed = 'café.md';
    const { identity } = lstatOf({ [`${ROOT}/${composed}`]: ONE, [`${ROOT}/${decomposed}`]: ONE });
    expect(caseCollisionOf([entry(composed), entry(decomposed)], identity)).toStrictEqual([composed, decomposed]);
  });

  it('asks the volume nothing when no two paths fold alike', () => {
    const { identity, asked } = lstatOf({});
    expect(caseCollisionOf([entry('a.md'), entry('b.md'), entry('docs/a.md')], identity)).toBeUndefined();
    expect(asked).toStrictEqual([]);
  });

  // NFD `é.md`, NFC `é.md` and NFC `É.md`: three spellings of one fold.
  const nfd = 'e\u0301.md';
  const nfc = '\u00E9.md';
  const upper = '\u00C9.md';

  it('compares every pair of a fold group, not each spelling with the group\'s first', () => {
    // The NFD one is its own file; the two NFC ones are one (a volume that folds case, not normalisation).
    const { identity } = lstatOf({ [`${ROOT}/${nfd}`]: { dev: 1n, ino: 8n }, [`${ROOT}/${nfc}`]: ONE, [`${ROOT}/${upper}`]: ONE });
    expect(caseCollisionOf([entry(nfd), entry(nfc), entry(upper)], identity)).toStrictEqual([nfc, upper]);
  });

  it('asks the volume once per spelling, however many pairs a fold group holds', () => {
    const { identity, asked } = lstatOf({ [`${ROOT}/${nfd}`]: ONE, [`${ROOT}/${nfc}`]: { dev: 1n, ino: 8n }, [`${ROOT}/${upper}`]: { dev: 1n, ino: 9n } });
    expect(caseCollisionOf([entry(nfd), entry(nfc), entry(upper)], identity)).toBeUndefined();
    expect(asked).toHaveLength(3);
    expect(new Set(asked)).toStrictEqual(new Set([nfd, nfc, upper].map((name) => `${ROOT}/${name}`)));
  });

  it.for([
    ['both report', { dev: 1n, ino: 0n }, { dev: 1n, ino: 0n }],
    ['one reports', { dev: 1n, ino: 0n }, { dev: 1n, ino: 8n }],
  ] as const)('takes two existing spellings as possibly one file when %s inode 0, which proves nothing apart', ([, left, right]) => {
    const { identity } = lstatOf({ [`${ROOT}/A.md`]: left, [`${ROOT}/a.md`]: right });
    expect(caseCollisionOf([entry('A.md'), entry('a.md')], identity)).toStrictEqual(['A.md', 'a.md']);
  });

  it('keeps an inode-0 pair on two volumes apart: the device proves them two files', () => {
    const { identity } = lstatOf({ [`${ROOT}/A.md`]: { dev: 1n, ino: 0n }, [`${ROOT}/a.md`]: { dev: 2n, ino: 0n } });
    expect(caseCollisionOf([entry('A.md'), entry('a.md')], identity)).toBeUndefined();
  });

  it('keeps looking past a fold that is two files on disk', () => {
    const { identity } = lstatOf({
      [`${ROOT}/A.md`]: ONE,
      [`${ROOT}/a.md`]: { dev: 1n, ino: 8n },
      [`${ROOT}/B.md`]: { dev: 1n, ino: 9n },
      [`${ROOT}/b.md`]: { dev: 1n, ino: 9n },
    });
    expect(caseCollisionOf([entry('A.md'), entry('a.md'), entry('B.md'), entry('b.md')], identity)).toStrictEqual(['B.md', 'b.md']);
  });
});
