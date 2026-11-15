/**
 * `vat skills build` — where one run's output lands: every pre-build failure reported in one run,
 * and `dist/skills` replaced only by a build that succeeded. What the run REPORTS is
 * `build-report.test.ts`; a swap the filesystem refuses is the integration tier's
 * (`test/integration/skills-build-staging-refused.integration.test.ts`).
 */
import { statSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BROKEN_BODY,
  build,
  CLEAN_BODY,
  distEntries,
  PREVIOUS_BUNDLE,
  readBundle,
  seedPreviousOutput,
} from '../../helpers/skills-build-fixture.js';
import { createTempDirTracker } from '../../system/test-common.js';

describe('runSkillBuild - one run reports EVERY pre-build validation failure', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-build-staging-validate-');

  beforeEach(() => {
    // A guard, not a convenience: collecting failures instead of aborting is the
    // whole point, so any `process.exit` from inside the run is a regression.
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`runSkillBuild called process.exit(${String(code)}) instead of collecting the failure`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    return cleanupTempDirs();
  });

  it('names both failing skills, not just the first', async () => {
    const run = await build(createTempDir(), [
      ['bad-one', BROKEN_BODY],
      ['bad-two', BROKEN_BODY],
      ['good', CLEAN_BODY],
    ]);
    expect(run.validationFailures.map((f) => f.name)).toEqual(['bad-one', 'bad-two']);
  });

  it('carries each failure\'s own findings rather than a flat one-error stand-in', async () => {
    const run = await build(createTempDir(), [['bad-one', BROKEN_BODY], ['good', CLEAN_BODY]]);
    expect(run.validationFailures[0]?.issues.filter((i) => i.severity === 'error').map((i) => i.code)).toContain('LINK_MISSING_TARGET');
  });

  it('still packages the skills that passed', async () => {
    const run = await build(createTempDir(), [['bad-one', BROKEN_BODY], ['good', CLEAN_BODY]]);
    expect(run.results.map((r) => r.name)).toEqual(['good']);
  });
});

describe('runSkillBuild - dist/skills is replaced only by a build that succeeded', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-build-staging-swap-');

  afterEach(() => cleanupTempDirs());

  it('leaves the previous bundle byte-intact when the run fails', async () => {
    const cwd = createTempDir();
    await seedPreviousOutput(cwd, ['kept']);
    const run = await build(cwd, [['good', CLEAN_BODY], ['bad', BROKEN_BODY]]);

    expect(run.outputCommitted).toBe(false);
    await expect(readBundle(cwd, 'kept')).resolves.toBe(PREVIOUS_BUNDLE);
    // And the run it just discarded left nothing of itself behind.
    await expect(distEntries(cwd)).resolves.toEqual(['skills']);
    await expect(readdir(safePath.join(cwd, 'dist', 'skills'))).resolves.toEqual(['kept']);
  });

  it('promotes the staged tree on success, leaving no staging directory behind', async () => {
    const cwd = createTempDir();
    const run = await build(cwd, [['good', CLEAN_BODY]]);

    expect(run.outputCommitted).toBe(true);
    await expect(readBundle(cwd, 'good')).resolves.toContain('name: good');
    await expect(distEntries(cwd)).resolves.toEqual(['skills']);
  });

  // A full build's staged tree BECOMES `dist/skills`: it must get the mode any
  // directory the build makes gets, never a temp directory's 0700.
  it.skipIf(process.platform === 'win32')('promotes dist/skills with the ordinary directory mode, not a temp dir\'s 0700', async () => {
    const cwd = createTempDir();
    const probe = safePath.join(cwd, 'mode-probe');
    await mkdir(probe);
    const ordinary = statSync(probe).mode & 0o777;

    const run = await build(cwd, [['good', CLEAN_BODY]]);

    expect(run.outputCommitted).toBe(true);
    expect((statSync(safePath.join(cwd, 'dist', 'skills')).mode & 0o777).toString(8)).toBe(ordinary.toString(8));
  });

  it('reports the FINAL output path, never the path it staged through', async () => {
    const cwd = createTempDir();
    const run = await build(cwd, [['good', CLEAN_BODY]]);
    expect(run.results[0]?.result.outputPath).toBe(safePath.resolve(cwd, 'dist', 'skills', 'good'));
  });

  it('removes a stale bundle the successful build no longer produces', async () => {
    const cwd = createTempDir();
    await seedPreviousOutput(cwd, ['stale']);
    const run = await build(cwd, [['good', CLEAN_BODY]]);

    expect(run.outputCommitted).toBe(true);
    await expect(readdir(safePath.join(cwd, 'dist', 'skills'))).resolves.toEqual(['good']);
  });

  it('replaces only the named skill in --skill mode', async () => {
    const cwd = createTempDir();
    await seedPreviousOutput(cwd, ['one', 'two']);
    const run = await build(cwd, [['one', CLEAN_BODY]], { onlySkill: 'one' });

    expect(run.outputCommitted).toBe(true);
    await expect(readBundle(cwd, 'one')).resolves.toContain('name: one');
    await expect(readBundle(cwd, 'two')).resolves.toBe(PREVIOUS_BUNDLE);
    await expect(distEntries(cwd)).resolves.toEqual(['skills']);
  });

  it('leaves the named skill\'s previous bundle intact when --skill mode fails', async () => {
    const cwd = createTempDir();
    await seedPreviousOutput(cwd, ['one', 'two']);
    const run = await build(cwd, [['one', BROKEN_BODY]], { onlySkill: 'one' });

    expect(run.outputCommitted).toBe(false);
    await expect(readBundle(cwd, 'one')).resolves.toBe(PREVIOUS_BUNDLE);
    await expect(readBundle(cwd, 'two')).resolves.toBe(PREVIOUS_BUNDLE);
    await expect(distEntries(cwd)).resolves.toEqual(['skills']);
  });
});
