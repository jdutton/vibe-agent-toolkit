/**
 * `gitTreeKey` over a scripted flag listing: what each listing git can hand back makes of the key.
 * The snapshot and the listing are seams here, so a listing git would not write (cut short, failed,
 * a path that is not UTF-8) is driven exactly. The real repository cases are in the integration
 * suite.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as GitRunModule from '../src/git-run.js';
import type * as GitSnapshotModule from '../src/git-snapshot.js';

const seams = vi.hoisted(() => ({
  listing: undefined as GitRunModule.GitBytesRunResult | undefined,
  args: [] as unknown[],
}));

vi.mock('../src/git-run.js', async (importOriginal) => {
  const actual = await importOriginal<typeof GitRunModule>();
  return {
    ...actual,
    runGitBytes: (args: readonly string[], options: unknown) => {
      seams.args.push(options);
      if (seams.listing === undefined) throw new Error(`unscripted git ${args.join(' ')}`);
      return seams.listing;
    },
  };
});

const ROOT = '/repo';
const SNAPSHOT: GitSnapshotModule.GitTreeSnapshot = { ok: true, hash: 'a'.repeat(40), repositoryRoot: ROOT, entries: [] };

vi.mock('../src/git-snapshot.js', async (importOriginal) => {
  const actual = await importOriginal<typeof GitSnapshotModule>();
  return { ...actual, gitTreeSnapshot: () => ({ ...SNAPSHOT }) };
});

const { GIT_FAILED_CODE, GIT_SNAPSHOT_INDEX_HIDES_CODE, gitSnapshotFailureOf } = await import('../src/git-no-answer.js');
const { gitTreeKey } = await import('../src/git-tree-key.js');

/** A listing git wrote, exit 0. */
function listed(bytes: Uint8Array): GitRunModule.GitBytesRunResult {
  return { ok: true, status: 0, stdout: Buffer.from(bytes), stderr: '' };
}

/** `ls-files -v -z` entries: tag, space, path, NUL. */
function entries(...tagged: ReadonlyArray<readonly [string, Uint8Array | string]>): Uint8Array {
  return Buffer.concat(tagged.map(([tag, path]) => Buffer.concat([Buffer.from(`${tag} `), Buffer.from(path), Buffer.from([0])])));
}

/** The key's cause, classified, or a failed test when the key was taken. */
function declined(): { code: string; reason: string } {
  const key = gitTreeKey({ cwd: ROOT });
  expect(key.ok, 'the key was taken').toBe(false);
  if (key.ok) throw new Error('unreachable');
  return gitSnapshotFailureOf(key);
}

afterEach(() => {
  seams.listing = undefined;
  seams.args = [];
});

describe('gitTreeKey over a scripted flag listing', () => {
  it('takes the key when no entry is flagged', () => {
    seams.listing = listed(entries(['H', 'a.md'], ['H', 'b.md']));
    expect(gitTreeKey({ cwd: ROOT })).toMatchObject({ ok: true, hash: SNAPSHOT.hash });
  });

  it('keys a skip-worktree entry with nothing on disk, under a hash apart from the unflagged tree\'s', () => {
    // ROOT does not exist, so every listed path is absent.
    seams.listing = listed(entries(['H', 'a.md'], ['S', 'gone.md']));
    const key = gitTreeKey({ cwd: ROOT });
    if (!key.ok) throw new Error(`declined: ${gitSnapshotFailureOf(key).reason}`);
    expect(key.hash).not.toBe(SNAPSHOT.hash);
    seams.listing = listed(entries(['H', 'a.md'], ['S', 'other.md']));
    const other = gitTreeKey({ cwd: ROOT });
    expect(other.ok && other.hash, 'another absent set, another key').not.toBe(key.hash);
  });

  it('declines an absent entry that is assume-unchanged as well (tag `s`)', () => {
    seams.listing = listed(entries(['s', 'gone.md']));
    expect(declined().code).toBe(GIT_SNAPSHOT_INDEX_HIDES_CODE);
  });

  it('names a file carrying both flags (tag `s`) with both', () => {
    seams.listing = listed(entries(['s', 'both.md']));
    const cause = declined();
    expect(cause.code).toBe(GIT_SNAPSHOT_INDEX_HIDES_CODE);
    expect(cause.reason).toContain('"both.md" (assume-unchanged and skip-worktree)');
  });

  it('shows a flagged path that is not UTF-8 quoted once', () => {
    seams.listing = listed(entries(['h', Uint8Array.of(0xff, 0x2e, 0x6d, 0x64)]));
    const { reason } = declined();
    expect(reason).toContain(String.raw`"\xff.md" (assume-unchanged)`);
    expect(reason).not.toContain(String.raw`\"`);
  });

  it('counts the flagged entries past the ones it names', () => {
    seams.listing = listed(entries(['h', 'a.md'], ['h', 'b.md'], ['h', 'c.md']));
    const { reason } = declined();
    expect(reason).toContain('flags 3 file(s)');
    expect(reason).toContain('and 1 more');
  });

  it('declines when git fails the listing, quoting what git said', () => {
    seams.listing = { ok: false, status: 128, stdout: Buffer.alloc(0), stderr: 'fatal: index file corrupt' };
    const cause = declined();
    expect(cause.code).toBe(GIT_FAILED_CODE);
    expect(cause.reason).toContain('git said: fatal: index file corrupt');
  });

  it('declines a listing cut short (no closing NUL) as VAT\'s own reading, never as something git said', () => {
    seams.listing = listed(Buffer.from('H a.md'));
    const cause = declined();
    expect(cause.code).toBe(GIT_FAILED_CODE);
    expect(cause.reason).toContain('does not end in NUL');
    expect(cause.reason).not.toContain('git said');
  });

  it('declines a listing git did not finish with a remedy for the key, not for changed_files', () => {
    const overrun = Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ENOBUFS' });
    seams.listing = { ok: false, status: 1, stdout: Buffer.alloc(0), stderr: overrun.message, error: overrun };
    const cause = declined();
    expect(cause.code).toBe(GIT_FAILED_CODE);
    expect(cause.reason).not.toContain('changed_files');
    expect(cause.reason).toContain('git ls-files -v');
  });

  it('asks for the whole listing: the runner\'s own cap, never a smaller default', () => {
    seams.listing = listed(entries(['H', 'a.md']));
    gitTreeKey({ cwd: ROOT });
    expect(seams.args).toEqual([expect.objectContaining({ cwd: ROOT, maxBuffer: Number.MAX_SAFE_INTEGER })]);
  });
});
