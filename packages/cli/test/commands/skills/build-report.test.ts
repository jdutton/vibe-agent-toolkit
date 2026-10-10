/**
 * `vat skills build` — what one run REPORTS: where a finding says it is, what each outcome line
 * names, how a collapsed findings block reads, which output paths it publishes, and what its
 * failure message says was (not) replaced. Where the output lands is `build-staging.test.ts`.
 */
import { existsSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { skillsBuildWork, type SkillBuildRun } from '../../../src/commands/skills/build.js';
import { collectPostBuildIssues } from '../../../src/utils/issue-rendering.js';
import {
  BROKEN_BODY,
  build,
  CLEAN_BODY,
  DEMO_SKILL_LOCATION,
  PREVIOUS_BUNDLE,
  readBundle,
  seedPreviousOutput,
  seedProjectRoot,
  STAGING_INFIX,
  WRONG_PERSON_DESCRIPTION,
} from '../../helpers/skills-build-fixture.js';
import { createTempDirTracker } from '../../system/test-common.js';
import { recordingLogger } from '../../test-doubles.js';

/**
 * Drive one run carrying exactly ONE collapsible (warning) finding, and return
 * every line it printed — the fixture behind both verbosity assertions.
 */
async function collapseReportLines(cwd: string, verbose: boolean): Promise<string[]> {
  await seedProjectRoot(cwd);
  const { logger, lines } = recordingLogger();
  await build(cwd, [['demo', CLEAN_BODY, WRONG_PERSON_DESCRIPTION]], { logger, verbose });
  return lines;
}

describe('runSkillBuild - findings point at the tree the swap lands on', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-build-staging-anchor-');

  afterEach(() => cleanupTempDirs());

  /** Every post-build finding location the run published, across every skill. */
  const publishedLocations = (run: SkillBuildRun): Array<string | undefined> =>
    run.results.flatMap(({ result }) => collectPostBuildIssues(result).map((i) => i.location));

  it('re-anchors a finding off the transient staging directory', async () => {
    // The defect: the location named `dist/.vat-skills-<rand>/demo/SKILL.md` — a
    // directory that has been renamed (success) or removed (failure) by the time
    // anyone reads it, and whose random suffix makes it unreconstructable.
    const cwd = createTempDir();
    await seedProjectRoot(cwd);
    const run = await build(cwd, [['demo', CLEAN_BODY, WRONG_PERSON_DESCRIPTION]]);

    const locations = publishedLocations(run);
    expect(locations).toContain(DEMO_SKILL_LOCATION);
    expect(locations.join('\n')).not.toContain(STAGING_INFIX);
  });

  it('re-anchors on a run that never promoted its output either', async () => {
    // The adopter met this on a FAILED run, where the staging directory is not
    // renamed but DELETED — so the published path is unopenable in both outcomes.
    const cwd = createTempDir();
    await seedProjectRoot(cwd);
    const run = await build(cwd, [
      ['demo', CLEAN_BODY, WRONG_PERSON_DESCRIPTION],
      ['bad', BROKEN_BODY],
    ]);

    expect(run.outputCommitted).toBe(false);
    expect(publishedLocations(run)).toContain(DEMO_SKILL_LOCATION);
    expect(publishedLocations(run).join('\n')).not.toContain(STAGING_INFIX);
  });

  it('never shows the operator a staging path on stderr', async () => {
    // The re-anchoring has to happen BEFORE the report is rendered, not only
    // before the result is returned: the human stream is where an operator reads
    // these locations first.
    const cwd = createTempDir();
    await seedProjectRoot(cwd);
    const { logger, lines } = recordingLogger();
    await build(cwd, [['demo', CLEAN_BODY, WRONG_PERSON_DESCRIPTION]], { logger, verbose: true });

    expect(lines.join('\n')).toContain(`Location: ${DEMO_SKILL_LOCATION}`);
    expect(lines.join('\n')).not.toContain(STAGING_INFIX);
  });
});

describe('runSkillBuild - every outcome line names its skill', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-build-staging-attrib-');

  afterEach(() => cleanupTempDirs());

  it('attributes the file count and the findings heading to the skill that produced them', async () => {
    // The defect: the validation pass printed 92 `Building skill: <name>` banners
    // and the outcome pass then printed 86 NAMELESS result lines, so at two skills
    // `ok`'s file count appeared beneath `demo`'s failure banner and read as
    // "demo failed, and built 1 file".
    const cwd = createTempDir();
    await seedProjectRoot(cwd);
    const { logger, lines } = recordingLogger();
    await build(cwd, [['demo', CLEAN_BODY, WRONG_PERSON_DESCRIPTION], ['ok', CLEAN_BODY]], {
      logger,
    });

    expect(lines).toContain('   ok: built 1 file');
    expect(lines.some((l) => l.startsWith('   demo: 1 post-build issue'))).toBe(true);
  });

  it('pluralizes the file count', async () => {
    const cwd = createTempDir();
    const { logger, lines } = recordingLogger();
    await build(cwd, [['ok', CLEAN_BODY]], { logger });
    expect(lines).not.toContain('   ok: built 1 files');
  });
});

describe('runSkillBuild - a collapsed findings block says how to see it', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-build-staging-collapse-');

  afterEach(() => cleanupTempDirs());

  it('drops the colon that promised a list, and points at the two ways to read it', async () => {
    // The defect: `1 post-build issue (1 info):` printed its colon and then
    // nothing, with no hint that --verbose exists — unlike `vat audit`, which
    // has said so all along.
    const lines = await collapseReportLines(createTempDir(), false);

    expect(lines.some((l) => l.endsWith('post-build issue (1 warning)'))).toBe(true);
    expect(lines.some((l) => l.endsWith('post-build issue (1 warning):'))).toBe(false);
    expect(lines.filter((l) => l.includes('re-run with --verbose'))).toHaveLength(1);
  });

  it('keeps the colon and drops the hint when the bodies are actually printed', async () => {
    const lines = await collapseReportLines(createTempDir(), true);

    expect(lines.some((l) => l.endsWith('post-build issue (1 warning):'))).toBe(true);
    expect(lines.filter((l) => l.includes('re-run with --verbose'))).toEqual([]);
  });
});

/** The report's `data` for a run over the named skills, sources under `cwd`. */
function dataOf(cwd: string, run: SkillBuildRun, names: readonly string[]): ReturnType<typeof skillsBuildWork>['data'] {
  const skills = names.map((name) => ({ name, sourcePath: safePath.join(cwd, 'skills', name, 'SKILL.md') }));
  return skillsBuildWork({ cwd, skills, setAside: { inPlace: [], pluginOnly: [] }, dryRun: false, run, setAsideIssues: [] }).data;
}

describe('runSkillBuild - a published output path exists exactly when the run committed', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-build-staging-paths-');

  afterEach(() => cleanupTempDirs());

  it('says outputCommitted: false, and no row\'s output exists, when the output was not promoted', async () => {
    // The defect, measured on a 90-skill adopter: a failed run published 86
    // `dist/skills/<name>` paths, 85 of which did not exist, beside a boolean
    // nobody was told to read. The paths are the swap's target, never a claim.
    const cwd = createTempDir();
    const run = await build(cwd, [['good', CLEAN_BODY], ['bad', BROKEN_BODY]]);
    const data = dataOf(cwd, run, ['good', 'bad']);

    expect(data.outputCommitted).toBe(false);
    expect(data.skills.map((row) => row.status)).toEqual(['ok', 'findings']);
    expect(data.skills.map((row) => existsSync(safePath.join(cwd, row.output)))).toEqual([false, false]);
  });

  it('publishes a path that exists for every row of a promoted run', async () => {
    const cwd = createTempDir();
    const run = await build(cwd, [['good', CLEAN_BODY]]);
    const data = dataOf(cwd, run, ['good']);

    expect(data.outputCommitted).toBe(true);
    expect(data.skills.map((row) => existsSync(safePath.join(cwd, row.output)))).toEqual([true]);
  });
});

describe('runSkillBuild - the failure message names what THIS run promotes', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-build-staging-scope-');

  afterEach(() => cleanupTempDirs());

  it('names the single bundle, not the whole tree, when --skill mode fails with siblings on disk', async () => {
    // The defect: `--skill one` failing with no previous bundle for `one`
    // printed "Nothing was written — dist/skills does not exist" while
    // dist/skills sat on disk holding `two`. The direction is the alarming one:
    // an operator is told their whole output tree is gone when it is not.
    const cwd = createTempDir();
    await seedPreviousOutput(cwd, ['two']);
    const { logger, lines } = recordingLogger();

    const run = await build(cwd, [['one', BROKEN_BODY]], { onlySkill: 'one', logger });

    expect(run.outputCommitted).toBe(false);
    expect(lines.join('\n')).toContain('Nothing was written — dist/skills/one does not exist');
    // And the claim is true of the disk it describes.
    await expect(readBundle(cwd, 'two')).resolves.toBe(PREVIOUS_BUNDLE);
  });

  it('names the single bundle in the "nothing was replaced" arm too', async () => {
    const cwd = createTempDir();
    await seedPreviousOutput(cwd, ['one', 'two']);
    const { logger, lines } = recordingLogger();

    await build(cwd, [['one', BROKEN_BODY]], { onlySkill: 'one', logger });

    expect(lines.join('\n')).toContain('Nothing was replaced — the previous dist/skills/one is intact');
  });

  it('still names the whole tree for a full build', async () => {
    const cwd = createTempDir();
    const { logger, lines } = recordingLogger();

    await build(cwd, [['bad', BROKEN_BODY]], { logger });

    expect(lines.join('\n')).toContain('Nothing was written — dist/skills does not exist');
  });
});
