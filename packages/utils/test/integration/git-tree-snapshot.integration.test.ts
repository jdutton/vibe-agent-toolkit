/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
/**
 * Integration tests for {@link gitTreeSnapshot}, against a real `git`.
 *
 * Deliberately NOT unit tests with a mocked git. Every property worth pinning
 * here is a property of git itself — that a dirty file's OID names what is on
 * disk rather than what was committed, that `write-tree` is timestamp-free, that
 * a symlink's blob is its target string — and a mock would simply restate this
 * file's own assumptions back to it.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GIT_MODE_SYMLINK, gitTreeSnapshot } from '../../src/git-tree-snapshot.js';
import { mkdirSyncReal, normalizedTmpdir, safePath } from '../../src/path-utils.js';
import { canCreateSymlinks } from '../../src/test-helpers.js';
import { createGitRepo } from '../test-helpers.js';

/**
 * Run git in the fixture and return stdout.
 *
 * The single place this file shells out, so the `git`-from-PATH exemption is
 * declared once rather than at each call site.
 *
 * @param args - Arguments after the binary
 * @param cwd - Fixture directory to run in
 * @returns stdout, trimmed of nothing — callers decide
 */
function gitOut(args: readonly string[], cwd: string): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- test fixture uses git from PATH
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf-8', stdio: 'pipe' });
  return result.stdout ?? '';
}

/**
 * Commit everything currently in the working tree.
 *
 * Identity is passed with `-c` rather than written to config: a CI or dev box
 * with no global `user.email` would otherwise fail here for a reason that has
 * nothing to do with what is being tested.
 *
 * @param cwd - Fixture directory
 * @param message - Commit message
 */
function commitAll(cwd: string, message: string): void {
  gitOut(['add', '--all'], cwd);
  gitOut(
    [
      '-c', 'user.email=test@example.com',
      '-c', 'user.name=Test',
      'commit', '-m', message, '--no-gpg-sign',
    ],
    cwd,
  );
}

/** The fixture's one ordinary tracked document, root-relative. */
const DOC = 'doc.md';

/** The fixture's untracked-but-not-ignored document. */
const UNTRACKED = 'untracked.md';

/** `git status` in machine-readable form. */
const STATUS_PORCELAIN = ['status', '--porcelain'];

/** The entry for one root-relative path, or undefined. */
function entryFor(
  snapshot: { entries: { path: string; oid: string; mode: string }[] } | null,
  path: string,
): { path: string; oid: string; mode: string } | undefined {
  return snapshot?.entries.find((e) => e.path === path);
}

describe('gitTreeSnapshot', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-tree-snapshot-'));
    createGitRepo(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns null outside a git repository rather than an empty snapshot', () => {
    const bare = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-not-a-repo-'));
    try {
      // The distinction this pins: "could not ask" must not be spelled the same
      // way as "asked, and the answer is nothing". A caller that inferred
      // emptiness from null would report a whole corpus as absent.
      expect(gitTreeSnapshot({ cwd: bare })).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('names the ON-DISK bytes of a tracked-but-dirty file, not the committed ones', () => {
    const file = safePath.join(root, DOC);
    writeFileSync(file, 'committed\n');
    commitAll(root, 'initial');

    const clean = gitTreeSnapshot({ cwd: root });
    const committedOid = entryFor(clean, DOC)?.oid;
    expect(committedOid).toBeDefined();

    // Dirty it WITHOUT staging. `git ls-files -s` against the real index would
    // still report `committedOid` here — that is the whole defect this function
    // exists to avoid, so the assertion is inequality, not merely "defined".
    writeFileSync(file, 'edited on disk\n');

    const dirty = gitTreeSnapshot({ cwd: root });
    const dirtyOid = entryFor(dirty, DOC)?.oid;
    expect(dirtyOid).toBeDefined();
    expect(dirtyOid).not.toBe(committedOid);

    // And it is the OID git itself computes for those exact bytes.
    const hashed = gitOut(['hash-object', file], root).trim();
    expect(dirtyOid).toBe(hashed);
  });

  it('leaves the real index and the working tree untouched', () => {
    writeFileSync(safePath.join(root, DOC), 'committed\n');
    commitAll(root, 'initial');
    writeFileSync(safePath.join(root, DOC), 'edited on disk\n');
    writeFileSync(safePath.join(root, UNTRACKED), 'new\n');

    const before = gitOut(STATUS_PORCELAIN, root);

    gitTreeSnapshot({ cwd: root });

    const after = gitOut(STATUS_PORCELAIN, root);

    // If GIT_INDEX_FILE were not honoured, `git add --all` would have staged
    // both files and this string would change from `` M``/`??` to `M `/`A `.
    expect(after).toBe(before);
  });

  it('is deterministic across calls on identical content', () => {
    writeFileSync(safePath.join(root, DOC), 'stable\n');
    commitAll(root, 'initial');
    writeFileSync(safePath.join(root, DOC), 'dirty but stable\n');

    const first = gitTreeSnapshot({ cwd: root });
    const second = gitTreeSnapshot({ cwd: root });

    // A `stash create` implementation passes this only when both calls land in
    // the same wall-clock second, which is why the mechanism is `write-tree`.
    expect(first?.treeOid).toBe(second?.treeOid);
    expect(first?.treeOid).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it('includes untracked-not-ignored files and excludes gitignored ones', () => {
    writeFileSync(safePath.join(root, '.gitignore'), 'dist/\n');
    writeFileSync(safePath.join(root, 'tracked.md'), 'tracked\n');
    commitAll(root, 'initial');

    writeFileSync(safePath.join(root, UNTRACKED), 'untracked\n');
    mkdirSyncReal(safePath.join(root, 'dist'), { recursive: true });
    writeFileSync(safePath.join(root, 'dist', 'out.js'), 'built\n');

    const snapshot = gitTreeSnapshot({ cwd: root });
    const paths = snapshot?.entries.map((e) => e.path) ?? [];

    expect(paths).toContain('tracked.md');
    expect(paths).toContain(UNTRACKED);
    // The membership contract: `--all` without `--force`. A snapshot carrying
    // `dist/out.js` would mean secrets and build output were being checksummed.
    expect(paths).not.toContain('dist/out.js');
  });

  it('returns paths relative to the repository ROOT even when called from a subdirectory', () => {
    mkdirSyncReal(safePath.join(root, 'nested', 'deeper'), { recursive: true });
    writeFileSync(safePath.join(root, 'nested', 'deeper', 'doc.md'), 'x\n');
    writeFileSync(safePath.join(root, 'top.md'), 'y\n');
    commitAll(root, 'initial');

    const fromSub = gitTreeSnapshot({ cwd: safePath.join(root, 'nested', 'deeper') });
    const paths = fromSub?.entries.map((e) => e.path) ?? [];

    // This case caught a real bug, and the first fix for it was insufficient.
    // `git ls-files` both SPELLS paths relative to the cwd and SCOPES its
    // listing to the cwd; `--full-name` only fixes the spelling. With the flag
    // alone this returned `nested/deeper/doc.md` correctly and omitted `top.md`
    // entirely — a snapshot that looks well-formed and silently is not the whole
    // tree. The `top.md` assertion is the one that fails in that state, so it is
    // the load-bearing half rather than a second example of the first.
    expect(paths).toContain('nested/deeper/doc.md');
    expect(paths).toContain('top.md');
  });

  it('ignores the git environment a pre-commit hook exports into it', () => {
    // `vat resources validate` really does run inside a pre-commit hook, and git
    // exports GIT_DIR / GIT_INDEX_FILE / GIT_PREFIX into hooks. A child that
    // inherits them snapshots the OUTER commit's repository instead of the path
    // it was handed -- silently, with a well-formed answer.
    //
    // The fixture makes the two repositories distinguishable, which is the whole
    // point: `other` holds a file `root` does not, so an implementation that
    // followed the inherited GIT_DIR returns `elsewhere.md` and no `doc.md`.
    const other = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-outer-repo-'));
    const saved = { ...process.env };
    try {
      createGitRepo(other);
      writeFileSync(safePath.join(other, 'elsewhere.md'), 'not ours\n');
      commitAll(other, 'outer');

      writeFileSync(safePath.join(root, DOC), 'ours\n');
      commitAll(root, 'initial');

      // Exactly what git sets when it runs a hook, including the relative
      // GIT_DIR that resolves against the child's own cwd.
      process.env.GIT_DIR = safePath.join(other, '.git');
      process.env.GIT_WORK_TREE = other;
      process.env.GIT_INDEX_FILE = safePath.join(other, '.git', 'index');
      process.env.GIT_PREFIX = '';

      const snapshot = gitTreeSnapshot({ cwd: root });
      const paths = snapshot?.entries.map((e) => e.path) ?? [];

      expect(paths).toContain(DOC);
      expect(paths).not.toContain('elsewhere.md');

      // And the outer repository's real index is still untouched, which is the
      // failure that would actually corrupt someone's commit.
      expect(gitOut(STATUS_PORCELAIN, other)).toBe('');
    } finally {
      for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX']) {
        delete process.env[key];
        if (saved[key] !== undefined) process.env[key] = saved[key];
      }
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('reports a symlink under mode 120000, whose blob is the TARGET STRING', ({ skip }) => {
    if (!canCreateSymlinks(root)) {
      skip('symlink creation requires Developer Mode or admin rights on Windows');
    }

    writeFileSync(safePath.join(root, 'real.md'), 'the real contents\n');
    symlinkSync('real.md', safePath.join(root, 'link.md'));
    commitAll(root, 'initial');

    const snapshot = gitTreeSnapshot({ cwd: root });
    const link = entryFor(snapshot, 'link.md');
    const real = entryFor(snapshot, 'real.md');

    expect(link?.mode).toBe(GIT_MODE_SYMLINK);
    // The trap, pinned as a fact rather than left as prose: the link's OID is
    // NOT its target's OID, because the blob holds the string "real.md". A
    // consumer keying content from these OIDs must exclude mode 120000, or two
    // links with the same target string collapse onto one key.
    expect(link?.oid).not.toBe(real?.oid);

    expect(gitOut(['cat-file', '-p', link?.oid ?? ''], root)).toBe('real.md');
  });
});
