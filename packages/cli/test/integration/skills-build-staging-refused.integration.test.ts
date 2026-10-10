/**
 * `vat skills build` when the filesystem refuses the swap that promotes `dist/skills`: every case
 * here runs a real build into a temp project and fails one call of it (`installFaultFs`). What the
 * run reports and where it lands, with nothing refused, is the unit suite's
 * (`test/commands/skills/build-staging.test.ts`).
 */
import { existsSync } from 'node:fs';
import fsPromises, { mkdir, readFile, writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { installFaultFs, type FaultRule } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { refusalCodeOf } from '../../src/utils/command-refusal.js';
import {
  build,
  CLEAN_BODY,
  distEntries,
  OTHER_RUN_BUNDLE,
  OTHER_RUN_BYTES,
  PREVIOUS_BUNDLE,
  readBundle,
  seedPreviousOutput,
  STAGING_INFIX,
} from '../helpers/skills-build-fixture.js';
import { createTempDirTracker } from '../system/test-common.js';

/** Whether `path` is a staged tree beside a destination (never its parked `.previous` twin). */
const isStaged = (path: string): boolean => path.includes(STAGING_INFIX) && !path.endsWith('.previous');

/**
 * The errno a single refused rename is injected with. ⛔ Not `EACCES`, `EPERM` or `EBUSY`: those are
 * CONTENTION on win32 (a scanner, an indexer), where `renameFileAtomic` retries the rename — one
 * injected refusal is then a rename that succeeds, and the test would ask for a failure the product
 * is right not to have. `EXDEV` is final on every host.
 */
const UNRETRIED: FaultRule['errno'] = 'EXDEV';

/** Run `work` with the fault rules installed under `cwd`, restoring the filesystem after. */
async function withFaults<T>(cwd: string, faults: FaultRule[], work: () => Promise<T>): Promise<T> {
  const session = installFaultFs({ within: cwd, faults });
  try {
    return await work();
  } finally {
    session.restore();
  }
}

describe('runSkillBuild - a failed swap still leaves an answer', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-build-staging-promote-');

  afterEach(() => cleanupTempDirs());

  it('a swap the OS refuses after a clean build: the previous output intact, the promotion failure RUN_INCOMPLETE, nothing staged left', async () => {
    const cwd = createTempDir();
    await seedPreviousOutput(cwd, ['kept']);

    const run = await withFaults(cwd, [{ family: 'rename', path: isStaged, errno: UNRETRIED }], () => build(cwd, [['good', CLEAN_BODY]]));

    expect(run.outputCommitted).toBe(false);
    expect(refusalCodeOf(run.promotionFailure?.error)).toBe('RUN_INCOMPLETE');
    expect(run.promotionFailure?.description).toContain('Build output promotion failed');
    expect(run.promotionFailure?.description).toContain('The previous dist/skills is intact');
    await expect(readBundle(cwd, 'kept')).resolves.toBe(PREVIOUS_BUNDLE);
    await expect(distEntries(cwd)).resolves.toEqual(['skills']);
  });

  it('a swap refused and its restore refused too: the parked previous output is named, with the mv that restores it', async () => {
    const cwd = createTempDir();
    await seedPreviousOutput(cwd, ['kept']);
    // The park is the first rename naming a `.previous`; the restore is the second.
    const faults: FaultRule[] = [
      { family: 'rename', path: isStaged, errno: UNRETRIED },
      { family: 'rename', path: (path) => path.endsWith('.previous'), nth: 2, errno: UNRETRIED },
    ];

    const run = await withFaults(cwd, faults, () => build(cwd, [['good', CLEAN_BODY]]));

    expect(run.outputCommitted).toBe(false);
    expect(refusalCodeOf(run.promotionFailure?.error)).toBe('RUN_INCOMPLETE');
    const parked = (await distEntries(cwd)).find((name) => name.endsWith('.previous'));
    expect(parked).toBeDefined();
    expect(run.promotionFailure?.description).toContain(`mv ${safePath.join(cwd, 'dist', parked ?? '')} ${safePath.join(cwd, 'dist', 'skills')}`);
    await expect(readFile(safePath.join(cwd, 'dist', parked ?? '', 'kept', 'SKILL.md'), 'utf8')).resolves.toBe(PREVIOUS_BUNDLE);
  });

  // The concurrent-build case, which needs no injected errno: another run promotes its own output
  // between this run's park and its swap. The swap cannot land on the occupied path, and the
  // restore must NOT replace the other run's fresh output with this run's stale previous one —
  // the previous tree stays parked, named with the `mv` that restores it, the other run's output kept.
  it('a dist/skills reoccupied between the park and the swap: the other run\'s output is kept, the previous tree parked and named', async () => {
    const cwd = createTempDir();
    await seedPreviousOutput(cwd, ['kept']);
    const distSkills = safePath.join(cwd, 'dist', 'skills');
    const realRename = fsPromises.rename.bind(fsPromises);
    const spy = vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      // The swap: a staged tree renamed onto dist/skills. The other run got there first.
      if (String(to) === distSkills && isStaged(String(from)) && !existsSync(distSkills)) {
        await mkdir(safePath.join(distSkills, OTHER_RUN_BUNDLE), { recursive: true });
        await writeFile(safePath.join(distSkills, OTHER_RUN_BUNDLE, 'SKILL.md'), OTHER_RUN_BYTES);
      }
      return realRename(from, to);
    });
    let run: SkillBuildRun;
    try {
      run = await build(cwd, [['good', CLEAN_BODY]]);
    } finally {
      spy.mockRestore();
    }

    expect(run.outputCommitted).toBe(false);
    expect(run.promotionFailure?.error).toMatchObject({ code: 'TREE_ROLLBACK_INCOMPLETE' });
    const parked = (await distEntries(cwd)).find((name) => name.endsWith('.previous'));
    expect(parked).toBeDefined();
    expect(run.promotionFailure?.description).toContain(`mv ${safePath.join(cwd, 'dist', parked ?? '')} ${distSkills}`);
    await expect(readFile(safePath.join(distSkills, OTHER_RUN_BUNDLE, 'SKILL.md'), 'utf8')).resolves.toBe(OTHER_RUN_BYTES);
    await expect(readFile(safePath.join(cwd, 'dist', parked ?? '', 'kept', 'SKILL.md'), 'utf8')).resolves.toBe(PREVIOUS_BUNDLE);
  });

  it('a previous output the OS will not remove once replaced: the run committed, and a warning names the parked tree', async () => {
    const cwd = createTempDir();
    await seedPreviousOutput(cwd, ['kept']);

    // A rule fires once, on its first match that no earlier rule took: one for the removal's first
    // try, one for its retry after the walk.
    const parkedRemoval = (): FaultRule => ({ family: 'remove', op: 'rm', path: (path) => path.endsWith('.previous'), errno: 'EACCES' });

    const run = await withFaults(cwd, [parkedRemoval(), parkedRemoval()], () => build(cwd, [['good', CLEAN_BODY]]));

    expect(run.outputCommitted).toBe(true);
    expect(run.promotionFailure).toBeUndefined();
    await expect(readBundle(cwd, 'good')).resolves.toContain('name: good');
    const parked = (await distEntries(cwd)).find((name) => name.endsWith('.previous'));
    expect(run.residue).toEqual([expect.objectContaining({ code: 'TREE_CLEANUP_INCOMPLETE', severity: 'warning', link: safePath.join(cwd, 'dist', parked ?? '') })]);
  });
});

describe('runSkillBuild - a filesystem refusal is coded at its cause, never INTERNAL_ERROR', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-build-staging-refusal-');

  afterEach(() => cleanupTempDirs());

  it('refuses a previous output the OS will not examine as a destination fault (RUN_INCOMPLETE), before anything moves', async () => {
    // `existsSync` read EACCES as "no previous output", so the run went on to
    // promote over a tree it could not see.
    const cwd = createTempDir();
    await seedPreviousOutput(cwd, ['kept']);
    const target = safePath.join(cwd, 'dist', 'skills');

    const refused = await withFaults(cwd, [{ family: 'meta', path: (path) => path === target, errno: 'EACCES' }], () => build(cwd, [['good', CLEAN_BODY]]).catch((error: unknown) => error));

    expect(refused).toMatchObject({ code: 'FS_FAULT', side: 'destination', faultClass: 'refused' });
    expect(refusalCodeOf(refused)).toBe('RUN_INCOMPLETE');
    expect(String((refused as Error).message)).toContain(target);
    await expect(readBundle(cwd, 'kept')).resolves.toBe(PREVIOUS_BUNDLE);
  });

  it('refuses a previous output that cannot be parked as RUN_INCOMPLETE, naming the path', async () => {
    const cwd = createTempDir();
    await seedPreviousOutput(cwd, ['kept']);
    const target = safePath.join(cwd, 'dist', 'skills');

    const run = await withFaults(cwd, [{ family: 'rename', path: (path) => path === target, nth: 1, errno: UNRETRIED }], () => build(cwd, [['good', CLEAN_BODY]]));

    expect(refusalCodeOf(run.promotionFailure?.error)).toBe('RUN_INCOMPLETE');
    expect(run.promotionFailure?.description).toContain(target);
    await expect(readBundle(cwd, 'kept')).resolves.toBe(PREVIOUS_BUNDLE);
  });

  // The post-build checks re-read the staged bundle: a raw errno there escaped as
  // INTERNAL_ERROR. The staged tree is the destination's, so the refusal is RUN_INCOMPLETE.
  it('refuses a staged bundle the OS will not list as RUN_INCOMPLETE, the previous output intact and nothing staged left', async () => {
    const cwd = createTempDir();
    await seedPreviousOutput(cwd, ['kept']);
    const stagedBundle = (path: string): boolean => /\/dist\/\.[^/]+\/good$/.test(path);

    const refused = await withFaults(cwd, [{ family: 'list', path: stagedBundle, errno: 'EACCES' }], () => build(cwd, [['good', CLEAN_BODY]]).catch((error: unknown) => error));

    expect(refusalCodeOf(refused)).toBe('RUN_INCOMPLETE');
    await expect(readBundle(cwd, 'kept')).resolves.toBe(PREVIOUS_BUNDLE);
    await expect(distEntries(cwd)).resolves.toEqual(['skills']);
  });
});
