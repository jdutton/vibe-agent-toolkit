/**
 * `vat skills build` — what a FAILED repair of `dist/skills` tells the operator.
 *
 * Two lanes reach `BuildStaging.recover()` after the filesystem refused a move,
 * and both used to lose the second refusal: the residue line named the wrong
 * reason when this run's own output had already been promoted, and the packager
 * defect lane printed its recovery to stderr only, so the published document
 * never named the parked tree an operator needs to move back.
 *
 * `rm` and `rename` are named imports in the build, so a refusal is injected at
 * the module seam for exactly one path; every other call runs for real. The
 * packager is stubbed because a defect cannot be staged from a fixture.
 */

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { beginStagedBuild, runSkillsBuildPhase, settleStaging } from '../../../src/commands/skills/build.js';
import { publishedPhase } from '../../helpers/published-phase.js';
import { errno, realBehind, refusingOnly } from '../../helpers/refusal-doubles.js';
import { createTempDirTracker } from '../../system/test-common.js';
import { silentLogger } from '../../test-doubles.js';

vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('../../helpers/refusal-doubles.js')).spiedModule(importOriginal, ['rm', 'rename']));

const DEFECT = new TypeError("Cannot read properties of undefined (reading 'size')");

vi.mock('@vibe-agent-toolkit/agent-skills', async (importOriginal) =>
  (await import('../../helpers/stubbed-packager.js')).withStubbedPackager(importOriginal, (specs) =>
    Promise.resolve(specs.map(({ skillPath }) => ({ status: 'failed' as const, skillPath, error: DEFECT })))));

/** Seed `dist/skills/kept/SKILL.md`, as a previous good build would have. */
async function seedPrevious(cwd: string): Promise<void> {
  await mkdir(safePath.join(cwd, 'dist', 'skills', 'kept'), { recursive: true });
  await writeFile(safePath.join(cwd, 'dist', 'skills', 'kept', 'SKILL.md'), 'previous\n');
}

describe('vat skills build - a failed staging repair names its real reason, in the document', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-build-staging-recovery-');

  afterEach(() => {
    vi.mocked(rm).mockImplementation(realBehind(rm));
    vi.mocked(rename).mockImplementation(realBehind(rename));
    return cleanupTempDirs();
  });

  it('reports the removal that failed, not "occupied", when this run\'s own output was promoted', async () => {
    const cwd = createTempDir();
    await seedPrevious(cwd);
    const staging = await beginStagedBuild(cwd, undefined);
    await mkdir(safePath.join(staging.root, 'fresh'), { recursive: true });
    vi.mocked(rm).mockImplementation(refusingOnly(staging.parkedPath, errno('EACCES', 'EACCES: permission denied'), realBehind(rm)));

    const settled = await settleStaging(staging, false, silentLogger);

    expect(settled.outputCommitted).toBe(true);
    expect(settled.promotionError).toContain(`${staging.parkedPath} — removal failed: EACCES`);
    expect(settled.promotionError).not.toContain('occupied');
  });

  it('carries the recovery of a failed abort on the defect path into the published refusal', async () => {
    const cwd = createTempDir();
    await seedPrevious(cwd);
    await mkdir(safePath.join(cwd, 'skills', 'demo'), { recursive: true });
    await writeFile(
      safePath.join(cwd, 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: A skill whose packaging is made to throw in a test.\n---\n\n# demo\n\nNothing to see.\n',
    );
    await writeFile(safePath.join(cwd, 'vibe-agent-toolkit.config.yaml'), 'skills:\n  include: ["skills/**/SKILL.md"]\n');
    // Restoring the parked previous output is refused, both in `abort()` and in the repair after it.
    const real = realBehind(rename);
    vi.mocked(rename).mockImplementation((from, to) =>
      String(from).endsWith('.previous') ? Promise.reject(errno('EACCES', 'EACCES: permission denied')) : real(from, to));

    const { exitCode, document } = publishedPhase('skills build', await runSkillsBuildPhase(cwd, {}));

    expect(exitCode).toBe(ExitCode.ERROR);
    expect(document).toMatchObject({ status: 'error', error: { code: 'INTERNAL_ERROR' } });
    const message = (document as unknown as { error: { message: string } }).error.message;
    expect(message).toContain(DEFECT.message);
    expect(message).toMatch(/is parked at \S+\.previous/);
    expect(message).toContain('Recover it with: mv ');
  });
});
