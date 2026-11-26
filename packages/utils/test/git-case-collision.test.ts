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
