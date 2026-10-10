/**
 * `copyTree` and `proveTreeReadable` on a real filesystem: one walk, one link
 * policy, one special-file policy. Faults are injected with `installFaultFs`, so a
 * refusal deep in a tree runs on every OS and as any user; a real `chmod` is used
 * only where the mode itself is the subject. Named pipes are the system tier's
 * (`copy-directory-special-files`): making one spawns `mkfifo`.
 */

import fs from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { fsBoundary } from '../../src/errors/fs-boundary.js';
import { FS_FAULT_CODE, isFsFaultError } from '../../src/errors/fs-fault.js';
import { relativeEscapesRoot, safePath } from '../../src/path-core.js';
import { createSymlinkAsync, symlinkCapability } from '../../src/test-helpers.js';
import { installFaultFs, type FaultFsSession } from '../../src/testing/fault-fs.js';
import { PERMISSIONS_ENFORCED } from '../../src/testing/platform-gates.js';
import { tempDirTracker } from '../../src/testing/temp-dir.js';
import { copyRegularFile, copyTree } from '../../src/tree-change/copy-tree.js';
import { CopyLinkEscapesSourceError } from '../../src/tree-change/followed-walk.js';
import { proveTreeReadable, readRegularFile } from '../../src/tree-change/readable-tree.js';
import { setupNestedDirectory } from '../test-helpers.js';

const scratch = tempDirTracker('tree-change-copy-');
let session: FaultFsSession | undefined;
/** Modes to put back before teardown: a 0555 source directory is otherwise left for the cleanup to trip on. */
const restoreModes: Array<{ path: string; mode: number }> = [];
afterEach(async () => {
  session?.restore();
  session = undefined;
  for (const { path, mode } of restoreModes.splice(0)) await fs.chmod(path, mode);
  scratch.cleanupAll();
});

const FOLLOW = { links: 'follow-contained', side: 'source', onto: 'fresh' } as const;
const PRESERVE = { links: 'preserve', side: 'source', onto: 'fresh' } as const;
const SUBDIR = 'subdir';
const NESTED_TXT = 'nested.txt';
const NESTED_CONTENT = 'nested content';
const SKIP_NO_LINKS = 'host cannot create symlinks';

const under = (root: string) => (p: string): boolean => !relativeEscapesRoot(safePath.relative(root, p));

/** A scratch dir holding `src/` (made) and the path `dest/` (not made). */
async function srcAndDest(): Promise<{ root: string; src: string; dest: string }> {
  const root = scratch.create();
  const src = safePath.join(root, 'src');
  await fs.mkdir(src);
  return { root, src, dest: safePath.join(root, 'dest') };
}

/** `src/a/b/c/deep.md` and `src/top.md`; returns the deep file (three levels down). */
async function plantDeep(src: string): Promise<string> {
  const deep = safePath.join(src, 'a', 'b', 'c', 'deep.md');
  await fs.mkdir(safePath.join(src, 'a', 'b', 'c'), { recursive: true });
  await fs.writeFile(deep, 'deep');
  await fs.writeFile(safePath.join(src, 'top.md'), 'top');
  return deep;
}

const readUtf8 = (path: string): Promise<string> => fs.readFile(path, 'utf-8');

/** `tree/` (the root a single-file copy goes under), `outside/victim.md`, and the file `new.md` to copy. */
async function treeAndVictim(): Promise<{ root: string; tree: string; from: string; victim: string }> {
  const { root } = await srcAndDest();
  const tree = safePath.join(root, 'tree');
  const victim = safePath.join(root, 'outside', 'victim.md');
  await fs.mkdir(tree);
  await fs.mkdir(safePath.join(root, 'outside'));
  await fs.writeFile(victim, 'precious');
  const from = safePath.join(root, 'new.md');
  await fs.writeFile(from, 'new');
  return { root, tree, from, victim };
}

describe('copyTree', () => {
  it('copies an empty directory', async () => {
    const { src, dest } = await srcAndDest();
    await copyTree(src, dest, '', FOLLOW);
    expect((await fs.stat(dest)).isDirectory()).toBe(true);
    expect(await fs.readdir(dest)).toHaveLength(0);
  });

  // The root is where a copy into a tree that already holds a links-preserved copy lands: adopted
  // through a link, the whole copy was written into the link's target and that directory chmod-ed.
  it.for(['fresh', 'merge'] as const)('never adopts a LINK to a directory as its root (onto: %s): refused, the target untouched', async (onto, { skip }) => {
    const cap = symlinkCapability() ?? skip(SKIP_NO_LINKS);
    const { root, src, dest } = await srcAndDest();
    await fs.writeFile(safePath.join(src, 'SKILL.md'), 'copied');
    const outside = safePath.join(root, 'outside');
    await fs.mkdir(outside, { mode: 0o755 });
    await fs.writeFile(safePath.join(outside, 'kept.md'), 'kept');
    await createSymlinkAsync(cap, outside, dest, 'dir');

    const failure: unknown = await copyTree(src, dest, '', { ...PRESERVE, onto }).catch((error: unknown) => error);

    expect(failure, String(failure)).toMatchObject({ code: 'EEXIST' });
    expect(isFsFaultError(failure)).toBe(false);
    expect(await fs.readdir(outside)).toEqual(['kept.md']);
    expect((await fs.lstat(dest)).isSymbolicLink()).toBe(true);
  });

  // A copy that goes UNDER a tree — one that may hold links its own source shipped — names that tree's
  // root and where under it: the link standing above the copy took the whole copy outside the tree.
  it.for([
    { relative: 'sub/x', made: false, label: 'the copy\'s directory is not there yet' },
    { relative: 'sub/x', made: true, label: 'a directory of that name is already where the link points' },
    { relative: 'sub/deep/er/x', made: false, label: 'the link is three levels above' },
  ])('never goes through a LINK above where the copy goes under a root ($relative: $label): refused naming the link, nothing made where it points', async ({ relative, made }, { skip }) => {
    const cap = symlinkCapability() ?? skip(SKIP_NO_LINKS);
    const { root, src } = await srcAndDest();
    await fs.writeFile(safePath.join(src, 'SKILL.md'), 'copied');
    const tree = safePath.join(root, 'tree');
    const outside = safePath.join(root, 'outside');
    await fs.mkdir(tree);
    await fs.mkdir(outside);
    if (made) await fs.mkdir(safePath.join(outside, 'x'));
    await createSymlinkAsync(cap, outside, safePath.join(tree, 'sub'), 'dir');

    const failure: unknown = await copyTree(src, tree, relative, PRESERVE).catch((error: unknown) => error);

    expect(failure, String(failure)).toMatchObject({ code: FS_FAULT_CODE, side: 'source', origin: 'content', faultClass: 'occupied', path: safePath.join(tree, 'sub') });
    expect(await fs.readdir(outside)).toEqual(made ? ['x'] : []);
    if (made) expect(await fs.readdir(safePath.join(outside, 'x'))).toEqual([]);
  });

  it('copies under a root, making the real directories on the way and adopting the ones there', async () => {
    const { root, src } = await srcAndDest();
    await fs.writeFile(safePath.join(src, 'a.md'), 'a');
    const tree = safePath.join(root, 'tree');
    await fs.mkdir(safePath.join(tree, 'skills'), { recursive: true });
    await fs.writeFile(safePath.join(tree, 'skills', 'kept.md'), 'kept');

    await copyTree(src, tree, 'skills/group/x', FOLLOW);

    expect(await readUtf8(safePath.join(tree, 'skills', 'group', 'x', 'a.md'))).toBe('a');
    expect(await readUtf8(safePath.join(tree, 'skills', 'kept.md'))).toBe('kept');
  });

  it('never adopts a FILE as its root, and adopts a real directory that is there', async () => {
    const { root, src, dest } = await srcAndDest();
    await fs.writeFile(safePath.join(src, 'a.md'), 'a');
    const file = safePath.join(root, 'a-file');
    await fs.writeFile(file, 'kept');

    expect(await copyTree(src, file, '', FOLLOW).catch((error: unknown) => error)).toMatchObject({ code: 'EEXIST' });
    expect(await readUtf8(file)).toBe('kept');

    await fs.mkdir(dest);
    await copyTree(src, dest, '', FOLLOW);
    expect(await readUtf8(safePath.join(dest, 'a.md'))).toBe('a');
  });

  it('copies files, nested and deeply nested directories, creating the destination and its parents', async () => {
    const root = scratch.create();
    const { srcDir } = await setupNestedDirectory(root, SUBDIR, NESTED_TXT, NESTED_CONTENT);
    await plantDeep(srcDir);
    const dest = safePath.join(root, 'non', 'existent', 'dest');

    await copyTree(srcDir, dest, '', FOLLOW);

    expect(await readUtf8(safePath.join(dest, SUBDIR, NESTED_TXT))).toBe(NESTED_CONTENT);
    expect(await readUtf8(safePath.join(dest, 'a', 'b', 'c', 'deep.md'))).toBe('deep');
    expect(await readUtf8(safePath.join(dest, 'top.md'))).toBe('top');
  });

  it('keeps file contents byte for byte', async () => {
    const { src, dest } = await srcAndDest();
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    await fs.writeFile(safePath.join(src, 'binary.dat'), binary);
    await copyTree(src, dest, '', FOLLOW);
    expect(Buffer.compare(await fs.readFile(safePath.join(dest, 'binary.dat')), binary)).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('keeps a file\'s mode, so a script stays executable', async () => {
    const { src, dest } = await srcAndDest();
    await fs.writeFile(safePath.join(src, 'run.sh'), '#!/bin/sh\n');
    await fs.chmod(safePath.join(src, 'run.sh'), 0o755);
    await copyTree(src, dest, '', FOLLOW);
    expect((await fs.stat(safePath.join(dest, 'run.sh'))).mode & 0o777).toBe(0o755);
  });

  // The R7 d-I-2 invariant: a read-only source must not become a copy nothing can fill or remove.
  it.skipIf(process.platform === 'win32')('gives each directory its source\'s mode with the owner\'s rwx kept (0555 → 0755)', async () => {
    const { src, dest } = await srcAndDest();
    const sub = safePath.join(src, 'sub');
    await fs.mkdir(sub);
    await fs.writeFile(safePath.join(sub, 'a.md'), 'a');
    await fs.chmod(sub, 0o555);
    await fs.chmod(src, 0o555);
    restoreModes.push({ path: sub, mode: 0o755 }, { path: src, mode: 0o755 });

    await copyTree(src, dest, '', FOLLOW);

    expect((await fs.stat(dest)).mode & 0o777).toBe(0o755);
    expect((await fs.stat(safePath.join(dest, 'sub'))).mode & 0o777).toBe(0o755);
    expect(await readUtf8(safePath.join(dest, 'sub', 'a.md'))).toBe('a');
  });

  describe('links', () => {
    it('follow-contained copies a link to a file inside the tree as the file\'s bytes', async ({ skip }) => {
      const cap = symlinkCapability() ?? skip(SKIP_NO_LINKS);
      const { src, dest } = await srcAndDest();
      await fs.writeFile(safePath.join(src, 'real.md'), 'real');
      await createSymlinkAsync(cap, safePath.join(src, 'real.md'), safePath.join(src, 'alias.md'));
      await copyTree(src, dest, '', FOLLOW);
      expect((await fs.lstat(safePath.join(dest, 'alias.md'))).isSymbolicLink()).toBe(false);
      expect(await readUtf8(safePath.join(dest, 'alias.md'))).toBe('real');
    });

    it('follow-contained refuses a link out of the source (scripts/etc -> a directory outside), before writing it', async ({ skip }) => {
      const cap = symlinkCapability() ?? skip(SKIP_NO_LINKS);
      const { root, src, dest } = await srcAndDest();
      const outside = safePath.join(root, 'etc');
      await fs.mkdir(outside);
      await fs.writeFile(safePath.join(outside, 'passwd'), 'not the source\'s');
      await fs.mkdir(safePath.join(src, 'scripts'));
      const link = safePath.join(src, 'scripts', 'etc');
      await createSymlinkAsync(cap, outside, link, 'dir');

      await expect(copyTree(src, dest, '', FOLLOW)).rejects.toThrow(CopyLinkEscapesSourceError);
      await expect(fs.access(safePath.join(dest, 'scripts', 'etc'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('preserve copies a dangling link as a link, its target verbatim, never examining it', async ({ skip }) => {
      const cap = symlinkCapability() ?? skip(SKIP_NO_LINKS);
      const { root, src, dest } = await srcAndDest();
      const dangling = safePath.join(src, 'dangling');
      await createSymlinkAsync(cap, 'nowhere', dangling);
      session = installFaultFs({ within: root });

      await copyTree(src, dest, '', PRESERVE);

      expect((await fs.lstat(safePath.join(dest, 'dangling'))).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(safePath.join(dest, 'dangling'))).toBe('nowhere');
      const touched = session.calls.filter((call) => call.path === dangling).map((call) => call.op);
      expect(touched).toEqual(['readlink']);
    });
  });

  // Windows without the privilege (EPERM) or a filesystem with no links (ENOTSUP): the copy names no
  // side for a link it cannot write; the caller's boundary classifies it like any other write.
  it('surfaces a link it cannot create (preserve) as the raw errno, for the caller to classify', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip(SKIP_NO_LINKS);
    const { root, src, dest } = await srcAndDest();
    await createSymlinkAsync(cap, 'target', safePath.join(src, 'link'));
    const made = safePath.join(dest, 'link');
    session = installFaultFs({ within: root, faults: [{ family: 'create', op: 'symlink', path: (p) => p === made, errno: 'EPERM' }] });

    const failure: unknown = await copyTree(src, dest, '', PRESERVE).catch((error: unknown) => error);
    expect(isFsFaultError(failure)).toBe(false);
    expect(failure).toMatchObject({ code: 'EPERM', path: made });
    expect(session.fired.map((call) => call.op)).toEqual(['symlink']);
    expect(fsBoundary({ source: [src], destination: [dest] }).classify(failure, 'copy', 'destination'))
      .toMatchObject({ code: FS_FAULT_CODE, side: 'destination', faultClass: 'refused', errno: 'EPERM' });
  });

  it('never touches a path the filter excludes: no stat, no open, no listing below it', async () => {
    const { root, src, dest } = await srcAndDest();
    await plantDeep(src);
    const excluded = safePath.join(src, 'a');
    session = installFaultFs({ within: root });

    await copyTree(src, dest, '', { ...FOLLOW, filter: (relative) => relative !== 'a' });

    expect(session.calls.filter((call) => under(excluded)(call.path))).toEqual([]);
    expect(session.calls.some((call) => call.op === 'open' && call.path === safePath.join(src, 'top.md'))).toBe(true);
    expect(await fs.readdir(dest)).toEqual(['top.md']);
  });

  describe('a refusal reading the source is a classified source fault (content), naming the entry', () => {
    const expectSourceFault = async (run: Promise<void>, path: string, faultClass: string): Promise<void> => {
      await expect(run).rejects.toMatchObject({ code: FS_FAULT_CODE, side: 'source', origin: 'content', faultClass, path });
    };

    it('a source directory that is not there', async () => {
      const { root, dest } = await srcAndDest();
      const missing = safePath.join(root, 'no-such-dir');
      await expectSourceFault(copyTree(missing, dest, '', FOLLOW), missing, 'absent');
    });

    it('a source that is a file, not a directory', async () => {
      const { root, dest } = await srcAndDest();
      const file = safePath.join(root, 'file.txt');
      await fs.writeFile(file, 'content');
      await expectSourceFault(copyTree(file, dest, '', FOLLOW), file, 'absent');
    });

    it('a file the OS will not open, three levels down', async () => {
      const { root, src, dest } = await srcAndDest();
      const deep = await plantDeep(src);
      session = installFaultFs({ within: root, faults: [{ family: 'read', op: 'open', path: (p) => p === deep, errno: 'EACCES' }] });
      await expectSourceFault(copyTree(src, dest, '', FOLLOW), deep, 'refused');
    });

    it.skipIf(!PERMISSIONS_ENFORCED)('a file a real mode makes unreadable', async () => {
      const { src, dest } = await srcAndDest();
      const locked = safePath.join(src, 'locked.md');
      await fs.writeFile(locked, 'secret');
      await fs.chmod(locked, 0o000);
      await expectSourceFault(copyTree(src, dest, '', FOLLOW), locked, 'refused');
    });

    // The copy reads the tree the caller named, on the side the caller names — the proof's side. A plugin
    // install copies the marketplace copy it already made under ~/.claude (`destination`); the copy used to
    // call every read `source`, so a refused read there was the operator's input instead of the run's.
    it.for(['destination', 'environment'] as const)('a file the OS will not read mid-copy, on the declared side (%s)', async (side) => {
      const { root, src, dest } = await srcAndDest();
      const deep = await plantDeep(src);
      session = installFaultFs({ within: root, faults: [{ family: 'read', op: 'read', path: (p) => p === deep, errno: 'EACCES' }] });
      await expect(copyTree(src, dest, '', { ...FOLLOW, side })).rejects.toMatchObject({ code: FS_FAULT_CODE, side, origin: 'content', faultClass: 'refused', path: deep });
    });

    it('a dangling link under follow-contained', async ({ skip }) => {
      const cap = symlinkCapability() ?? skip(SKIP_NO_LINKS);
      const { src, dest } = await srcAndDest();
      const dangling = safePath.join(src, 'dangling');
      await createSymlinkAsync(cap, safePath.join(src, 'nowhere'), dangling);
      await expectSourceFault(copyTree(src, dest, '', FOLLOW), dangling, 'absent');
    });
  });

  describe('a failure writing the destination is the caller\'s to classify', () => {
    it('surfaces the raw errno: the copy names no side for what it writes', async () => {
      const { root, src } = await srcAndDest();
      await fs.writeFile(safePath.join(src, 'a.md'), 'a');
      const blocked = safePath.join(root, 'blocked');
      await fs.writeFile(blocked, 'a file where the destination directory should go');
      const failure: unknown = await copyTree(src, safePath.join(blocked, 'dest'), '', FOLLOW).catch((error: unknown) => error);
      expect(isFsFaultError(failure)).toBe(false);
      expect(failure).toMatchObject({ code: expect.stringMatching(/^E[A-Z]+$/) as unknown });
    });

    it('an injected ENOSPC on the second write is a destination fault under the caller\'s boundary', async () => {
      const { root, src, dest } = await srcAndDest();
      await fs.writeFile(safePath.join(src, 'a.md'), 'a');
      await fs.writeFile(safePath.join(src, 'b.md'), 'b');
      session = installFaultFs({ within: root, faults: [{ family: 'write', op: 'writeFile', path: under(dest), nth: 2, errno: 'ENOSPC' }] });
      const boundary = fsBoundary({ source: [src], destination: [dest] });

      await expect(boundary.run(`copy ${src} to ${dest}`, 'destination', () => copyTree(src, dest, '', FOLLOW)))
        .rejects.toMatchObject({ code: FS_FAULT_CODE, side: 'destination', faultClass: 'exhausted', errno: 'ENOSPC' });
      expect(session.fired).toHaveLength(1);
      expect(session.fired[0]?.op).toBe('writeFile');
    });

    // Both fail: the write the copy could not make is what happened, not the source's close after it.
    it('reports the failed write, not a source close that also fails after it', async () => {
      const { root, src, dest } = await srcAndDest();
      const file = safePath.join(src, 'a.md');
      await fs.writeFile(file, 'a');
      session = installFaultFs({
        within: root,
        faults: [
          { family: 'write', op: 'writeFile', path: under(dest), errno: 'ENOSPC' },
          { family: 'meta', op: 'close', path: (p) => p === file, errno: 'EPERM' },
        ],
      });
      const failure: unknown = await copyTree(src, dest, '', FOLLOW).catch((error: unknown) => error);
      expect(isFsFaultError(failure)).toBe(false);
      expect(failure).toMatchObject({ code: 'ENOSPC' });
      expect(session.fired.map((call) => call.op)).toEqual(['writeFile', 'close']);
    });
  });
});

describe('proveTreeReadable', () => {
  it('passes a tree whose every entry lists and opens, opening every file', async () => {
    const { root, src } = await srcAndDest();
    const deep = await plantDeep(src);
    session = installFaultFs({ within: root });
    await proveTreeReadable(src, FOLLOW);
    expect(session.calls.some((call) => call.op === 'open' && call.path === deep)).toBe(true);
  });

  it('refuses an EACCES file three levels down as a source fault (refused) naming that file', async () => {
    const { root, src } = await srcAndDest();
    const deep = await plantDeep(src);
    session = installFaultFs({ within: root, faults: [{ family: 'read', op: 'open', path: (p) => p === deep, errno: 'EACCES' }] });
    const failure: unknown = await proveTreeReadable(src, PRESERVE).catch((error: unknown) => error);
    expect(isFsFaultError(failure)).toBe(true);
    expect(failure).toMatchObject({ side: 'source', faultClass: 'refused', path: deep });
  });

  it('raises the fault on the side the caller names', async () => {
    const { root, src } = await srcAndDest();
    const deep = await plantDeep(src);
    session = installFaultFs({ within: root, faults: [{ family: 'read', op: 'open', path: (p) => p === deep, errno: 'EACCES' }] });
    await expect(proveTreeReadable(src, { ...PRESERVE, side: 'environment' })).rejects.toMatchObject({ side: 'environment', path: deep });
  });

  it('names a directory the OS will not list', async () => {
    const { root, src } = await srcAndDest();
    await plantDeep(src);
    const middle = safePath.join(src, 'a', 'b');
    session = installFaultFs({ within: root, faults: [{ family: 'list', path: (p) => p === middle, errno: 'EACCES' }] });
    await expect(proveTreeReadable(src, FOLLOW)).rejects.toMatchObject({ side: 'source', faultClass: 'refused', path: middle });
  });

  // The proof and the copy cannot disagree: a root copyTree would refuse is refused here, before anything is written.
  it('refuses a root that is a file, as copyTree does', async () => {
    const { root } = await srcAndDest();
    const file = safePath.join(root, 'scripts');
    await fs.writeFile(file, 'not a directory');
    await expect(proveTreeReadable(file, PRESERVE)).rejects.toMatchObject({ side: 'source', path: file, errno: 'ENOTDIR' });
  });

  it('never opens a path the filter excludes', async () => {
    const { root, src } = await srcAndDest();
    const deep = await plantDeep(src);
    session = installFaultFs({ within: root, faults: [{ family: 'read', op: 'open', path: (p) => p === deep, errno: 'EACCES' }] });
    await proveTreeReadable(src, { ...FOLLOW, filter: (relative) => relative !== 'a/b/c/deep.md' });
    expect(session.calls.filter((call) => call.path === deep)).toEqual([]);
  });

  it('preserve never examines a link, so a dangling one passes; follow-contained refuses it as absent', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip(SKIP_NO_LINKS);
    const { src } = await srcAndDest();
    const dangling = safePath.join(src, 'dangling');
    await createSymlinkAsync(cap, safePath.join(src, 'nowhere'), dangling);
    await proveTreeReadable(src, PRESERVE);
    await expect(proveTreeReadable(src, FOLLOW)).rejects.toMatchObject({ faultClass: 'absent', path: dangling });
  });

  it('follow-contained refuses a link out of the tree, as copyTree does', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip(SKIP_NO_LINKS);
    const { root, src } = await srcAndDest();
    await fs.mkdir(safePath.join(root, 'outside'));
    await createSymlinkAsync(cap, safePath.join(root, 'outside'), safePath.join(src, 'out'), 'dir');
    await expect(proveTreeReadable(src, FOLLOW)).rejects.toThrow(CopyLinkEscapesSourceError);
    await proveTreeReadable(src, PRESERVE);
  });
});

describe('readRegularFile', () => {
  it('reads a regular file\'s bytes', async () => {
    const { root } = await srcAndDest();
    const file = safePath.join(root, 'prompt.md');
    await fs.writeFile(file, 'You are a cat.');
    expect((await readRegularFile(file)).toString('utf-8')).toBe('You are a cat.');
  });

  it('refuses a directory with the raw errno, for the caller to classify', async () => {
    const { src } = await srcAndDest();
    const failure: unknown = await readRegularFile(src).catch((error: unknown) => error);
    expect(isFsFaultError(failure)).toBe(false);
    expect(failure).toMatchObject({ code: 'EISDIR' });
  });
});

describe('copyRegularFile', () => {
  const COPY = { side: 'source', reading: 'the file', existing: 'replace', writing: 'the copy' } as const;
  const IN_THE_WAY = { code: FS_FAULT_CODE, side: 'source', origin: 'content', faultClass: 'occupied' } as const;

  it('copies one file\'s bytes and mode, from the handle it judged, making the real directories on its way', async () => {
    const { root } = await srcAndDest();
    const from = safePath.join(root, 'run.sh');
    await fs.writeFile(from, 'echo hi');
    await fs.chmod(from, 0o751);

    await copyRegularFile(from, root, 'bin/tools/copied.sh', COPY);

    const to = safePath.join(root, 'bin', 'tools', 'copied.sh');
    expect(await readUtf8(to)).toBe('echo hi');
    if (PERMISSIONS_ENFORCED) expect((await fs.stat(to)).mode & 0o777).toBe(0o751);
  });

  // The destination is made as `writeFileUnder` makes a file: a copy written through a link a tree
  // kept overwrote the file the link pointed at, and chmod-ed it.
  it.for(['refuse', 'replace'] as const)('never writes or chmods through a LINK at the copy\'s name (existing: %s): the target outside keeps its bytes and mode', async (existing, { skip }) => {
    const cap = symlinkCapability() ?? skip(SKIP_NO_LINKS);
    const { tree, from, victim } = await treeAndVictim();
    await fs.chmod(victim, 0o600);
    await fs.chmod(from, 0o755);
    await createSymlinkAsync(cap, victim, safePath.join(tree, 'link.md'), 'file');

    const failure: unknown = await copyRegularFile(from, tree, 'link.md', { ...COPY, existing }).catch((error: unknown) => error);

    expect(failure, String(failure)).toMatchObject({ ...IN_THE_WAY, path: safePath.join(tree, 'link.md'), message: expect.stringContaining('write the copy') as unknown });
    expect(await readUtf8(victim)).toBe('precious');
    if (PERMISSIONS_ENFORCED) expect((await fs.stat(victim)).mode & 0o777).toBe(0o600);
    expect((await fs.lstat(safePath.join(tree, 'link.md'))).isSymbolicLink()).toBe(true);
  });

  it('never goes through a LINK standing where one of the copy\'s directories goes: nothing is created where it points', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip(SKIP_NO_LINKS);
    const { root, tree, from } = await treeAndVictim();
    await createSymlinkAsync(cap, safePath.join(root, 'outside'), safePath.join(tree, 'linkdir'), 'dir');

    const failure: unknown = await copyRegularFile(from, tree, 'linkdir/deep/x.md', COPY).catch((error: unknown) => error);

    expect(failure, String(failure)).toMatchObject({ ...IN_THE_WAY, path: safePath.join(tree, 'linkdir') });
    expect(await fs.readdir(safePath.join(root, 'outside'))).toEqual(['victim.md']);
  });

  it('replace takes the place of a regular file there; refuse leaves it as it was; neither removes a directory', async () => {
    const { tree, from } = await treeAndVictim();
    await fs.writeFile(safePath.join(tree, 'a.md'), 'earlier');
    await fs.mkdir(safePath.join(tree, 'dir.md'));

    expect(await copyRegularFile(from, tree, 'a.md', { ...COPY, existing: 'refuse' }).catch((error: unknown) => error)).toMatchObject(IN_THE_WAY);
    expect(await readUtf8(safePath.join(tree, 'a.md'))).toBe('earlier');

    await copyRegularFile(from, tree, 'a.md', COPY);
    expect(await readUtf8(safePath.join(tree, 'a.md'))).toBe('new');

    expect(await copyRegularFile(from, tree, 'dir.md', COPY).catch((error: unknown) => error)).toMatchObject(IN_THE_WAY);
    expect((await fs.stat(safePath.join(tree, 'dir.md'))).isDirectory()).toBe(true);
  });

  it('replace removes nothing for a source that cannot be read', async () => {
    const { root, tree } = await treeAndVictim();
    await fs.writeFile(safePath.join(tree, 'a.md'), 'earlier');

    const failure: unknown = await copyRegularFile(safePath.join(root, 'absent.md'), tree, 'a.md', COPY).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: FS_FAULT_CODE, side: 'source', faultClass: 'absent' });
    expect(await readUtf8(safePath.join(tree, 'a.md'))).toBe('earlier');
  });

  it('classifies a refused read on the side named, saying what was read, and writes nothing', async () => {
    const { root } = await srcAndDest();
    const from = safePath.join(root, 'notes.md');
    await fs.writeFile(from, 'notes');
    const to = safePath.join(root, 'out.md');
    session = installFaultFs({ within: root, faults: [{ family: 'read', op: 'open', path: (p) => p === from, errno: 'EACCES' }] });

    const failure: unknown = await copyRegularFile(from, root, 'out.md', { ...COPY, reading: 'linked file notes.md' }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: FS_FAULT_CODE, side: 'source', origin: 'content', path: from, message: expect.stringContaining('read linked file notes.md') as unknown });
    session.restore();
    await expect(fs.stat(to)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a directory on the side named, never copying it', async () => {
    const { src, root } = await srcAndDest();
    const failure: unknown = await copyRegularFile(src, root, 'x', { ...COPY, side: 'destination', reading: 'the dir' }).catch((error: unknown) => error);
    expect(isFsFaultError(failure) && failure.side === 'destination', String(failure)).toBe(true);
  });

  it.for(['open', 'writeFile', 'fchmod', 'close'])('leaves a failure writing the copy (%s) raw, for the caller to classify', async (op) => {
    const { root } = await srcAndDest();
    const from = safePath.join(root, 'a.md');
    await fs.writeFile(from, 'a');
    const to = safePath.join(root, 'out', 'a.md');
    session = installFaultFs({ within: root, faults: [{ op, path: (p) => p === to, errno: 'ENOSPC' }] });

    const failure: unknown = await copyRegularFile(from, root, 'out/a.md', COPY).catch((error: unknown) => error);

    expect(session.fired.map((call) => call.op)).toEqual([op]);
    expect(isFsFaultError(failure)).toBe(false);
    expect(failure).toMatchObject({ code: 'ENOSPC' });
  });

  it('leaves a root that is not there raw (ENOENT): the root is the caller\'s to make', async () => {
    const { root } = await srcAndDest();
    const from = safePath.join(root, 'a.md');
    await fs.writeFile(from, 'a');
    const failure: unknown = await copyRegularFile(from, safePath.join(root, 'missing-dir'), 'a.md', COPY).catch((error: unknown) => error);
    expect(isFsFaultError(failure)).toBe(false);
    expect(failure).toMatchObject({ code: 'ENOENT' });
  });
});
