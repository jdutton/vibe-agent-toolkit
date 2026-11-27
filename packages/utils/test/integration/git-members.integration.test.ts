/**
 * `gitMembersOf` over real repositories: a member's OID is the one `git hash-object` gives its file,
 * its bytes and size come from git's object store, and a partial clone on a git that cannot refuse
 * a lazy fetch has no members.
 */

import { chmodSync, copyFileSync, utimesSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gitMembersOf } from '../../src/git-members.js';
import { type GitObjectReaders, openGitObjectReaders } from '../../src/git-object-reader.js';
import { runGit } from '../../src/git-run.js';
import { safePath } from '../../src/path-utils.js';
import { plantFiles } from '../../src/testing/plant-files.js';
import { createTempDir, removeTempDir } from '../../src/testing/temp-dir.js';

import { git, initRepository, keyed } from './git-test-kit.js';

describe('gitMembersOf over a real repository', () => {
  let dir: string;
  let objects: GitObjectReaders;

  beforeEach(() => {
    dir = createTempDir('vat-git-members-');
    objects = openGitObjectReaders({});
  });

  afterEach(async () => {
    await objects.close();
    removeTempDir(dir);
  });

  it.for(['sha1', 'sha256'] as const)('keys a %s repository\'s files by the OID git hashes them to, and reads them from git', async (format) => {
    initRepository(dir, `--object-format=${format}`);
    plantFiles(dir, { 'docs/a.md': 'committed\n', 'run.sh': '#!/bin/sh\n' });
    chmodSync(safePath.join(dir, 'run.sh'), 0o755);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'init');
    plantFiles(dir, { 'docs/a.md': 'edited, not staged\r\n' });
    const members = gitMembersOf(keyed(dir), objects);
    if (members === null) throw new Error('no members');
    const member = members.memberAt(safePath.join(dir, 'docs/a.md'));
    expect(member).toStrictEqual({ oid: git(dir, 'hash-object', 'docs/a.md'), keyKind: format === 'sha1' ? 'git-sha1' : 'git-sha256' });
    if (member === undefined) throw new Error('not a member');
    expect(Buffer.from(await members.bytesOf(member)).toString()).toBe('edited, not staged\r\n');
    expect(await members.sizeOf(member)).toBe('edited, not staged\r\n'.length);
    expect(members.memberAt(safePath.join(dir, 'run.sh'))?.oid).toBe(git(dir, 'hash-object', 'run.sh'));
  });

  it('keys a same-second edit git\'s stat cannot see by its new bytes: the snapshot keeps the index racy', async () => {
    // Every stat git compares under these settings is equal before and after the edit: the size,
    // and the mtime in whole seconds. Only the index's own mtime, in the same second as the
    // entry's, makes git recheck the bytes (a racy entry).
    const second = new Date('2026-01-01T00:00:00.000Z');
    const file = safePath.join(dir, 'docs/a.md');
    initRepository(dir);
    git(dir, 'config', 'core.trustctime', 'false');
    git(dir, 'config', 'core.checkStat', 'minimal');
    plantFiles(dir, { 'docs/a.md': 'committed one\n' });
    utimesSync(file, second, second);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'init');
    const committed = git(dir, 'rev-parse', 'HEAD:docs/a.md');
    plantFiles(dir, { 'docs/a.md': 'committed two\n' });
    utimesSync(file, second, second);
    utimesSync(safePath.join(dir, '.git/index'), second, second);
    const edited = git(dir, 'hash-object', 'docs/a.md');
    expect(edited, 'the edit moved the bytes').not.toBe(committed);

    // Control: a copy of the index stamped now is not racy, and git stages the committed bytes.
    const stamped = safePath.join(dir, '.git/control-index');
    copyFileSync(safePath.join(dir, '.git/index'), stamped);
    // Stamp it now explicitly: a copy keeps the source's mtime on Windows (CopyFile), which would
    // leave the control as racy as the original.
    const now = new Date();
    utimesSync(stamped, now, now);
    const control = runGit(['add', '--all'], { cwd: dir, env: { GIT_INDEX_FILE: stamped } });
    expect(control.ok, control.stderr).toBe(true);
    const staged = runGit(['ls-files', '-s', '--', 'docs/a.md'], { cwd: dir, env: { GIT_INDEX_FILE: stamped } });
    expect(staged.stdout.split(/\s+/u)[1], 'a now-stamped index trusts the stat and stages the committed bytes').toBe(committed);
    utimesSync(safePath.join(dir, '.git/index'), second, second);

    const members = gitMembersOf(keyed(dir), objects);
    expect(members?.memberAt(file)?.oid, 'the member keys the edited bytes').toBe(edited);
  });

  describe('a partial clone', () => {
    beforeEach(() => {
      initRepository(dir);
      plantFiles(dir, { 'a.md': 'a\n' });
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'init');
      git(dir, 'config', 'remote.origin.promisor', 'true');
    });

    // The notice is remembered per repository, and this test's repository is its own: order-independent.
    it('has no members on a git before 2.45, noticed once for the repository', async () => {
      const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
      const old = openGitObjectReaders({ gitVersion: [2, 44] });
      try {
        expect(gitMembersOf(keyed(dir), old)).toBeNull();
        expect(gitMembersOf(keyed(dir), old)).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toContain('partial clone');
      } finally {
        warn.mockRestore();
        await old.close();
      }
    });

    it('has members on git 2.45 or later, whose reads refuse a lazy fetch', async () => {
      const current = openGitObjectReaders({ gitVersion: [2, 45] });
      try {
        expect(gitMembersOf(keyed(dir), current)?.memberAt(safePath.join(dir, 'a.md'))?.oid).toBe(git(dir, 'hash-object', 'a.md'));
      } finally {
        await current.close();
      }
    });
  });
});
