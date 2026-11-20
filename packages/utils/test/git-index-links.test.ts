/**
 * `gitLinksCheckedOutAsFiles` reads `core.symlinks` the way the platform's git
 * does, and an index entry's mode at the stage git reads it from. `runGit` is
 * the seam: what is pinned is this module's reading of git's answers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GitRunResult } from '../src/git-run.js';
import { safePath } from '../src/path-utils.js';

vi.mock('../src/git-run.js', () => ({
  runGit: vi.fn(),
  gitIsMissing: vi.fn(() => false),
}));

const { runGit } = await import('../src/git-run.js');
const { gitLinksCheckedOutAsFiles } = await import('../src/git-index-links.js');

const CWD = '/repo/docs';
const OID = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

function result(status: number, stdout = ''): GitRunResult {
  return { ok: status === 0, status, stdout, stderr: '' };
}

/** `git config` answers `config`; `git ls-files -s` answers `records`, NUL-joined. */
function gitAnswers(config: GitRunResult, records: readonly string[] = []): void {
  vi.mocked(runGit).mockImplementation((args) =>
    args[0] === 'config' ? config : result(0, records.map((record) => `${record}\0`).join('')));
}

/** Run with `process.platform` reading `platform`. */
function onPlatform<T>(platform: NodeJS.Platform, work: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return work();
  } finally {
    if (original !== undefined) Object.defineProperty(process, 'platform', original);
  }
}

const LINK = `120000 ${OID} 0\tlink.md`;
const FILE = `100644 ${OID} 0\tplain.md`;

afterEach(() => {
  vi.mocked(runGit).mockReset();
});

describe('gitLinksCheckedOutAsFiles: core.symlinks', () => {
  it('reads the index when core.symlinks is false', () => {
    gitAnswers(result(0, 'false'), [LINK, FILE]);
    expect([...gitLinksCheckedOutAsFiles(CWD)]).toEqual([safePath.resolve(CWD, 'link.md')]);
  });

  it('reads nothing more when core.symlinks is true', () => {
    gitAnswers(result(0, 'true'), [LINK]);
    expect(gitLinksCheckedOutAsFiles(CWD).size).toBe(0);
    expect(vi.mocked(runGit)).toHaveBeenCalledTimes(1);
  });

  it('reads an unset key as true off Windows, as git does', () => {
    gitAnswers(result(1), [LINK]);
    expect(onPlatform('linux', () => gitLinksCheckedOutAsFiles(CWD)).size).toBe(0);
    expect(onPlatform('darwin', () => gitLinksCheckedOutAsFiles(CWD)).size).toBe(0);
  });

  it('reads an unset key as false on Windows, as Git for Windows does', () => {
    gitAnswers(result(1), [LINK]);
    expect([...onPlatform('win32', () => gitLinksCheckedOutAsFiles(CWD))]).toEqual([safePath.resolve(CWD, 'link.md')]);
  });

  it('refuses, coded, when git config fails otherwise', () => {
    gitAnswers(result(128));
    expect(() => gitLinksCheckedOutAsFiles(CWD)).toThrow(expect.objectContaining({ code: 'GIT_NO_ANSWER' }) as Error);
  });

  it('refuses, coded, when the index cannot be read', () => {
    vi.mocked(runGit).mockImplementation((args) => (args[0] === 'config' ? result(0, 'false') : result(128)));
    expect(() => gitLinksCheckedOutAsFiles(CWD)).toThrow(expect.objectContaining({ code: 'GIT_NO_ANSWER' }) as Error);
  });
});

describe('gitLinksCheckedOutAsFiles: the stage git reads a conflicted path from', () => {
  const off = result(0, 'false');

  it('reads "ours" (stage 2) over the base and "theirs"', () => {
    gitAnswers(off, [`100644 ${OID} 1\tc.md`, `120000 ${OID} 2\tc.md`, `100644 ${OID} 3\tc.md`]);
    expect([...gitLinksCheckedOutAsFiles(CWD)]).toEqual([safePath.resolve(CWD, 'c.md')]);
  });

  it('is not a link when "ours" is a file, whatever "theirs" is', () => {
    gitAnswers(off, [`100644 ${OID} 2\tc.md`, `120000 ${OID} 3\tc.md`]);
    expect(gitLinksCheckedOutAsFiles(CWD).size).toBe(0);
  });

  it('reads the base (stage 1) over "theirs" when "ours" is absent', () => {
    gitAnswers(off, [`120000 ${OID} 1\tc.md`, `100644 ${OID} 3\tc.md`]);
    expect([...gitLinksCheckedOutAsFiles(CWD)]).toEqual([safePath.resolve(CWD, 'c.md')]);
  });

  it('reads "theirs" (stage 3) when it is the only stage', () => {
    gitAnswers(off, [`120000 ${OID} 3\tc.md`]);
    expect([...gitLinksCheckedOutAsFiles(CWD)]).toEqual([safePath.resolve(CWD, 'c.md')]);
  });

  it('keeps a path with a tab in its name whole', () => {
    gitAnswers(off, [`120000 ${OID} 0\ta\tb.md`]);
    expect([...gitLinksCheckedOutAsFiles(CWD)]).toEqual([safePath.resolve(CWD, 'a\tb.md')]);
  });
});
