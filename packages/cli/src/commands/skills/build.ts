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
} from '@vibe-agent-toolkit/schema';
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
  countCollapsedFindings,
  formatCollapsedFindingsHint,
  formatIssueLines,
  formatIssueSetHeading,
  formatPackagedFileCount,
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
import { rejectUnscopablePath, type SkillsScopeSubject } from './scope-guard.js';
import { discoverSkillsFromConfig } from './skill-discovery.js';

export interface SkillsBuildCommandOptions {
  skill?: string;
  dryRun?: boolean;
  debug?: boolean;
  verbose?: boolean;
}

/**
 * What a mis-scoped `vat skills build` used to do.
 *
 * The twin of the `vat skills validate` hole, and strictly the worse of the two:
 * a mistyped path printed "No skills configuration found — nothing to build" and
 * exited **0**, so a release pipeline whose build step named the wrong directory
 * published having built nothing, with a green tick. Measured on a project whose
 * bare `vat skills build` finds a skill: `vat skills build nope` exited 0.
 */
const SCOPE_SUBJECT: SkillsScopeSubject = {
  command: 'vat skills build',
  silentSuccess: 'nothing to build',
};

export function createBuildCommand(): Command {
  const command = new Command('build');

  command
    .description('Build skills from config yaml (discovers SKILL.md files via globs)')
    .argument('[path]', 'Path to project directory (default: current directory)')
    .option('--skill <name>', 'Build specific skill only')
    .option('--dry-run', 'Preview build without creating files')
    .option('-v, --verbose', 'Show every individual finding, not just the errors')
    .option('--debug', 'Enable debug logging')
    .action(async (pathArg: string | undefined, options: SkillsBuildCommandOptions) => {
      rejectUnscopablePath(SCOPE_SUBJECT, pathArg);
      await buildCommand(pathArg, options);
    })
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

  On stderr, every findings heading names its skill, the whole set and its
  severity breakdown, and errors are always printed in full beneath it.
  Warnings and info findings stay collapsed into that heading unless
  --verbose, because they are the high-cardinality ones (one adopter skill
  carries 348 LINK_DROPPED_BY_DEPTH warnings alone); one line at the end of
  the run names how many were collapsed.

  --verbose changes the stderr report ONLY. The stdout YAML is identical at
  either verbosity: every row carries its full issues array (code, message,
  location, fix) whether or not the human report printed it, because filtering
  a machine-readable document by a human report's verbosity breaks the
  consumers that parse it.

  skills:         one row per skill whose bundle EXISTS on disk — empty
                  whenever outputCommitted is false
  skillsStaged:   the same rows for a run that built its bundles and then
                  aborted the promotion. Deliberately a different key, and
                  deliberately carrying no outputPath: nothing was written, so
                  there is no path to publish. A consumer that installs,
                  symlinks or checksums what a build produced reads skills[]
                  and correctly finds nothing.
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
                                + sum(skillsStaged[].issueCounts)
                                + sum(failedSkills[].issueCounts)
                                + sum(validationFailedSkills[].issueCounts)
                                + runIssueCounts

                  Every error, warning and info in the header total is
                  therefore attributable to a row you can point at. (Exactly
                  one of skills / skillsStaged is ever non-empty, so no
                  packaged bundle is counted twice.)
  outputCommitted:
                  whether dist/skills was REPLACED by this run. A build writes
                  into a staging directory and promotes it only if the whole
                  run is clean, so 'false' means nothing on disk changed and
                  the previous dist/skills (if any) is exactly as it was — and
                  the packaged rows are published as skillsStaged, without an
                  outputPath, because none was written.
  promotionError: present ONLY when the promotion/discard step itself failed
                  (EACCES, ENOSPC, or the ENOTEMPTY a concurrent build in the
                  same dist/ produces). Its text names what is on disk and the
                  single 'mv' that recovers it, because the parked path carries
                  a random suffix nobody can reconstruct. Read outputCommitted
                  beside it: a promotion that landed the tree and then failed to
                  clean up still committed the output.

Exit Codes:
  0 - All skills built successfully (or dry-run preview)
  1 - One or more skills failed pre-build validation, emitted post-build
      validation errors, or could not be packaged at all. No single skill
      aborts the run: every failure of every kind is collected and reported
      in ONE pass, so one build cycle surfaces all the work. Because the run
      failed, outputCommitted is false and dist/skills was left untouched.
  2 - System error (config invalid, directory not found), a [path] argument
      this command cannot read a config from, or a failure on the promotion
      path — see promotionError. On a promotion failure the YAML document is
      still written; it is the only report that says where the output went.

  A [path] naming a directory that does not exist, is not a directory, or holds
  no vibe-agent-toolkit.config.yaml is REFUSED with exit 2. It previously
  printed "No skills configuration found — nothing to build" and exited 0, so a
  pipeline whose build step named the wrong directory shipped having built
  nothing, and reported success.

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
 * Render ONE skill's post-build integrity issues, each prefixed by its OWN
 * resolved severity.
 *
 * Reads BOTH post-build channels (see `collectPostBuildIssues`) so a build that
 * failed purely on the built-output validation still shows the findings that
 * failed it, and the heading names the set's actual severity mix rather than
 * calling every set by its worst member.
 *
 * The heading NAMES THE SKILL, matching `vat claude plugin build`'s per-skill
 * heading, because this line is printed in the outcome pass — the validation pass
 * has already emitted every `Building skill: <name>` banner, so at scale (92
 * banners, then 86 outcome blocks) an unnamed heading sits under an unrelated
 * skill's banner and is read as that skill's findings.
 *
 * The heading is unconditional and counts the WHOLE set; `verbose` decides only
 * which findings get a block beneath it (see `issuesToRenderAtVerbosity`). This
 * loop printing every occurrence is what made a 90-skill build emit 6,552 stderr
 * lines against the 804 `vat skills validate` emitted for the same corpus — 1,620
 * of them one high-cardinality warning code. A set whose findings all collapse
 * still renders its heading: collapsing that too would turn a warning-carrying
 * build into silence, which is the reassuring direction this module warns about.
 *
 * The trailing colon is what varies: it introduces the blocks below, so a heading
 * with nothing beneath it does not print one. A colon promising a list that the
 * current verbosity will not print is the defect this half fixes; the other half
 * is the run-level `--verbose` hint (see `formatCollapsedFindingsHint`).
 *
 * Pure: returns the lines instead of writing them, so the whole rendered set is
 * assertable without capturing a stream.
 */
export function formatPostBuildIssueReport(
  skillName: string,
  result: PackageSkillResult,
  verbose: boolean,
): string[] {
  const issues = collectPostBuildIssues(result);
  if (issues.length === 0) return [];
  const rendered = issuesToRenderAtVerbosity(issues, verbose);
  const heading = `   ${skillName}: ${formatIssueSetHeading(issues, 'post-build')}`;
  const lines = [rendered.length === 0 ? heading : `${heading}:`];
  for (const issue of rendered) {
    lines.push(...formatIssueLines(issue, '     '));
  }
  return lines;
}

/**
 * Log one skill's post-build integrity issues to stderr (the human stream;
 * stdout is reserved for the YAML summary).
 *
 * Returns how many findings this verbosity collapsed, so the run can print ONE
 * hint naming the total rather than one per skill.
 */
function logPostBuildIssues(
  skillName: string,
  result: PackageSkillResult,
  logger: ReturnType<typeof createLogger>,
  verbose: boolean,
): number {
  for (const line of formatPostBuildIssueReport(skillName, result, verbose)) {
    logger.info(line);
  }
  return countCollapsedFindings(collectPostBuildIssues(result), verbose);
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
 *     issueCounts === Σ (skills[] ∪ skillsStaged[])[].issueCounts
 *                   + Σ failedSkills[].issueCounts
 *                   + Σ validationFailedSkills[].issueCounts
 *                   + runIssueCounts
 *
 * `skills` and `skillsStaged` are the same population under two names, and
 * exactly one of them is ever non-empty (see the comment on `skills` below), so
 * summing both is summing each packaged bundle once.
 *
 * Every addend therefore has a ROW a reader can point at. Counting the failures
 * only in the header — which is how this first shipped — reproduced, one command
 * over, the exact defect `vat skills validate` was fixed for: a header reporting
 * more than its rows summed to (there, 1814 warnings against 1800), leaving a
 * consumer to hand-count a list to find out what the difference was. `--help`
 * states this identity; changing it means changing that text too.
 *
 * Each packaged row carries its `issues` as well as its counts. It did not, for
 * a while: the findings were collected here and then dropped at the publish
 * step, so the document offered a count with no `code`, no location and no fix
 * string at ANY verbosity — an adopter run published 67 warnings and zero
 * findings. That is acute for the four detectors this lane added: their output
 * existed only on stderr, where no CI consumer reads it. Full findings on the
 * rows is the shape `vat audit` and `vat skills validate --verbose` already
 * publish, and it is verbosity-INDEPENDENT here for the reason stated in
 * `issuesToRenderAtVerbosity`: filtering a machine-readable document by a human
 * report's verbosity silently breaks the consumers that parse it.
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
  /** Present only when the promotion/discard step itself failed. */
  promotionError?: string;
  skills: Array<{
    name: string;
    outputPath: string;
    filesPackaged: number;
    issueCounts: SeverityCounts;
    issues: ValidationIssue[];
  }>;
  skillsStaged: Array<{
    name: string;
    filesPackaged: number;
    issueCounts: SeverityCounts;
    issues: ValidationIssue[];
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
      //
      // Do not read the rest of the report as clean because the failure MESSAGES
      // are: those were scrubbed of absolute project paths and are confirmed clean,
      // but the SUCCESS-path fields were not. This one and the plugin lane's `dir:`
      // (5 places in the measured report — see `pluginBuildCommand` in
      // ../claude/plugin/build.ts) are the two that still publish `$HOME` into CI
      // logs, and they wait on the same `root:` decision — fix them as a pair, or
      // the two lanes end up anchored differently.
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
  //
  // KNOWN, DELIBERATELY NOT FIXED — these rows carry no `issues` key, so the
  // findings that just failed the build are COUNTED here and never NAMED. On a
  // real adopter monorepo build, all 28 build-blocking errors were counted but
  // never named — 551 of 1707 findings were named overall. A CI consumer reading
  // stdout gets a number it cannot act on; the findings themselves exist only on
  // stderr.
  //
  // Stated explicitly, because a reader will otherwise assume it is covered: the
  // sibling defect on the `skills` rows — their `issues` array dropped at the
  // publish seam, see the comment on `buildYamlSummary` — was fixed, and that fix
  // does NOT cover this row type. This one is not a publish-seam drop: the
  // findings never reach here at all. `SkillValidationFailure` is `{ name,
  // issueCounts }`, so fixing it means widening that type back at the pre-build
  // validation lane, not adding a key at this call.
  const validationFailedSkills = validationFailures.map(({ name, issueCounts }) => ({
    name,
    issueCounts,
  }));

  return {
    // `promotionError` gates too: a run whose bundles all validated cleanly and
    // whose promotion then threw has no issue to derive a status from, so
    // deriving it from the issue channels alone would publish `success` beside an
    // exit code of 2 and a `dist/skills` nobody can vouch for.
    status: failures.length > 0 || validationFailures.length > 0 || run.promotionError !== undefined
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
    ...(run.promotionError === undefined ? {} : { promotionError: run.promotionError }),
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
    //
    // That invariant did not survive `outputCommitted: false`, which is the OTHER
    // way a row can name a path nothing was written to: the bundles are built into
    // staging and the promotion is then aborted, so a failed 86-skill run published
    // 86 `dist/skills/<name>` paths of which 85 did not exist (verified with
    // `fs.existsSync` over every row). A CI step reading `skills[].outputPath` to
    // install, symlink or checksum got 85 dead paths, with no signal but a sibling
    // boolean it was not told to read.
    //
    // So the rows MOVE when the swap did not happen, rather than losing a field:
    // a consumer iterating `skills[]` sees the empty list its documented meaning
    // ("what exists on disk") demands, while `skillsStaged[]` — a name that
    // promises nothing about the disk — keeps the findings and the counts the
    // header identity is summed from. Those rows publish no `outputPath` at all,
    // because there is no honest value for it: the staging path has been deleted
    // and the final path was never written.
    skills: outputCommitted ? perSkill : [],
    skillsStaged: outputCommitted
      ? []
      : perSkill.map(({ name, filesPackaged, issueCounts, issues }) => ({
        name,
        filesPackaged,
        issueCounts,
        issues,
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
    skills, skillsStaged, failedSkills, validationFailedSkills, outputCommitted,
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
        // Published in the BODY, not the header: `writeYamlHeader` writes raw
        // `key: value` lines, and this text is multi-line by design (what is on
        // disk, and the `mv` that recovers it). Emitting it there would produce a
        // document that does not parse — the one failure mode a report about a
        // failed build must not add. `status: error` and `outputCommitted` are
        // already in the header, so a reader who stops there is not misled.
        ...(summary.promotionError === undefined ? {} : { promotionError: summary.promotionError }),
        skills,
        // Always published, even empty, for the same reason `failedSkills` is: an
        // absent key reads as "this run had no such concept", and a consumer that
        // has to distinguish absent from empty will get it wrong.
        skillsStaged,
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

/** The tree a successful build promotes its staged bundles into. */
function distSkillsDir(cwd: string): string {
  return safePath.resolve(cwd, 'dist', 'skills');
}

/**
 * Where a skill's bundle lives once a build has earned the swap.
 *
 * THE one definition, shared by the progress line, the published `outputPath`
 * and the staging promotion — so the path a reader is told about is by
 * construction the path the swap lands on.
 */
function finalOutputPath(cwd: string, skillName: string): string {
  return safePath.join(distSkillsDir(cwd), skillNameToFsPath(skillName));
}

/**
 * Rewrite `value` when it names `from` or something inside it; otherwise
 * `undefined`, so a caller can fall through to the next candidate base.
 *
 * The separator in the prefix test is load-bearing: `beginStagedBuild` parks the
 * previous output at `${root}.previous`, a SIBLING whose string starts with the
 * staging root. A bare `startsWith` would rewrite it into the final tree and
 * report a finding against a path that never held the file.
 */
function replacePathPrefix(value: string, from: string, to: string): string | undefined {
  if (value === from) return to;
  return value.startsWith(`${from}/`) ? `${to}${value.slice(from.length)}` : undefined;
}

/**
 * Map any path anchored on the run's staging root onto the tree the swap lands
 * on — the ONE re-anchoring, applied to every path a result publishes.
 *
 * Staging is transient in BOTH outcomes: `dist/.vat-skills-<rand>` is renamed
 * away on success and deleted on failure, and the `mkdtemp` suffix means a
 * reader cannot even reconstruct it. Any path that escapes this mapping is
 * therefore unopenable by the time anyone reads it — which is what the published
 * `outputPath` was fixed for, while the per-finding `location` strings kept
 * leaking it (`Location: dist/.vat-skills-uxxJfu/demo/SKILL.md`, observed on a
 * real adopter and on a two-skill fixture). One mapper, applied at one seam, is
 * what keeps the two from drifting apart again.
 *
 * Both spellings are handled because the two carriers use different coordinate
 * systems: `outputPath` is absolute (see `buildYamlSummary`), while a finding's
 * `location` is relative to the project root the validator anchored on. The
 * mapping preserves whichever it was given — re-basing a location here would put
 * the report into two coordinate systems, the very thing `locationRoot` exists
 * to prevent.
 */
function createStagingPathMapper(cwd: string, stagingRoot: string): (value: string) => string {
  const absoluteFrom = toForwardSlash(stagingRoot);
  const absoluteTo = distSkillsDir(cwd);
  const relativeFrom = toForwardSlash(safePath.relative(cwd, stagingRoot));
  const relativeTo = toForwardSlash(safePath.relative(cwd, absoluteTo));

  return (value: string): string => {
    const forward = toForwardSlash(value);
    return (
      replacePathPrefix(forward, absoluteFrom, absoluteTo)
      ?? replacePathPrefix(forward, relativeFrom, relativeTo)
      ?? value
    );
  };
}

/** Re-anchor the `location` of every issue that names a staged path. */
function reanchorIssueLocations(
  issues: readonly ValidationIssue[],
  mapPath: (value: string) => string,
): ValidationIssue[] {
  return issues.map((issue) => {
    if (issue.location === undefined) return issue;
    const location = mapPath(issue.location);
    return location === issue.location ? issue : { ...issue, location };
  });
}

/**
 * Re-anchor everything ONE skill's result says about where things are.
 *
 * Both post-build channels are rewritten, not just the one the summary reads:
 * `collectPostBuildIssues` merges them and either can carry a staged location
 * (the built-output validation runs against the staged `SKILL.md` itself), so a
 * mapper applied to one of them leaves the report half-anchored.
 *
 * The `postBuildIssues` half is a live invariant with NO live producer today, and
 * the distinction matters to anyone changing it. Every issue on that channel is
 * anchored either on the bundle (`checkUnreferencedFiles`,
 * `checkBrokenPackagedLinks`, `detectPackagedAgentInstructionFiles`,
 * `checkPackagedTestInput` — all `relative(outputPath, …)`) or on the SOURCE
 * project root (`droppedGlobMatchesToIssues`, `walkerExclusionsToIssues`,
 * `deferredAssetsToIssues`, `FILENAME_COLLISION` — all `relative(projectRoot, …)`,
 * where `projectRoot` is discovered from the skill's own source path). Neither
 * spelling contains the staging prefix, so deleting this branch changes no
 * fixture in the repo — which is exactly why it is unit-tested directly rather
 * than through a build. Do not delete it on the strength of a green suite: the
 * moment any producer anchors on `outputPath` ABSOLUTELY, this is the only thing
 * standing between a report and a path its reader cannot open.
 *
 * Exported for that unit test.
 */
export function reanchorStagedResult(
  result: PackageSkillResult,
  mapPath: (value: string) => string,
): PackageSkillResult {
  const reanchored: PackageSkillResult = { ...result, outputPath: mapPath(result.outputPath) };
  if (result.postBuildIssues) {
    reanchored.postBuildIssues = reanchorIssueLocations(result.postBuildIssues, mapPath);
  }
  if (result.postBuildValidation) {
    reanchored.postBuildValidation = {
      ...result.postBuildValidation,
      allErrors: reanchorIssueLocations(result.postBuildValidation.allErrors, mapPath),
    };
  }
  return reanchored;
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
export interface BuildStaging {
  /** Where each bundle is written during the run, in place of `dist/skills`. */
  root: string;
  /** True when a previous build's output was set aside and can be restored. */
  hadPreviousOutput: boolean;
  /**
   * Where the previous output is held while the run is in flight.
   *
   * Published so a failure on the promotion path can NAME it. It is a
   * `mkdtemp`-suffixed sibling, so a reader who is not told the path cannot
   * reconstruct it — which is the difference between "recover with one `mv`" and
   * "your previous output is gone".
   */
  parkedPath: string;
  /**
   * How the human stream names what THIS run promotes.
   *
   * `dist/skills` for a full build, `dist/skills/<name>` in `--skill` mode. The
   * scope is not cosmetic: a failed `--skill bad` used to report "Nothing was
   * written — dist/skills does not exist" while `dist/skills` sat on disk holding
   * every sibling bundle. Only this skill's bundle was ever in question.
   */
  promoteLabel: string;
  /** True once this run's bundles have actually landed on the promotion target. */
  promoted: () => boolean;
  /** Promote the staged tree, discarding the previous output. */
  commit: () => Promise<void>;
  /** Discard the staged tree, restoring the previous output byte for byte. */
  abort: () => Promise<void>;
  /**
   * Best-effort repair after {@link BuildStaging.commit} or
   * {@link BuildStaging.abort} threw, and a description of what is left on disk.
   *
   * Never overwrites whatever occupies the promotion target: a promotion can fail
   * BECAUSE a concurrent build already promoted its own tree there, and restoring
   * over it would replace fresh output with a stale copy. When the target is
   * occupied the parked tree is left where it is and named in the report instead.
   */
  recover: () => Promise<StagingRecovery>;
}

/** What a best-effort {@link BuildStaging.recover} left behind. */
export interface StagingRecovery {
  /** True when the previous output was moved back onto the promotion target. */
  restoredPrevious: boolean;
  /** Paths still on disk that this run could not clean up, in report order. */
  residue: string[];
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
 *
 * That window covers KILLS only. A promotion that throws — EACCES, ENOSPC, or the
 * ENOTEMPTY a concurrent build produces with no injection at all — is deterministic,
 * needs no signal, and IS handled: see {@link BuildStaging.recover} and
 * {@link settleStaging}.
 *
 * Exported for tests, which drive the primitives directly. Injecting a promotion
 * failure through a whole `runSkillBuild` would mean racing the filesystem;
 * holding the staging handle lets a test create the exact on-disk state
 * (a target reoccupied between the park and the promotion) that produces one.
 */
export async function beginStagedBuild(
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

  // Flipped the instant this run's bundles reach `promoteTo`, so a later failure
  // in the SAME call (the parked-tree cleanup, the staging-shell removal) is not
  // mistaken for "the output never landed". Without it, a `commit()` that renamed
  // successfully and then failed to delete the parked copy would report
  // `outputCommitted: false` about a `dist/skills` that holds the new output.
  let promoted = false;

  return {
    root,
    hadPreviousOutput,
    parkedPath: parked,
    promoteLabel: subPath === undefined
      ? DIST_SKILLS_LABEL
      : `${DIST_SKILLS_LABEL}/${subPath}`,
    promoted: () => promoted,
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
      promoted = true;
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
    recover: async () => {
      const residue: string[] = [];
      let restoredPrevious = false;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from cwd
      const targetFree = !existsSync(promoteTo);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from cwd
      if (hadPreviousOutput && existsSync(parked)) {
        if (targetFree) {
          try {
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from cwd
            await mkdir(promoteToParent, { recursive: true });
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from cwd
            await rename(parked, promoteTo);
            restoredPrevious = true;
          } catch {
            // The repair is best-effort by construction: it runs because the
            // filesystem already refused something. A throw here must not replace
            // the original diagnosis, so the parked path is reported as residue
            // and the caller still names the real cause.
            residue.push(parked);
          }
        } else {
          residue.push(parked);
        }
      }
      // This run's own staging root is always safe to drop: it holds output this
      // run produced and can rebuild. Leaving it is what accumulated a complete
      // copy of the build output in `dist/` on every failed promotion.
      try {
        await rm(root, { recursive: true, force: true });
      } catch {
        residue.push(root);
      }
      return { restoredPrevious, residue };
    },
  };
}

/**
 * Promote or discard the staged tree, and never leave the operator without an
 * answer when that fails.
 *
 * `commit()` / `abort()` used to be called bare. Any throw on that path — the
 * promotion `rename`, the restore `rename`, either cleanup — propagated to
 * `buildCommand`'s catch, which exits 2 WITHOUT emitting the YAML document. The
 * measured result: `dist/skills` absent, the user's previous output orphaned at
 * `dist/.vat-skills-<rand>.previous` under a name the `mkdtemp` suffix makes
 * unguessable, and not one byte of the report whose `outputCommitted` field
 * `--help` tells an operator to read when they see a non-zero exit.
 *
 * So: repair what can be repaired, then return a message rather than throwing —
 * the caller publishes the document first and exits 2 after.
 *
 * `outputCommitted` comes from {@link BuildStaging.promoted}, not from
 * `!runFailed`: a `commit()` that renamed the tree into place and then failed to
 * delete the parked copy DID replace `dist/skills`, and saying otherwise would
 * put the report back into contradiction with the disk — the one thing this whole
 * summary exists to prevent.
 */
export async function settleStaging(
  staging: BuildStaging,
  runFailed: boolean,
  logger: ReturnType<typeof createLogger>,
): Promise<{ outputCommitted: boolean; promotionError?: string }> {
  try {
    await (runFailed ? staging.abort() : staging.commit());
  } catch (error) {
    const recovery = await staging.recover();
    return {
      outputCommitted: staging.promoted(),
      promotionError: describePromotionFailure(staging, error, recovery),
    };
  }

  if (runFailed) {
    logger.error(
      staging.hadPreviousOutput
        ? `\n   Nothing was replaced — the previous ${staging.promoteLabel} is intact`
        : `\n   Nothing was written — ${staging.promoteLabel} does not exist`,
    );
  }
  return { outputCommitted: !runFailed };
}

/**
 * State the failure, then state what is on disk and how to get back.
 *
 * Every branch names an absolute path the operator can act on. A promotion
 * failure is the one moment where "your previous output is at <path>" is the
 * whole remedy, and the path is unreconstructable without being told.
 */
function describePromotionFailure(
  staging: BuildStaging,
  error: unknown,
  recovery: StagingRecovery,
): string {
  const cause = error instanceof Error ? error.message : String(error);
  const lines = [`Build output promotion failed: ${cause}`];
  if (staging.promoted()) {
    lines.push(`   ${staging.promoteLabel} DOES hold this run's output — the failure was in the cleanup that follows.`);
  } else if (recovery.restoredPrevious) {
    lines.push(`   The previous ${staging.promoteLabel} has been restored; nothing this run built was kept.`);
  } else if (staging.hadPreviousOutput) {
    lines.push(
      `   The previous ${staging.promoteLabel} is parked at ${staging.parkedPath}`,
      `   Recover it with: mv ${staging.parkedPath} <your ${staging.promoteLabel}>`,
    );
  } else {
    lines.push(`   ${staging.promoteLabel} was never written, and there was no previous output to lose.`);
  }
  for (const path of recovery.residue) {
    lines.push(`   Left on disk (this run could not remove it): ${path}`);
  }
  return lines.join('\n');
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
  /**
   * The promotion/discard step itself failed — a SYSTEM error, not a validation
   * one, and the only failure mode where the state of `dist/skills` is in doubt.
   *
   * Carried on the run rather than thrown so the document is still published: an
   * exception here used to escape all the way to `handleCommandError`, which
   * exits 2 having emitted nothing at all. Its text names what is on disk and how
   * to recover it — see {@link describePromotionFailure}.
   */
  promotionError?: string;
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
  const mapStagedPath = createStagingPathMapper(cwd, staging.root);
  let collapsedFindings = 0;
  for (const [i, spec] of buildable.entries()) {
    const outcome = outcomes[i];
    if (!outcome) continue;
    const skillName = spec.skill.name;
    if (outcome.status === 'failed') {
      // No file-count line here: nothing was built, and claiming a count for an
      // absent bundle is the misreport this branch exists to avoid.
      logger.error(`\nBuild failed for skill: ${skillName}`);
      logger.error(`   ${outcome.error.message}`);
      failures.push({ name: skillName, message: outcome.error.message });
      continue;
    }
    // Re-anchored BEFORE anything reads it — the report below and the published
    // row both. The bundle was written under staging, and staging is transient
    // in both outcomes, so any path that survives this call unmapped is a path
    // its reader cannot open. See `createStagingPathMapper`.
    const result = reanchorStagedResult(outcome.result, mapStagedPath);
    // Named, because this line is printed in a SECOND pass: the validation pass
    // above emits every `Building skill: <name>` banner first, so at scale (92
    // banners, then 86 outcomes) an unnamed count line sits under an unrelated
    // skill's banner and reads as that skill's result.
    logger.info(`   ${skillName}: built ${formatPackagedFileCount(result)}`);
    collapsedFindings += logPostBuildIssues(skillName, result, logger, verbose);
    if (result.hasErrors) {
      skillsWithErrors.push(skillName);
    }
    results.push({ name: skillName, result });
  }
  // ONE hint for the run, after every skill has reported — the shape `vat audit`
  // already uses. Per skill it would repeat 86 times on the adopter run that
  // motivated it; omitted entirely (which is how this shipped) the collapsed
  // block is a heading with nothing under it and no way to learn there is more.
  const collapsedHint = formatCollapsedFindingsHint(collapsedFindings, 'build');
  if (collapsedHint !== undefined) logger.info(collapsedHint);

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

  const { outputCommitted, promotionError } = await settleStaging(staging, runFailed, logger);

  return {
    results,
    runIssues,
    skillsWithErrors,
    failures,
    validationFailures,
    outputCommitted,
    ...(promotionError === undefined ? {} : { promotionError }),
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

    // A promotion failure is a SYSTEM error (2), not a validation one (1): the
    // build's verdict on the skills is not what went wrong, and a CI script has
    // to be able to tell "your skills are broken" from "the filesystem refused
    // and dist/skills is in a state someone must look at". Reported AFTER the
    // document is written, which is the whole reason it rides on the run rather
    // than being thrown from inside it.
    if (run.promotionError !== undefined) {
      logger.error(`\n${run.promotionError}`);
      process.exit(2);
    }

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
