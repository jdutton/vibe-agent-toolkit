/* eslint-disable security/detect-non-literal-fs-filename -- test code writes into its own temp dirs */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';

import type {
  PackageSkillResult,
  PackagingValidationResult,
  SkillPackagingConfig,
} from '@vibe-agent-toolkit/agent-skills';
import type { ValidationIssue } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginStagedBuild,
  buildYamlSummary,
  reanchorStagedResult,
  runSkillBuild,
  settleStaging,
  type BuildSkillSpec,
  type SkillBuildRun,
  type SkillBuildRunInput,
} from '../../../src/commands/skills/build.js';
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

/** The `mkdtemp` prefix `beginStagedBuild` writes under `dist/`. */
const STAGING_PREFIX = '.vat-skills-';

/** The location every anchor assertion expects once the staging path is mapped away. */
const DEMO_SKILL_LOCATION = 'dist/skills/demo/SKILL.md';

/** A bundle written into `dist/skills` by a DIFFERENT run, mid-flight. */
const OTHER_RUN_BUNDLE = 'from-the-other-run';
const OTHER_RUN_BYTES = 'other run\n';

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
  writeFile(safePath.join(cwd, 'vibe-agent-toolkit.config.yaml'), 'version: 1\n');

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

  it('publishes each failure\'s own severity counts rather than a flat one-error stand-in', async () => {
    const run = await build(createTempDir(), [['bad-one', BROKEN_BODY], ['good', CLEAN_BODY]]);
    expect(run.validationFailures[0]?.issueCounts.errors).toBeGreaterThanOrEqual(1);
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
    expect(locations.join('\n')).not.toContain(STAGING_PREFIX);
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
    expect(publishedLocations(run).join('\n')).not.toContain(STAGING_PREFIX);
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
    expect(lines.join('\n')).not.toContain(STAGING_PREFIX);
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

describe('runSkillBuild - no published output path that does not exist', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-build-staging-paths-');

  afterEach(() => cleanupTempDirs());

  it('publishes no `skills[]` row at all when the output was not promoted', async () => {
    // The defect, measured on a 90-skill adopter: a failed run published 86
    // `skills[]` rows carrying `dist/skills/<name>` paths, 85 of which did not
    // exist — the bundles were staged and the promotion was then aborted.
    const cwd = createTempDir();
    const run = await build(cwd, [['good', CLEAN_BODY], ['bad', BROKEN_BODY]]);
    const summary = buildYamlSummary(run, 1);

    expect(summary.outputCommitted).toBe(false);
    expect(summary.skills).toEqual([]);
    // The findings are not lost — they move to a list whose name does not
    // promise disk presence, and which carries no path at all.
    expect(summary.skillsStaged.map((s) => s.name)).toEqual(['good']);
    expect(JSON.stringify(summary.skillsStaged)).not.toContain('outputPath');
  });

  it('publishes a path that exists for every row of a promoted run', async () => {
    const cwd = createTempDir();
    const run = await build(cwd, [['good', CLEAN_BODY]]);
    const summary = buildYamlSummary(run, 1);

    expect(summary.outputCommitted).toBe(true);
    expect(summary.skillsStaged).toEqual([]);
    expect(summary.skills.map((s) => existsSync(s.outputPath))).toEqual([true]);
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

/** Write one file into `dir`, creating it — a stand-in for a staged bundle. */
async function seedTree(dir: string, contents: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(safePath.join(dir, 'SKILL.md'), contents);
}

describe('beginStagedBuild - a failed promotion still leaves an answer', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-build-staging-promote-');

  afterEach(() => cleanupTempDirs());

  it('restores the parked previous output when the promotion target is free', async () => {
    // The primitive the whole repair rests on: after `commit()` throws, the
    // previous tree is one rename away and nothing else knows where it is.
    const cwd = createTempDir();
    await seedPreviousOutput(cwd, ['kept']);
    const staging = await beginStagedBuild(cwd, undefined);

    expect(staging.hadPreviousOutput).toBe(true);
    expect(existsSync(safePath.join(cwd, 'dist', 'skills'))).toBe(false);

    const recovery = await staging.recover();

    expect(recovery.restoredPrevious).toBe(true);
    expect(recovery.residue).toEqual([]);
    await expect(readBundle(cwd, 'kept')).resolves.toBe(PREVIOUS_BUNDLE);
    // Its own staging root is always safe to drop, and dropping it is what stops
    // a full copy of the build output accumulating in dist/ per failed promotion.
    await expect(distEntries(cwd)).resolves.toEqual(['skills']);
  });

  it('never restores over a tree that already occupies the promotion target', async () => {
    // The concurrent-build case, which needs no injection: the other run promoted
    // its own output while this one was building. Restoring here would replace
    // fresh output with a stale copy, so the parked tree is REPORTED instead.
    const cwd = createTempDir();
    await seedPreviousOutput(cwd, ['kept']);
    const staging = await beginStagedBuild(cwd, undefined);
    await seedTree(safePath.join(cwd, 'dist', 'skills', OTHER_RUN_BUNDLE), OTHER_RUN_BYTES);

    const recovery = await staging.recover();

    expect(recovery.restoredPrevious).toBe(false);
    expect(recovery.residue).toEqual([staging.parkedPath]);
    await expect(readdir(safePath.join(cwd, 'dist', 'skills'))).resolves.toEqual([OTHER_RUN_BUNDLE]);
  });

  it('reports the promotion failure, names the parked path, and publishes the document', async () => {
    // End to end through `settleStaging`: a real ENOTEMPTY/EPERM from renaming
    // the staging root onto a non-empty directory, with no mocks.
    const cwd = createTempDir();
    await seedPreviousOutput(cwd, ['kept']);
    const staging = await beginStagedBuild(cwd, undefined);
    await seedTree(safePath.join(staging.root, 'fresh'), 'this run\n');
    // A concurrent build promoted first. `rename(root, dist/skills)` now fails.
    await seedTree(safePath.join(cwd, 'dist', 'skills', OTHER_RUN_BUNDLE), OTHER_RUN_BYTES);

    const settled = await settleStaging(staging, false, SILENT_LOGGER);

    expect(settled.outputCommitted).toBe(false);
    expect(settled.promotionError).toContain('Build output promotion failed');
    expect(settled.promotionError).toContain(staging.parkedPath);
    expect(settled.promotionError).toContain('mv ');
  });
});

/** A staging root with the `mkdtemp` suffix spelled out, so the mapper is real. */
const STAGED = 'dist/.vat-skills-abc123';

/** The one rewrite `createStagingPathMapper` performs, in its relative spelling. */
const mapPath = (value: string): string =>
  value.startsWith(`${STAGED}/`) ? `dist/skills${value.slice(STAGED.length)}` : value;

function resultWith(overrides: Partial<PackageSkillResult>): PackageSkillResult {
  return {
    outputPath: `${STAGED}/demo`,
    files: { skill: 'SKILL.md', dependencies: [] },
    hasErrors: false,
    ...overrides,
  } as PackageSkillResult;
}

const stagedIssue = (location: string): ValidationIssue => ({
  code: 'PACKAGED_BROKEN_LINK',
  severity: 'error',
  message: 'A packaged link resolves to nothing.',
  location,
});

describe('reanchorStagedResult - BOTH post-build channels are re-anchored', () => {
  // A live invariant with no live producer: every current `postBuildIssues`
  // location is bundle-relative or source-project-relative, so removing the
  // branch below breaks no build fixture in the repo. Asserted directly, because
  // "the suite stayed green" is not evidence about a branch nothing exercises.

  it('re-anchors a location on the postBuildIssues channel', () => {
    const result = reanchorStagedResult(
      resultWith({ postBuildIssues: [stagedIssue(`${STAGED}/demo/pack/b.md`)] }),
      mapPath,
    );

    expect(result.postBuildIssues?.[0]?.location).toBe('dist/skills/demo/pack/b.md');
  });

  it('re-anchors a location on the postBuildValidation channel', () => {
    const result = reanchorStagedResult(
      resultWith({
        postBuildValidation: {
          allErrors: [stagedIssue(`${STAGED}/demo/SKILL.md`)],
        } as PackagingValidationResult,
      }),
      mapPath,
    );

    expect(result.postBuildValidation?.allErrors[0]?.location).toBe(DEMO_SKILL_LOCATION);
  });

  it('leaves a location that names no staged path alone', () => {
    const result = reanchorStagedResult(
      resultWith({ postBuildIssues: [stagedIssue('resources/skills/demo/extra/CLAUDE.md')] }),
      mapPath,
    );

    expect(result.postBuildIssues?.[0]?.location).toBe('resources/skills/demo/extra/CLAUDE.md');
  });
});
