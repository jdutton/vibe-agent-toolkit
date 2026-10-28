/**
 * One link, one answer: the SAME link, failing with the SAME errno, is classified the same way by
 * every lane that looks at it — the link validator's existence walk (`vat resources validate`), the
 * projection's filesystem extent (`vat resources query` / `check`), and the plugin tree copy every
 * build and install goes through. A link the OS looked at and found nothing behind (dangling, a loop)
 * is missing or unresolvable everywhere; one the OS declined or could not complete (`EACCES`, `EIO`,
 * Windows' `UNKNOWN`) is unreadable or a fault everywhere — never "missing" on one lane and
 * "unreadable" on the next.
 *
 * The divergence this pins: the existence walk used to call a directory that loops (`ELOOP` from
 * `readdir`) unreadable while the realpath beside it, through `isUnresolvableLinkError`, called the
 * same link a link to nothing.
 *
 * Each fixture is ONE tree, `docs/a.md` linking `./alias/x.md` through `docs/alias`, judged by all
 * three lanes.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';

import { FilesystemCrawlSource, FilesystemExtentContributor, ProjectionBuilder, ResourceRegistry } from '@vibe-agent-toolkit/resources';
import { createSymlink, FS_FAULT_CODE, mkdirSyncReal, realpathNativeSync, safePath, symlinkCapability, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { GitTracker } from '@vibe-agent-toolkit/utils/git';
import { CANNOT_DENY_READS, createTempDir, gitExecutable, installFaultFs, removeTempDir, type FaultFsSession, type InjectedErrno } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { PluginSymlinkRefusedError, treeCopyPlugin } from '../../src/commands/claude/plugin/tree-copy.js';
import { refusalCodeOf } from '../../src/utils/command-refusal.js';

const CAPABILITY = symlinkCapability();

let session: FaultFsSession | undefined;
const scratch: string[] = [];
const locked: string[] = [];

afterEach(() => {
  session?.restore();
  session = undefined;
  for (const dir of locked.splice(0)) chmodSync(dir, 0o755);
  for (const dir of scratch.splice(0)) removeTempDir(dir);
});

/** How `docs/alias` is made to fail, and the errno class every lane must agree on. */
interface LinkFixture {
  readonly label: string;
  /** The link's target text, relative to `docs/`. */
  readonly target: string;
  /** Build whatever the target needs inside the project root. */
  readonly prepare?: (root: string) => void;
  /** An errno injected at every `realpath` of the link (the OS's answer, where a real tree cannot produce it). */
  readonly inject?: InjectedErrno;
  /** The fault class the projection row carries, or null for "resolves to nothing". */
  readonly faultClass: string | null;
}

/**
 * `docs/a.md -> ./alias/x.md`, `docs/alias -> <fixture target>`, in a repository (the validator runs
 * its containment and leak checks only there); the parent and the project root. Every target is
 * INSIDE the project, so each lane judges it rather than calling it outside.
 */
function tree(fixture: LinkFixture): { parent: string; root: string; arm: () => void } {
  if (CAPABILITY === null) throw new Error('unreachable — the suite is skipped without the capability');
  const made = createTempDir('vat-link-one-answer-');
  scratch.push(made);
  // The real spelling (macOS `/var` is `/private/var`), so the injected fault matches the path every
  // lane asks about, however it spelled the root.
  const parent = realpathNativeSync(made);
  const root = safePath.join(parent, 'project');
  mkdirSyncReal(safePath.join(root, 'docs'), { recursive: true });
  spawnSync(gitExecutable(), ['init', '-b', 'main', '--quiet', root], { stdio: 'ignore' });
  writeFileSync(safePath.join(root, 'docs', 'a.md'), '# a\n\nSee [x](./alias/x.md).\n');
  fixture.prepare?.(root);
  const alias = safePath.join(root, 'docs', 'alias');
  createSymlink(CAPABILITY, fixture.target, alias);
  // Tracked, so the tree copy's git route sweeps the link as a member.
  spawnSync(gitExecutable(), ['add', '-A'], { cwd: root, stdio: 'ignore' });
  // A rule fails ONE matching call (and its immediate retries), so it is armed afresh before each
  // lane: every lane meets the same refusal on its own first look.
  const arm = (): void => {
    if (fixture.inject === undefined) return;
    session?.restore();
    const errno = fixture.inject;
    session = installFaultFs({ within: parent, faults: [{ op: 'realpath', path: (path) => path === alias || toForwardSlash(path).startsWith(`${alias}/`), errno, everyTry: true }] });
  };
  return { parent, root, arm };
}

/** A real directory holding `inner/x.md`, so only the injected errno stands between the link and its target. */
function realTarget(root: string): void {
  mkdirSyncReal(safePath.join(root, 'real', 'inner'), { recursive: true });
  writeFileSync(safePath.join(root, 'real', 'inner', 'x.md'), '# x\n');
}

/** The validator's verdict on `./alias/x.md`, as `vat resources validate` reaches it. */
async function validatorCode(root: string): Promise<string | null> {
  const registry = new ResourceRegistry({ baseDir: root });
  await registry.addResource(safePath.join(root, 'docs', 'a.md'));
  const result = await registry.validate();
  const issue = result.issues.find((candidate) => candidate.link?.includes('alias/x.md') === true);
  return issue?.code ?? null;
}

/** The filesystem extent's condition row for the link. */
async function extentRow(root: string): Promise<{ code: string; targetFaultClass: string | null } | undefined> {
  const tracker = new GitTracker(root);
  await tracker.initialize({ includeUntracked: true });
  const builder = new ProjectionBuilder({ root, gitTracker: tracker });
  const contribution = await new FilesystemExtentContributor((at) => new FilesystemCrawlSource(at, [])).contribute(builder.base(), null);
  return contribution.conditions.find((row) => row.path === 'docs/alias');
}

/** What the plugin tree copy does with `docs/` as its source. */
async function treeCopyOutcome(root: string, parent: string): Promise<unknown> {
  return treeCopyPlugin({ sourceDir: safePath.join(root, 'docs'), destDir: safePath.join(parent, 'dest') })
    .then(() => 'copied', (error: unknown) => error);
}

/** Absent: the OS looked and found nothing. Every lane says missing / unresolvable. */
const ABSENT: readonly LinkFixture[] = [
  { label: 'dangling (ENOENT)', target: '../nowhere', faultClass: null },
  { label: 'a loop (ELOOP)', target: 'alias', faultClass: null },
];

/** A fault: the OS declined or could not complete the lookup. Every lane says unreadable / fault. */
const FAULTS: readonly LinkFixture[] = [
  { label: 'injected EIO (device)', target: '../real/inner', prepare: realTarget, inject: 'EIO', faultClass: 'device' },
  { label: 'injected UNKNOWN (device — libuv src/win/error.c:172: a missing share AND refused credentials)', target: '../real/inner', prepare: realTarget, inject: 'UNKNOWN', faultClass: 'device' },
  { label: 'injected EACCES (refused)', target: '../real/inner', prepare: realTarget, inject: 'EACCES', faultClass: 'refused' },
  // Ambiguous on Windows (libuv src/win/error.c: four Win32 errors are EINVAL, :102-105; a buffer overflow is ENAMETOOLONG, :129).
  { label: 'injected EINVAL (unsupported — ambiguous, never "nothing there")', target: '../real/inner', prepare: realTarget, inject: 'EINVAL', faultClass: 'unsupported' },
  { label: 'injected ENAMETOOLONG (wrong-type — ambiguous, never "nothing there")', target: '../real/inner', prepare: realTarget, inject: 'ENAMETOOLONG', faultClass: 'wrong-type' },
  // A file call on a share whose network failed (libuv src/win/error.c :131).
  { label: 'injected ENETUNREACH (device)', target: '../real/inner', prepare: realTarget, inject: 'ENETUNREACH', faultClass: 'device' },
  // The table is not the guarantee: an errno it does not list is a device fault, never handed back raw.
  { label: 'injected EWHATEVER (device — an errno no table lists)', target: '../real/inner', prepare: realTarget, inject: 'EWHATEVER', faultClass: 'device' },
];

describe.skipIf(CAPABILITY === null)('one link, one errno, one answer on every lane', () => {
  it.each(ABSENT)('$label: missing to the validator, unresolved to the extent, unresolvable to the tree copy', async (fixture) => {
    const { parent, root } = tree(fixture);

    expect(await validatorCode(root)).toBe('LINK_BROKEN_FILE');
    expect(await extentRow(root)).toMatchObject({ code: 'EXTENT_SYMLINK_TARGET_UNRESOLVED', targetFaultClass: null });
    const copied = await treeCopyOutcome(root, parent);
    expect(copied).toBeInstanceOf(PluginSymlinkRefusedError);
    expect((copied as PluginSymlinkRefusedError).refused).toEqual([{ path: 'alias', reason: 'unresolvable' }]);
  });

  it.each(FAULTS)('$label: unreadable to the validator, unreadable to the extent, a classified fault to the tree copy', async (fixture) => {
    const { parent, root, arm } = tree(fixture);

    arm();
    expect(await validatorCode(root)).toBe('LINK_TARGET_UNREADABLE');
    arm();
    expect(await extentRow(root)).toMatchObject({ code: 'EXTENT_SYMLINK_TARGET_UNREADABLE', targetFaultClass: fixture.faultClass });
    arm();
    const copied = await treeCopyOutcome(root, parent);
    expect(copied).toMatchObject({ code: FS_FAULT_CODE, errno: fixture.inject, side: 'source' });
    expect(refusalCodeOf(copied)).toBe('INPUT_UNREADABLE');
  });

  // The same refusal from a REAL mode bit, where the host can deny a read: no injection between the
  // lanes and the kernel.
  it.skipIf(CANNOT_DENY_READS)('a real EACCES (a 000 directory on the way): unreadable on every lane', async () => {
    const fixture: LinkFixture = {
      label: 'real EACCES',
      target: '../locked/inner',
      // Gitignored, so the projection records the unlistable directory rather than refusing the run
      // over a locked directory inside its population — the link is what this asks about.
      prepare: (root) => {
        writeFileSync(safePath.join(root, '.gitignore'), 'locked/\n');
        const dir = safePath.join(root, 'locked');
        mkdirSyncReal(safePath.join(dir, 'inner'), { recursive: true });
        writeFileSync(safePath.join(dir, 'inner', 'x.md'), '# x\n');
        chmodSync(dir, 0o000);
        locked.push(dir);
      },
      faultClass: 'refused',
    };
    const { parent, root } = tree(fixture);

    expect(await validatorCode(root)).toBe('LINK_TARGET_UNREADABLE');
    expect(await extentRow(root)).toMatchObject({ code: 'EXTENT_SYMLINK_TARGET_UNREADABLE', targetFaultClass: 'refused' });
    const copied = await treeCopyOutcome(root, parent);
    expect(copied).toMatchObject({ code: FS_FAULT_CODE, errno: 'EACCES', side: 'source' });
    expect(refusalCodeOf(copied)).toBe('INPUT_UNREADABLE');
  });
});
