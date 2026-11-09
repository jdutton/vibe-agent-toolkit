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
  mergeBaseOf,
  parseNameStatusZ,
} from '../src/git-changed-files.js';

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
  it('reads every status letter, with the rename source and score', () => {
    const records = parseNameStatusZ(z(
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
    // Copies are never asked for (no -C), and a tree-to-tree diff has no unmerged path.
    ['a copy', z('C100', 'src.md', 'copy.md')],
    ['an unmerged path', z('U', 'conflicted.md')],
  ])('refuses %s rather than guessing', (_what, listing) => {
    expect(() => parseNameStatusZ(listing)).toThrow(/git diff-tree --name-status -z/);
  });
});

/** The rows for a listing under the root `site/`. */
function under(listing: Buffer): ReturnType<typeof changedFilesUnderPrefix> {
  return changedFilesUnderPrefix(parseNameStatusZ(listing), Buffer.from('site/', 'utf8'));
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
    expect(changedFilesUnderPrefix(parseNameStatusZ(z('M', 'z.md', 'D', 'a/b.md')), Buffer.alloc(0))).toStrictEqual({
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

describe('caseSpellingRefusal', () => {
  const prefix = Buffer.from('docs/', 'utf8');

  it.each([
    ['the old side of a rename', z('R100', 'Docs/a.md', 'docs/a.md'), 'Docs/'],
    ['a deletion', z('D', 'Docs/b.md'), 'Docs/'],
    ['the new side of a rename', z('R100', 'docs/a.md', 'DOCS/a.md'), 'DOCS/'],
  ])('refuses a path spelled in another case on %s, naming both spellings', (_what, listing, other) => {
    const refusal = caseSpellingRefusal(parseNameStatusZ(listing), prefix);

    expect(refusal).toMatchObject({ ok: false, kind: 'repository' });
    expect(refusal?.reason).toContain('"docs/"');
    expect(refusal?.reason).toContain(`"${other}"`);
  });

  it('accepts paths that carry the prefix exactly, or lie elsewhere', () => {
    expect(caseSpellingRefusal(parseNameStatusZ(z('M', 'docs/a.md', 'M', 'other/x.md', 'M', 'docsx/y.md')), prefix))
      .toBeUndefined();
  });

  it('has nothing to check at the repository root', () => {
    expect(caseSpellingRefusal(parseNameStatusZ(z('M', 'Docs/a.md')), Buffer.alloc(0))).toBeUndefined();
  });
});

describe('mergeBaseOf', () => {
  it('answers the one merge base', () => {
    expect(mergeBaseOf('main', 'aaa\n')).toStrictEqual({ ok: true, commit: 'aaa' });
  });

  it('refuses more than one, naming each and the fix', () => {
    expect(mergeBaseOf('main', 'aaa\nbbb\n')).toMatchObject({
      ok: false,
      kind: 'repository',
      reason: expect.stringMatching(/"main" has 2 merge bases with HEAD \(aaa, bbb\).*Pass one of them/s),
    });
  });
});

/** A spawn failure carrying `code`, as Node reports one. */
function failed(code: string): { ok: false; stderr: string; error: Error } {
  return { ok: false, stderr: '', error: Object.assign(new Error(`spawnSync git ${code}`), { code }) };
}

describe('gitDidNotRun', () => {
  it.each([
    ['git is not on PATH', 'ENOENT', /Put git on PATH/],
    ['git ran out of time', 'ETIMEDOUT', /did not finish within.*nearer base/s],
    ['the output overran the buffer', 'ENOBUFS', /more output than VAT reads.*nearer base/s],
  ])('names the real remedy when %s', (_what, code, remedy) => {
    const refusal = gitDidNotRun('diff-tree', failed(code));

    expect(refusal).toMatchObject({ ok: false, kind: 'git-failed', reason: expect.stringMatching(remedy) });
    expect(refusal?.reason).toContain('git diff-tree');
    expect(refusal?.reason).not.toMatch(/re-run/);
  });

  it('is silent for a git that ran to an exit status', () => {
    expect(gitDidNotRun('diff-tree', { ok: false, stderr: 'fatal: bad object' })).toBeUndefined();
  });
});
