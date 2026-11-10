/**
 * The pure half of `gitChangedFiles`: reading `git diff-tree --name-status -z` as bytes, keeping
 * only what lies under the project root, relative to it, refusing a root git spells in another
 * case, and wording a git that did not finish. The git wiring is one integration test
 * (`test/integration/git-changed-files.integration.test.ts`).
 */

import { describe, expect, it } from 'vitest';

import {
  caseSpellingRefusal,
  changedFilesUnderPrefix,
  gitDidNotRun,
  hiddenEditEntriesOf,
  mergeBaseOf,
  parseNameStatusZ,
} from '../src/git-changed-files.js';

import { gitSpawnFailure } from './test-helpers.js';

/** A NUL-separated record stream, as `-z` writes it. */
function z(...fields: readonly (string | Uint8Array)[]): Buffer {
  return Buffer.concat(fields.flatMap((field) => [
    typeof field === 'string' ? Buffer.from(field, 'utf8') : Buffer.from(field),
    Buffer.from([0]),
  ]));
}

/** The text a byte path spells, for a readable assertion. */
function text(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : Buffer.from(bytes).toString('utf8');
}

/** The records of a listing the parser must read; fails the test on a refusal. */
function recordsOf(listing: Uint8Array): Parameters<typeof changedFilesUnderPrefix>[0] {
  const parsed = parseNameStatusZ(listing);
  if (!parsed.ok) throw new Error(`expected a readable listing: ${parsed.reason}`);
  return parsed.records;
}

describe('parseNameStatusZ', () => {
  it('reads every status letter, with the rename source and score', () => {
    const records = recordsOf(z(
      'A', 'new.md',
      'M', 'docs/edited.md',
      'D', 'gone.md',
      'T', 'link.md',
      'R087', 'old name.md', 'new name.md',
    ));

    expect(records.map((record) => ({ ...record, path: text(record.path), oldPath: text(record.oldPath) }))).toStrictEqual([
      { status: 'added', path: 'new.md', oldPath: null, similarity: null },
      { status: 'modified', path: 'docs/edited.md', oldPath: null, similarity: null },
      { status: 'deleted', path: 'gone.md', oldPath: null, similarity: null },
      { status: 'type-changed', path: 'link.md', oldPath: null, similarity: null },
      { status: 'renamed', path: 'new name.md', oldPath: 'old name.md', similarity: 87 },
    ]);
  });

  it('keeps a path byte for byte, a leading space and bytes that are not UTF-8 included', () => {
    const notUtf8 = Uint8Array.from([0x61, 0xff, 0x2e, 0x6d, 0x64]);
    const [spaced, raw] = recordsOf(z('M', ' lead.md', 'A', notUtf8));

    expect(text(spaced?.path ?? null)).toBe(' lead.md');
    expect(Buffer.from(raw?.path ?? []).equals(Buffer.from(notUtf8))).toBe(true);
  });

  it('reads an empty listing as no change', () => {
    expect(recordsOf(Buffer.alloc(0))).toStrictEqual([]);
  });

  it.each([
    ['an unknown status letter', z('X', 'what.md')],
    ['a rename missing its destination', z('R100', 'only-source.md')],
    ['a record missing its path', z('M')],
    ['a listing that does not end in NUL', Buffer.from('M\0a.md', 'utf8')],
    ['a rename with no score', z('R', 'a.md', 'b.md')],
    // Copies are never asked for (no -C), and a tree-to-tree diff has no unmerged path.
    ['a copy', z('C100', 'src.md', 'copy.md')],
    ['an unmerged path', z('U', 'conflicted.md')],
  ])('refuses %s rather than guessing, as the repository\'s refusal naming the record', (_what, listing) => {
    expect(parseNameStatusZ(listing)).toMatchObject({
      ok: false,
      kind: 'repository',
      reason: expect.stringMatching(/git diff-tree --name-status -z/),
    });
  });
});

/** The rows for a listing under the root `site/`. */
function under(listing: Buffer): ReturnType<typeof changedFilesUnderPrefix> {
  return changedFilesUnderPrefix(recordsOf(listing), Buffer.from('site/', 'utf8'));
}

describe('changedFilesUnderPrefix', () => {
  it('keeps only paths under the root, relative to it', () => {
    expect(under(z('M', 'site/a.md', 'M', 'other/b.md', 'M', 'sitemap.md'))).toStrictEqual({
      ok: true,
      files: [{ path: 'a.md', status: 'modified', oldPath: null, similarity: null }],
    });
  });

  it('keeps a rename wholly inside the root as a rename, both ends relative', () => {
    expect(under(z('R090', 'site/old.md', 'site/new.md'))).toStrictEqual({
      ok: true,
      files: [{ path: 'new.md', status: 'renamed', oldPath: 'old.md', similarity: 90 }],
    });
  });

  it('reads a rename INTO the root as an addition, and one OUT of it as a deletion', () => {
    expect(under(z('R100', 'elsewhere/in.md', 'site/in.md', 'R100', 'site/out.md', 'elsewhere/out.md'))).toStrictEqual({
      ok: true,
      files: [
        { path: 'in.md', status: 'added', oldPath: null, similarity: null },
        { path: 'out.md', status: 'deleted', oldPath: null, similarity: null },
      ],
    });
  });

  it('keeps everything at the repository root when the prefix is empty, sorted by path', () => {
    expect(changedFilesUnderPrefix(recordsOf(z('M', 'z.md', 'D', 'a/b.md')), Buffer.alloc(0))).toStrictEqual({
      ok: true,
      files: [
        { path: 'a/b.md', status: 'deleted', oldPath: null, similarity: null },
        { path: 'z.md', status: 'modified', oldPath: null, similarity: null },
      ],
    });
  });

  it('refuses a path under the root that is not UTF-8, naming its bytes', () => {
    const result = under(z('A', Uint8Array.from([...Buffer.from('site/', 'utf8'), 0xff])));

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain(String.raw`\xff`);
  });

  it('ignores a path that is not UTF-8 when it lies outside the root', () => {
    expect(under(z('A', Uint8Array.from([0x6f, 0xff])))).toStrictEqual({ ok: true, files: [] });
  });
});

/** U+0301 COMBINING ACUTE ACCENT: `e` + it is NFD for `é`. */
const ACUTE = String.fromCodePoint(0x03_01);
/** `café/` composed (NFC), as git reports a root on most systems. */
const COMPOSED = `caf${String.fromCodePoint(0xE9)}/`;

describe('caseSpellingRefusal', () => {
  const prefix = Buffer.from('docs/', 'utf8');
  /** The check as it runs on a filesystem that folds case. */
  const caseSpellingRefusalWhereFolded = (
    records: Parameters<typeof caseSpellingRefusal>[0],
    root: Uint8Array,
  ): ReturnType<typeof caseSpellingRefusal> => caseSpellingRefusal(records, root, true);

  it.each([
    ['a deletion', z('D', 'Docs/b.md'), 'Docs/'],
    ['the new side of a rename', z('R100', 'docs/a.md', 'DOCS/a.md'), 'DOCS/'],
    // Reported as a deletion of its old side, so judged by the deletion's rule.
    ['the old side of a rename out of the root', z('R100', 'Docs/a.md', 'other/a.md'), 'Docs/'],
  ])('refuses a path spelled in another case on %s, naming both spellings', (_what, listing, other) => {
    const refusal = caseSpellingRefusalWhereFolded(recordsOf(listing), prefix);

    expect(refusal).toMatchObject({ ok: false, kind: 'repository' });
    expect(refusal?.reason).toContain('"docs/"');
    expect(refusal?.reason).toContain(`"${other}"`);
  });

  // A case-only directory rename in history (`Docs/` -> `docs/` before HEAD): the old side names
  // where the file WAS, which is no path the root's answer reports when the new side is under the root.
  it('checks only the new side of a rename into the root: an old side in another case is history', () => {
    expect(caseSpellingRefusalWhereFolded(recordsOf(z('R100', 'Docs/a.md', 'docs/a.md')), prefix)).toBeUndefined();
  });

  it('accepts paths that carry the prefix exactly, or lie elsewhere', () => {
    expect(caseSpellingRefusalWhereFolded(recordsOf(z('M', 'docs/a.md', 'M', 'other/x.md', 'M', 'docsx/y.md')), prefix))
      .toBeUndefined();
  });

  it.each([
    ['a non-ASCII letter in another case', 'Été/', 'été/a.md', 'été/'],
    ['decomposed (NFD) where git reports composed (NFC)', COMPOSED, `cafe${ACUTE}/a.md`, `cafe${ACUTE}/`],
    ['decomposed AND in another case', COMPOSED, `CAFE${ACUTE}/a.md`, `CAFE${ACUTE}/`],
  ])('refuses %s, as APFS folds it, naming both spellings', (_what, root, path, other) => {
    const refusal = caseSpellingRefusalWhereFolded(recordsOf(z('M', path)), Buffer.from(root, 'utf8'));

    expect(refusal).toMatchObject({ ok: false, kind: 'repository' });
    expect(refusal?.reason).toContain(`"${other}"`);
  });

  it('accepts a non-ASCII prefix spelled exactly, and a sibling that only shares its letters', () => {
    const root = Buffer.from('été/', 'utf8');

    expect(caseSpellingRefusalWhereFolded(recordsOf(z('M', 'été/a.md', 'M', 'étéx/a.md', 'M', 'ete/a.md')), root)).toBeUndefined();
  });

  it('folds as APFS does: case and normalisation, never ß into ss', () => {
    // `straße` and `strasse` are two names to APFS; an upper-case round trip made them one.
    expect(caseSpellingRefusalWhereFolded(recordsOf(z('M', 'strasse/a.md')), Buffer.from('straße/', 'utf8'))).toBeUndefined();
    expect(caseSpellingRefusalWhereFolded(recordsOf(z('M', 'STRASSE/a.md')), Buffer.from('strasse/', 'utf8'))).toMatchObject({ ok: false, kind: 'repository' });
    expect(caseSpellingRefusalWhereFolded(recordsOf(z('M', `${'été'.normalize('NFD')}/a.md`)), Buffer.from('été/', 'utf8'))).toMatchObject({ ok: false, kind: 'repository' });
  });

  it('has nothing to check at the repository root', () => {
    expect(caseSpellingRefusalWhereFolded(recordsOf(z('M', 'Docs/a.md')), Buffer.alloc(0))).toBeUndefined();
  });

  // On a case-sensitive filesystem `Docs/` and `docs/` are two sibling directories: a change under
  // the other one is simply not under the root, and refusing it would refuse every such repository.
  it('answers where the filesystem does not fold case: a sibling in another case is another directory', () => {
    expect(caseSpellingRefusal(recordsOf(z('M', 'Docs/a.md', 'R100', 'Docs/b.md', 'docs/b.md')), prefix, false)).toBeUndefined();
  });
});

describe('mergeBaseOf', () => {
  it('names the history a shallow clone cut off when there is no merge base, and how to complete it', () => {
    expect(mergeBaseOf('main', '', true)).toMatchObject({
      ok: false,
      kind: 'repository',
      reason: expect.stringMatching(/shallow clone.*cut off before the base "main" and HEAD meet.*fetch-depth: 0.*between the merge base and the tips is complete/s),
    });
  });

  it('refuses no merge base in a whole history as the base\'s fault: another base is the fix', () => {
    expect(mergeBaseOf('main', '', false)).toMatchObject({
      ok: false,
      kind: 'base',
      reason: expect.stringMatching(/"main" shares no history with HEAD/),
    });
  });

  it('answers the one merge base', () => {
    expect(mergeBaseOf('main', 'aaa\n', false)).toStrictEqual({ ok: true, commit: 'aaa' });
  });

  it('refuses more than one as the base\'s fault, naming each and the fix: pass one of them', () => {
    expect(mergeBaseOf('main', 'aaa\nbbb\n', false)).toMatchObject({
      ok: false,
      kind: 'base',
      reason: expect.stringMatching(/"main" has 2 merge bases with HEAD \(aaa, bbb\).*Pass one of them/s),
    });
  });
});

// The lens's view of the one classifier (`gitRunFailureOf`): every cause of a git that did not finish is git's.
describe('gitDidNotRun', () => {
  it.each([
    ['git is not on PATH', 'ENOENT', /git was not found on PATH/],
    ['git ran out of time', 'ETIMEDOUT', /did not finish within.*nearer base/s],
    ['the output overran the buffer', 'ENOBUFS', /more output than VAT reads.*nearer base/s],
  ])('names the real remedy when %s', (_what, code, remedy) => {
    const refusal = gitDidNotRun('diff-tree', gitSpawnFailure(code));

    expect(refusal).toMatchObject({ ok: false, kind: 'git-failed', reason: expect.stringMatching(remedy) });
    expect(refusal?.reason).toContain('git diff-tree');
    expect(refusal?.reason).not.toMatch(/re-run/);
  });

  it('is silent for a git that ran to an exit status', () => {
    expect(gitDidNotRun('diff-tree', { ok: false, stderr: 'fatal: bad object' })).toBeUndefined();
  });
});

describe('hiddenEditEntriesOf', () => {
  it('reads each `ls-files -v -z` entry as its tag and path bytes', () => {
    const read = hiddenEditEntriesOf(z('H site/a.md', 'S out.md'));

    expect(read.ok).toBe(true);
    expect(read.ok ? read.entries.map(({ tag, path }) => `${tag}:${text(path) ?? ''}`) : []).toStrictEqual(['H:site/a.md', 'S:out.md']);
  });

  it('refuses a listing that does not end in NUL as malformed, never as no flagged file', () => {
    expect(hiddenEditEntriesOf(Buffer.from('S out.md', 'utf8'))).toMatchObject({
      ok: false,
      kind: 'repository',
      reason: expect.stringMatching(/git ls-files -v -z wrote a listing VAT cannot read: the listing does not end in NUL/),
    });
  });
});
