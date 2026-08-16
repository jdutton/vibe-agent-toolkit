/**
 * Subject resolution is where a moving ref becomes a pinned coordinate, so
 * these tests pin the things that would each silently corrupt every report
 * downstream:
 *
 * 1. **A git subject resolves to a concrete SHA**, never a branch name. A
 *    coordinate carrying `main` claims a pin it does not have.
 * 2. **Every fingerprint is a real hash.** Asserting only that two runs agree
 *    cannot tell a hash from `return 'constant'`, so every stability assertion
 *    here is paired with a sensitivity assertion on the same fixture — one that
 *    changes a single content byte, and (for snapshots) one that moves a file
 *    without changing any. Both directions, for the snapshot fingerprint and
 *    for the working fingerprint alike.
 * 3. **A dirty tree is measured and labelled, never refused and never silently
 *    stamped with its HEAD alone.** The dirty assertions sit beside a positive
 *    control on the *same* fixture — the identical repo, clean — so a `dirty`
 *    that is simply always true cannot pass.
 * 4. **The resolved version satisfies `SubjectVersionSchema`.** The schema is
 *    the contract now, and its `superRefine` carries the dirty ⇔
 *    workingFingerprint pairing, so parsing the real output is the cheapest way
 *    to keep this module honest about it.
 * 5. **An unborn HEAD is a snapshot, not a commit.** `git init` with nothing
 *    committed is a git repository whose HEAD does not resolve; the fixtures
 *    below deliberately include both a committed and an uncommitted repo,
 *    because a repo fixture with no commits behaves nothing like one with them.
 */

import { rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { mkdirSyncReal, runGitOrThrow, safePath, setupSyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type SubjectVersion, SubjectVersionSchema } from '../src/envelope/coordinate.js';
import { resolveSubject } from '../src/harness/subject.js';
import type { ResolvedSubject } from '../src/harness/types.js';

/** Pinned so the assertion does not depend on the host's `init.defaultBranch`. */
const FIXTURE_BRANCH = 'lab-fixture';

/**
 * Identity and signing forced per-invocation, because a fixture repo inherits
 * the host's global git config and a machine with no `user.email` — or with
 * `commit.gpgsign=true` and no key — would otherwise fail to commit at all.
 */
const COMMIT_CONFIG = [
  '-c',
  'user.name=Lab Fixture',
  '-c',
  'user.email=lab@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

const TRACKED_FILE = 'docs/tracked.md';
const NESTED_FILE = 'nested/b.txt';
/** Lives outside the subject subtree, inside the repository. */
const OUTSIDE_FILE = 'outside.md';
/** Gitignored, so git's population cannot see it but a filesystem walk can. */
const IGNORED_FILE = 'build-cache';
const CONCRETE_SHA = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const suite = setupSyncTempDirSuite('lab-subject');

/**
 * Run a git command in a fixture repo, throwing on any failure.
 *
 * Fixtures must fail loudly: a silently failed `git commit` would leave an
 * unborn HEAD and turn a git-case test into a snapshot-case test that still
 * passes some other assertion.
 *
 * @param args - Arguments after the `git` executable
 * @param cwd - Fixture directory to run in
 */
function git(args: readonly string[], cwd: string): void {
  runGitOrThrow([...args], { cwd, stdio: 'pipe' });
}

/**
 * Write a file inside a fixture, creating parent directories.
 *
 * @param root - Fixture root
 * @param relativePath - Forward-slash path under the root
 * @param content - File content
 */
function writeFixtureFile(root: string, relativePath: string, content: string): void {
  const absolute = safePath.join(root, relativePath);
  mkdirSyncReal(dirname(absolute), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture path built from this suite's temp dir
  writeFileSync(absolute, content, 'utf8');
}

/**
 * Delete a file inside a fixture.
 *
 * @param root - Fixture root
 * @param relativePath - Forward-slash path under the root
 */
function removeFixtureFile(root: string, relativePath: string): void {
  rmSync(safePath.join(root, relativePath), { force: true });
}

/**
 * `git init` on a known branch, with nothing committed yet.
 *
 * `symbolic-ref` rather than `git init -b`, so the branch is pinned on every
 * git version rather than only those new enough for the flag.
 *
 * @param root - Fixture root
 */
function initRepo(root: string): void {
  git(['init', '--quiet'], root);
  git(['symbolic-ref', 'HEAD', `refs/heads/${FIXTURE_BRANCH}`], root);
}

/**
 * Stage everything present and commit it.
 *
 * @param root - Fixture root
 * @param message - Commit message
 */
function commitAll(root: string, message: string): void {
  git(['add', '--all'], root);
  git([...COMMIT_CONFIG, 'commit', '--no-verify', '--quiet', '-m', message], root);
}

/**
 * A repository with exactly one commit — the only fixture shape that can yield
 * a `git` version at all.
 *
 * @param root - Fixture root
 */
function committedRepo(root: string): void {
  initRepo(root);
  writeFixtureFile(root, TRACKED_FILE, 'first\n');
  commitAll(root, 'initial');
}

/**
 * A committed repository that gitignores {@link IGNORED_FILE}.
 *
 * The `.gitignore` is itself committed, so the repo is clean afterwards and any
 * dirtiness a test observes is dirtiness that test created.
 *
 * @param root - Fixture root
 */
function ignoringRepo(root: string): void {
  committedRepo(root);
  writeFixtureFile(root, '.gitignore', `${IGNORED_FILE}\n`);
  commitAll(root, 'ignore');
}

/**
 * Resolve a fixture directory as a subject.
 *
 * @param path - Path to resolve
 * @returns The resolved subject
 */
async function resolve(path: string): Promise<ResolvedSubject> {
  return resolveSubject({ id: 'fixture-subject', path });
}

/**
 * The resolved version, asserted to satisfy the schema on the way past.
 *
 * Every case routes through here, so the dirty ⇔ workingFingerprint pairing is
 * checked against real output on every fixture rather than in one test that a
 * later change could route around.
 *
 * @param path - Folder to resolve
 * @returns The pinned version
 */
async function versionOf(path: string): Promise<SubjectVersion> {
  const { version } = await resolve(path);
  expect(SubjectVersionSchema.safeParse(version).success).toBe(true);
  return version;
}

/**
 * The git version of a working tree, failing loudly if it resolved otherwise.
 *
 * @param path - Folder to resolve
 * @returns The git version
 */
async function gitVersionOf(path: string): Promise<Extract<SubjectVersion, { kind: 'git' }>> {
  const version = await versionOf(path);
  if (version.kind !== 'git') throw new Error(`expected a git version, got ${version.kind}`);
  return version;
}

/**
 * The working fingerprint of a dirty tree, failing loudly if it is clean.
 *
 * @param path - Folder to resolve
 * @returns The non-null working fingerprint
 */
async function workingFingerprintOf(path: string): Promise<string> {
  const version = await gitVersionOf(path);
  if (version.workingFingerprint === null) throw new Error('expected a dirty tree');
  return version.workingFingerprint;
}

/**
 * The snapshot of a folder, failing loudly if it resolved as git instead.
 *
 * @param path - Folder to resolve
 * @returns Fingerprint and file count
 */
async function snapshotOf(path: string): Promise<{ fingerprint: string; fileCount: number }> {
  const version = await versionOf(path);
  if (version.kind !== 'snapshot') throw new Error(`expected a snapshot, got ${version.kind}`);
  return { fingerprint: version.fingerprint, fileCount: version.fileCount };
}

beforeAll(suite.beforeAll);
afterAll(suite.afterAll);
beforeEach(suite.beforeEach);

describe('resolveSubject — git subjects', () => {
  it('pins a committed checkout to a concrete commit, never a branch name', async () => {
    const root = suite.getTempDir();
    committedRepo(root);

    const version = await gitVersionOf(root);

    expect(version.commit).toMatch(CONCRETE_SHA);
    expect(version.commit).not.toBe(FIXTURE_BRANCH);
  });

  it('records the branch HEAD was resolved from', async () => {
    const root = suite.getTempDir();
    committedRepo(root);

    const version = await gitVersionOf(root);

    expect(version.ref).toBe(FIXTURE_BRANCH);
  });

  it('records a null ref when HEAD is detached', async () => {
    const root = suite.getTempDir();
    committedRepo(root);
    git(['checkout', '--quiet', '--detach'], root);

    const version = await gitVersionOf(root);

    // The commit must survive detaching — only the ref becomes unknown.
    expect(version.commit).toMatch(CONCRETE_SHA);
    expect(version.ref).toBeNull();
  });

  it('reports a repository with an unborn HEAD as a snapshot, not a commit', async () => {
    // The trap this fixture exists for: `git init` alone IS a git repository,
    // but has no commit to pin to. It must take the snapshot route — and the
    // file count proves `.git/` (a dozen-plus files: config, HEAD, hook
    // samples) stayed outside the fingerprint's scope.
    const root = suite.getTempDir();
    initRepo(root);
    writeFixtureFile(root, TRACKED_FILE, 'first\n');
    writeFixtureFile(root, 'notes.txt', 'second\n');

    const snapshot = await snapshotOf(root);

    expect(snapshot.fileCount).toBe(2);
    expect(snapshot.fingerprint).toMatch(SHA256_HEX);
  });
});

describe('resolveSubject — a dirty working tree is measured and labelled', () => {
  it('marks a clean tree clean, and gives it no working fingerprint', async () => {
    // The positive control for every dirty assertion below: same fixture, same
    // shape. Without it, a `dirty` hardcoded to true would pass them all.
    const root = suite.getTempDir();
    committedRepo(root);

    const version = await gitVersionOf(root);

    expect(version.dirty).toBe(false);
    expect(version.workingFingerprint).toBeNull();
  });

  it('resolves a modified tree rather than throwing, keeping the real HEAD commit', async () => {
    const root = suite.getTempDir();
    committedRepo(root);
    const clean = await gitVersionOf(root);

    writeFixtureFile(root, TRACKED_FILE, 'edited\n');
    const dirty = await gitVersionOf(root);

    // The commit must be unchanged and still concrete — dirtiness qualifies the
    // commit, it does not replace or decorate it.
    expect(dirty.commit).toBe(clean.commit);
    expect(dirty.commit).toMatch(CONCRETE_SHA);
    expect(dirty.ref).toBe(FIXTURE_BRANCH);
    expect(dirty.dirty).toBe(true);
    expect(dirty.workingFingerprint).toMatch(SHA256_HEX);
  });

  it('counts an untracked file as dirty', async () => {
    // Untracked-but-not-ignored content is still content the instrument reads,
    // so a measurement that saw it is not reproducible from HEAD either.
    const root = suite.getTempDir();
    committedRepo(root);
    writeFixtureFile(root, 'stray.md', 'not committed\n');

    const version = await gitVersionOf(root);

    expect(version.dirty).toBe(true);
    expect(version.workingFingerprint).toMatch(SHA256_HEX);
  });

  it('does not count a gitignored file as dirty', async () => {
    const root = suite.getTempDir();
    ignoringRepo(root);

    writeFixtureFile(root, IGNORED_FILE, 'generated\n');
    const version = await gitVersionOf(root);

    expect(version.dirty).toBe(false);
    expect(version.workingFingerprint).toBeNull();
  });

  it('holds the working fingerprint still when only a gitignored file changes', async () => {
    // The population-coherence check, and the ONLY fixture that can make it.
    // The test above cannot: with nothing else dirty, no fingerprint is
    // computed at all, so it passes whichever population the fingerprint uses.
    // Here the tree is *already* dirty for an unrelated reason, so a fingerprint
    // exists both times and the ignored file is the only thing that moves. A
    // filesystem walk would report a moved subject that `dirty` — computed from
    // git's population — insists did not move.
    const root = suite.getTempDir();
    ignoringRepo(root);
    writeFixtureFile(root, TRACKED_FILE, 'edited\n');
    writeFixtureFile(root, IGNORED_FILE, 'generated\n');
    const before = await workingFingerprintOf(root);

    writeFixtureFile(root, IGNORED_FILE, 'REGENERATED, and much longer than before\n');
    const after = await workingFingerprintOf(root);

    expect(after).toBe(before);
  });

  it('returns the same working fingerprint for two runs over an unchanged dirty tree', async () => {
    const root = suite.getTempDir();
    committedRepo(root);
    writeFixtureFile(root, TRACKED_FILE, 'edited\n');

    const first = await workingFingerprintOf(root);
    const second = await workingFingerprintOf(root);

    expect(second).toBe(first);
  });

  it('changes the working fingerprint when one content byte changes', async () => {
    // Same paths, same file count, same byte length — only the content differs.
    // This is the direction a `return 'constant'` implementation fails, and the
    // reason a dirty run stays comparable to itself but not to a later edit.
    const root = suite.getTempDir();
    committedRepo(root);
    writeFixtureFile(root, TRACKED_FILE, 'edited\n');
    const before = await workingFingerprintOf(root);

    writeFixtureFile(root, TRACKED_FILE, 'EDITED\n');
    const after = await workingFingerprintOf(root);

    expect(after).not.toBe(before);
  });

  it('pins the whole repository, not just the subject subtree', async () => {
    // `commit` and `dirty` are both repository-wide facts, so the fingerprint
    // qualifying them has to be one too. Everything that changes here lies
    // OUTSIDE the subject path: a fingerprint scoped to the subtree would call
    // these two states one version while `dirty` said otherwise.
    const repo = suite.getTempDir();
    initRepo(repo);
    writeFixtureFile(repo, 'sub/inner.md', 'inner\n');
    writeFixtureFile(repo, OUTSIDE_FILE, 'outside\n');
    commitAll(repo, 'initial');
    const subject = safePath.join(repo, 'sub');

    writeFixtureFile(repo, OUTSIDE_FILE, 'changed\n');
    const version = await gitVersionOf(subject);
    const first = await workingFingerprintOf(subject);

    writeFixtureFile(repo, OUTSIDE_FILE, 'CHANGED\n');
    const second = await workingFingerprintOf(subject);

    expect(version.dirty).toBe(true);
    expect(second).not.toBe(first);
  });

  it('survives a tracked file deleted from the working tree', async () => {
    // `git ls-files` still lists a deleted-but-tracked path, so hashing the
    // population naively would throw ENOENT on one of the commonest dirty
    // states there is.
    const root = suite.getTempDir();
    committedRepo(root);
    const before = await gitVersionOf(root);

    removeFixtureFile(root, TRACKED_FILE);
    const after = await gitVersionOf(root);

    expect(before.dirty).toBe(false);
    expect(after.dirty).toBe(true);
    expect(after.workingFingerprint).toMatch(SHA256_HEX);
  });
});

describe('resolveSubject — snapshot subjects', () => {
  it('fingerprints a plain folder and counts the files in scope', async () => {
    const root = suite.getTempDir();
    writeFixtureFile(root, 'a.txt', 'one\n');
    writeFixtureFile(root, NESTED_FILE, 'two\n');
    writeFixtureFile(root, 'nested/deep/c.txt', 'three\n');

    const snapshot = await snapshotOf(root);

    expect(snapshot.fileCount).toBe(3);
    expect(snapshot.fingerprint).toMatch(SHA256_HEX);
  });

  it('returns the same fingerprint for two runs over unchanged content', async () => {
    const root = suite.getTempDir();
    writeFixtureFile(root, 'a.txt', 'one\n');
    writeFixtureFile(root, NESTED_FILE, 'two\n');

    const first = await snapshotOf(root);
    const second = await snapshotOf(root);

    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it('changes the fingerprint when one content byte changes', async () => {
    // Same paths, same file count, same byte length — only the content differs,
    // so nothing but a real content hash can tell these two trees apart. This
    // is the direction a `return 'constant'` implementation fails.
    const root = suite.getTempDir();
    writeFixtureFile(root, 'a.txt', 'one\n');
    writeFixtureFile(root, NESTED_FILE, 'two\n');
    const before = await snapshotOf(root);

    writeFixtureFile(root, NESTED_FILE, 'TWO\n');
    const after = await snapshotOf(root);

    expect(after.fileCount).toBe(before.fileCount);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('changes the fingerprint when a file moves without changing content', async () => {
    // The complementary direction: identical bytes, identical count, different
    // path. A digest over content alone would call these two trees one version.
    const root = suite.getTempDir();
    writeFixtureFile(root, 'here/a.txt', 'one\n');
    const before = await snapshotOf(root);

    removeFixtureFile(root, 'here/a.txt');
    writeFixtureFile(root, 'there/a.txt', 'one\n');
    const after = await snapshotOf(root);

    expect(after.fileCount).toBe(before.fileCount);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });
});

describe('resolveSubject — axis A and the path to measure', () => {
  it('records the subject as it was named, and resolves the path to measure', async () => {
    const root = suite.getTempDir();
    writeFixtureFile(root, 'a.txt', 'one\n');

    const resolved = await resolve(root);

    expect(resolved.ref).toEqual({ id: 'fixture-subject', source: root });
    expect(resolved.path).toBe(safePath.resolve(root));
  });

  it('rejects a path that does not exist rather than fingerprinting nothing', async () => {
    const missing = safePath.join(suite.getTempDir(), 'no-such-directory');

    await expect(resolve(missing)).rejects.toThrow(/not an existing directory/);
  });
});
