/**
 * `linkTextRefusal`: where a link's text leads in a tree that will be relocated, decided by
 * walking it over a described layout — never by a lexical resolve, which cancels `x/..` without
 * asking whether `x` is a link.
 */
import { describe, expect, it } from 'vitest';

import { toForwardSlashAnyPlatform } from '../src/path-core.js';
import { linkTextRefusal, type PlaceKind } from '../src/tree-change/link-walk.js';

/** A tree, as what stands at each place below its root; anything not listed is absent. */
type Layout = Readonly<Record<string, Exclude<PlaceKind, 'absent'>>>;

const LAYOUT: Layout = {
  'SKILL.md': 'file',
  shared: 'directory',
  'shared/b.md': 'file',
  deep: 'directory',
  'deep/a': 'directory',
  // `up -> ../..`: the tree's root.
  'deep/a/up': 'link',
  'deep/a/l': 'link',
  alias: 'link',
};

const walk = (linkDir: string, text: string, host: 'posix' | 'win32' = 'posix', layout: Layout = LAYOUT): ReturnType<typeof linkTextRefusal> =>
  linkTextRefusal(linkDir === '' ? [] : toForwardSlashAnyPlatform(linkDir).split('/'), text, (place) => layout[place.join('/')] ?? 'absent', host);

describe('linkTextRefusal', () => {
  it.each([
    ['a file beside the link', 'deep/a', '../../SKILL.md'],
    ['a file in a sibling directory', 'deep/a', '../../shared/b.md'],
    ['a directory', 'deep', '../shared'],
    ['the tree\'s own root', 'deep/a', '../..'],
    ['another link, pointed AT and not through', 'deep', '../alias'],
    ['a text with `.` and doubled separators', 'deep', './..//shared/./b.md'],
  ])('accepts a link to %s', (_what, linkDir, text) => {
    expect(walk(linkDir, text)).toBeUndefined();
    expect(walk(linkDir, text, 'win32')).toBeUndefined();
  });

  // The text is split as the HOST's kernel splits it. A backslash separates on win32 and is an
  // ordinary character of a name on POSIX — where `a\b\c` is one component, and every `..` after it
  // climbs from that one directory.
  describe('a backslash in the text', () => {
    const SPELLED = String.raw`..\..\shared\b.md`;
    const ONE_NAME = String.raw`a\b\c`;
    /** Real directories `d/a/b/c`, a directory NAMED `a\b\c` beside them, and a decoy one level up. */
    const NAMED: Layout = { d: 'directory', 'd/a': 'directory', 'd/a/b': 'directory', 'd/a/b/c': 'directory', [`d/${ONE_NAME}`]: 'directory', 'd/secret': 'file' };

    it('separates on win32', () => {
      expect(walk('deep/a', SPELLED, 'win32')).toBeUndefined();
    });

    it('is one name on POSIX: a text spelled with backslashes names a single entry, which is not there', () => {
      expect(walk('deep/a', SPELLED)).toEqual({ why: 'dangling', at: `deep/a/${SPELLED}` });
    });

    it('buys no extra `..` on POSIX: three steps up from ONE directory leave the tree', () => {
      // Split on the backslash, this is three directories down and three back: `d/secret`, accepted.
      expect(walk('d', `${ONE_NAME}/../../../secret`, 'posix', NAMED)).toEqual({ why: 'climbs-out' });
      expect(walk('d', `${ONE_NAME}/../secret`, 'posix', NAMED)).toBeUndefined();
    });
  });

  it.each([
    // The reviewer's scenario: `up` is a link to the root, so the kernel climbs three levels ABOVE the
    // root where a lexical resolve cancels `up/..` and stays one level below it.
    ['climbs out through another link', 'deep/a', 'up/../../../.ssh/id_rsa', { why: 'through-link', at: 'deep/a/up' }],
    ['passes through a link that stays inside', 'deep', '../alias/b.md', { why: 'through-link', at: 'alias' }],
    ['climbs above the root', 'deep/a', '../../../outside', { why: 'climbs-out' }],
    ['leaves and re-enters by the tree\'s own name', '', '../unit/SKILL.md', { why: 'climbs-out' }],
    ['names nothing', 'deep', 'not-there.md', { why: 'dangling', at: 'deep/not-there.md' }],
    ['names something under nothing', 'deep', '../gone/x.md', { why: 'dangling', at: 'gone' }],
    ['passes through a file', 'deep', '../SKILL.md/x', { why: 'dangling', at: 'SKILL.md' }],
    ['is a POSIX absolute path', 'deep', '/etc/passwd', { why: 'absolute' }],
    ['is absolute though it points into the tree', 'deep', '/unit/SKILL.md', { why: 'absolute' }],
    ['is a drive path', 'deep', String.raw`C:\Users\x`, { why: 'absolute' }],
    ['is a UNC path', 'deep', String.raw`\\host\share\x`, { why: 'absolute' }],
  ])('refuses a link whose text %s', (_what, linkDir, text, refusal) => {
    expect(walk(linkDir, text)).toEqual(refusal);
  });
});
