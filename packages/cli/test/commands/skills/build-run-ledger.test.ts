/* eslint-disable security/detect-non-literal-fs-filename -- test code writes into its own temp dirs */
import { mkdir, writeFile } from 'node:fs/promises';

import type { SkillPackagingConfig } from '@vibe-agent-toolkit/agent-skills';
import type { ValidationIssue } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { runSkillBuild, type BuildSkillSpec } from '../../../src/commands/skills/build.js';
import type { Logger } from '../../../src/utils/logger.js';
import { createTempDirTracker } from '../../system/test-common.js';
import { recordingLogger, silentLogger as SILENT_LOGGER } from '../../test-doubles.js';

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

/** Write a valid skill document at `sourcePath` and return that path. */
async function writeSkillSource(sourcePath: string, name: string, body: string): Promise<string> {
  await writeFile(
    sourcePath,
    `---\nname: ${name}\ndescription: A skill used to exercise vat skills build in tests.\n---\n\n# ${name}\n\n${body}\n`,
  );
  return sourcePath;
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
    // Only the teaching skill carries the non-portable reference, so only its
    // SOURCE validation can match the package-level entry above.
    const body = name === TEACHING_SKILL
      ? 'Never write `${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs` — it is plugin-only.'
      : 'Nothing non-portable here.';
    const sourcePath = await writeSkillSource(safePath.join(skillsDir, `${name}.md`), name, body);
    specs.push({ skill: { name, sourcePath }, packagingConfig: packagingConfig() });
  }

  // `[]`: these fixtures declare no eval suites, so the project-wide test-input
  // list is genuinely empty — not a lane declining to supply it.
  const run = await runSkillBuild({
    specs,
    cwd,
    logger: SILENT_LOGGER,
    projectSkills: [],
    onlySkill: undefined,
    verbose: false,
  });
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

// ---------------------------------------------------------------------------
// One skill's failure must not discard the batch
//
// `runSkillBuild` already degrades gracefully for a skill that fails by
// RETURNING errors (`skillsWithErrors`), and used to abort the whole invocation
// for a skill that fails by THROWING. Measured on a 90-skill adopter, a single
// filename collision discarded 89 successful builds and collapsed the report to
// one bare `error:` string.
//
// That collision no longer throws — it is a `FILENAME_COLLISION` issue on the
// ordinary channel now, which is one fewer way to reach this code path. (The
// same 90-skill adopter confirms it: `vat skills build` hit three collisions
// and still built the other 87.) The containment stays load-bearing for every
// throw that remains, so this suite exercises it through one of those instead:
// an absent `files:` source. Same contract, a vehicle that still throws.
// ---------------------------------------------------------------------------

/** The phrase the surviving throw uses to attribute itself to a skill. */
const THROWN_ATTRIBUTION = "skill 'two'";

/**
 * The `files:` entry the middle skill fails on.
 *
 * `undefined` means "the plain absent NON-GLOB source" — the packager's own
 * throw, which names the skill. Any other value is a GLOB, which fails later
 * inside `applyFilesConfig` and takes a different throw with a different
 * message. Both are `failures[]`, and the leak guard below has to see both:
 * driving only the non-glob shape is what let three glob throws publish the
 * absolute project path under a test asserting no message does.
 *
 * Spelled relative to the SKILL directory, not to `cwd`: this fixture tree has
 * neither a config nor a `.git`, so `packageSkill`'s `findProjectRoot` finds no
 * ancestor and falls back to the skill's own directory. A `cwd`-relative glob
 * silently resolves under `<cwd>/skills/two/skills/two/...`, matches nothing,
 * and collapses BOTH glob cases into the zero-match route.
 */
const GLOB_NO_MATCH = 'dist/nope/**/*';
const GLOB_ONLY_NEVER_PACKAGED = 'extras/**/*';

/** Three skills under `cwd`; the middle one throws on its `files:` source. */
async function buildRunWithOneThrowingSkill(
  cwd: string,
  logger: Logger,
  failingSource?: string,
) {
  const specs: BuildSkillSpec[] = [];
  for (const name of ['one', 'two', 'three']) {
    const dir = safePath.join(cwd, 'skills', name);
    await mkdir(dir, { recursive: true });
    const sourcePath = await writeSkillSource(
      safePath.join(dir, 'SKILL.md'),
      name,
      'Nothing to see.',
    );
    // Deliberately never written: resolving it is what raises.
    const source = failingSource ?? 'skills/two/never-written.txt';
    const packagingConfig = (name === 'two'
      ? { files: [{ source, dest: 'never-written.txt' }] }
      : {}) as SkillPackagingConfig;
    specs.push({ skill: { name, sourcePath }, packagingConfig });
  }
  // The all-refused glob needs real matches that the never-package list drops,
  // or it takes the zero-match route instead and the two cases collapse into one.
  if (failingSource === GLOB_ONLY_NEVER_PACKAGED) {
    const extras = safePath.join(cwd, 'skills', 'two', 'extras');
    await mkdir(extras, { recursive: true });
    for (const basename of ['CLAUDE.md', 'AGENTS.md']) {
      await writeFile(safePath.join(extras, basename), `content of ${basename}\n`);
    }
  }
  return runSkillBuild({ specs, cwd, logger, projectSkills: [], onlySkill: undefined, verbose: false });
}

describe('runSkillBuild - a skill that throws does not discard the batch', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-build-run-throw-');

  afterEach(() => cleanupTempDirs());

  it('returns the results of every skill either side of the failure', async () => {
    const run = await buildRunWithOneThrowingSkill(createTempDir(), SILENT_LOGGER);
    expect(run.results.map((r) => r.name)).toEqual(['one', 'three']);
  });

  it('names the failed skill and carries its reason, not one bare string for the run', async () => {
    const run = await buildRunWithOneThrowingSkill(createTempDir(), SILENT_LOGGER);
    expect(run.failures.map((f) => f.name)).toEqual(['two']);
    expect(run.failures[0]?.message).toContain(THROWN_ATTRIBUTION);
  });

  it('does not claim a file count for a skill that never built', async () => {
    const { logger, lines } = recordingLogger();
    await buildRunWithOneThrowingSkill(createTempDir(), logger);
    expect(lines.filter((l) => l.includes(': built '))).toHaveLength(2);
    expect(lines.some((l) => l.includes(THROWN_ATTRIBUTION))).toBe(true);
  });

  it('attributes the failure to a skill without publishing where the run happened', async () => {
    // `failures[]` is published verbatim as `failedSkills[]` on stdout, so this
    // message is machine-readable output — the one place an absolute path is a
    // leak rather than a convenience. Attribution rides on the declared NAME,
    // which is portable; the paths inside the message are the project's own.
    const cwd = createTempDir();
    const run = await buildRunWithOneThrowingSkill(cwd, SILENT_LOGGER);

    expect(run.failures.map((f) => f.name)).toEqual(['two']);
    expect(run.failures[0]?.message).toContain(THROWN_ATTRIBUTION);
    expect(JSON.stringify(run.failures)).not.toContain(cwd);
    // Not the root check alone: macOS resolves this temp root through a
    // `/private` symlink, so a containment check can pass over an absolute path
    // that merely spells its prefix the other way. This reads the SHAPE of every
    // value the message states.
    expect(run.failures[0]?.message).not.toMatch(/:\s+\//);
  });

  // The case above drives ONE `files:` shape — a plain absent non-glob source,
  // whose throw happens to interpolate no path at all. It therefore certified
  // "no absolute path in failedSkills[]" while three sibling throws in the same
  // feature published one; a guard that cannot fail is the defect that lets a
  // leak ship. These cases drive the GLOB routes, where the leak actually was.
  //
  // Attribution is asserted on `failures[].name` here, not on the message: the
  // glob throws are raised inside `applyFilesConfig`, which knows the entry but
  // not the skill. The NAME is the machine-readable attribution either way.
  it.each([
    { label: 'glob matched nothing', source: GLOB_NO_MATCH, reached: /matched no files/ },
    {
      label: 'glob matched only never-packaged files',
      source: GLOB_ONLY_NEVER_PACKAGED,
      reached: /never packaged/,
    },
  ])('publishes no absolute path for a failing $label', async ({ source, reached }) => {
    const cwd = createTempDir();
    const run = await buildRunWithOneThrowingSkill(cwd, SILENT_LOGGER, source);

    expect(run.failures.map((f) => f.name)).toEqual(['two']);
    // Proves the case reached the intended throw rather than some earlier one.
    expect(run.failures[0]?.message).toMatch(reached);
    expect(JSON.stringify(run.failures)).not.toContain(cwd);
    // Shape, for the `/private` symlink reason above — and matched at any word
    // boundary, because the glob throws spell their path after `under `, not
    // after `: `, which is exactly why the older `/:\s+\//` probe missed them.
    expect(run.failures[0]?.message).not.toMatch(/(?:^|[\s(<'"])(?:\/|[A-Za-z]:[\\/])/);
  });
});
