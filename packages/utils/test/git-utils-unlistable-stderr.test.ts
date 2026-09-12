/**
 * The one place git tells us a directory was skipped: its stderr.
 *
 * `git ls-files --others` walks the working tree and, on a directory it cannot
 * open, prints `warning: could not open directory '<repo-relative>/': <reason>`,
 * exits 0, and omits the subtree. Nothing on stdout distinguishes that from a
 * tree with fewer files, so the parser below is the ONLY witness to the gap.
 *
 * Pure: three lines in, the directories out. The wiring that turns them into a
 * `DirectoryRefusal` is exercised against a real repository in
 * `file-crawler-git-refused-listing.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { unlistableDirectoriesIn } from '../src/git-utils.js';

const LOCKED_WARNING = "warning: could not open directory 'docs/locked/': Permission denied";

describe('unlistableDirectoriesIn', () => {
  it('returns every refused directory, repo-relative and without the trailing slash, ignoring unrelated lines', () => {
    const stderr = [
      LOCKED_WARNING,
      'warning: in the working copy of "a.md", LF will be replaced by CRLF the next time Git touches it',
      "warning: could not open directory 'build/cache/': Permission denied",
      'hint: use --force to override',
    ].join('\n');

    expect(unlistableDirectoriesIn(stderr)).toEqual([
      { directory: 'docs/locked', code: 'EACCES' },
      { directory: 'build/cache', code: 'EACCES' },
    ]);
  });

  it('returns nothing for empty stderr and for stderr with no refusal in it', () => {
    expect(unlistableDirectoriesIn('')).toEqual([]);
    expect(unlistableDirectoriesIn('warning: something else entirely\n')).toEqual([]);
  });

  it.each([
    ['Permission denied', 'EACCES'],
    ['Too many open files', 'EMFILE'],
    ['Too many open files in system', 'ENFILE'],
    ['Too many levels of symbolic links', 'ELOOP'],
  ])('maps the C-locale strerror "%s" to %s', (reason, code) => {
    expect(unlistableDirectoriesIn(`warning: could not open directory 'x/y/': ${reason}`)).toEqual([
      { directory: 'x/y', code },
    ]);
  });

  it('keeps an unrecognised reason as a refusal with code UNKNOWN rather than dropping it', () => {
    // "I could not read why" is still "git did not list it": dropping the line
    // would reinstate the silent gap for every errno not in the table.
    expect(unlistableDirectoriesIn("warning: could not open directory 'x/': Some new reason")).toEqual([
      { directory: 'x', code: 'UNKNOWN' },
    ]);
  });

  it('reports one directory once even when git repeats the warning', () => {
    expect(unlistableDirectoriesIn(`${LOCKED_WARNING}\n${LOCKED_WARNING}\n`)).toEqual([
      { directory: 'docs/locked', code: 'EACCES' },
    ]);
  });
});
