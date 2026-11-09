/**
 * The pure half of `gitChangedFiles`: reading `git diff --name-status -z` as bytes, and keeping
 * only what lies under the project root, relative to it. The git wiring is one integration test
 * (`test/integration/git-changed-files.integration.test.ts`).
 */

import { describe, expect, it } from 'vitest';

import { changedFilesUnderPrefix, parseNameStatusZ } from '../src/git-changed-files.js';

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

describe('parseNameStatusZ', () => {
  it('reads every status letter, with the rename and copy source and score', () => {
    const records = parseNameStatusZ(z(
      'A', 'new.md',
      'M', 'docs/edited.md',
      'D', 'gone.md',
      'T', 'link.md',
      'R087', 'old name.md', 'new name.md',
      'C100', 'src.md', 'copy.md',
    ));

    expect(records.map((record) => ({ ...record, path: text(record.path), oldPath: text(record.oldPath) }))).toStrictEqual([
      { status: 'added', path: 'new.md', oldPath: null, similarity: null },
      { status: 'modified', path: 'docs/edited.md', oldPath: null, similarity: null },
      { status: 'deleted', path: 'gone.md', oldPath: null, similarity: null },
      { status: 'type-changed', path: 'link.md', oldPath: null, similarity: null },
      { status: 'renamed', path: 'new name.md', oldPath: 'old name.md', similarity: 87 },
      { status: 'copied', path: 'copy.md', oldPath: 'src.md', similarity: 100 },
    ]);
  });

  it('reads an unmerged path as modified: the working tree holds a different file than the base', () => {
    expect(parseNameStatusZ(z('U', 'conflicted.md')).map((record) => record.status)).toStrictEqual(['modified']);
  });

  it('keeps a path byte for byte, a leading space and bytes that are not UTF-8 included', () => {
    const notUtf8 = Uint8Array.from([0x61, 0xff, 0x2e, 0x6d, 0x64]);
    const [spaced, raw] = parseNameStatusZ(z('M', ' lead.md', 'A', notUtf8));

    expect(text(spaced?.path ?? null)).toBe(' lead.md');
    expect(Buffer.from(raw?.path ?? []).equals(Buffer.from(notUtf8))).toBe(true);
  });

  it('reads an empty listing as no change', () => {
    expect(parseNameStatusZ(Buffer.alloc(0))).toStrictEqual([]);
  });

  it.each([
    ['an unknown status letter', z('X', 'what.md')],
    ['a rename missing its destination', z('R100', 'only-source.md')],
    ['a record missing its path', z('M')],
    ['a listing that does not end in NUL', Buffer.from('M\0a.md', 'utf8')],
    ['a rename with no score', z('R', 'a.md', 'b.md')],
  ])('refuses %s rather than guessing', (_what, listing) => {
    expect(() => parseNameStatusZ(listing)).toThrow(/name-status/);
  });
});

/** The rows for a listing and an untracked list, under the root `site/`. */
function under(listing: Buffer, untracked: readonly string[] = []): ReturnType<typeof changedFilesUnderPrefix> {
  return changedFilesUnderPrefix(
    parseNameStatusZ(listing),
    untracked.map((path) => Buffer.from(path, 'utf8')),
    Buffer.from('site/', 'utf8'),
  );
}

describe('changedFilesUnderPrefix', () => {
  it('keeps only paths under the root, relative to it', () => {
    expect(under(z('M', 'site/a.md', 'M', 'other/b.md', 'M', 'sitemap.md'))).toStrictEqual({
      ok: true,
      files: [{ path: 'a.md', status: 'modified', oldPath: null, similarity: null }],
    });
  });

  it('adds every untracked path as added', () => {
    expect(under(z(), ['site/draft.md'])).toStrictEqual({
      ok: true,
      files: [{ path: 'draft.md', status: 'added', oldPath: null, similarity: null }],
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

  it('reads a copy from outside the root as an addition, and drops a copy that leaves it', () => {
    expect(under(z('C100', 'elsewhere/src.md', 'site/copy.md', 'C100', 'site/src.md', 'elsewhere/copy.md'))).toStrictEqual({
      ok: true,
      files: [{ path: 'copy.md', status: 'added', oldPath: null, similarity: null }],
    });
  });

  it('keeps everything at the repository root when the prefix is empty, sorted by path', () => {
    expect(changedFilesUnderPrefix(parseNameStatusZ(z('M', 'z.md', 'D', 'a/b.md')), [], Buffer.alloc(0))).toStrictEqual({
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

  it('drops an untracked nested repository, which git lists as its directory', () => {
    expect(under(z(), ['site/nested/', 'site/draft.md'])).toStrictEqual({
      ok: true,
      files: [{ path: 'draft.md', status: 'added', oldPath: null, similarity: null }],
    });
  });

  it('reports a path git lists twice with one kind once, so (path, status) stays a key', () => {
    expect(under(z('U', 'site/conflicted.md', 'M', 'site/conflicted.md'))).toStrictEqual({
      ok: true,
      files: [{ path: 'conflicted.md', status: 'modified', oldPath: null, similarity: null }],
    });
  });

  it('ignores a path that is not UTF-8 when it lies outside the root', () => {
    expect(under(z('A', Uint8Array.from([0x6f, 0xff])))).toStrictEqual({ ok: true, files: [] });
  });
});
