/**
 * Which refusal an archive (`.zip`, `.tgz`, an npm tarball) that could not be
 * extracted is, decided by the one classifier from the path the OS named: the
 * staging directory giving out is VAT's own scratch (`environment`, the run not
 * finishing); a layout fault the archive decided while it was written into staging
 * is the archive's; bytes that are no archive are the archive's.
 *
 * Containment is the filesystem's judgement (`fsBoundary` canonicalises with
 * realpath), so this runs on a real staging directory.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { FS_FAULT_CODE, mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { archiveFailure } from '../../src/utils/archive-staging.js';
import { refusalCodeOf } from '../../src/utils/command-refusal.js';

let root: string;
let archive: string;
let staged: string;

beforeEach(() => {
  root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-archive-failure-'));
  archive = safePath.join(root, 'skill.tgz');
  writeFileSync(archive, 'x');
  staged = safePath.join(root, 'vat-install-tgz-x');
  mkdirSyncReal(staged);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** An errno-shaped error naming `path` — node-tar's entry failures carry the errno as `code` and its own as `tarCode`. */
function errnoAt(code: string, path: string, tarCode?: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: refused, open '${path}'`), { code, path }, tarCode === undefined ? {} : { tarCode });
}

describe('archiveFailure', () => {
  it.each(['ENOSPC', 'EDQUOT', 'EROFS', 'EMFILE', 'ENFILE', 'EIO', 'EACCES'])('classifies %s writing into staging as VAT\'s own scratch: RUN_INCOMPLETE, naming the staged path', (code) => {
    const entry = safePath.join(staged, 'package', 'SKILL.md');

    const failure = archiveFailure(archive, [staged], errnoAt(code, entry, 'TAR_ENTRY_ERROR'));

    expect(failure).toMatchObject({ code: FS_FAULT_CODE, side: 'environment', errno: code, path: entry });
    expect(refusalCodeOf(failure)).toBe('RUN_INCOMPLETE');
  });

  it.each([
    ['a file `a` beside a file `a/b` (adm-zip)', 'ENOTDIR'],
    ['a file `a` beside a file `a/b` (node-tar)', 'EEXIST'],
    ['an entry that already exists as a directory', 'EISDIR'],
  ])('puts %s on the archive: a layout it decided, INPUT_UNREADABLE', (_label, code) => {
    const failure = archiveFailure(archive, [staged], errnoAt(code, safePath.join(staged, 'a', 'b')));

    expect(failure).toMatchObject({ code: FS_FAULT_CODE, side: 'source', origin: 'content', errno: code });
    expect(refusalCodeOf(failure)).toBe('INPUT_UNREADABLE');
  });

  // adm-zip makes the extraction root's parents itself: a `stat` of $TMPDIR the OS answers ENOENT is
  // followed by a `mkdir` that answers EEXIST — at the staging root or above it, where no entry of the
  // archive lands. The archive decided nothing there: it is VAT's own scratch, RUN_INCOMPLETE.
  it.each([
    ['the staging root itself', (): string => staged],
    ['an ancestor of the staging root ($TMPDIR)', (): string => root],
  ])('keeps a layout errno at %s on the environment: RUN_INCOMPLETE, never the archive\'s', (_label, at) => {
    const failure = archiveFailure(archive, [staged], errnoAt('EEXIST', at()));

    expect(failure).toMatchObject({ code: FS_FAULT_CODE, side: 'environment', errno: 'EEXIST' });
    expect(refusalCodeOf(failure)).toBe('RUN_INCOMPLETE');
  });

  // node-tar reports a full disk mid-entry with an errno that names no path: the refusal must still
  // say WHERE — VAT's staging — and keep the classified cause (a full $TMPDIR, RUN_INCOMPLETE).
  it('names the staging directory for a capacity errno that names no path', () => {
    const failure = archiveFailure(archive, [staged], Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }));

    expect(failure).toMatchObject({ code: FS_FAULT_CODE, side: 'environment', errno: 'ENOSPC', faultClass: 'exhausted', path: staged });
    expect((failure as Error).message).toContain(staged);
    expect(refusalCodeOf(failure)).toBe('RUN_INCOMPLETE');
  });

  it('puts a read of the archive itself the OS refuses on the archive', () => {
    const failure = archiveFailure(archive, [staged], errnoAt('EACCES', archive));

    expect(failure).toMatchObject({ code: FS_FAULT_CODE, side: 'source', path: archive });
    expect(refusalCodeOf(failure)).toBe('INPUT_UNREADABLE');
  });

  it.each([
    ['bytes that are no tarball', Object.assign(new Error('TAR_BAD_ARCHIVE: Unrecognized archive format'), { code: 'TAR_BAD_ARCHIVE' })],
    ['an error of the archive library itself', new Error('Invalid or unsupported zip format')],
  ])('codes %s as the archive\'s INPUT_UNREADABLE, naming the archive', (_label, error) => {
    const failure = archiveFailure(archive, [staged], error);

    expect(refusalCodeOf(failure)).toBe('INPUT_UNREADABLE');
    expect((failure as Error).message).toContain(archive);
  });
});
