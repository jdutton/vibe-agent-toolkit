import { describe, expect, it } from 'vitest';

import { ARCHIVE_REFUSED_CODE, type ArchiveEntry, archiveEntryRefusal, assertArchiveExtractable } from '../src/archive/entries.js';
import { isVatError } from '../src/errors/vat-error.js';
import { foldedSegment } from '../src/name-fold.js';

const file = (name: string): ArchiveEntry => ({ name, kind: 'file', size: 1 });
const dir = (name: string): ArchiveEntry => ({ name, kind: 'directory', size: 0 });

describe('archiveEntryRefusal', () => {
  it('accepts files and directories named inside the archive', () => {
    expect(archiveEntryRefusal([dir('./'), dir('package/'), file('package/a.md'), file('package/sub/b.md'), dir('package/sub/'), dir('package/sub')])).toBeUndefined();
  });

  it.each([
    ['a symbolic link', { name: 'package/keys', kind: 'link', size: 0 }, 'link'],
    ['a hard link', { name: 'package/twin', kind: 'hardlink', size: 0 }, 'hardlink'],
    ['a device', { name: 'package/dev', kind: 'other', size: 0 }, 'special'],
  ] as const)('refuses %s, whatever it points at', (_what, entry, reason) => {
    expect(archiveEntryRefusal([file('package/a.md'), entry])).toMatchObject({ reason, entry: entry.name });
  });

  it.each([
    ['../x'],
    ['package/../../x'],
    String.raw`package\..\..\x`,
    ['/abs.md'],
    [String.raw`C:\x.md`],
    ['C:x.md'],
    [String.raw`\\host\share\x.md`],
    ['a\0b'],
    ['.'],
  ].flat())('refuses the name %j as a place outside the archive', (name) => {
    expect(archiveEntryRefusal([file(name)])).toMatchObject({ reason: 'unsafe-name', entry: name });
  });

  it.each([
    ['listed twice', [file('a/b.md'), file('a/b.md')]],
    ['listed twice, one spelled with a backslash', [file('a/b.md'), file(String.raw`a\b.md`)]],
    ['a file with an entry under it', [file('a'), file('a/b.md')]],
    ['an entry under what is then a file', [file('a/b.md'), file('a')]],
    ['a file and a directory at one name', [file('a'), dir('a/')]],
    ['differing only in letter case', [file('Notes.md'), file('notes.md')]],
    ['differing only in the case of a directory', [file('Docs/a.md'), file('docs/b.md')]],
    ['differing only in Unicode form', [file('caf\u00e9.md'), file('cafe\u0301.md')]],
    ['one a compatibility form of the other', [file('\ufb01le.md'), file('file.md')]],
    ['folding to one name', [file('stra\u00dfe.md'), file('STRASSE.md')]],
    ['differing only in a trailing dot', [file('a.'), file('a')]],
    ['one a stream of the other', [file('a.md:hidden'), file('a.md')]],
  ] as const)('refuses two entries %s', (_what, entries) => {
    expect(archiveEntryRefusal(entries)).toMatchObject({ reason: 'name-clash', entry: entries[1].name });
  });

  it('names the FIRST offending entry in archive order', () => {
    expect(archiveEntryRefusal([file('ok.md'), file('../first'), { name: 'second', kind: 'link', size: 0 }])).toMatchObject({ entry: '../first' });
  });

  it('lets a directory be listed more than once: it is one directory either way', () => {
    expect(archiveEntryRefusal([dir('a/'), dir('a'), file('a/b.md')])).toBeUndefined();
  });
});

describe('assertArchiveExtractable', () => {
  it('throws a coded refusal naming the archive and the entry', () => {
    let thrown: unknown;
    try {
      assertArchiveExtractable('/in/pkg.tgz', [{ name: 'package/keys', kind: 'link', size: 0 }]);
    } catch (error) {
      thrown = error;
    }
    expect(isVatError(thrown, ARCHIVE_REFUSED_CODE)).toBe(true);
    expect(thrown).toMatchObject({ reason: 'link', entry: 'package/keys' });
    expect((thrown as Error).message).toContain('/in/pkg.tgz is not an archive VAT accepts, nothing was changed');
    expect((thrown as Error).message).toContain('`package/keys` is a symbolic link');
  });

  it('returns for an archive every entry of which may be extracted', () => {
    expect(() => assertArchiveExtractable('/in/pkg.tgz', [file('package/a.md')])).not.toThrow();
  });
});

describe('a name clash says which fold made two names one', () => {
  it('names the NTFS stream rule when the two names share only the text before a `:`', () => {
    const refusal = archiveEntryRefusal([file('logs/10:00.log'), file('logs/10:30.log')]);

    expect(refusal).toMatchObject({ reason: 'name-clash', entry: 'logs/10:30.log' });
    expect(refusal?.why).toContain('what follows a `:` names a stream');
    expect(refusal?.why).not.toContain('letter case');
  });

  it('names case, Unicode form and trailing dots otherwise', () => {
    expect(archiveEntryRefusal([file('Notes.md'), file('notes.md')])?.why).toContain('folds letter case, Unicode form or trailing dots');
  });
});

describe('foldedSegment', () => {
  it.each([
    ['README.md', 'readme.md'],
    ['a.', 'a'],
    ['a  ', 'a'],
    ['a.md:stream', 'a.md'],
    ['skills::$INDEX_ALLOCATION', 'skills'],
    ['STRASSE', 'strasse'],
    ['stra' + String.fromCodePoint(0xdf) + 'e', 'strasse'],
    // A ligature and the two letters it stands for; a dotless i and a capital I.
    [String.fromCodePoint(0xfb01) + 'le', 'file'],
    [String.fromCodePoint(0x131), 'i'],
  ])('folds %j to %j', (segment, folded) => {
    expect(foldedSegment(segment)).toBe(folded);
  });
});
