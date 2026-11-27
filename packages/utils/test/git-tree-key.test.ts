/**
 * `gitTreeKey` over scripted flag listings: what each listing git can hand back makes of the key.
 * The snapshot and the listings are seams here, so a listing git would not write (cut short, failed,
 * a path that is not UTF-8) is driven exactly. The root does not exist, so every listed path is
 * absent from disk but one that is not UTF-8, which counts as present. The real repository cases
 * are in the integration suite.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as GitRunModule from '../src/git-run.js';
import type * as GitSnapshotModule from '../src/git-snapshot.js';

/** The flag listing's argv, and the sparse listing's. */
const FLAGS = 'ls-files -v -z';
const SPARSE = 'ls-files --sparse -s -z';

const seams = vi.hoisted(() => ({
  listings: new Map<string, GitRunModule.GitBytesRunResult>(),
  calls: [] as Array<{ args: string; options: unknown }>,
}));

vi.mock('../src/git-run.js', async (importOriginal) => {
  const actual = await importOriginal<typeof GitRunModule>();
  return {
    ...actual,
    runGitBytes: (args: readonly string[], options: unknown) => {
      const joined = args.join(' ');
      seams.calls.push({ args: joined, options });
      const listing = seams.listings.get(joined);
      if (listing === undefined) throw new Error(`unscripted git ${joined}`);
      return listing;
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
const { safePath } = await import('../src/path-utils.js');

/** A listing git wrote, exit 0. */
function listed(bytes: Uint8Array): GitRunModule.GitBytesRunResult {
  return { ok: true, status: 0, stdout: Buffer.from(bytes), stderr: '' };
}

/** `ls-files -v -z` entries: tag, space, path, NUL. */
function entries(...tagged: ReadonlyArray<readonly [string, Uint8Array | string]>): Uint8Array {
  return Buffer.concat(tagged.map(([tag, path]) => Buffer.concat([Buffer.from(`${tag} `), Buffer.from(path), Buffer.from([0])])));
}

/** `ls-files --sparse -s -z` records, one per `<mode> <oid> <stage>\t<path>`. */
function sparseListing(...records: string[]): Uint8Array {
  return Buffer.from(records.map((record) => `${record}\0`).join(''));
}

/** A path that is not UTF-8: it counts as present on disk. */
const NOT_UTF8 = Uint8Array.of(0xff, 0x2e, 0x6d, 0x64);

/** A sparse listing holding a collapsed directory, and one holding none. */
const COLLAPSED = sparseListing(`040000 ${'b'.repeat(40)} 0\tout/`);
const WHOLE = sparseListing(`100644 ${'c'.repeat(40)} 0\tin/a.md`);

/** Script the flag listing, and the sparse listing when one is asked. */
function script(flags: Uint8Array | GitRunModule.GitBytesRunResult, sparse?: Uint8Array | GitRunModule.GitBytesRunResult): void {
  const asResult = (bytes: Uint8Array | GitRunModule.GitBytesRunResult): GitRunModule.GitBytesRunResult =>
    (bytes instanceof Uint8Array ? listed(bytes) : bytes);
  seams.listings.set(FLAGS, asResult(flags));
  if (sparse !== undefined) seams.listings.set(SPARSE, asResult(sparse));
}

/** The key's cause, classified, or a failed test when the key was taken. */
function declined(): { code: string; reason: string } {
  const key = gitTreeKey({ cwd: ROOT });
  expect(key.ok, 'the key was taken').toBe(false);
  if (key.ok) throw new Error('unreachable');
  return gitSnapshotFailureOf(key);
}

afterEach(() => {
  seams.listings.clear();
  seams.calls = [];
});

describe('gitTreeKey over a scripted flag listing', () => {
  it('takes the key when no entry is flagged', () => {
    script(entries(['H', 'a.md'], ['H', 'b.md']));
    expect(gitTreeKey({ cwd: ROOT })).toMatchObject({ ok: true, hash: SNAPSHOT.hash });
  });

  it('keys an assume-unchanged entry under the snapshot\'s own hash, never asking about a sparse index', () => {
    script(entries(['h', 'a.md'], ['h', NOT_UTF8]));
    expect(gitTreeKey({ cwd: ROOT })).toMatchObject({ ok: true, hash: SNAPSHOT.hash, absent: new Set() });
    expect(seams.calls.map(({ args }) => args)).toStrictEqual([FLAGS]);
  });

  it.for(['S', 's'])('keys a skip-worktree entry with nothing on disk (tag `%s`), under a hash apart from the unflagged tree\'s', (tag) => {
    script(entries(['H', 'a.md'], [tag, 'gone.md']));
    const key = gitTreeKey({ cwd: ROOT });
    if (!key.ok) throw new Error(`declined: ${gitSnapshotFailureOf(key).reason}`);
    expect(key.hash).not.toBe(SNAPSHOT.hash);
    expect(key.absent).toStrictEqual(new Set([safePath.resolve(ROOT, 'gone.md')]));
    script(entries(['H', 'a.md'], [tag, 'other.md']));
    const other = gitTreeKey({ cwd: ROOT });
    expect(other.ok && other.hash, 'another absent set, another key').not.toBe(key.hash);
  });

  it('keys a skip-worktree entry on disk when the index holds no collapsed directory', () => {
    script(entries(['S', NOT_UTF8]), WHOLE);
    expect(gitTreeKey({ cwd: ROOT })).toMatchObject({ ok: true, hash: SNAPSHOT.hash });
    expect(seams.calls.map(({ args }) => args)).toStrictEqual([FLAGS, SPARSE]);
  });

  it('declines a skip-worktree entry on disk when a sparse index holds a directory collapsed, showing its path quoted once', () => {
    script(entries(['S', NOT_UTF8]), COLLAPSED);
    const { code, reason } = declined();
    expect(code).toBe(GIT_SNAPSHOT_INDEX_HIDES_CODE);
    expect(reason).toContain(String.raw`"\xff.md" (skip-worktree)`);
    expect(reason).not.toContain(String.raw`\"`);
  });

  it('names an entry carrying both flags (tag `s`) with both', () => {
    script(entries(['s', NOT_UTF8]), COLLAPSED);
    expect(declined().reason).toContain(String.raw`"\xff.md" (assume-unchanged and skip-worktree)`);
  });

  it('counts the hiding entries past the ones it names', () => {
    script(entries(['S', NOT_UTF8], ['S', Uint8Array.of(0xfe)], ['S', Uint8Array.of(0xfd)]), COLLAPSED);
    const { reason } = declined();
    expect(reason).toContain('3 file(s) flagged skip-worktree');
    expect(reason).toContain('and 1 more');
  });

  it('declines when git fails the flag listing, quoting what git said', () => {
    script({ ok: false, status: 128, stdout: Buffer.alloc(0), stderr: 'fatal: index file corrupt' });
    const cause = declined();
    expect(cause.code).toBe(GIT_FAILED_CODE);
    expect(cause.reason).toContain('git said: fatal: index file corrupt');
  });

  it('declines when git fails the sparse listing, naming that listing', () => {
    script(entries(['S', NOT_UTF8]), { ok: false, status: 129, stdout: Buffer.alloc(0), stderr: 'error: unknown option `sparse\'' });
    const cause = declined();
    expect(cause.code).toBe(GIT_FAILED_CODE);
    expect(cause.reason).toContain('git ls-files --sparse -s -z failed');
  });

  it.for([
    ['the flag listing', () => script(Buffer.from('H a.md'))],
    ['the sparse listing', () => script(entries(['S', NOT_UTF8]), Buffer.from(`040000 ${'b'.repeat(40)} 0\tout/`))],
  ] as const)('declines %s cut short (no closing NUL) as VAT\'s own reading, never as something git said', ([, scripted]) => {
    scripted();
    const cause = declined();
    expect(cause.code).toBe(GIT_FAILED_CODE);
    expect(cause.reason).toContain('does not end in NUL');
    expect(cause.reason).not.toContain('git said');
  });

  it('declines a listing git did not finish with a remedy for the key, not for changed_files', () => {
    const overrun = Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ENOBUFS' });
    script({ ok: false, status: 1, stdout: Buffer.alloc(0), stderr: overrun.message, error: overrun });
    const cause = declined();
    expect(cause.code).toBe(GIT_FAILED_CODE);
    expect(cause.reason).not.toContain('changed_files');
    expect(cause.reason).toContain('git ls-files -v');
  });

  it('asks for each whole listing: the runner\'s own cap, never a smaller default', () => {
    script(entries(['S', NOT_UTF8]), WHOLE);
    gitTreeKey({ cwd: ROOT });
    const whole = expect.objectContaining({ cwd: ROOT, maxBuffer: Number.MAX_SAFE_INTEGER });
    expect(seams.calls.map(({ options }) => options)).toStrictEqual([whole, whole]);
  });
});
