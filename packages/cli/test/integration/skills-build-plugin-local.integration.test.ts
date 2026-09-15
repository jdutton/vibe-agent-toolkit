/**
 * `vat skills build` over a real project whose plugin-local index is LISTED, not stubbed:
 * whether a `publish: false` skill under a plugin's `skills/` is plugin-only or in place
 * depends on whether git tracks it. The same partition over a stubbed index is unit-tested
 * in `test/commands/skills/build-in-place.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

import { runSkillsBuildPhase } from '../../src/commands/skills/build.js';
import {
  pluginProjectConfig,
  pluginSkillDir,
  writeProjectConfig,
  writeSkillProject,
  type FixtureSkill,
} from '../helpers/plugin-local-fixture.js';
import { captureStdout } from '../helpers/stdout-capture.js';
import { createTempDirTracker } from '../system/test-common.js';

const tempDirs = createTempDirTracker('vat-build-plugin-local-');

/** The repo-only skill; its directory is not named after it. */
const KEPT: FixtureSkill = { dir: 'skills/kept-dir', name: 'kept' };
/** The skill under plugin `p`'s `skills/` dir, in a directory not named after it. */
const SHIPPED: FixtureSkill = { dir: pluginSkillDir('shipped-dir'), name: 'shipped' };

/** Write a `skills.defaults.publish: false` project, then run `fn` against it with stdout captured. */
async function inProject<T>(
  git: Parameters<typeof writeSkillProject>[2],
  fn: (root: string) => Promise<T>,
): Promise<{ result: T; stdout: string }> {
  const root = tempDirs.createTempDir();
  writeProjectConfig(root, pluginProjectConfig(false));
  writeSkillProject(root, [KEPT, SHIPPED], git);
  const captured: string[] = [];
  const restore = captureStdout(captured);
  try {
    return { result: await fn(root), stdout: captured.join('') };
  } finally {
    restore();
  }
}

describe('vat skills build — plugin-only vs in place, from the listed project', () => {
  afterEach(() => tempDirs.cleanupTempDirs());

  it('a tracked skill under a plugin skills/ dir is plugin-only; the repo-only skill is in place', async () => {
    const { result, stdout } = await inProject({ untracked: [] }, (root) => runSkillsBuildPhase(root, { dryRun: true }));

    expect(result.exitCode).toBe(0);
    expect(yaml.parse(stdout)).toMatchObject({
      skillsInPlaceNames: [KEPT.name],
      skillsPluginOnlyNames: [SHIPPED.name],
    });
  });

  it('an UNTRACKED skill under a plugin skills/ dir does not ship with its plugin, so it is in place — and --skill says so', async () => {
    const { stdout } = await inProject({ untracked: [SHIPPED.dir] }, (root) => runSkillsBuildPhase(root, { dryRun: true }));
    expect(yaml.parse(stdout)).toMatchObject({ skillsInPlace: 2, skillsPluginOnly: 0 });

    const { result } = await inProject({ untracked: [SHIPPED.dir] }, (root) => runSkillsBuildPhase(root, { skill: SHIPPED.name }));
    expect(result.exitCode).toBe(1);
    expect(String((result.document as { error: string }).error)).toContain(`Skill "${SHIPPED.name}" is an in-place skill`);
  });
});
