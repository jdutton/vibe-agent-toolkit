/**
 * Build skills from source into dist/skills/ during package build
 *
 * Reads skills config from vibe-agent-toolkit.config.yaml, discovers SKILL.md
 * files via include/exclude globs, reads frontmatter for skill names, merges
 * packaging config (schema defaults -> config defaults -> per-skill overrides),
 * validates, and packages into dist/skills/<name>/.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';

import {
  allowUnusedIssues,
  calculateValidationStatus,
  countBySeverity,
  createAllowUsageLedger,
  type AllowUsageLedger,
  type SeverityCounts,
  type ValidationIssue,
} from '@vibe-agent-toolkit/agent-schema';
import {
  packageSkills,
  packagingConfigToPackageOptions,
  skillNameToFsPath,
  validateSkillForPackaging,
  type DeclaredEvalSuite,
  type PackageSkillResult,
  type PackagingValidationResult,
  type SkillBuildSpec,
  type SkillPackagingConfig,
} from '@vibe-agent-toolkit/agent-skills';
import type { Target } from '@vibe-agent-toolkit/claude-marketplace';
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';
import * as yaml from 'yaml';

import { handleCommandError } from '../../utils/command-error.js';
import { loadConfig } from '../../utils/config-loader.js';
import {
  collectPostBuildIssues,
  formatIssueLines,
  formatIssueSetHeading,
  formatRunIssueLines,
  issuesToRenderAtVerbosity,
  sumSeverityCounts,
} from '../../utils/issue-rendering.js';
import { type createLogger } from '../../utils/logger.js';
import { requireProjectRoot } from '../../utils/project-root-policy.js';
import { collectDeclaredEvalSuites, mergeSkillPackagingConfig } from '../../utils/skill-packaging-config.js';
import { applyConfigVerdicts } from '../../utils/verdict-helpers.js';

import {
  filterSkillsByName,
  setupCommandContext,
  writeYamlHeader,
  type DiscoveredSkill,
} from './command-helpers.js';
import { discoverSkillsFromConfig } from './skill-discovery.js';

export interface SkillsBuildCommandOptions {
  skill?: string;
  dryRun?: boolean;
  debug?: boolean;
  verbose?: boolean;
}

export function createBuildCommand(): Command {
  const command = new Command('build');

  command
    .description('Build skills from config yaml (discovers SKILL.md files via globs)')
    .argument('[path]', 'Path to project directory (default: current directory)')
    .option('--skill <name>', 'Build specific skill only')
    .option('--dry-run', 'Preview build without creating files')
    .option('-v, --verbose', 'Show every individual finding, not just the errors')
    .option('--debug', 'Enable debug logging')
    .action(buildCommand)
    .addHelpText(
      'after',
      `
Description:
  Discovers SKILL.md files using include/exclude globs from the skills
  section of vibe-agent-toolkit.config.yaml. Reads each SKILL.md's
  frontmatter to extract the skill name, merges packaging config
  (schema defaults -> config yaml defaults -> per-skill overrides),
  validates, and packages into dist/skills/<name>/.

Config Structure (vibe-agent-toolkit.config.yaml):
  version: 1
  skills:
    include: ["resources/skills/**/SKILL.md"]
    exclude: ["resources/skills/draft/**"]
    defaults:
      linkFollowDepth: 2
      resourceNaming: basename
    config:
      my-skill:
        linkFollowDepth: full
        validation:
          severity:
            LINK_TO_NAVIGATION_FILE: ignore
          allow:
            LINK_DROPPED_BY_DEPTH:
              - paths: ["docs/**"]
                reason: depth drop is intentional for large reference docs

Validation:
  Both pre-build and post-build checks use the unified validation framework.
  Override per-code severity (error/warning/ignore) or allow specific paths
  via validation.severity and validation.allow in vibe-agent-toolkit.config.yaml.
  See docs/validation-codes.md for all codes and their defaults.

Output:
  YAML summary -> stdout (for programmatic parsing)
  Build progress -> stderr (for human reading)

  On stderr, every findings heading names the whole set and its severity
  breakdown, and errors are always printed in full beneath it. Warnings and
  info findings stay collapsed into that heading unless --verbose, because
  they are the high-cardinality ones (one adopter skill carries 348
  LINK_DROPPED_BY_DEPTH warnings alone).

  --verbose changes the stderr report only. The stdout YAML is identical at
  either verbosity because it publishes issueCounts ONLY — per-finding detail
  (code, message, location) is on stderr and nowhere else in this command's
  output. If you need the full machine-readable finding list, run
  'vat skills validate' or 'vat audit'; those emit per-finding issues arrays.

  skills:         one row per skill that produced a bundle
  failedSkills:   one row per skill that could not be packaged AT ALL (no
                  bundle exists for it); each carries name, error and an
                  issueCounts of one error
  validationFailedSkills / skillsFailedValidation:
                  the THIRD failure mode — skills rejected by the PRE-build
                  source validation, so packaging was never attempted for
                  them. Distinct from failedSkills (packaging was attempted
                  and threw) because the fix is different: these carry their
                  own issueCounts, and the findings behind them are on stderr.
  skillsWithErrors / skillsWithErrorNames:
                  the FOURTH failure mode — skills that packaged fine and then
                  emitted post-build validation errors. They are counted in
                  skillsBuilt, not skillsFailed, so read ALL of these before
                  concluding a run was clean: the exit code follows this one too.
  runIssueCounts: findings that belong to the run rather than to any one
                  skill (ALLOW_UNUSED)
  issueCounts:    the run total, which reconciles against the rows above:

                    issueCounts = sum(skills[].issueCounts)
                                + sum(failedSkills[].issueCounts)
                                + sum(validationFailedSkills[].issueCounts)
                                + runIssueCounts

                  Every error, warning and info in the header total is
                  therefore attributable to a row you can point at.
  outputCommitted:
                  whether dist/skills was REPLACED by this run. A build writes
                  into a staging directory and promotes it only if the whole
                  run is clean, so 'false' means nothing on disk changed and
                  the previous dist/skills (if any) is exactly as it was.
                  skills[].outputPath names where each bundle WOULD live; when
                  outputCommitted is false, nothing was written there.

Exit Codes:
  0 - All skills built successfully (or dry-run preview)
  1 - One or more skills failed pre-build validation, emitted post-build
      validation errors, or could not be packaged at all. No single skill
      aborts the run: every failure of every kind is collected and reported
      in ONE pass, so one build cycle surfaces all the work. Because the run
      failed, outputCommitted is false and dist/skills was left untouched.
  2 - System error (config invalid, directory not found)

Requirements:
  projectRoot: required (errors if no vibe-agent-toolkit.config.yaml or .git/ ancestor)
  config:      required file with skills.* fields populated

  See docs/concepts/roots-and-config.md for terminology.

Example:
  $ vat skills build                    # Build all skills from config
`
    );

  return command;
}

/**
 * Render every emitted pre-build finding, each labelled with its own severity.
 *
 * `allErrors` is the full emitted set INCLUDING info (its name lies — see the
 * doc comment on `PackagingValidationResult`). Walking only the errors plus the
 * `ALLOW_EXPIRED` subset of the warnings, which is what this used to do,
 * dropped every other warning and every info finding from a report that had
 * already decided to abort the build.
 *
 * `verbose` picks how much of that set is spelled out, never how much of it is
 * COUNTED: the heading is built from `allErrors` either way, so the severity
 * breakdown stays whole even when the bodies below it do not (see
 * `issuesToRenderAtVerbosity`). Every error is printed at both verbosities —
 * these are the findings that just aborted the build, so putting one behind a
 * flag would mean re-running to learn what broke.
 *
 * Pure so the whole set is assertable, not a chosen subset of it.
 */
export function formatPreBuildIssueReport(
  validationResult: PackagingValidationResult,
  verbose: boolean,
): string[] {
  const lines: string[] = [];
  if (validationResult.allErrors.length > 0) {
    lines.push(`\n   ${formatIssueSetHeading(validationResult.allErrors)}:`);
    for (const issue of issuesToRenderAtVerbosity(validationResult.allErrors, verbose)) {
      lines.push(...formatIssueLines(issue, '     '));
    }
  }
  return lines;
}

/**
 * Render post-build integrity issues, each prefixed by its OWN resolved severity.
 *
 * Reads BOTH post-build channels (see `collectPostBuildIssues`) so a build that
 * failed purely on the built-output validation still shows the findings that
 * failed it, and the heading names the set's actual severity mix rather than
 * calling every set by its worst member.
 *
 * The heading is unconditional and counts the WHOLE set; `verbose` decides only
 * which findings get a block beneath it (see `issuesToRenderAtVerbosity`). This
 * loop printing every occurrence is what made a 90-skill build emit 6,552 stderr
 * lines against the 804 `vat skills validate` emitted for the same corpus — 1,620
 * of them one high-cardinality warning code. A set whose findings all collapse
 * still renders its heading: collapsing that too would turn a warning-carrying
 * build into silence, which is the reassuring direction this module warns about.
 *
 * Pure: returns the lines instead of writing them, so the whole rendered set is
 * assertable without capturing a stream.
 */
export function formatPostBuildIssueReport(
  result: PackageSkillResult,
  verbose: boolean,
): string[] {
  const issues = collectPostBuildIssues(result);
  if (issues.length === 0) return [];
  const lines = [`   ${formatIssueSetHeading(issues, 'post-build')}:`];
  for (const issue of issuesToRenderAtVerbosity(issues, verbose)) {
    lines.push(...formatIssueLines(issue, '     '));
  }
  return lines;
}

/**
 * Log post-build integrity issues to stderr (the human stream; stdout is
 * reserved for the YAML summary).
 */
function logPostBuildIssues(
  result: PackageSkillResult,
  logger: ReturnType<typeof createLogger>,
  verbose: boolean,
): void {
  for (const line of formatPostBuildIssueReport(result, verbose)) {
    logger.info(line);
  }
}

/**
 * Display allowed issues for context
 */
function displayIgnoredErrors(
  validationResult: PackagingValidationResult,
  logger: ReturnType<typeof createLogger>
): void {
  if (validationResult.ignoredErrors.length > 0) {
    logger.info(`\n   Allowed issues (${validationResult.ignoredErrors.length}):`);
    for (const record of validationResult.ignoredErrors) {
      logger.info(`     [${String(record.code)}] ${String(record.location)} (allowed: ${record.reason})`);
    }
  }
}

/**
 * Validate skill before building.
 *
 * An object parameter, not a positional list: `allowLedger` and `projectSkills` are
 * both RUN-scoped values threaded from {@link runSkillBuild}, and neither is
 * meaningful in isolation — a positional call site can transpose the two roots
 * (`locationRoot`) and the two run values in silence.
 */
interface ValidateSkillInput {
  skillName: string;
  sourcePath: string;
  packagingConfig: SkillPackagingConfig;
  logger: ReturnType<typeof createLogger>;
  locationRoot: string;
  /** The RUN's allow-entry usage ledger, drained once after the last skill. */
  allowLedger: AllowUsageLedger;
  /** The RUN's declared eval suites — the whole project's, not this skill's. */
  projectSkills: readonly DeclaredEvalSuite[];
  verbose: boolean;
}

/**
 * Run the PRE-build source validation for one skill and REPORT the verdict —
 * never act on it.
 *
 * This used to `process.exit(1)` from inside the per-skill loop, so a run named
 * the first bad skill and nothing else. Measured on a 90-skill adopter: 3 of the
 * 28 errors and 1 of the 6 broken skills, which is six full build cycles to
 * discover the work. Returning the failure lets {@link runSkillBuild} collect
 * every one of them and fail once, at the end, with the whole list.
 *
 * The returned counts come from `allErrors` — the full EMITTED set including
 * warnings and info (its name lies; see `PackagingValidationResult`) — so the
 * row this becomes carries the same three-valued distribution every other row
 * publishes, rather than a flat "one error" stand-in.
 */
async function validateSkillBeforeBuild(
  input: ValidateSkillInput,
): Promise<SkillValidationFailure | undefined> {
  const { skillName, sourcePath, packagingConfig, logger, locationRoot, allowLedger, projectSkills, verbose } = input;
  logger.debug(`   Validating skill: ${skillName}`);

  // The run's ledger, not this call's: an allow entry scoped to a SOURCE
  // filename can only ever match here — packaging renames the file to
  // `SKILL.md` and the built lane drops the source-only codes — so a build that
  // withholds this lane's matches from the run reports live entries as dead.
  //
  // The run's declared eval suites likewise: this lane must model the same bundle
  // the packager below produces, and that bundle excludes EVERY skill's test input.
  const validationResult = await validateSkillForPackaging(
    sourcePath,
    packagingConfig,
    'source',
    { allowLedger, projectSkills },
  );
  applyConfigVerdicts(
    validationResult,
    packagingConfig.targets as readonly Target[] | undefined,
    sourcePath,
    locationRoot,
  );

  if (validationResult.status !== 'error') {
    if (validationResult.ignoredErrors.length > 0) {
      logger.debug(`   ${validationResult.ignoredErrors.length} issue(s) allowed by config`);
    }
    return undefined;
  }

  // Validation failed — display every emitted finding, then hand the verdict
  // back. No `Build aborted` line: the run continues, and saying otherwise here
  // would contradict the 89 skills that go on to build beneath this message.
  logger.error(`\nSkill validation failed: ${skillName}`);
  logger.error(`   Source: ${sourcePath}`);

  for (const line of formatPreBuildIssueReport(validationResult, verbose)) {
    logger.error(line);
  }
  displayIgnoredErrors(validationResult, logger);

  return { name: skillName, issueCounts: countBySeverity(validationResult.allErrors) };
}

/**
 * Output dry-run results
 */
function outputDryRunYaml(
  skills: DiscoveredSkill[],
  duration: number
): void {
  writeYamlHeader({
    status: 'success',
    dryRun: true,
    // A dry run validates NOTHING, so it has no severity distribution to
    // publish. Saying so is the point: an absent `issueCounts` next to
    // `status: success` otherwise reads as "clean", which is the reassuring
    // misreading. This field makes the absence explicit instead.
    validated: false,
    skillsFound: skills.length,
  });
  process.stdout.write(`skills:\n`);
  for (const skill of skills) {
    process.stdout.write(`  - name: ${skill.name}\n`);
    process.stdout.write(`    source: ${skill.sourcePath}\n`);
    process.stdout.write(`    output: dist/skills/${skillNameToFsPath(skill.name)}\n`);
  }
  process.stdout.write(`duration: ${duration}ms\n`);
}

/**
 * Perform dry-run preview
 */
function performDryRun(
  skillsToBuild: DiscoveredSkill[],
  duration: number,
  logger: ReturnType<typeof createLogger>
): void {
  logger.info(`Dry-run: Analyzing skill build...`);
  logger.info(`   Skills to build: ${skillsToBuild.length}`);

  logger.info(`\nSkills:`);
  for (const skill of skillsToBuild) {
    logger.info(`   ${skill.name}`);
    logger.info(`      Source: ${skill.sourcePath}`);
    logger.info(`      Output: dist/skills/${skillNameToFsPath(skill.name)}`);
  }

  outputDryRunYaml(skillsToBuild, duration);

  logger.info(`\nDry-run complete (no files created)`);
  logger.info(`   Run without --dry-run to build the skills`);
}

/**
 * What ONE unpackageable skill contributes to the run's counts.
 *
 * A fresh object per row: these are published as separate YAML nodes, and a
 * shared reference is how a document grows anchors (or a later mutation edits
 * every row at once).
 */
const failureIssueCounts = (): SeverityCounts => ({ errors: 1, warnings: 0, info: 0 });

/**
 * The archived summary of a build, as YAML fields.
 *
 * `status` used to be the literal `success` — printed even for a build that then
 * exited 1 on post-build errors, so the machine-readable half of the output
 * contradicted the exit code, in the reassuring direction. It is now derived
 * from the same issues the human stream renders, and the per-severity counts
 * ride beside it because a status cannot express a three-valued distribution:
 * `success` here means "nothing you must act on", not "there was nothing to see".
 *
 * The header total reconciles against the document, by construction:
 *
 *     issueCounts === Σ skills[].issueCounts
 *                   + Σ failedSkills[].issueCounts
 *                   + Σ validationFailedSkills[].issueCounts
 *                   + runIssueCounts
 *
 * Every addend therefore has a ROW a reader can point at. Counting the failures
 * only in the header — which is how this first shipped — reproduced, one command
 * over, the exact defect `vat skills validate` was fixed for: a header reporting
 * more than its rows summed to (there, 1814 warnings against 1800), leaving a
 * consumer to hand-count a list to find out what the difference was. `--help`
 * states this identity; changing it means changing that text too.
 *
 * Takes the whole {@link SkillBuildRun} rather than a positional list of its
 * parts: the run has four populations now, and a positional call site can
 * transpose two same-shaped lists in silence.
 */
export function buildYamlSummary(
  run: SkillBuildRun,
  duration: number,
): {
  status: 'success' | 'warning' | 'error';
  issueCounts: SeverityCounts;
  runIssueCounts: SeverityCounts;
  skillsBuilt: number;
  skillsFailed: number;
  skillsFailedValidation: number;
  skillsWithErrors: string[];
  outputCommitted: boolean;
  skills: Array<{
    name: string;
    outputPath: string;
    filesPackaged: number;
    issueCounts: SeverityCounts;
  }>;
  failedSkills: Array<{ name: string; error: string; issueCounts: SeverityCounts }>;
  validationFailedSkills: Array<{ name: string; issueCounts: SeverityCounts }>;
  runIssues: ValidationIssue[];
  duration: string;
} {
  const { results, failures, runIssues, skillsWithErrors, validationFailures, outputCommitted } = run;
  const perSkill = results.map(({ name, result }) => {
    const issues = collectPostBuildIssues(result);
    return {
      name,
      // KNOWN, DELIBERATELY NOT FIXED — this is an ABSOLUTE path, so stdout carries
      // `$HOME`. Confirmed on a real 90-skill adopter run:
      // `outputPath: /Users/<user>/Workspaces/.../dist/skills/<name>`. It is absolute
      // because `runSkillBuild` builds it with `safePath.resolve(cwd, 'dist', ...)`.
      //
      // Do NOT "helpfully" relativize it. It is blocked on an approved-but-unbuilt
      // design decision that is the project owner's call: the document must state one
      // `root:` and re-base every path onto it, the same coordinate-system rule
      // `vat audit` already follows (see `deriveScanRoot` in ../audit.ts — "the ONE base
      // every `path` and `location` in a report is expressed relative to"). Making this
      // one field relative ahead of that decision picks the anchor by accident and
      // leaves the document in two coordinate systems.
      outputPath: result.outputPath,
      filesPackaged: result.files.dependencies.length + 1,
      issueCounts: countBySeverity(issues),
      issues,
    };
  });
  const allIssues = perSkill.flatMap((s) => s.issues);
  const runIssueCounts = countBySeverity(runIssues);
  // A skill that THREW emits no issues at all — it never reached the lanes that
  // produce them. Deriving the header purely from issue channels therefore said
  // `success` for a run the command then exited 1 on, which is exactly the
  // reassuring contradiction this summary exists to prevent. Each failure is
  // counted as one error so `status`, `issueCounts` and the exit code agree —
  // and that error is published ON the failure's own row (see
  // `failureIssueCounts`), never as a header-only addend, so the identity
  // documented in `--help` holds.
  const failedSkills = failures.map(({ name, message }) => ({
    name,
    error: message,
    issueCounts: failureIssueCounts(),
  }));
  // The THIRD population, and the one an adopter meets first: a skill the
  // PRE-build source validation rejected, so packaging was never attempted. It
  // gets its own rows rather than joining either list above, because neither
  // answers the question this one raises — `failedSkills` says packaging was
  // attempted and threw, `skills` says a bundle exists. And unlike a throw, this
  // failure HAS a severity distribution of its own, so it publishes the real
  // counts instead of the flat `failureIssueCounts()` stand-in.
  const validationFailedSkills = validationFailures.map(({ name, issueCounts }) => ({
    name,
    issueCounts,
  }));

  return {
    status: failures.length > 0 || validationFailures.length > 0
      ? 'error'
      : calculateValidationStatus([...allIssues, ...runIssues]),
    issueCounts: sumSeverityCounts([
      ...perSkill.map((s) => s.issueCounts),
      ...failedSkills.map((s) => s.issueCounts),
      ...validationFailedSkills.map((s) => s.issueCounts),
      runIssueCounts,
    ]),
    runIssueCounts,
    skillsBuilt: results.length,
    skillsFailed: failures.length,
    skillsFailedValidation: validationFailures.length,
    // Whether dist/skills was actually REPLACED. Carried through from the run
    // rather than re-derived here: two definitions of "did this build change
    // anything" is exactly how a report ends up contradicting the disk.
    outputCommitted,
    // The OTHER meaning of "failed", published because the exit code follows
    // THIS one and nothing in the document did. `skillsFailed` counts skills
    // that could not be packaged at all; a skill that packaged fine and then
    // emitted post-build validation errors is a `skillsBuilt`, so a real run
    // printed "Build failed: 3 skill(s) emitted post-build validation errors"
    // over `skillsFailed: 0` and `failedSkills: []`, and exited 1. A CI job
    // reading either field saw a clean build. Both categories are now named.
    skillsWithErrors: [...skillsWithErrors],
    // `skills` lists what exists on disk. A failed skill is published in its own
    // list rather than here, because every field of this shape (outputPath,
    // filesPackaged) would have to be invented for a bundle that was not written.
    skills: perSkill.map(({ name, outputPath, filesPackaged, issueCounts }) => ({
      name,
      outputPath,
      filesPackaged,
      issueCounts,
    })),
    failedSkills,
    validationFailedSkills,
    runIssues: [...runIssues],
    duration: `${duration}ms`,
  };
}

/**
 * Output build results
 */
function outputBuildYaml(run: SkillBuildRun, duration: number): void {
  const summary = buildYamlSummary(run, duration);
  const {
    status, skillsBuilt, skillsFailed, skillsFailedValidation, issueCounts, runIssueCounts,
    skills, failedSkills, validationFailedSkills, outputCommitted,
    duration: durationText,
  } = summary;
  // In the header, beside the other counts: these are the numbers the exit code
  // actually follows, so a reader who stops at the header is not misled by it.
  // `outputCommitted` rides up here too — a reader who sees exit 1 needs to know
  // whether their dist/skills still exists before they do anything else.
  writeYamlHeader({
    status,
    skillsBuilt,
    skillsFailed,
    skillsFailedValidation,
    skillsWithErrors: summary.skillsWithErrors.length,
    outputCommitted,
  });
  process.stdout.write(
    yaml.stringify(
      {
        issueCounts,
        runIssueCounts,
        skills,
        failedSkills,
        validationFailedSkills,
        skillsWithErrorNames: summary.skillsWithErrors,
        runIssues: summary.runIssues,
      },
      { indent: 2, lineWidth: 0, aliasDuplicateObjects: false },
    ),
  );
  process.stdout.write(`duration: ${durationText}\n`);
}

/** How the human stream names the output tree. One spelling, one place. */
const DIST_SKILLS_LABEL = 'dist/skills';

/**
 * Where a skill's bundle lives once a build has earned the swap.
 *
 * THE one definition, shared by the progress line, the published `outputPath`
 * and the staging promotion — so the path a reader is told about is by
 * construction the path the swap lands on.
 */
function finalOutputPath(cwd: string, skillName: string): string {
  return safePath.resolve(cwd, 'dist', 'skills', skillNameToFsPath(skillName));
}

/**
 * A build in progress: it writes under {@link root} and earns `dist/skills` only
 * by finishing clean.
 *
 * The old flow deleted `dist/skills` up front and wrote the new bundles straight
 * into it, so ANY failure left the tree destroyed rather than stale — and
 * `dist/` is gitignored, so the previous good output was unrecoverable. Measured
 * on a 90-skill adopter: 27 skill directories and 106 files present before,
 * directory absent after. Downstream consumers (`vat claude plugin install
 * --dev` symlinks out of `dist/skills`; plugin builds re-read it) then saw an
 * ABSENT tree, and a later `vat build --only claude` reported
 * `status: success / Skills available: 0` against a tree the previous command
 * had deleted.
 */
interface BuildStaging {
  /** Where each bundle is written during the run, in place of `dist/skills`. */
  root: string;
  /** True when a previous build's output was set aside and can be restored. */
  hadPreviousOutput: boolean;
  /** Promote the staged tree, discarding the previous output. */
  commit: () => Promise<void>;
  /** Discard the staged tree, restoring the previous output byte for byte. */
  abort: () => Promise<void>;
}

/**
 * Move the previous output aside and open a staging root for this run.
 *
 * Three properties the placement is load-bearing for:
 *
 * 1. **Same filesystem.** The staging root is a SIBLING of `dist/skills` under
 *    `dist/`, so promotion is a `rename` — atomic and free — never a
 *    cross-device copy of a tree that can be tens of thousands of files.
 * 2. **Invisible to the run.** `createProjectRegistry` crawls the project for
 *    `**\/*.md` and excludes `**\/dist/**`, so nothing staged here can enter the
 *    registry the packager resolves links against. The leading dot is a second
 *    belt: a `files:` glob like `dist/**` does not descend into dot-directories.
 * 3. **The final path is ABSENT while the build runs.** The previous tree is
 *    renamed away before the first bundle is written, which is exactly what the
 *    delete-up-front flow guaranteed — so no lane can read a half-replaced
 *    `dist/skills`, and a stale bundle cannot leak into the new output.
 *
 * `mkdtemp` rather than a fixed name: two builds in one `dist/` must not share a
 * staging root, and a leftover root from a killed run must not be adopted.
 *
 * KNOWN WINDOW, deliberately not closed here: a run killed between the park and
 * the commit/abort (Ctrl-C on a multi-minute build, a CI timeout, a crash) leaves
 * `dist/skills` absent and the previous output parked at
 * `dist/.vat-skills-<rand>.previous`. That is no worse than the delete-up-front
 * flow this replaces — there, the same interrupt lost the tree outright — and the
 * output is recoverable with a single `mv`. Auto-recovering it on the next run is
 * NOT safe as long as `mkdtemp` allows concurrent builds in one `dist/`: a sweep
 * cannot tell a dead run's parked tree from a live run's, and adopting the wrong
 * one would restore stale bundles over fresh output. Closing this needs a lock on
 * `dist/`, not a heuristic.
 */
async function beginStagedBuild(
  cwd: string,
  onlySkill: string | undefined,
): Promise<BuildStaging> {
  const distDir = safePath.resolve(cwd, 'dist');
  const skillsDir = safePath.join(distDir, 'skills');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from cwd
  await mkdir(distDir, { recursive: true });
  const root = toForwardSlash(await mkdtemp(safePath.join(distDir, '.vat-skills-')));

  // `--skill <name>` rebuilds ONE bundle, so the all-or-nothing guarantee is
  // scoped to that bundle: its siblings under dist/skills are neither replaced
  // nor set aside, exactly as the delete-just-that-directory flow behaved.
  const subPath = onlySkill === undefined ? undefined : skillNameToFsPath(onlySkill);
  const promoteFrom = subPath === undefined ? root : safePath.join(root, subPath);
  const promoteTo = subPath === undefined ? skillsDir : safePath.join(skillsDir, subPath);
  // `skillNameToFsPath` yields ONE path segment, so the parent is always known
  // without a dirname call.
  const promoteToParent = subPath === undefined ? distDir : skillsDir;
  const parked = `${root}.previous`;

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from cwd
  const hadPreviousOutput = existsSync(promoteTo);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from cwd
  if (hadPreviousOutput) await rename(promoteTo, parked);

  return {
    root,
    hadPreviousOutput,
    commit: async () => {
      // Guarded because in single-skill mode the staged bundle is a SUBPATH that
      // exists only if that one skill actually built. (In full-build mode the
      // staging root always exists, so a run that built nothing promotes an
      // empty dist/skills — an accurate statement of "this build produced no
      // bundles", where the old delete-up-front flow left the path absent.)
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from cwd
      if (existsSync(promoteFrom)) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from cwd
        await mkdir(promoteToParent, { recursive: true });
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from cwd
        await rename(promoteFrom, promoteTo);
      }
      await rm(parked, { recursive: true, force: true });
      // A no-op in full-build mode (the rename above consumed it); in
      // single-skill mode this is the now-empty staging shell.
      await rm(root, { recursive: true, force: true });
    },
    abort: async () => {
      await rm(root, { recursive: true, force: true });
      if (!hadPreviousOutput) return;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from cwd
      await mkdir(promoteToParent, { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from cwd
      await rename(parked, promoteTo);
    },
  };
}

/** One discovered skill paired with the packaging config merged for it. */
export interface BuildSkillSpec {
  skill: DiscoveredSkill;
  packagingConfig: SkillPackagingConfig;
}

/**
 * A skill whose packaging THREW — it produced no artifact at all.
 *
 * Deliberately distinct from `skillsWithErrors`, which names skills that built
 * successfully and then failed post-build validation. Collapsing the two would
 * lose the only distinction that matters to the reader: whether `dist/skills/`
 * contains anything for that name.
 */
export interface SkillBuildFailure {
  name: string;
  message: string;
}

/**
 * A skill the PRE-build source validation rejected — packaging was never
 * attempted for it.
 *
 * The third of four populations, and deliberately not merged into either
 * neighbour: {@link SkillBuildFailure} means packaging ran and threw, and
 * `skillsWithErrors` means a bundle exists and is invalid. This one means the
 * source never qualified. It carries real per-severity counts (a rejected
 * source has a whole emitted finding set) rather than the one-error stand-in a
 * throw is forced to publish.
 */
export interface SkillValidationFailure {
  name: string;
  issueCounts: SeverityCounts;
}

/** Everything one `vat build` invocation produced, ready to report on. */
export interface SkillBuildRun {
  results: Array<{ name: string; result: PackageSkillResult }>;
  /** Findings that belong to the run, not to any one skill (ALLOW_UNUSED). */
  runIssues: ValidationIssue[];
  /** Names of skills that BUILT and whose own post-build validation errored. */
  skillsWithErrors: string[];
  /** Skills that never built because packaging threw. */
  failures: SkillBuildFailure[];
  /** Skills that never built because their SOURCE failed validation. */
  validationFailures: SkillValidationFailure[];
  /**
   * Whether `dist/skills` was replaced by this run.
   *
   * `false` means the staged tree was thrown away and whatever was on disk
   * before is still there, untouched — the fact an operator staring at exit 1
   * needs before deciding whether their downstream consumers are broken.
   */
  outputCommitted: boolean;
}

/** The inputs of ONE `vat skills build` invocation. */
export interface SkillBuildRunInput {
  specs: readonly BuildSkillSpec[];
  cwd: string;
  logger: ReturnType<typeof createLogger>;
  /** The RUN's declared eval suites — the whole project's, not `specs`'. */
  projectSkills: readonly DeclaredEvalSuite[];
  /**
   * `--skill <name>`, or `undefined` for a full build. Scopes BOTH what gets
   * built and what the swap replaces, so a single-skill build leaves its
   * siblings' bundles exactly where they were.
   */
  onlySkill: string | undefined;
  verbose: boolean;
}

/**
 * Validate, package, and drain — the whole span of ONE `vat build` invocation.
 *
 * The allow-usage ledger created here spans EVERY skill and BOTH validation
 * lanes (the source-tree pre-build check and the two lanes inside
 * `packageSkill`), because `validation.allow` is declared once for the package
 * while being evaluated once per skill per lane. Anything narrower reports
 * entries that legitimately matched somewhere else as unused: measured on this
 * repo's own 13-skill package, 3 live entries produced 32 false ALLOW_UNUSED
 * warnings — 6 from the cross-skill seam, 26 because the two lanes inside
 * `packageSkill` see a FILTERED issue population against a file packaging has
 * renamed to `SKILL.md`, so entries scoped to a source filename are structurally
 * incapable of matching there. A lane that sees a subset cannot answer "matched
 * nothing"; only the union can. Hence one ledger, drained once, here.
 *
 * Extracted from the command body so the span is testable without driving
 * `process.exit` — the drain seam is the thing worth asserting. Nothing in here
 * exits: every failure of every kind is COLLECTED and returned, so one run
 * surfaces all the work rather than the first item of it.
 */
export async function runSkillBuild(input: SkillBuildRunInput): Promise<SkillBuildRun> {
  const { specs, cwd, logger, projectSkills, onlySkill, verbose } = input;
  const allowLedger = createAllowUsageLedger();
  const staging = await beginStagedBuild(cwd, onlySkill);

  // Validate every skill before building ANY of them, and keep going past the
  // ones that fail: a rejected source is a finding to report, not a reason to
  // stop looking. The path logged is the FINAL one — it is where the bundle will
  // live if this run earns the swap, and the staging path is an implementation
  // detail no reader should have to decode.
  const buildable: BuildSkillSpec[] = [];
  const validationFailures: SkillValidationFailure[] = [];
  for (const spec of specs) {
    const { skill, packagingConfig } = spec;
    logger.info(`\nBuilding skill: ${skill.name}`);
    logger.info(`   Source: ${skill.sourcePath}`);
    logger.info(`   Output: ${finalOutputPath(cwd, skill.name)}`);

    const failure = await validateSkillBeforeBuild({
      skillName: skill.name,
      sourcePath: skill.sourcePath,
      packagingConfig,
      logger,
      locationRoot: cwd,
      allowLedger,
      projectSkills,
      verbose,
    });
    if (failure) {
      validationFailures.push(failure);
      continue;
    }
    buildable.push(spec);
  }

  // Build the skills that qualified, with a shared registry.
  //
  // `projectSkills` is the run's declared eval suites — the whole project's, not
  // `specs`'. `--skill x` narrows what gets BUILT; it never narrows what counts as
  // test input, because an excluded skill's suite is still an answer key that must
  // not ship inside x's bundle.
  const buildSpecs: SkillBuildSpec[] = buildable.map(({ skill, packagingConfig }) => ({
    skillPath: skill.sourcePath,
    options: packagingConfigToPackageOptions(
      packagingConfig,
      {
        skillPath: skill.sourcePath,
        // Into staging, not dist/skills: see `beginStagedBuild`.
        outputPath: safePath.join(staging.root, skillNameToFsPath(skill.name)),
      },
      projectSkills,
    ),
  }));

  const outcomes = await packageSkills(buildSpecs, cwd, allowLedger);

  const results: Array<{ name: string; result: PackageSkillResult }> = [];
  const skillsWithErrors: string[] = [];
  const failures: SkillBuildFailure[] = [];
  for (const [i, spec] of buildable.entries()) {
    const outcome = outcomes[i];
    if (!outcome) continue;
    if (outcome.status === 'failed') {
      // No `Built N files` line here: nothing was built, and claiming a count
      // for an absent bundle is the misreport this branch exists to avoid.
      logger.error(`\nBuild failed for skill: ${spec.skill.name}`);
      logger.error(`   ${outcome.error.message}`);
      failures.push({ name: spec.skill.name, message: outcome.error.message });
      continue;
    }
    const { result } = outcome;
    logger.info(`   Built ${result.files.dependencies.length + 1} files`);
    logPostBuildIssues(result, logger, verbose);
    if (result.hasErrors) {
      skillsWithErrors.push(spec.skill.name);
    }
    // Re-anchored onto the FINAL path. The bundle was written under staging, but
    // staging is transient: publishing that path would hand a consumer a
    // directory that stops existing the moment this function returns.
    results.push({
      name: spec.skill.name,
      result: { ...result, outputPath: finalOutputPath(cwd, spec.skill.name) },
    });
  }

  // Drain point: every skill and every lane has now contributed, so this is the
  // first place the run can honestly say an entry matched nothing. A skill that
  // threw still contributed the matches it made before throwing — which is why
  // the drain must stay here, after a partially-failed batch, and not move into
  // a success-only path. (Before per-skill containment the drain never ran at
  // all on a throw, because the exception propagated straight past it.)
  //
  // Known residual: a skill that threw never reached its later lanes, so an
  // allow entry only THAT skill could have matched may now be reported
  // ALLOW_UNUSED. That is a warning, and `runHasErrors` gates on `error` only,
  // so it cannot fail a build on its own — and the run is already exiting 1 on
  // the failure the operator actually needs to fix.
  const runIssues = allowUnusedIssues(allowLedger);

  // ONE predicate, evaluated once, for BOTH "does dist/skills get replaced" and
  // (via `outputCommitted`) "what does the command exit with". Two definitions
  // of "this run failed" is how a report ends up disagreeing with the disk and
  // with the exit code — the failure mode this whole summary exists to prevent.
  // A run-level ALLOW_UNUSED is a `warning`, so it is not in here: a warning must
  // never discard artifacts that were produced correctly.
  const runFailed = failures.length > 0
    || validationFailures.length > 0
    || skillsWithErrors.length > 0
    || runIssues.some((i) => i.severity === 'error');

  if (runFailed) {
    await staging.abort();
    logger.error(
      staging.hadPreviousOutput
        ? `\n   Nothing was replaced — the previous ${DIST_SKILLS_LABEL} is intact`
        : `\n   Nothing was written — ${DIST_SKILLS_LABEL} does not exist`,
    );
  } else {
    await staging.commit();
  }

  return {
    results,
    runIssues,
    skillsWithErrors,
    failures,
    validationFailures,
    outputCommitted: !runFailed,
  };
}

/**
 * Name every way this run failed, on stderr, one section per population.
 *
 * All four sections print — a run can fail in several ways at once, and the
 * whole point of collecting rather than aborting is that ONE build cycle shows
 * an adopter all of the work. A section that stopped at the first population
 * would put the fail-fast defect back one level up.
 */
function logRunFailures(run: SkillBuildRun, logger: ReturnType<typeof createLogger>): void {
  const { failures, skillsWithErrors, validationFailures, runIssues } = run;
  if (validationFailures.length > 0) {
    logger.error(`\nBuild failed: ${validationFailures.length} skill(s) failed pre-build validation`);
    for (const { name } of validationFailures) logger.error(`   - ${name}`);
  }
  if (failures.length > 0) {
    logger.error(`\nBuild failed: ${failures.length} skill(s) could not be packaged at all`);
    for (const { name, message } of failures) {
      logger.error(`   - ${name}: ${message.split('\n')[0] ?? message}`);
    }
  }
  if (skillsWithErrors.length > 0) {
    logger.error(`\nBuild failed: ${skillsWithErrors.length} skill(s) emitted post-build validation errors`);
    for (const name of skillsWithErrors) logger.error(`   - ${name}`);
  }
  // A run-level finding belongs to no skill, so the loops above cannot carry it.
  // Only `error` severity gates: ALLOW_UNUSED ships as a `warning`, and a
  // warning must never abort a build that produced its artifacts.
  if (runIssues.some((i) => i.severity === 'error')) {
    logger.error(`\nBuild failed: run-level validation errors (project config, not any one skill)`);
  }
}

async function buildCommand(
  pathArg: string | undefined,
  options: SkillsBuildCommandOptions
): Promise<void> {
  const { logger, cwd, startTime } = setupCommandContext(pathArg, options.debug);

  try {
    // Spec §7: `vat skills build` requires a projectRoot — fails fast at the
    // CLI boundary if no config or git ancestor exists. The resolved root is
    // discarded here because config is read from `cwd` (the package dir),
    // not the project root; the guard exists to satisfy the policy contract.
    requireProjectRoot(cwd, 'vat skills build');

    // Load config yaml from cwd (not workspace root — config lives next to the package)
    const config = loadConfig(cwd);

    if (!config?.skills) {
      logger.info('No skills configuration found — nothing to build');
      process.exit(0);
    }

    const skillsConfig = config.skills;

    // Discover SKILL.md files from config globs (relative to cwd where config lives)
    logger.info(`Discovering skills from config...`);
    const discoveredSkills = await discoverSkillsFromConfig(skillsConfig, cwd);

    if (discoveredSkills.length === 0) {
      throw new Error(
        `No SKILL.md files found matching include patterns: ${skillsConfig.include.join(', ')}`
      );
    }

    // Filter by skill name if specified
    const skillsToBuild = filterSkillsByName(discoveredSkills, options.skill);

    logger.info(`Found ${skillsToBuild.length} skill(s) to build`);

    // Handle dry-run mode. Nothing has touched `dist/` at this point — the
    // staging directory and the swap both live inside `runSkillBuild`, which a
    // dry run never reaches, so "preview without creating files" is now true of
    // the OUTPUT TREE as well as of the bundles. (The old flow deleted
    // `dist/skills` before this branch and relied on an `if (!options.dryRun)`
    // guard three lines up to stay honest.)
    if (options.dryRun) {
      const duration = Date.now() - startTime;
      performDryRun(skillsToBuild, duration, logger);
      process.exit(0);
    }

    const buildSpecs: BuildSkillSpec[] = skillsToBuild.map((skill) => ({
      skill,
      packagingConfig: mergeSkillPackagingConfig(
        skillsConfig.defaults,
        skillsConfig.config?.[skill.name],
      ),
    }));

    // Assembled ONCE, from the UNFILTERED discovery: `--skill x` narrows the build,
    // not the set of files that count as some skill's declared test input.
    const projectSkills = collectDeclaredEvalSuites(skillsConfig, discoveredSkills);

    const run = await runSkillBuild({
      specs: buildSpecs,
      cwd,
      logger,
      projectSkills,
      onlySkill: options.skill,
      verbose: options.verbose === true,
    });
    const duration = Date.now() - startTime;

    // Output YAML results
    outputBuildYaml(run, duration);
    for (const line of formatRunIssueLines(run.runIssues)) {
      logger.info(line);
    }
    logRunFailures(run, logger);

    // Gated on the SAME fact that decided whether the swap happened, not on a
    // second copy of the predicate: the exit code and `outputCommitted` can then
    // never disagree about whether this run succeeded.
    if (!run.outputCommitted) {
      process.exit(1);
    }

    logger.info(`\nBuilt ${run.results.length} skill(s) successfully`);

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'SkillsBuild');
  }
}
