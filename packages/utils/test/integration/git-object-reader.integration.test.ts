/**
 * `openGitObjectReaders` against real repositories: one long-lived `git cat-file --batch` per
 * repository root, framed by byte count, so an object's bytes come back exactly as git stores them.
 */

import { writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isVatError } from '../../src/errors/vat-error.js';
import {
  GitObjectMissingError,
  GitObjectReadError,
  type GitObjectReaders,
  openGitObjectReaders,
} from '../../src/git-object-reader.js';
import { safePath } from '../../src/path-utils.js';
import { createTempDir, removeTempDir } from '../../src/testing/temp-dir.js';
import { readWorkCounters } from '../../src/work-counters.js';

import { git, initRepository } from './git-test-kit.js';

/** Write `bytes` into the repository's object store; its OID. */
function blobOf(root: string, name: string, bytes: Uint8Array): string {
  const path = safePath.join(root, name);
  writeFileSync(path, bytes);
  return git(root, 'hash-object', '-w', '--', name);
}

/** How much a counter moved while `work` ran. */
async function counted<T>(counter: 'git.calls' | 'content.gitRead', work: () => Promise<T>): Promise<{ value: T; count: number }> {
  const before = readWorkCounters()[counter];
  const value = await work();
  return { value, count: readWorkCounters()[counter] - before };
}

/** An OID of the right length that names nothing here. */
const ABSENT_SHA1 = 'f'.repeat(40);

/** Every repository a test made, removed after it. */
const dirs: string[] = [];

/** A fresh repository, removed after the test. */
function repository(format: 'sha1' | 'sha256' = 'sha1'): string {
  const dir = createTempDir('vat-object-reader-');
  dirs.push(dir);
  initRepository(dir, `--object-format=${format}`);
  return dir;
}

describe('openGitObjectReaders', () => {
  let readers: GitObjectReaders;

  beforeEach(() => {
    readers = openGitObjectReaders({});
    // Spend the once-per-process version probe (and this set's memo) here, so every test's
    // `git.calls` count is exact whether it runs alone or after the others.
    readers.guardsLazyFetch();
  });

  afterEach(async () => {
    await readers.close();
    for (const dir of dirs.splice(0)) removeTempDir(dir);
  });

  it('reads each object\'s exact bytes (NUL, CR, LF, bytes that are not UTF-8, empty), pipelined through one child', async () => {
    const root = repository();
    const bodies = [
      Buffer.from('line one\r\nline two\r\n'),
      Buffer.from([0x00, 0x0a, 0xff, 0xfe, 0x0d, 0x0a, 0x00]),
      Buffer.from(`${ABSENT_SHA1} blob 3\nabc\n`),
      Buffer.alloc(0),
      Buffer.alloc(3 * 1024 * 1024, 0x61),
    ];
    const oids = bodies.map((body, index) => blobOf(root, `f${String(index)}`, body));
    const read = await counted('git.calls', async () =>
      counted('content.gitRead', async () => Promise.all([...oids, oids[0] ?? ''].map(async (oid) => readers.read(root, oid)))));
    const expected = [...bodies, bodies[0] ?? Buffer.alloc(0)];
    expect(read.value.value.map((bytes, index) => Buffer.from(bytes).equals(expected[index] ?? Buffer.alloc(1)))).toStrictEqual(expected.map(() => true));
    expect(read.count, 'one child for the repository').toBe(1);
    expect(read.value.count, 'one count per object read').toBe(oids.length + 1);
  });

  it('reads a SHA-256 repository\'s objects', async () => {
    const root = repository('sha256');
    const oid = blobOf(root, 'a.md', Buffer.from('sha256 bytes\n'));
    expect(oid).toHaveLength(64);
    expect(Buffer.from(await readers.read(root, oid)).toString()).toBe('sha256 bytes\n');
  });

  it('reads the object its name names, never a replace ref\'s replacement, and sizes it so', async () => {
    const root = repository();
    const real = blobOf(root, 'real.md', Buffer.from('real\n'));
    const replacement = blobOf(root, 'evil.md', Buffer.from('replacement bytes\n'));
    git(root, 'replace', real, replacement);
    expect(git(root, 'cat-file', '-p', real), 'the control: git honours the replace ref by default').toBe('replacement bytes');
    expect(Buffer.from(await readers.read(root, real)).toString()).toBe('real\n');
    expect((await readers.sizes(root, [real])).get(real)).toBe(5);
  });

  it('rejects a missing object alone, as GitObjectMissingError, and keeps reading through the same child', async () => {
    const root = repository();
    const oid = blobOf(root, 'a.md', Buffer.from('kept\n'));
    const { value, count } = await counted('git.calls', async () => Promise.allSettled([
      readers.read(root, ABSENT_SHA1),
      readers.read(root, oid),
    ]));
    const [missing, present] = value;
    expect(missing?.status === 'rejected' && isVatError(missing.reason, GitObjectMissingError.code)).toBe(true);
    expect(present?.status === 'fulfilled' && Buffer.from(present.value).toString()).toBe('kept\n');
    expect(count).toBe(1);
  });

  it.for(['abc', 'F'.repeat(40), `${'a'.repeat(40)}\n${'b'.repeat(40)}`, 'a'.repeat(41)])(
    'rejects an object name that is not a whole lowercase OID (%j) as VAT\'s own fault, starting no git',
    async (oid) => {
      const root = repository();
      const { value, count } = await counted('git.calls', async () => readers.read(root, oid).then(() => undefined, (error: unknown) => error));
      expect(value).toBeInstanceOf(Error);
      expect(isVatError(value)).toBe(false);
      expect(count).toBe(0);
    },
  );

  it('rejects a non-blob object as VAT\'s own fault', async () => {
    const root = repository();
    blobOf(root, 'a.md', Buffer.from('a\n'));
    git(root, 'add', '-A');
    const tree = git(root, 'write-tree');
    const refused = await readers.read(root, tree).then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(Error);
    expect(isVatError(refused)).toBe(false);
  });

  it('rejects every pending read when closed, and close() resolves once the child has exited', async () => {
    const root = repository();
    const oid = blobOf(root, 'big', Buffer.alloc(8 * 1024 * 1024, 0x62));
    const pending = Array.from({ length: 8 }, async () => readers.read(root, oid).then(() => 'read', (error: unknown) => error));
    await readers.close();
    const settled = await Promise.all(pending);
    expect(settled.some((outcome) => isVatError(outcome, GitObjectReadError.code)), 'a read cut off by close').toBe(true);
    expect(settled.every((outcome) => outcome === 'read' || isVatError(outcome, GitObjectReadError.code))).toBe(true);
    const after = await readers.read(root, oid).then(() => undefined, (error: unknown) => error);
    expect(isVatError(after, GitObjectReadError.code), 'a closed set reads nothing').toBe(true);
  });

  it('closes on its abort signal', async () => {
    const root = repository();
    const oid = blobOf(root, 'a.md', Buffer.from('a\n'));
    const controller = new AbortController();
    const aborted = openGitObjectReaders({ signal: controller.signal });
    await aborted.read(root, oid);
    controller.abort();
    const after = await aborted.read(root, oid).then(() => undefined, (error: unknown) => error);
    expect(isVatError(after, GitObjectReadError.code)).toBe(true);
    await aborted.close();
  });

  it('keeps at most four children live, retiring the least recently used', async () => {
    const roots = Array.from({ length: 5 }, () => repository());
    const oids = roots.map((root) => blobOf(root, 'a.md', Buffer.from(root)));
    const first = await counted('git.calls', async () => {
      for (const [index, root] of roots.entries()) expect(Buffer.from(await readers.read(root, oids[index] ?? '')).toString()).toBe(root);
    });
    expect(first.count).toBe(5);
    const again = await counted('git.calls', async () => readers.read(roots[4] ?? '', oids[4] ?? ''));
    expect(again.count, 'the most recent child is still live').toBe(0);
    const retired = await counted('git.calls', async () => readers.read(roots[0] ?? '', oids[0] ?? ''));
    expect(retired.count, 'the least recently used child was retired').toBe(1);
  });

  it('sizes objects through one batch-check, leaving a missing one out', async () => {
    const root = repository();
    const oids = [blobOf(root, 'a', Buffer.from('12345')), blobOf(root, 'b', Buffer.alloc(0))];
    const { value, count } = await counted('git.calls', async () => readers.sizes(root, [...oids, ABSENT_SHA1]));
    expect(count).toBe(1);
    expect([...value]).toStrictEqual([[oids[0], 5], [oids[1], 0]]);
  });

  it.for([
    [[2, 44], false],
    [[2, 45], true],
    [[3, 0], true],
  ] as const)('guards lazy fetches with --no-lazy-fetch only from git 2.45 (%j: %s), and reads either way', async ([gitVersion, guards]) => {
    const root = repository();
    const oid = blobOf(root, 'a.md', Buffer.from('a\n'));
    const versioned = openGitObjectReaders({ gitVersion });
    try {
      expect(versioned.guardsLazyFetch()).toBe(guards);
      expect(Buffer.from(await versioned.read(root, oid)).toString()).toBe('a\n');
      expect((await versioned.sizes(root, [oid])).get(oid)).toBe(2);
    } finally {
      await versioned.close();
    }
  });

  it('asks this git its version when none is given, and agrees with it', () => {
    const [major, minor] = git(process.cwd(), '--version').replace(/^git version /, '').split('.').map(Number);
    const installed = (major ?? 0) > 2 || ((major ?? 0) === 2 && (minor ?? 0) >= 45);
    expect(readers.guardsLazyFetch()).toBe(installed);
  });
});
