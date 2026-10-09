import { existsSync, statSync } from 'node:fs';
import fsPromises, { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';

import type { SkillPackagingConfig } from '@vibe-agent-toolkit/agent-skills';
import { safePath } from '@vibe-agent-toolkit/utils';
import { installFaultFs, type FaultRule } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  runSkillBuild,
  skillsBuildWork,
  type BuildSkillSpec,
  type SkillBuildRun,
  type SkillBuildRunInput,
} from '../../../src/commands/skills/build.js';
import { refusalCodeOf } from '../../../src/utils/command-refusal.js';
import { collectPostBuildIssues } from '../../../src/utils/issue-rendering.js';
import type { Logger } from '../../../src/utils/logger.js';
import { createTempDirTracker } from '../../system/test-common.js';
import { recordingLogger, silentLogger as SILENT_LOGGER } from '../../test-doubles.js';

/**
 * A body whose relative link resolves to nothing: `LINK_MISSING_TARGET`, an
 * `error` in the SOURCE lane, so this skill fails the PRE-build gate — the one
 * that used to `process.exit` inside the per-skill loop.
 */
const BROKEN_BODY = 'See [the missing companion](./nope.md).';
const CLEAN_BODY = 'Nothing to see.';

/**
 * Byte content of a bundle from a PREVIOUS, good build. Asserted verbatim: a
 * build that half-wrote its replacement before failing would leave a directory
 * that still exists, so existence alone cannot tell "untouched" from "clobbered".
 */
const PREVIOUS_BUNDLE = 'previous good output — a failed build must not touch this\n';

const CLEAN_DESCRIPTION = 'A skill used to exercise vat skills build in tests.';

/**
 * A description that trips `SKILL_DESCRIPTION_WRONG_PERSON` — a `warning` the
 * BUILT lane emits against the STAGED copy of `SKILL.md`, so the finding carries
 * that copy's path as its `location`. The vehicle for every assertion about
 * where a post-build finding says it is.
 */
const WRONG_PERSON_DESCRIPTION =
  'You should use this skill whenever a test needs a post-build finding to exist.';

/** A bundle written into `dist/skills` by a DIFFERENT run, mid-flight. */
const OTHER_RUN_BUNDLE = 'from-the-other-run';
const OTHER_RUN_BYTES = 'other run\n';

/** What names every staged (and parked) tree the swap writes beside `dist/skills`. */
const STAGING_INFIX = '.vat-staged-';

/** The location every anchor assertion expects once the staging path is mapped away. */
const DEMO_SKILL_LOCATION = 'dist/skills/demo/SKILL.md';

/** One skill fixture: its name, its body, and (optionally) a noisy description. */
type SkillFixture = readonly [name: string, body: string, description?: string];

/** How one run is driven — every field optional so a case names only what it uses. */
interface BuildOptions {
  onlySkill?: string;
  logger?: Logger;
  verbose?: boolean;
}

async function writeSkill(
  cwd: string,
  name: string,
  body: string,
  description: string,
): Promise<BuildSkillSpec> {
  const dir = safePath.join(cwd, 'skills', name);
  await mkdir(dir, { recursive: true });
  const sourcePath = safePath.join(dir, 'SKILL.md');
  await writeFile(
    sourcePath,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`,
  );
  return { skill: { name, sourcePath }, packagingConfig: {} as SkillPackagingConfig };
}

/**
 * Make `cwd` a project root.
 *
 * Load-bearing for every location assertion: `validateSkillForPackaging` anchors
 * its `location` strings on the project root it discovers from the file being
 * validated, so without a config file here the built lane finds no root above the
 * staged bundle and emits a bare `SKILL.md` — a fixture that could not tell a
 * re-anchored path from an unanchored one.
 */
const seedProjectRoot = (cwd: string): Promise<void> =>
  writeFile(safePath.join(cwd, 'vibe-agent-toolkit.config.yaml'), '{}\n');

/** Build the named skills (name → body) in one run, optionally in `--skill` mode. */
async function build(
  cwd: string,
  skills: readonly SkillFixture[],
  options: BuildOptions = {},
): Promise<SkillBuildRun> {
  const specs: BuildSkillSpec[] = [];
  for (const [name, body, description] of skills) {
    specs.push(await writeSkill(cwd, name, body, description ?? CLEAN_DESCRIPTION));
  }
  // `[]`: these fixtures declare no eval suites, so the project-wide test-input
  // list is genuinely empty — not a lane declining to supply it.
  const input: SkillBuildRunInput = {
    specs,
    cwd,
    logger: options.logger ?? SILENT_LOGGER,
    projectSkills: [],
    onlySkill: options.onlySkill,
    verbose: options.verbose ?? false,
    runOutputs: [],
  };
  return runSkillBuild(input);
}

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

/** Seed `dist/skills/<name>/SKILL.md` for each name, as a previous build would have. */
async function seedPreviousOutput(cwd: string, names: readonly string[]): Promise<void> {
  for (const name of names) {
    const dir = safePath.join(cwd, 'dist', 'skills', name);
    await mkdir(dir, { recursive: true });
    await writeFile(safePath.join(dir, 'SKILL.md'), PREVIOUS_BUNDLE);
  }
}

const readBundle = (cwd: string, name: string): Promise<string> =>
  readFile(safePath.join(cwd, 'dist', 'skills', name, 'SKILL.md'), 'utf8');

/** Everything under `dist/`, sorted — the check for a leftover staging tree. */
const distEntries = (cwd: string): Promise<string[]> =>
  readdir(safePath.join(cwd, 'dist')).then((e) => e.toSorted((a, b) => a.localeCompare(b)));

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

/** Whether `path` is a staged tree beside a destination (never its parked `.previous` twin). */
const isStaged = (path: string): boolean => path.includes(STAGING_INFIX) && !path.endsWith('.previous');

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

    const run = await withFaults(cwd, [{ family: 'rename', path: isStaged, errno: 'EACCES' }], () => build(cwd, [['good', CLEAN_BODY]]));

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
      { family: 'rename', path: isStaged, errno: 'EACCES' },
      { family: 'rename', path: (path) => path.endsWith('.previous'), nth: 2, errno: 'EACCES' },
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

    const run = await withFaults(cwd, [{ family: 'rename', path: (path) => path === target, nth: 1, errno: 'EACCES' }], () => build(cwd, [['good', CLEAN_BODY]]));

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
