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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GIT_FAILED_CODE, GIT_SNAPSHOT_INDEX_HIDES_CODE, gitSnapshotFailureOf } from '../../src/git-no-answer.js';
import type * as GitRunModule from '../../src/git-run.js';
import { gitTreeSnapshot } from '../../src/git-snapshot.js';
import { gitTreeKey } from '../../src/git-tree-key.js';
import { normalizedTmpdir, resolveFromImportMeta, safePath } from '../../src/path-utils.js';
import { createLfsFixtureRepo, type LfsFixtureRepo, lfsPointerOf } from '../../src/testing/lfs-fixture.js';

/** Every `runGitBytes` spawn's args, and the one subcommand made to fail, if any. */
const spawns = vi.hoisted(() => ({ args: [] as string[][], failing: undefined as string | undefined }));

vi.mock('../../src/git-run.js', async (importOriginal) => {
  const actual = await importOriginal<typeof GitRunModule>();
  return {
    ...actual,
    runGitBytes: (args: readonly string[], options: GitRunModule.GitRunOptions) => {
      spawns.args.push([...args]);
      if (spawns.failing !== undefined && args[0] === spawns.failing) {
        return { ok: false, status: 128, stdout: Buffer.alloc(0), stderr: `fatal: ${spawns.failing} refused` };
      }
      return actual.runGitBytes(args, options);
    },
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
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

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
    expect(pulled.lfs.filterConfigured).toBe(true);
  });

  it('names the pointer\'s LFS oid: the sha256 of the content', () => {
    expect(keyed().lfs.pointers[0]?.lfsOid).toBe(createHash('sha256').update(CONTENT).digest('hex'));
  });

  it('declines a file whose content is exactly its pointer\'s length: its size cannot tell pulled from not', () => {
    // 128 bytes declare `size 128`, and that pointer is 128 bytes too.
    const exact = 'x'.repeat(128);
    expect(Buffer.byteLength(pointerOf(exact)), 'premise').toBe(128);
    writeAndRefresh('big.bin', exact);
    const cause = declined();
    expect(cause.code).toBe(GIT_SNAPSHOT_INDEX_HIDES_CODE);
    expect(cause.reason).toContain('big.bin');
    expect(cause.reason).toContain('git lfs pull');
  });

  it('keys the pulled file without the filter configured as it keys it with, and says the filter is absent', () => {
    const withFilter = keyed();
    git('config', '--remove-section', 'filter.lfs');
    const without = keyed();
    expect(without.hash).toBe(withFilter.hash);
    expect(withFilter.lfs.filterConfigured).toBe(true);
    expect(without.lfs.filterConfigured).toBe(false);
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

  it('keys a small blob that is not a well-formed pointer as an ordinary file', () => {
    configureFilter();
    const malformed = 'version https://git-lfs.github.com/spec/v1\noid sha256:not-hex\nsize 3000\n';
    commit({ 'small.bin': malformed });
    commit({ '.gitattributes': 'small.bin filter=lfs -text\n' });
    expect(readFileSync(safePath.join(repo, 'small.bin'), 'utf8'), 'premise: committed raw').toBe(malformed);
    const key = keyed();
    expect(key.hash).toBe(snapshotHash());
    expect(key.lfs.pointers).toEqual([]);
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
