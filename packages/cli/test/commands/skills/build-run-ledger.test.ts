/* eslint-disable security/detect-non-literal-fs-filename -- test code writes into its own temp dirs */
import { mkdir, writeFile } from 'node:fs/promises';

import type { ValidationIssue } from '@vibe-agent-toolkit/agent-schema';
import type { SkillPackagingConfig } from '@vibe-agent-toolkit/agent-skills';
import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { runSkillBuild, type BuildSkillSpec } from '../../../src/commands/skills/build.js';
import type { Logger } from '../../../src/utils/logger.js';
import { createTempDirTracker } from '../../system/test-common.js';

const SILENT_LOGGER: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const SOURCE_SCOPED_FIELD = 'validation.allow.NON_PORTABLE_ASSET_REFERENCE';
const DEAD_ENTRY_FIELD = 'validation.allow.SKILL_TOO_LARGE';

/** The skill whose source deliberately contains the non-portable reference. */
const TEACHING_SKILL = 'teaches-the-rule';

/**
 * ONE package-level allow list, handed identically to every skill — exactly how
 * `skills.defaults.validation` reaches them. Declared once, evaluated many
 * times: the whole reason "matched nothing" is a run-level question.
 *
 * `NON_PORTABLE_ASSET_REFERENCE` is scoped to ONE skill's SOURCE filename — the
 * shape this repo's own config uses for the skills that deliberately document
 * the anti-pattern they enforce. Packaging renames that file to `SKILL.md`, so
 * no lane inside `packageSkill` can match this glob for ANY skill: only the
 * source lane can, and only if it shares the run's ledger.
 *
 * `SKILL_TOO_LARGE` matches nothing anywhere — the positive control.
 */
function packagingConfig(): SkillPackagingConfig {
  return {
    validation: {
      allow: {
        NON_PORTABLE_ASSET_REFERENCE: [
          { paths: [`**/${TEACHING_SKILL}.md`], reason: 'documents the anti-pattern it enforces' },
        ],
        SKILL_TOO_LARGE: [{ paths: ['nowhere/**'], reason: 'matches nothing' }],
      },
    },
  } as SkillPackagingConfig;
}

/**
 * Build two skills whose source files are NOT named `SKILL.md`, and return
 * every ALLOW_UNUSED the run produced on ANY channel — per-skill post-build
 * issues, per-skill built-output validation, and the run-level drain.
 *
 * Reading all three is what keeps the assertions honest: a run that still
 * concludes per skill publishes its false verdicts on the per-skill channels,
 * so inspecting only `runIssues` would report zero and pass either way.
 */
async function allowUnusedAcrossBuildRun(cwd: string): Promise<{
  unused: ValidationIssue[];
  runIssues: ValidationIssue[];
}> {
  const skillsDir = safePath.join(cwd, 'skills');
  await mkdir(skillsDir, { recursive: true });

  const specs: BuildSkillSpec[] = [];
  for (const name of [TEACHING_SKILL, 'plain']) {
    const sourcePath = safePath.join(skillsDir, `${name}.md`);
    // Only the teaching skill carries the non-portable reference, so only its
    // SOURCE validation can match the package-level entry above.
    const body = name === TEACHING_SKILL
      ? 'Never write `${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs` — it is plugin-only.'
      : 'Nothing non-portable here.';
    await writeFile(
      sourcePath,
      `---\nname: ${name}\ndescription: A skill used to exercise the run-level allow ledger in tests.\n---\n\n# ${name}\n\n${body}\n`,
    );
    specs.push({ skill: { name, sourcePath }, packagingConfig: packagingConfig() });
  }

  const run = await runSkillBuild(specs, cwd, SILENT_LOGGER);
  const unused = [
    ...run.results.flatMap(({ result }) => [
      ...(result.postBuildIssues ?? []),
      ...result.postBuildValidation.allErrors,
    ]),
    ...run.runIssues,
  ].filter((i) => i.code === 'ALLOW_UNUSED');

  return { unused, runIssues: run.runIssues };
}

describe('runSkillBuild - one allow-usage ledger for the whole invocation', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-build-run-ledger-');

  afterEach(() => cleanupTempDirs());

  it('does not report an entry only the source lane can match as unused', async () => {
    const { unused } = await allowUnusedAcrossBuildRun(createTempDir());
    expect(unused.filter((i) => i.field === SOURCE_SCOPED_FIELD)).toEqual([]);
  });

  it('still reports an entry no lane matched — once for the run, not once per skill', async () => {
    const { unused, runIssues } = await allowUnusedAcrossBuildRun(createTempDir());
    expect(unused.filter((i) => i.field === DEAD_ENTRY_FIELD)).toHaveLength(1);
    // And it is published as a RUN finding, not attributed to a skill.
    expect(runIssues.filter((i) => i.field === DEAD_ENTRY_FIELD)).toHaveLength(1);
  });

  it('keeps a run-level warning out of the per-skill error gate', async () => {
    const { runIssues } = await allowUnusedAcrossBuildRun(createTempDir());
    expect(runIssues.every((i) => i.severity === 'warning')).toBe(true);
  });
});
