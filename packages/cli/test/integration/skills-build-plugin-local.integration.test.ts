/**
 * `vat skills build` over a real project whose plugin-local index is LISTED, not stubbed:
 * whether a `publish: false` skill under a plugin's `skills/` is plugin-only or in place
 * depends on whether git tracks it. The same partition over a stubbed index is unit-tested
 * in `test/commands/skills/build-in-place.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { type SKILLS_BUILD_REPORT_SCHEMA } from '../../src/commands/skills/build-schema.js';
import { runSkillsBuildPhase } from '../../src/commands/skills/build.js';
import {
  pluginProjectConfig,
  pluginSkillDir,
  writeProjectConfig,
  writeSkillProject,
  type FixtureSkill,
} from '../helpers/plugin-local-fixture.js';
import { publishedPhase } from '../helpers/published-phase.js';
import { createTempDirTracker } from '../system/test-common.js';

const tempDirs = createTempDirTracker('vat-build-plugin-local-');

/** The repo-only skill; its directory is not named after it. */
const KEPT: FixtureSkill = { dir: 'skills/kept-dir', name: 'kept' };
/** The skill under plugin `p`'s `skills/` dir, in a directory not named after it. */
const SHIPPED: FixtureSkill = { dir: pluginSkillDir('shipped-dir'), name: 'shipped' };

/** Write a `skills.defaults.publish: false` project, run the build phase against it, and parse its report. */
async function inProject(
  git: Parameters<typeof writeSkillProject>[2],
  options: Parameters<typeof runSkillsBuildPhase>[1],
): Promise<{ exitCode: number; report: ReturnType<typeof SKILLS_BUILD_REPORT_SCHEMA.parse> }> {
  const root = tempDirs.createTempDir();
  writeProjectConfig(root, pluginProjectConfig(false));
  writeSkillProject(root, [KEPT, SHIPPED], git);
  const { exitCode, document } = publishedPhase<ReturnType<typeof SKILLS_BUILD_REPORT_SCHEMA.parse>>('skills build', await runSkillsBuildPhase(root, options, []));
  return { exitCode, report: document };
}

describe('vat skills build — plugin-only vs in place, from the listed project', () => {
  afterEach(() => tempDirs.cleanupTempDirs());

  it('a tracked skill under a plugin skills/ dir is plugin-only; the repo-only skill is in place', async () => {
    const { exitCode, report } = await inProject({ untracked: [] }, { dryRun: true });

    expect(exitCode).toBe(0);
    expect(report.data).toMatchObject({ skillsInPlace: [KEPT.name], skillsPluginOnly: [SHIPPED.name] });
  });

  it('an UNTRACKED skill under a plugin skills/ dir does not ship with its plugin, so it is in place — and --skill says so', async () => {
    const { report: preview } = await inProject({ untracked: [SHIPPED.dir] }, { dryRun: true });
    expect(new Set(preview.data?.skillsInPlace)).toEqual(new Set([KEPT.name, SHIPPED.name]));
    expect(preview.data?.skillsPluginOnly).toEqual([]);

    const { exitCode, report } = await inProject({ untracked: [SHIPPED.dir] }, { skill: SHIPPED.name });
    expect(exitCode).toBe(1);
    expect(report.findings.map((finding) => finding.code)).toEqual(['SKILL_BUILD_TARGET_NOT_BUILDABLE']);
    expect(report.findings[0]?.message).toContain(`Skill "${SHIPPED.name}" is an in-place skill`);
  });
});
