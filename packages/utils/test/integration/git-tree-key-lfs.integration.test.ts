/**
 * `gitTreeKey` over a repository whose files go through an LFS filter.
 *
 * Under `filter=lfs` the index holds a POINTER blob, so a file's own bytes never reach the tree
 * hash: the same tree hash describes the file pulled (its content on disk) and not pulled (its
 * pointer on disk). The key tells the two apart from each pointer's declared size and the file's
 * size on disk, and declines a tree where the sizes cannot tell (the content is exactly the
 * pointer's length, or the pointer was checked out CRLF).
 *
 * The filter is an emulated clean/smudge pair (`test/fixtures/lfs-filter.mjs`), never a machine's
 * git-lfs: git runs under a home inside the fixture with no system config. Every fixture file is
 * backdated before each commit, refresh and emulated pull, so no index entry is racily clean and a
 * stat-clean entry is clean by stat, not by the clock.
 */

import { createHash } from 'node:crypto';
import type * as Fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GIT_FAILED_CODE, GIT_SNAPSHOT_INDEX_HIDES_CODE, GIT_SNAPSHOT_UNREADABLE_CODE, gitSnapshotFailureOf } from '../../src/git-no-answer.js';
import type * as GitRunModule from '../../src/git-run.js';
import { gitTreeSnapshot } from '../../src/git-snapshot.js';
import { gitTreeKey } from '../../src/git-tree-key.js';
import { normalizedTmpdir, resolveFromImportMeta, safePath } from '../../src/path-utils.js';
import { createLfsFixtureRepo, type LfsFixtureRepo, lfsPointerOf } from '../../src/testing/lfs-fixture.js';

/**
 * Every `runGitBytes` spawn's args, the one subcommand made to fail, if any, and the answers
 * rewritten by their command (`check-attr`, `cat-file --batch-check`, `cat-file --batch`).
 */
const spawns = vi.hoisted(() => ({
  args: [] as string[][],
  failing: undefined as string | undefined,
  rewritten: new Map<string, string>(),
}));

/** The absolute paths whose `lstat` or read the filesystem refuses (`EACCES`). */
const refused = vi.hoisted(() => ({ lstat: new Set<string>(), read: new Set<string>() }));

vi.mock('../../src/git-run.js', async (importOriginal) => {
  const actual = await importOriginal<typeof GitRunModule>();
  return {
    ...actual,
    runGitBytes: (args: readonly string[], options: GitRunModule.GitRunOptions) => {
      spawns.args.push([...args]);
      if (spawns.failing !== undefined && args[0] === spawns.failing) {
        return { ok: false, status: 128, stdout: Buffer.alloc(0), stderr: `fatal: ${spawns.failing} refused` };
      }
      const result = actual.runGitBytes(args, options);
      const rewrite = spawns.rewritten.get(args.slice(0, 2).join(' ')) ?? spawns.rewritten.get(args[0] ?? '');
      return rewrite === undefined || !result.ok ? result : { ...result, stdout: Buffer.from(rewrite) };
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  const eacces = (path: unknown): Error => Object.assign(new Error(`EACCES: permission denied, '${String(path)}'`), { code: 'EACCES', path });
  return {
    ...actual,
    lstatSync: ((...args: Parameters<typeof Fs.lstatSync>) => {
      if (refused.lstat.has(String(args[0]))) throw eacces(args[0]);
      return actual.lstatSync(...args);
    }) as typeof Fs.lstatSync,
    readFileSync: ((...args: Parameters<typeof Fs.readFileSync>) => {
      if (refused.read.has(String(args[0]))) throw eacces(args[0]);
      return actual.readFileSync(...args);
    }) as typeof Fs.readFileSync,
  };
});

const FILTER_SCRIPT = resolveFromImportMeta(import.meta.url, '../fixtures/lfs-filter.mjs');

/** 3,000 bytes: a pointer is 129, so the sizes tell pulled from not pulled. */
const CONTENT = 'lfs content '.repeat(250);

let dir: string;
let fixture: LfsFixtureRepo;
let repo: string;

const git = (...args: string[]): void => fixture.git(...args);
const backdate = (...relatives: string[]): void => fixture.backdate(...relatives);
const writeAndRefresh = (relative: string, content: string): void => fixture.writeAndRefresh(relative, content);
const configureFilter = (): void => fixture.configureFilter();
const commit = (files: Readonly<Record<string, string>>): void => fixture.commit(files);
const pointerOf = lfsPointerOf;

const V1 = 'version https://git-lfs.github.com/spec/v1';
const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const HEX_C = 'c'.repeat(64);

/** Commit `text` as `small.bin` raw, then `filter=lfs` over it: the blob is `text` byte for byte. */
function commitRawUnderLfs(text: string): void {
  configureFilter();
  commit({ 'small.bin': text });
  commit({ '.gitattributes': 'small.bin filter=lfs -text\n' });
  expect(readFileSync(safePath.join(repo, 'small.bin'), 'utf8'), 'premise: committed raw').toBe(text);
}

/** The key, or a failed test naming why it declined. */
function keyed(): Extract<ReturnType<typeof gitTreeKey>, { ok: true }> {
  const key = gitTreeKey({ cwd: repo });
  if (!key.ok) throw new Error(`declined: ${gitSnapshotFailureOf(key).reason}`);
  return key;
}

/** The declined key's cause, as the one classifier states it. */
function declined(): { code: string; reason: string } {
  const key = gitTreeKey({ cwd: repo });
  if (key.ok) throw new Error('the key was taken');
  return gitSnapshotFailureOf(key);
}

/** The snapshot's own hash, unsuffixed. */
function snapshotHash(): string {
  const snapshot = gitTreeSnapshot({ cwd: repo });
  if (!snapshot.ok) throw new Error('no snapshot');
  return snapshot.hash;
}

beforeEach(() => {
  dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-tree-key-lfs-'));
  fixture = createLfsFixtureRepo({ dir, filterScript: FILTER_SCRIPT });
  repo = fixture.repo;
  for (const [name, value] of Object.entries(fixture.env)) vi.stubEnv(name, value);
  spawns.args = [];
  spawns.failing = undefined;
  spawns.rewritten.clear();
  refused.lstat.clear();
  refused.read.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** The key's decline when the OS refused VAT a look at `big.bin`: unreadable, naming the file and the errno. */
function refusedFileCause(): ReturnType<typeof gitSnapshotFailureOf> {
  const key = gitTreeKey({ cwd: repo });
  if (key.ok) throw new Error('the key was taken');
  expect(key.kind).toBe('lfs-file-unread');
  const cause = gitSnapshotFailureOf(key);
  expect(cause.code).toBe(GIT_SNAPSHOT_UNREADABLE_CODE);
  expect(cause.reason).toContain('big.bin');
  expect(cause.reason).toContain('EACCES');
  return cause;
}

describe('gitTreeKey over LFS pointers', () => {
  beforeEach(() => {
    configureFilter();
    commit({ '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n', 'big.bin': CONTENT, 'plain.md': 'plain\n' });
  });

  it('keys a file pulled apart from the same file not pulled, though the tree hash is one', () => {
    writeAndRefresh('big.bin', pointerOf(CONTENT));
    const notPulled = keyed();
    const notPulledTree = snapshotHash();
    writeAndRefresh('big.bin', CONTENT);
    const pulled = keyed();
    expect(snapshotHash(), 'premise: the pointer, and so the tree, does not move').toBe(notPulledTree);
    expect(pulled.hash).not.toBe(notPulled.hash);
    expect(notPulled.lfs.pointers).toEqual([expect.objectContaining({ absolutePath: safePath.join(repo, 'big.bin'), pulled: false })]);
    expect(pulled.lfs.pointers).toEqual([expect.objectContaining({ pulled: true })]);
    expect(pulled.lfs.filter).toBe('configured');
  });

  it('names the pointer\'s LFS oid: the sha256 of the content', () => {
    expect(keyed().lfs.pointers[0]?.lfsOid).toBe(createHash('sha256').update(CONTENT).digest('hex'));
  });

  it('keys content exactly as long as its pointer apart from that pointer, by its bytes', () => {
    // 128 bytes declare `size 128`, and that pointer is 128 bytes too: only the bytes tell.
    const exact = 'x'.repeat(128);
    expect(Buffer.byteLength(pointerOf(exact)), 'premise').toBe(128);
    writeAndRefresh('big.bin', pointerOf(exact));
    const notPulled = keyed();
    writeAndRefresh('big.bin', exact);
    const pulled = keyed();
    expect(notPulled.lfs.pointers).toEqual([expect.objectContaining({ pulled: false })]);
    expect(pulled.lfs.pointers).toEqual([expect.objectContaining({ pulled: true })]);
    expect(pulled.hash).not.toBe(notPulled.hash);
  });

  it('declines content exactly as long as its pointer when its bytes cannot be read, naming no pull as the remedy', () => {
    writeAndRefresh('big.bin', 'x'.repeat(128));
    refused.read.add(safePath.join(repo, 'big.bin'));
    const cause = refusedFileCause();
    expect(cause.reason).not.toContain('git lfs pull');
  });

  it('declines, never throws, when the OS refuses to lstat a pointer\'s file', () => {
    refused.lstat.add(safePath.join(repo, 'big.bin'));
    refusedFileCause();
  });

  it.for(['check-attr', 'cat-file --batch-check', 'cat-file --batch'])(
    'declines as unreadable when git %s answers for none of the objects it was asked about',
    (command) => {
      spawns.rewritten.set(command, '');
      const key = gitTreeKey({ cwd: repo });
      if (key.ok) throw new Error(`the key was taken: ${JSON.stringify(key.lfs)}`);
      expect(key.kind).toBe('lfs-unreadable');
      expect(gitSnapshotFailureOf(key).code).toBe(GIT_FAILED_CODE);
    },
  );

  it('keys the pulled file without the filter configured as it keys it with, and says the filter is absent', () => {
    const withFilter = keyed();
    git('config', '--remove-section', 'filter.lfs');
    const without = keyed();
    expect(without.hash).toBe(withFilter.hash);
    expect(withFilter.lfs.filter).toBe('configured');
    expect(without.lfs.filter).toBe('not-configured');
  });

  it('moves the tree hash itself for a pulled file touched without the filter: git hashes the content', () => {
    const tree = snapshotHash();
    const withFilter = keyed();
    git('config', '--remove-section', 'filter.lfs');
    backdate('big.bin');
    expect(snapshotHash()).not.toBe(tree);
    const touched = keyed();
    expect(touched.hash).not.toBe(withFilter.hash);
    expect(touched.lfs.pointers, 'the raw content is no pointer').toEqual([]);
    expect(touched.lfs.filter, 'with no pointer, the filter is never asked about').toBe('not-asked');
  });

  it.for(['check-attr', 'cat-file', 'config'])('declines when git %s fails, as a listing git would not give', (failing) => {
    spawns.failing = failing;
    const key = gitTreeKey({ cwd: repo });
    if (key.ok) throw new Error('the key was taken');
    expect(key.kind).toBe('lfs-unlisted');
    const cause = gitSnapshotFailureOf(key);
    expect(cause.code).toBe(GIT_FAILED_CODE);
    expect(cause.reason).toContain(`fatal: ${failing} refused`);
  });
});

describe('gitTreeKey over files filter=lfs names that are not pointers', () => {
  it('keys a large blob committed before its attribute as an ordinary file, reading only its size', () => {
    configureFilter();
    commit({ 'big.bin': 'r'.repeat(300 * 1024) });
    commit({ '.gitattributes': 'big.bin filter=lfs -text\n' });
    spawns.args = [];
    const key = keyed();
    expect(key.hash).toBe(snapshotHash());
    expect(key.lfs.pointers).toEqual([]);
    expect(spawns.args.filter((args) => args[0] === 'cat-file').map((args) => args[1])).toEqual(['--batch-check']);
  });

  it.for([
    ['an oid that is not hex', `${V1}\noid sha256:not-hex\nsize 3000\n`],
    ['two extensions of one priority', `${V1}\next-0-a sha256:${HEX_A}\next-0-b sha256:${HEX_B}\noid sha256:${HEX_C}\nsize 3000\n`],
    ['a line past size', `${V1}\noid sha256:${HEX_C}\nsize 3000\nextra line\n`],
  ])('declines a small blob that opens with a pointer\'s version line but is no pointer: %s', ([, malformed]) => {
    commitRawUnderLfs(malformed ?? '');
    const key = gitTreeKey({ cwd: repo });
    if (key.ok) throw new Error('the key was taken');
    expect(key.kind).toBe('lfs-malformed');
    const cause = gitSnapshotFailureOf(key);
    expect(cause.code).toBe(GIT_SNAPSHOT_INDEX_HIDES_CODE);
    expect(cause.reason).toContain('small.bin');
    expect(cause.reason).not.toContain('git lfs pull');
  });

  it('keys a small blob with no pointer version line as an ordinary file', () => {
    commitRawUnderLfs('just some small text\n');
    const key = keyed();
    expect(key.hash).toBe(snapshotHash());
    expect(key.lfs.pointers).toEqual([]);
  });
});

describe('gitTreeKey over pointers git-lfs reads beyond the canonical three lines', () => {
  it.for([
    ['an ext- extension line', `${V1}\next-0-foo sha256:${HEX_A}\noid sha256:${HEX_C}\nsize 3000\n`],
    ['two ext- lines, by priority', `${V1}\next-0-foo sha256:${HEX_A}\next-1-bar sha256:${HEX_B}\noid sha256:${HEX_C}\nsize 3000\n`],
    ['the pre-release hawser version', `version https://hawser.github.com/spec/v1\noid sha256:${HEX_C}\nsize 3000\n`],
    ['the alpha git-media version', `version http://git-media.io/v/2\noid sha256:${HEX_C}\nsize 3000\n`],
  ])('reads %s as a pointer, not an ordinary file', ([, pointer]) => {
    commitRawUnderLfs(pointer ?? '');
    const key = keyed();
    expect(key.lfs.pointers).toEqual([{ absolutePath: safePath.join(repo, 'small.bin'), lfsOid: HEX_C, pulled: false }]);
    expect(key.hash).not.toBe(snapshotHash());
  });
});

describe('gitTreeKey over an LFS pointer checked out CRLF', () => {
  it('declines a pointer core.autocrlf checked out with CRLF: its size is neither the pointer\'s nor the content\'s', () => {
    git('config', 'core.autocrlf', 'true');
    configureFilter();
    commit({ '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs\n', 'big.bin': CONTENT });
    rmSync(safePath.join(repo, 'big.bin'));
    git('checkout', '--', 'big.bin');
    expect(readFileSync(safePath.join(repo, 'big.bin'), 'utf8'), 'premise: the pointer, CRLF').toBe(pointerOf(CONTENT).replaceAll('\n', '\r\n'));
    backdate('big.bin');
    git('update-index', '-q', '--refresh');
    const cause = declined();
    expect(cause.code).toBe(GIT_SNAPSHOT_INDEX_HIDES_CODE);
    expect(cause.reason).toContain('big.bin');
  });
});
