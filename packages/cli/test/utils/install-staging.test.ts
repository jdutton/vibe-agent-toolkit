/**
 * An install's `$TMPDIR` staging once the work is done: a staging directory the OS will not
 * remove is a warning naming it on a FINISHED install, never its refusal; a failed install is
 * rethrown as it was. And the plan of a skills install, decided before anything is copied. The
 * temp-directory and presence primitives are replaced, so nothing here touches a disk.
 */

import type * as Utils from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { __internal } from '../../src/commands/claude/plugin/install.js';
import { discardingOnFailure, withResolvedTempDirs } from '../../src/commands/skills/source-resolvers.js';
import { inStaging } from '../../src/utils/install-plan.js';

const { newInstallRun, planInstall, stagedIn } = __internal;

const { withTempDir, disposeTempDir, disposeTempDirAfterFailure, pathPresent } = vi.hoisted(() => ({ withTempDir: vi.fn(), disposeTempDir: vi.fn(), disposeTempDirAfterFailure: vi.fn(), pathPresent: vi.fn() }));
vi.mock('@vibe-agent-toolkit/utils', async (importOriginal) => ({ ...(await importOriginal<typeof Utils>()), withTempDir, disposeTempDir, disposeTempDirAfterFailure, pathPresent }));

const STAGED = '/tmp/vat-install-abc123';
/** `withTempDir` over the fixed directory: runs the work, then answers with `leftover`. */
const disposingWith = (leftover: unknown): void => {
  withTempDir.mockImplementation(async (_prefix: string, work: (dir: string) => Promise<unknown>) => ({ value: await work(STAGED), leftover }));
};

afterEach(() => {
  withTempDir.mockReset();
  disposeTempDir.mockReset();
  disposeTempDirAfterFailure.mockReset();
  pathPresent.mockReset();
});

describe('inStaging', () => {
  it('runs the work in the staging directory and says nothing when it was removed', async () => {
    disposingWith(undefined);
    const work = vi.fn(async () => undefined);
    const onLeftover = vi.fn();

    await inStaging('vat-install-', work, onLeftover);

    expect(withTempDir).toHaveBeenCalledWith('vat-install-', expect.any(Function));
    expect(work).toHaveBeenCalledWith(STAGED);
    expect(onLeftover).not.toHaveBeenCalled();
  });

  it('hands a staging directory that would not go to the caller as one warning naming and linking it', async () => {
    disposingWith(new Error('EBUSY: resource busy or locked'));
    const onLeftover = vi.fn();

    await inStaging('vat-install-', async () => undefined, onLeftover);

    expect(onLeftover).toHaveBeenCalledTimes(1);
    expect(onLeftover.mock.calls[0]?.[0]).toMatchObject({
      code: 'TREE_CLEANUP_INCOMPLETE',
      severity: 'warning',
      link: STAGED,
      message: `The install is complete, but its staging directory ${STAGED} could not be removed: EBUSY: resource busy or locked`,
    });
  });

  it('rethrows a failed install as it was, with no warning', async () => {
    disposingWith(undefined);
    const failure = new Error('copy refused');
    const onLeftover = vi.fn();

    await expect(inStaging('vat-install-', async () => {
      throw failure;
    }, onLeftover)).rejects.toBe(failure);
    expect(onLeftover).not.toHaveBeenCalled();
  });
});

describe('stagedIn (vat claude plugin install)', () => {
  const runOf = () => newInstallRun({}, { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never);

  it('declares the staging directory as the run\'s own scratch before the work reads it', async () => {
    disposingWith(undefined);
    const run = runOf();
    let rootsDuringWork: string[] = [];

    await stagedIn(run, 'vat-install-zip-', async (dir) => {
      rootsDuringWork = [...run.roots.environment];
      expect(dir).toBe(STAGED);
    });

    expect(rootsDuringWork).toEqual([STAGED]);
    expect(run.issues).toEqual([]);
  });

  it('a staging directory left behind is a warning on the run, logged, and the install stands', async () => {
    disposingWith(new Error('EACCES: permission denied'));
    const run = runOf();

    await stagedIn(run, 'vat-install-zip-', async () => undefined);

    expect(run.issues).toEqual([expect.objectContaining({ code: 'TREE_CLEANUP_INCOMPLETE', link: STAGED })]);
    expect(run.logger.warn).toHaveBeenCalledWith(expect.stringContaining(STAGED));
  });
});

describe('discardingOnFailure', () => {
  it('hands back what the work made and leaves the directory for the caller it is returned to', async () => {
    await expect(discardingOnFailure(STAGED, async () => 'extracted')).resolves.toBe('extracted');
    expect(disposeTempDirAfterFailure).not.toHaveBeenCalled();
  });

  it('disposes of the directory when the work throws, and rethrows that same failure', async () => {
    const failure = new Error('not a tarball');
    await expect(discardingOnFailure(STAGED, () => {
      throw failure;
    })).rejects.toBe(failure);
    expect(disposeTempDirAfterFailure).toHaveBeenCalledWith(STAGED, failure);
  });
});

describe('withResolvedTempDirs', () => {
  const DIRS = ['/tmp/vat-npm-1', '/tmp/vat-npm-2'];

  it('disposes of every directory once the work is done, and names each one that stayed', async () => {
    disposeTempDir.mockImplementation(async (dir: string) => (dir === DIRS[1] ? new Error(`could not remove ${dir}`) : undefined));

    const { value, leftovers } = await withResolvedTempDirs(DIRS, () => 'listed');

    expect(value).toBe('listed');
    expect(disposeTempDir.mock.calls.map((call) => call[0])).toEqual(DIRS);
    expect(leftovers).toEqual([expect.objectContaining({ code: 'TREE_CLEANUP_INCOMPLETE', message: 'could not remove /tmp/vat-npm-2' })]);
  });

  it('a disposal that throws is a warning naming the directory, never the work\'s failure', async () => {
    disposeTempDir.mockRejectedValue(new Error('outside the temp directory'));
    const { leftovers } = await withResolvedTempDirs([DIRS[0] ?? ''], () => 1);
    expect(leftovers).toEqual([expect.objectContaining({ link: '/tmp/vat-npm-1', message: 'Could not remove temp directory /tmp/vat-npm-1: outside the temp directory' })]);
  });

  it('when the work fails, disposes of each directory beside that failure, in order, and rethrows it', async () => {
    const failure = new Error('validation crashed');
    await expect(withResolvedTempDirs(DIRS, () => {
      throw failure;
    })).rejects.toBe(failure);
    expect(disposeTempDirAfterFailure.mock.calls).toEqual([[DIRS[0], failure], [DIRS[1], failure]]);
    expect(disposeTempDir).not.toHaveBeenCalled();
  });
});

describe('planInstall (the skills lanes)', () => {
  const SKILLS_DIR = '/home/u/.claude/skills';
  const runWith = (options: Record<string, unknown> = {}) => newInstallRun({ skillsDir: SKILLS_DIR, ...options }, { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never);

  it('a package\'s declared skills are one copy each, from its dist/skills under the fs-safe name, with no registry edit', async () => {
    pathPresent.mockReturnValue(true);

    const planned = await planInstall(runWith(), { kind: 'skills', side: 'environment', rootDir: '/tmp/pkg', skillNames: ['plain', 'pkg:sub'] } as never, 'copy');

    expect(planned.registry).toBeNull();
    expect(planned.replaced).toEqual([]);
    expect(planned.skills).toEqual([
      { name: 'plain', installPath: `${SKILLS_DIR}/plain`, sourcePath: null },
      { name: 'pkg:sub', installPath: `${SKILLS_DIR}/pkg:sub`, sourcePath: null },
    ]);
    expect(planned.changes.map((change) => (change.op === 'replace' && change.fill.from === 'copy' ? [change.fill.source, change.fill.side, change.ownership.kind] : change.op))).toEqual([
      ['/tmp/pkg/dist/skills/plain', 'environment', 'must-be-free'],
      ['/tmp/pkg/dist/skills/pkg__sub', 'environment', 'must-be-free'],
    ]);
    // The build is confirmed present on the side the package is on, before anything is planned to change.
    expect(pathPresent).toHaveBeenCalledWith('/tmp/pkg/dist/skills/plain', 'follow', 'environment', 'confirmed');
  });

  it('one skill directory is one copy from that directory, and --force may take what is there', async () => {
    pathPresent.mockReturnValue(true);
    const planned = await planInstall(runWith({ force: true }), { kind: 'skill-dir', side: 'source', skillPath: '/src/my-skill', skillName: 'my-skill' } as never, 'copy');
    expect(planned.changes).toEqual([expect.objectContaining({ dest: `${SKILLS_DIR}/my-skill`, ownership: { kind: 'force' }, label: 'skill my-skill' })]);
  });

  it('a declared skill with no build rejects as the invocation\'s mistake, naming the path', async () => {
    pathPresent.mockReturnValue(false);
    await expect(planInstall(runWith(), { kind: 'skills', side: 'source', rootDir: '/proj', skillNames: ['unbuilt'] } as never, 'copy'))
      .rejects.toMatchObject({ refusal: 'USAGE_INVALID', message: 'Skill "unbuilt" has no build to install. Path does not exist: /proj/dist/skills/unbuilt' });
  });

  it('a skill name that is not one path segment rejects before any destination is formed', async () => {
    pathPresent.mockReturnValue(true);
    await expect(planInstall(runWith(), { kind: 'skill-dir', side: 'source', skillPath: '/src/x', skillName: '../victim' } as never, 'copy'))
      .rejects.toMatchObject({ refusal: 'INPUT_UNREADABLE' });
  });
});
