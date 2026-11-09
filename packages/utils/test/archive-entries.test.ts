import { describe, expect, it } from 'vitest';

import { ARCHIVE_REFUSED_CODE, type ArchiveEntry, archiveEntryRefusal, assertArchiveExtractable, entryNameOf } from '../src/archive/entries.js';
import { isVatError } from '../src/errors/vat-error.js';
import { foldedSegment } from '../src/name-fold.js';

const file = (name: string): ArchiveEntry => ({ name, kind: 'file', size: 1 });
const dir = (name: string): ArchiveEntry => ({ name, kind: 'directory', size: 0 });
/** A dotless `ı` (NTFS upper-cases it to `I`) and a zero-width non-joiner (HFS+ ignores it in a name). */
const DOTLESS_I = String.fromCodePoint(0x131);
const ZWNJ = String.fromCodePoint(0x200c);
/** Every code point HFS+ ignores in a name, as git's `next_hfs_char` lists them. */
const HFS_IGNORED = [0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f, 0xfeff];

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

  // A name Windows cannot hold as spelled is refused on EVERY host: on NTFS `a.md:hidden` writes a
  // stream of `a.md`, `aux` opens a device, and `a.` and `a ` lose their last character.
  it.each([
    ['a.md:hidden', 'holds a `:`'],
    ['dir:x/a.md', 'holds a `:`'],
    ['a.', 'ends in a `.` or a space'],
    ['docs /a.md', 'ends in a `.` or a space'],
    ['skill/notes.md ', 'ends in a `.` or a space'],
    ['CON', 'is a Windows device name'],
    ['skill/prn.txt', 'is a Windows device name'],
    ['Aux.tar.gz', 'is a Windows device name'],
    ['nul', 'is a Windows device name'],
    ['skill/com1.md', 'is a Windows device name'],
    ['lpt9/a.md', 'is a Windows device name'],
    ['LPT\u00b9', 'is a Windows device name'],
    ['con .md', 'is a Windows device name'],
    // A `.git` anywhere would make the folder it lands in a git repository.
    ...['.git', '.git/config', 'skill/.git/config', 'a/b/.GIT/HEAD', '.Git', 'skill/GIT~1/config', 'git~1', 'skill/.git.', '.git /config', '.git. ./config', `.g${DOTLESS_I}t/config`, `.G${DOTLESS_I}T/HEAD`, `.g${ZWNJ}it/config`].map((name) => [name, 'names a `.git`']),
    ...['<', '>', '"', '|', '?', '*'].map((character) => [`skill/a${character}b.md`, 'holds a character Windows does not allow in a name']),
    ...[1, 9, 31].map((codePoint) => [`skill/a${String.fromCodePoint(codePoint)}b.md`, 'holds a character Windows does not allow in a name']),
  ])('refuses %j, which %s, on every host', (name, why) => {
    const refusal = archiveEntryRefusal([file(name)]);
    expect(refusal).toMatchObject({ reason: 'unsafe-name', entry: name });
    expect(refusal?.why).toContain(why);
  });

  it.each([['console.md'], ['nullable.md'], ['com10.md'], ['lpt.md'], ['auxiliary/a.md'], ['a.b.md'], ['.hidden'], ['a b(1)[2]{3}#&!@=+,;~.md'], [`a${String.fromCodePoint(32)}b.md`], [`caf${String.fromCodePoint(0xe9)}.md`], ['.github/workflows/ci.yml'], ['.gitignore'], ['.gitattributes'], ['git/a.md'], ['my.git.md'], ['CONSOLE.md'], ['COM10'], ['LPT10'], ['git~2.md'], ['.git~1']])('keeps %j, which only looks like one of those', (name) => {
    expect(archiveEntryRefusal([file(name)])).toBeUndefined();
  });

  it('refuses a stream name beside the file it would write into, as the stream, before any clash', () => {
    expect(archiveEntryRefusal([file('a.md'), file('a.md:hidden')])).toMatchObject({ reason: 'unsafe-name', entry: 'a.md:hidden' });
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

// The readers name an entry as the tar library does on win32 (its `normalizeWindowsPath`: every
// backslash read as `/`), on every host — so the name the policy sees on Windows is the name it
// sees here, and a refusal proven here is the one Windows gives.
describe('an entry name on every host', () => {
  /** A hostile header name, and the name the tar library yields for it on win32 — spelled out, not computed. */
  const HOSTILE: ReadonlyArray<readonly [raw: string, onWin32: string]> = [
    [String.raw`C:\x.md`, 'C:/x.md'],
    ['C:x.md', 'C:x.md'],
    [String.raw`C:\a/b.md`, 'C:/a/b.md'],
    [String.raw`\\host\share\x.md`, '//host/share/x.md'],
    [String.raw`..\x`, '../x'],
    [String.raw`a\..\..\x`, 'a/../../x'],
    [String.raw`\abs.md`, '/abs.md'],
  ];

  it.each(HOSTILE)('reads %j as the tar library yields it on win32, %j', (raw, onWin32) => {
    expect(entryNameOf(raw)).toBe(onWin32);
  });

  it.each(HOSTILE)('refuses %j, and %j, as a place outside the archive', (raw, onWin32) => {
    expect(archiveEntryRefusal([file(raw)])).toMatchObject({ reason: 'unsafe-name' });
    expect(archiveEntryRefusal([file(onWin32)])).toMatchObject({ reason: 'unsafe-name', entry: onWin32 });
  });

  it('keeps every other character as the archive spells it', () => {
    expect(entryNameOf('skill/caf\u00e9 notes v2.md')).toBe('skill/caf\u00e9 notes v2.md');
  });
});

describe('a `.git` refusal says what it is about', () => {
  it('renders a sentence that is true of a `.git`', () => {
    let thrown: unknown;
    try {
      assertArchiveExtractable('/in/pkg.tgz', [file('skill/.git/config')]);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe('/in/pkg.tgz is not an archive VAT accepts, nothing was changed: its entry `skill/.git/config` names a `.git`, so extracted it would make the folder it lands in a git repository that git and VAT then act on');
  });
});

describe('a name clash says which fold made two names one', () => {
  it('names letter case and Unicode form', () => {
    expect(archiveEntryRefusal([file('Notes.md'), file('notes.md')])?.why).toContain('folds letter case or Unicode form');
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

  it.each(HFS_IGNORED)('drops code point %i, which HFS+ ignores in a name', (codePoint) => {
    expect(foldedSegment(`.G${String.fromCodePoint(codePoint)}it`)).toBe('.git');
  });

  it('cuts the trailing dots and spaces an ignored code point hid', () => {
    expect(foldedSegment(`a.${ZWNJ}`)).toBe('a');
  });
});
