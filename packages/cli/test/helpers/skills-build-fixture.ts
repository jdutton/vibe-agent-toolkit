/**
 * What the `vat skills build` staging suites share — the unit suite (what a run reports and where it
 * lands) and the integration suite (what a refused swap leaves): one project with skills written
 * into it, a previous `dist/skills`, and one run of the build over them.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';

import type { SkillPackagingConfig } from '@vibe-agent-toolkit/agent-skills';
import { forEachInOrder, mapInOrder, safePath } from '@vibe-agent-toolkit/utils';

import { runSkillBuild, type BuildSkillSpec, type SkillBuildRun, type SkillBuildRunInput } from '../../src/commands/skills/build.js';
import type { Logger } from '../../src/utils/logger.js';
import { silentLogger as SILENT_LOGGER } from '../test-doubles.js';

/**
 * A body whose relative link resolves to nothing: `LINK_MISSING_TARGET`, an
 * `error` in the SOURCE lane, so this skill fails the PRE-build gate — the one
 * that used to `process.exit` inside the per-skill loop.
 */
export const BROKEN_BODY = 'See [the missing companion](./nope.md).';
export const CLEAN_BODY = 'Nothing to see.';

/**
 * Byte content of a bundle from a PREVIOUS, good build. Asserted verbatim: a
 * build that half-wrote its replacement before failing would leave a directory
 * that still exists, so existence alone cannot tell "untouched" from "clobbered".
 */
export const PREVIOUS_BUNDLE = 'previous good output — a failed build must not touch this\n';

const CLEAN_DESCRIPTION = 'A skill used to exercise vat skills build in tests.';

/**
 * A description that trips `SKILL_DESCRIPTION_WRONG_PERSON` — a `warning` the
 * BUILT lane emits against the STAGED copy of `SKILL.md`, so the finding carries
 * that copy's path as its `location`. The vehicle for every assertion about
 * where a post-build finding says it is.
 */
export const WRONG_PERSON_DESCRIPTION =
  'You should use this skill whenever a test needs a post-build finding to exist.';

/** A bundle written into `dist/skills` by a DIFFERENT run, mid-flight. */
export const OTHER_RUN_BUNDLE = 'from-the-other-run';
export const OTHER_RUN_BYTES = 'other run\n';

/** What names every staged (and parked) tree the swap writes beside `dist/skills`. */
export const STAGING_INFIX = '.vat-staged-';

/** The location every anchor assertion expects once the staging path is mapped away. */
export const DEMO_SKILL_LOCATION = 'dist/skills/demo/SKILL.md';

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
export const seedProjectRoot = (cwd: string): Promise<void> =>
  writeFile(safePath.join(cwd, 'vibe-agent-toolkit.config.yaml'), '{}\n');

/** Build the named skills (name → body) in one run, optionally in `--skill` mode. */
export async function build(
  cwd: string,
  skills: readonly SkillFixture[],
  options: BuildOptions = {},
): Promise<SkillBuildRun> {
  // In order: the run reports its skills in the order they were written.
  const specs: BuildSkillSpec[] = await mapInOrder(skills, ([name, body, description]) => writeSkill(cwd, name, body, description ?? CLEAN_DESCRIPTION));
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

/** Seed `dist/skills/<name>/SKILL.md` for each name, as a previous build would have. */
export async function seedPreviousOutput(cwd: string, names: readonly string[]): Promise<void> {
  await forEachInOrder(names, async (name) => {
    const dir = safePath.join(cwd, 'dist', 'skills', name);
    await mkdir(dir, { recursive: true });
    await writeFile(safePath.join(dir, 'SKILL.md'), PREVIOUS_BUNDLE);
  });
}

export const readBundle = (cwd: string, name: string): Promise<string> =>
  readFile(safePath.join(cwd, 'dist', 'skills', name, 'SKILL.md'), 'utf8');

/** Everything under `dist/`, sorted — the check for a leftover staging tree. */
export const distEntries = (cwd: string): Promise<string[]> =>
  readdir(safePath.join(cwd, 'dist')).then((e) => e.toSorted((a, b) => a.localeCompare(b)));
