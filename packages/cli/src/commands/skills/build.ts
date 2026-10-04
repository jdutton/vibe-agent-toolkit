/**
 * Build skills from source into dist/skills/ during package build
 *
 * Reads skills config from vibe-agent-toolkit.config.yaml, discovers SKILL.md
 * files via include/exclude globs, reads frontmatter for skill names, merges
 * packaging config (schema defaults -> config defaults -> per-skill overrides),
 * validates, and packages into dist/skills/<name>/.
 */

import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';

import {
  conventionalSuiteProbe,
  indexPluginLocalSkills,
  isSkillPackagingInputError,
  packageSkills,
  packagingConfigToPackageOptions,
  skillNameToFsPath,
  validateSkillForPackaging,
  type ConventionalSuiteProbe,
  type DeclaredEvalSuite,
  type PackageSkillResult,
  type PackagingValidationResult,
  type PluginLocalSkillIndex,
  type SkillBuildSpec,
  type SkillPackageOutcome,
  type SkillPackagingConfig,
} from '@vibe-agent-toolkit/agent-skills';
import type { Target } from '@vibe-agent-toolkit/claude-marketplace';
import type { ResourcePopulationSource, SkillsConfig } from '@vibe-agent-toolkit/resources';
import {
  allowUnusedIssues,
  buildReport,
  createAllowUsageLedger,
  toFindings,
  type AllowUsageLedger,
  type Finding,
  type Gate,
  type Report,
  type ValidationIssue,
} from '@vibe-agent-toolkit/schema';
import { isPathAbsentError, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { CommandRefusalError, refusalCodeOf } from '../../utils/command-refusal.js';
import { loadConfig } from '../../utils/config-loader.js';
import { endWithReport, NOTHING_FINISHED, refusalReport, type FinishedWork } from '../../utils/document-writer.js';
import {
  collectPostBuildIssues,
  countCollapsedFindings,
  formatCollapsedFindingsHint,
  formatIssueLines,
  formatIssueSetHeading,
  formatPackagedFileCount,
  formatRunIssueLines,
  issuesToRenderAtVerbosity,
} from '../../utils/issue-rendering.js';
import { type createLogger } from '../../utils/logger.js';
import { requireProjectRoot, unstatablePathRefusal } from '../../utils/project-root-policy.js';
import { relativeLocationOrUndefined } from '../../utils/relativize-paths.js';
import { withResourcePopulationSource } from '../../utils/resource-loader.js';
import { collectDeclaredEvalSuites, mergeSkillPackagingConfig, publishScope } from '../../utils/skill-packaging-config.js';
import { applyConfigVerdicts } from '../../utils/verdict-helpers.js';
import type { PhaseOutcome } from '../phase-utils.js';

import type { SkillsBuildData } from './build-schema.js';
import {
  filterSkillsByName,
  setupCommandContext,
  type DiscoveredSkill,
} from './command-helpers.js';
import { assertScopableSkillsPath, type SkillsScopeSubject } from './scope-guard.js';
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

  publish: false (merged from skills.defaults and skills.config.<name>)
  marks an IN-PLACE skill: validated at source by 'vat validate', never
  bundled here, never expected by 'vat verify'. Such skills are set aside
  with one info line and counted as skillsInPlace; --skill naming one is
  an error (exit 1). A plugin-local skill (a git-tracked skill dir under a
  plugin's skills/) ships with its plugin regardless of publish, so it is
  never in place: under publish: false it is set aside on its own info line,
  counted as skillsPluginOnly, and --skill naming it exits 1 pointing at the
  claude phase that packages it.

Config Structure (vibe-agent-toolkit.config.yaml):
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
      used-in-place:
        publish: false

Validation:
  Both pre-build and post-build checks use the unified validation framework.
  Override per-code severity (error/warning/ignore) or allow specific paths
  via validation.severity and validation.allow in vibe-agent-toolkit.config.yaml.
  See docs/validation-codes.md for all codes and their defaults.

Output:
  YAML report -> stdout: status (ok | findings | error), summary, examined
  (skills discovered after --skill, the publish: false ones and a dry run's
  included), findings (every finding, each with its location), and data:
  dryRun, validated (false when nothing was validated: a dry run, a refused
  --skill), skillsBuilt, skillsFailed (packaging refused the skill's content:
  SKILL_PACKAGING_FAILED), skillsFailedValidation (the pre-build source check
  rejected them), skillsInPlace / skillsPluginOnly (names set aside by
  publish: false), outputCommitted (whether dist/skills was REPLACED — false
  leaves the previous output untouched), promotionError (only when the
  promotion itself failed), and skills[] of { name, source, output, status }.
  Paths are relative to the directory holding vibe-agent-toolkit.config.yaml.
  Build progress -> stderr

  On stderr, every findings heading names its skill, the whole set and its
  severity breakdown, and errors are always printed in full beneath it.
  Warnings and info findings stay collapsed unless --verbose. --verbose
  changes stderr ONLY: the stdout report carries every finding either way.

Exit Codes:
  0 - Built; findings, if any, are warnings or info (or a dry-run preview)
  1 - An error-severity finding: a skill failed pre-build validation, had its
      content refused by the packager (SKILL_PACKAGING_FAILED), or emitted
      post-build errors (every such failure is collected in ONE pass, and
      dist/skills is left untouched);
      --skill named a publish: false skill (SKILL_BUILD_TARGET_NOT_BUILDABLE);
      or nothing was examined — no skills: block, or globs matching no
      SKILL.md (RESOURCE_CHECK_BROKEN)
  2 - The build could not run (error.code): USAGE_INVALID (a [path] naming no
      directory or none holding a config, an unknown --skill, no project
      root), INPUT_UNREADABLE (a [path], directory or previous dist/skills the
      OS will not read), CONFIG_INVALID, or RUN_INCOMPLETE (the staging area
      under dist/ could not be opened, or the promotion of dist/skills failed —
      the report then still carries the findings and data.promotionError).
      Any other throw from the packager stops the run under its own code
      (INPUT_UNREADABLE for a directory the OS will not list); one that
      carries no code is a defect in VAT (INTERNAL_ERROR). Either way
      dist/skills is left untouched

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
  /**
   * The RUN's conventional-suite probe, shared with the PACKAGING phase below.
   *
   * The same probe both phases use, deliberately: they ask the identical
   * question of the identical paths, and this pre-build lane runs once per skill
   * inside the build loop — so a probe minted per call costs S² over the run.
   */
  suiteProbe: ConventionalSuiteProbe;
  /**
   * The RUN's enumeration lane, or `undefined` to keep the incumbent walk.
   *
   * This lane has no shared registry to inherit one from — unlike
   * `vat skills validate`, this command passes none — so the validator builds a
   * private registry per project root and this is the only thing that can put it
   * anywhere but the walk.
   */
  populationSource: ResourcePopulationSource | undefined;
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
 * The returned issues are `allErrors` — the full EMITTED set including
 * warnings and info (its name lies; see `PackagingValidationResult`) — so the
 * findings that rejected the skill are NAMED on the report's envelope, not
 * only counted.
 */
async function validateSkillBeforeBuild(
  input: ValidateSkillInput,
): Promise<SkillValidationFailure | undefined> {
  const { skillName, sourcePath, packagingConfig, logger, locationRoot, allowLedger, projectSkills, suiteProbe, populationSource, verbose } = input;
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
    {
      allowLedger,
      projectSkills,
      // A build must not ship a shorter bundle: a directory the validator's own
      // registry crawl cannot list refuses the run by name.
      unreadable: 'refuse',
      // Likewise the RUN's, and the same instance the packaging phase gets: this
      // lane resolves test input for the subject AND every entry in
      // `projectSkills`, so a per-call probe is S² over the loop.
      suiteProbe,
      // The RUN's source, so every skill in the loop shares one memo entry
      // behind `crawlAndResolveRegistry` and the run pays one crawl, not N.
      ...(populationSource !== undefined && { populationSource }),
    },
  );
  applyConfigVerdicts(
    validationResult,
    packagingConfig.targets as readonly Target[] | undefined,
    sourcePath,
    locationRoot,
  );

  if (validationResult.summary.errors === 0) {
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

  return { name: skillName, issues: [...validationResult.allErrors] };
}

/**
 * The skills a run sets aside unbuilt, by name — the `inPlace` and `pluginOnly`
 * halves of {@link partitionInPlaceSkills}.
 */
interface SetAsideSkillNames {
  inPlace: readonly string[];
  pluginOnly: readonly string[];
}

/**
 * Perform dry-run preview
 */
function performDryRun(
  skillsToBuild: readonly DiscoveredSkill[],
  setAside: SetAsideSkillNames,
  logger: ReturnType<typeof createLogger>
): void {
  logger.info(`Dry-run: Analyzing skill build...`);
  logger.info(`   Skills to build: ${skillsToBuild.length}`);
  logger.info(`   In-place skills (publish: false, not bundled): ${setAside.inPlace.length}`);
  logger.info(`   Plugin-only skills (publish: false, ship with their plugin): ${setAside.pluginOnly.length}`);

  logger.info(`\nSkills:`);
  for (const skill of skillsToBuild) {
    logger.info(`   ${skill.name}`);
    logger.info(`      Source: ${skill.sourcePath}`);
    logger.info(`      Output: dist/skills/${skillNameToFsPath(skill.name)}`);
  }

  logger.info(`\nDry-run complete (no files created)`);
  logger.info(`   Run without --dry-run to build the skills`);
}

/** The gate `vat skills build` is judged by: it offers no `--strict`. */
const GATE: Gate = { strict: false };

/** What ONE run did, before it is a report — see {@link skillsBuildWork}. */
interface SkillsBuildWorkInput {
  /** The directory whose config the build read: the ONE base every published path is relative to. */
  cwd: string;
  /** The skills this run bundles (or, on a dry run, would), in discovery order. */
  skills: readonly DiscoveredSkill[];
  setAside: SetAsideSkillNames;
  dryRun: boolean;
  /** The build, or `undefined` when none ran (a dry run, a refused `--skill`): nothing was validated. */
  run: SkillBuildRun | undefined;
  /** Findings about the set-aside skills — the `--skill` contradiction. */
  setAsideIssues: readonly ValidationIssue[];
}

/**
 * The two findings only this command emits. Both are `NonOverridableCode`s —
 * always `error`, never a `validation.severity` / `allow` key — because nothing
 * here reads an override for them, and a key that parses and does nothing is
 * the inert-config shape the registry exists to prevent.
 */
function notBuildableIssue(message: string, location: string | undefined): ValidationIssue {
  return {
    severity: 'error',
    code: 'SKILL_BUILD_TARGET_NOT_BUILDABLE',
    message,
    ...(location === undefined ? {} : { location }),
    fix: 'Drop --skill, set publish: true on the skill to distribute it through dist/skills, or — for a plugin-local skill — run vat build --only claude to package its plugin.',
  };
}

/**
 * A skill whose content the packager refused (`isSkillPackagingInputError`) — see
 * {@link notBuildableIssue} for why it is not overridable. Shared with `vat skills package`, whose packager refusals are the same finding.
 */
export function packagingFailedIssue(message: string, location: string | undefined): ValidationIssue {
  return {
    severity: 'error',
    code: 'SKILL_PACKAGING_FAILED',
    message,
    ...(location === undefined ? {} : { location }),
    fix: 'Fix what the message names in the skill or its skills.config entry, then rebuild.',
  };
}

/** A path as the report publishes it: relative to `cwd`, forward slashes. */
function reportPath(cwd: string, path: string): string {
  return toForwardSlash(safePath.relative(cwd, path));
}

/** A finding's `location` for `path`, or none when it has no `cwd`-relative spelling (another drive). */
function reportLocation(cwd: string, path: string): string | undefined {
  return relativeLocationOrUndefined(reportPath(cwd, path));
}

/**
 * Every issue ONE skill contributed, keyed by skill name: its pre-build
 * rejection, the packager's refusal of its content (as a `SKILL_PACKAGING_FAILED`
 * finding at its source), or its post-build findings.
 */
function issuesBySkill(input: SkillsBuildWorkInput): Map<string, ValidationIssue[]> {
  const { cwd, skills, run } = input;
  const bySkill = new Map<string, ValidationIssue[]>();
  if (run === undefined) return bySkill;
  const sources = new Map(skills.map((skill) => [skill.name, skill.sourcePath]));
  for (const { name, issues } of run.validationFailures) bySkill.set(name, [...issues]);
  for (const { name, message } of run.failures) {
    const source = sources.get(name);
    bySkill.set(name, [packagingFailedIssue(message, source === undefined ? undefined : reportLocation(cwd, source))]);
  }
  for (const { name, result } of run.results) bySkill.set(name, collectPostBuildIssues(result));
  return bySkill;
}

/**
 * THE document's content for one run — `examined`, the flat findings and
 * `data` — as a completed report or a refusal's finished work.
 *
 * `examined` is every skill the run discovered after `--skill`, the set-aside
 * ones included: a build that bundles fewer skills than it found says so by
 * name (`skillsInPlace`, `skillsPluginOnly`), never by a smaller denominator.
 *
 * Every finding is on the envelope — pre-build, packaging, post-build and the
 * run's own (`ALLOW_UNUSED`) — at every verbosity: `--verbose` changes stderr
 * only. A row carries its status, never a second list. The four failure
 * populations the old document split into four lists are one list here, told
 * apart by code: a pre-build rejection (`skillsFailedValidation`), a packaging
 * throw (`skillsFailed`, `SKILL_PACKAGING_FAILED`), and a bundle that failed its
 * post-build gate (counted in `skillsBuilt`, its findings on the envelope).
 */
export function skillsBuildWork(input: SkillsBuildWorkInput): FinishedWork & { data: SkillsBuildData; findings: Finding[] } {
  const { cwd, skills, setAside, dryRun, run, setAsideIssues } = input;
  const bySkill = issuesBySkill(input);
  const rows = skills.map((skill) => ({
    name: skill.name,
    source: reportPath(cwd, skill.sourcePath),
    output: reportPath(cwd, finalOutputPath(cwd, skill.name)),
    status: toFindings(bySkill.get(skill.name) ?? []).length === 0 ? 'ok' as const : 'findings' as const,
  }));
  const issues = [...setAsideIssues, ...skills.flatMap((skill) => bySkill.get(skill.name) ?? []), ...(run?.runIssues ?? [])];
  return {
    examined: skills.length + setAside.inPlace.length + setAside.pluginOnly.length,
    findings: toFindings(issues),
    data: {
      dryRun,
      validated: run !== undefined,
      skillsBuilt: run?.results.length ?? 0,
      skillsFailed: run?.failures.length ?? 0,
      skillsFailedValidation: run?.validationFailures.length ?? 0,
      skillsInPlace: [...setAside.inPlace],
      skillsPluginOnly: [...setAside.pluginOnly],
      outputCommitted: run?.outputCommitted ?? false,
      ...(run?.promotionError === undefined ? {} : { promotionError: run.promotionError }),
      skills: rows,
    },
  };
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
 * THE one definition, shared by the progress line, the published `skills[].output`
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
 * systems: `PackageSkillResult.outputPath` is absolute, while a finding's
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
  /**
   * Paths still on disk that this run could not clean up, in report order,
   * each with WHY it stayed. The repair is best-effort by construction — it
   * runs because the filesystem already refused something — so a second
   * refusal must not replace the first diagnosis; but it must not vanish
   * either, and a bare path list is where it used to vanish.
   */
  residue: StagingResidue[];
}

/** One path a recovery could not remove or restore, and the reason. */
export interface StagingResidue {
  path: string;
  reason: string;
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

  // `--skill <name>` rebuilds ONE bundle, so the all-or-nothing guarantee is
  // scoped to that bundle: its siblings under dist/skills are neither replaced
  // nor set aside, exactly as the delete-just-that-directory flow behaved.
  const subPath = onlySkill === undefined ? undefined : skillNameToFsPath(onlySkill);
  const promoteTo = subPath === undefined ? skillsDir : safePath.join(skillsDir, subPath);
  // `skillNameToFsPath` yields ONE path segment, so the parent is always known
  // without a dirname call.
  const promoteToParent = subPath === undefined ? distDir : skillsDir;

  // Asked before anything is created, so a refusal leaves the disk as it was.
  const hadPreviousOutput = outputExists(promoteTo);
  await stagingWrite(`create ${distDir}`, () => mkdir(distDir, { recursive: true }), undefined);
  const root = toForwardSlash(
    await stagingWrite(`create a staging directory under ${distDir}`, () => mkdtemp(safePath.join(distDir, '.vat-skills-')), undefined),
  );
  const promoteFrom = subPath === undefined ? root : safePath.join(root, subPath);
  const parked = `${root}.previous`;

  if (hadPreviousOutput) {
    await stagingWrite(`set the previous ${promoteTo} aside at ${parked}`, () => rename(promoteTo, parked), root);
  }

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
      if (outputExists(promoteFrom)) {
        await mkdir(promoteToParent, { recursive: true });
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
      await mkdir(promoteToParent, { recursive: true });
      await rename(parked, promoteTo);
    },
    recover: async () => {
      const residue: StagingResidue[] = [];
      let restoredPrevious = false;
      const targetFree = !existsSync(promoteTo);
      if (hadPreviousOutput && existsSync(parked)) {
        if (targetFree) {
          try {
            await mkdir(promoteToParent, { recursive: true });
            await rename(parked, promoteTo);
            restoredPrevious = true;
          } catch (error) {
            // The repair is best-effort by construction: it runs because the
            // filesystem already refused something. A throw here must not replace
            // the original diagnosis, so the parked path is reported as residue —
            // with this refusal beside it — and the caller still names the real cause.
            residue.push({ path: parked, reason: `restore failed: ${describeThrown(error)}` });
          }
        } else {
          residue.push({ path: parked, reason: 'the promotion target is already occupied' });
        }
      }
      // This run's own staging root is always safe to drop: it holds output this
      // run produced and can rebuild. Leaving it is what accumulated a complete
      // copy of the build output in `dist/` on every failed promotion.
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        residue.push({ path: root, reason: `removal failed: ${describeThrown(error)}` });
      }
      return { restoredPrevious, residue };
    },
  };
}

/**
 * Whether `path` exists. A path the OS will not stat is the INPUT's refusal
 * (`INPUT_UNREADABLE`, via `unstatablePathRefusal`) — never "absent", which
 * `existsSync` answered, so a build went on to promote over a tree it could not see.
 */
function outputExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if (isPathAbsentError(error)) return false;
    throw unstatablePathRefusal(path, error);
  }
}

/**
 * One write that opens the staging area. A refusal is the run stopping before it
 * built anything (`RUN_INCOMPLETE`), naming what it was doing — never an uncoded
 * throw read as a VAT defect. `created` is this run's own staging root when one
 * exists (removed on the way out, so the refusal leaves no residue it can
 * avoid), `undefined` before it does.
 */
async function stagingWrite<T>(what: string, write: () => Promise<T>, created: string | undefined): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const leftover = created === undefined ? '' : await removalFailure(created);
    throw new CommandRefusalError('RUN_INCOMPLETE', `Could not ${what}: ${describeThrown(error)}${leftover}`, { cause: error });
  }
}

/** Remove `path`; `''` when it went, else the sentence naming what stayed — a second refusal never hides the first. */
async function removalFailure(path: string): Promise<string> {
  try {
    await rm(path, { recursive: true, force: true });
    return '';
  } catch (error) {
    return ` (and ${path} could not be removed: ${describeThrown(error)})`;
  }
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
 * the caller publishes it as a `RUN_INCOMPLETE` refusal carrying the finished work (exit 2).
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
  const cause = describeThrown(error);
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
  for (const { path, reason } of recovery.residue) {
    lines.push(`   Left on disk (this run could not remove it): ${path} — ${reason}`);
  }
  return lines.join('\n');
}

/** The message of whatever was thrown, for a report line. */
function describeThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One discovered skill paired with the packaging config merged for it. */
export interface BuildSkillSpec {
  skill: DiscoveredSkill;
  packagingConfig: SkillPackagingConfig;
}

/**
 * Merge every skill's config and split the pool skills from the ones this run sets aside.
 *
 * `buildSpecs` is what this run bundles. Of the `publish: false` skills (see
 * `publishScope`), `inPlace` is every one used from the repo — validated at
 * source by `vat validate`, never bundled, never expected by `vat verify` — and
 * `pluginOnly` every PLUGIN-LOCAL one (its source dir is a location in `pluginLocal`,
 * from `indexPluginLocalSkills`): not bundled here either, but shipped with its
 * plugin, so reporting it as in-place would be false. Every list keeps discovery
 * order, so the human and machine reports list them as the globs found them.
 */
export function partitionInPlaceSkills(
  skills: readonly DiscoveredSkill[],
  skillsConfig: SkillsConfig,
  pluginLocal: PluginLocalSkillIndex,
): { buildSpecs: BuildSkillSpec[]; inPlace: BuildSkillSpec[]; pluginOnly: BuildSkillSpec[] } {
  const lists = { pool: [] as BuildSkillSpec[], 'in-place': [] as BuildSkillSpec[], 'plugin-only': [] as BuildSkillSpec[] };
  for (const skill of skills) {
    const packagingConfig = mergeSkillPackagingConfig(skillsConfig.defaults, skillsConfig.config?.[skill.name]);
    lists[publishScope(skill, packagingConfig, pluginLocal)].push({ skill, packagingConfig });
  }
  return { buildSpecs: lists.pool, inPlace: lists['in-place'], pluginOnly: lists['plugin-only'] };
}

/** How many set-aside names one info line spells out before "… and N more". */
const SET_ASIDE_NAMES_SHOWN = 10;

/**
 * ONE info line for one population this run set aside, naming the count and (up
 * to {@link SET_ASIDE_NAMES_SHOWN} of) the names. Nothing when there are none: a
 * "0 in-place" line on every build is noise that trains readers to skip the line
 * that matters.
 */
function logSetAsideSkills(
  setAside: readonly BuildSkillSpec[],
  label: string,
  logger: ReturnType<typeof createLogger>,
): void {
  if (setAside.length === 0) return;
  const names = setAside.map((spec) => spec.skill.name);
  const shown = names.slice(0, SET_ASIDE_NAMES_SHOWN).join(', ');
  const more = names.length > SET_ASIDE_NAMES_SHOWN ? ` … and ${names.length - SET_ASIDE_NAMES_SHOWN} more` : '';
  logger.info(`Skipping ${setAside.length} ${label}: ${shown}${more}`);
}

/** The info line for the in-place skills — see {@link logSetAsideSkills}. */
export function logInPlaceSkills(inPlace: readonly BuildSkillSpec[], logger: ReturnType<typeof createLogger>): void {
  logSetAsideSkills(inPlace, 'in-place skill(s) (publish: false — validated at source, never bundled)', logger);
}

/**
 * The info line for the plugin-local `publish: false` skills — deliberately NOT the
 * in-place line: they are left out of `dist/skills` but ship with their plugin.
 */
function logPluginOnlySkills(pluginOnly: readonly BuildSkillSpec[], logger: ReturnType<typeof createLogger>): void {
  logSetAsideSkills(
    pluginOnly,
    'plugin-local skill(s) from dist/skills (publish: false — each ships with its plugin via the claude phase)',
    logger,
  );
}

/**
 * `--skill x` on an in-place skill is a contradiction, not a silent skip: exit 1
 * naming the key that makes it one. (The one-skill filter leaves only that skill.)
 */
export function inPlaceSkillRefusal(skill: string | undefined, inPlace: readonly BuildSkillSpec[]): Error | undefined {
  if (skill === undefined || inPlace.length === 0) return undefined;
  return new Error(
    `Skill "${skill}" is an in-place skill (skills.config.${skill}.publish is false, `
      + 'directly or via skills.defaults.publish): vat build never bundles it, so there is no bundle to build. '
      + 'Set publish: true to distribute it through dist/skills, or drop --skill.',
  );
}

/**
 * `--skill x` on a plugin-local `publish: false` skill: exit 1 like the in-place
 * refusal, but saying what is true of it — it is not a pool skill, and it ships
 * with its plugin, packaged by the claude phase.
 */
function pluginOnlySkillRefusal(skill: string | undefined, pluginOnly: readonly BuildSkillSpec[]): Error | undefined {
  if (skill === undefined || pluginOnly.length === 0) return undefined;
  return new Error(
    `Skill "${skill}" is a plugin-local skill (under a plugin's skills/ directory) with publish: false `
      + `(skills.config.${skill}.publish, directly or via skills.defaults.publish): it ships with its plugin, `
      + 'packaged by the claude phase, and is never bundled into dist/skills, so this command has nothing to build for it. '
      + "Run 'vat build --only claude' to package its plugin, set publish: true to also distribute it through dist/skills, "
      + 'or drop --skill.',
  );
}

/** The human success line, naming each set-aside population only when it is non-empty. */
export function formatBuiltSuccessLine(built: number, setAside: { inPlace: number; pluginOnly: number }): string {
  const tails = [
    ...(setAside.inPlace === 0 ? [] : [`${setAside.inPlace} in-place skill(s) not bundled`]),
    ...(setAside.pluginOnly === 0 ? [] : [`${setAside.pluginOnly} plugin-only skill(s) shipped with their plugin`]),
  ];
  return `\nBuilt ${built} skill(s) successfully` + (tails.length === 0 ? '' : ` (${tails.join(', ')})`);
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
 * neighbour: {@link SkillBuildFailure} means packaging ran and refused the skill's content, and
 * `skillsWithErrors` means a bundle exists and is invalid. This one means the
 * source never qualified, and carries the whole emitted finding set that said so.
 */
export interface SkillValidationFailure {
  name: string;
  issues: ValidationIssue[];
}

/** Everything one `vat build` invocation produced, ready to report on. */
export interface SkillBuildRun {
  results: Array<{ name: string; result: PackageSkillResult }>;
  /** Findings that belong to the run, not to any one skill (ALLOW_UNUSED). */
  runIssues: ValidationIssue[];
  /** Names of skills that BUILT and whose own post-build validation errored. */
  skillsWithErrors: string[];
  /** Skills that never built because the packager refused their content. */
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
   * exception here used to escape to the command's last-resort handler, which
   * exited 2 having emitted nothing at all. Its text names what is on disk and how
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
 * exits: every failure that is the adopter's to fix is COLLECTED and returned, so
 * one run surfaces all the work rather than the first item of it. A packager
 * defect is the exception — see {@link stopOnPackagerDefect}.
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

  // ONE bracket over the WHOLE run — both validation lanes and the packaging —
  // rather than over `packageSkills` alone.
  //
  // Two properties depend on it, and neither is cosmetic. First, every
  // enumeration of the SOURCE tree this run performs is then on the lane the
  // process selected: the pre-build check builds a private registry through
  // `crawlAndResolveRegistry`, and outside the bracket it had no source to reach,
  // so a projection-lane build still did one full walk. (Each skill's POST-build
  // check is deliberately NOT on the lane — `runPostBuildValidation` passes no
  // source, because it validates the built output rather than the source tree.
  // See its docstring in `skill-packager.ts`.) Second, the memo behind that crawl
  // is keyed on the source's IDENTITY, so one closure for the run means one crawl
  // for the run; a bracket per phase would hand out two closures and buy a second
  // crawl to save the first.
  //
  // `populationSource` is `undefined` when the walk stays selected, and every
  // consumer below treats that as "keep the incumbent" — the default path is
  // structurally unchanged.
  // Run-scoped for the same reason `projectSkills` is, and it is the more expensive
  // half: resolving a skill's test-input dirs probes the filesystem for a conventional
  // eval suite under the subject AND under every entry of `projectSkills`, so a probe
  // rebuilt per skill costs O(S) per skill and O(S²) per run. Measured on a 103-skill
  // adopter, in the sibling `vat resources validate` lane that shares this helper:
  // 10,815 `existsSync` calls over 103 distinct paths, half of that command's entire
  // filesystem traffic. This lane has the same shape.
  //
  // NOT module-scoped: the answer is a filesystem snapshot, so a cache outliving the
  // run would keep answering for a tree that has since changed.
  const suiteProbe = conventionalSuiteProbe();

  const outcomes = await withResourcePopulationSource({ root: cwd }, async (populationSource) => {
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
        suiteProbe,
        populationSource,
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
        suiteProbe,
      ),
    }));

    // `packageSkills` builds THE registry for the run, so this is the only seam
    // that can put `vat skills build` — and therefore `vat build`'s packaging
    // phase — on the lane. The registry's markdown-only `include` is re-applied
    // to whatever the source offers, so what gets packaged is unchanged; only how
    // the file list was obtained differs.
    return packageSkills(buildSpecs, cwd, allowLedger, {
      ...(populationSource !== undefined && { populationSource }),
    });
  });

  await stopOnPackagerDefect(outcomes, staging, logger);

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
 * Leave the run on the first packager throw that is not the packager refusing
 * the skill's own content — the contract `vat skills package`, `vat agent
 * build`, `vat claude plugin build` and `vat skill test run` implement, through
 * the same predicate. Such a throw is not the adopter's to fix, so it is never a
 * `SKILL_PACKAGING_FAILED` finding telling them to: it is rethrown as itself and
 * published by its own code (`INTERNAL_ERROR` when it has none).
 *
 * Staging is settled first. The previous `dist/skills` was parked when the run
 * began, so a bare rethrow would leave the path absent.
 */
async function stopOnPackagerDefect(
  outcomes: readonly SkillPackageOutcome[],
  staging: BuildStaging,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const defect = outcomes.find((outcome) => outcome.status === 'failed' && !isSkillPackagingInputError(outcome.error));
  if (defect?.status !== 'failed') return;
  const { promotionError } = await settleStaging(staging, true, logger);
  if (promotionError !== undefined) logger.error(promotionError);
  throw defect.error;
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

/**
 * The work before the build: config, discovery and the publish partition —
 * or the report that ends the run early (no `skills:` block, no skill
 * discovered, a `--skill` naming a set-aside skill, a dry run).
 */
type PreparedBuild =
  | { kind: 'done'; report: Report<unknown> }
  | {
    kind: 'build';
    buildSpecs: BuildSkillSpec[];
    setAside: SetAsideSkillNames;
    projectSkills: readonly DeclaredEvalSuite[];
  };

/** A report for a run that built nothing, from the skills it examined. */
function earlyReport(input: Omit<SkillsBuildWorkInput, 'run'>, startTime: number): Report<unknown> {
  return buildReport({ ...skillsBuildWork({ ...input, run: undefined }), gate: GATE, durationMs: Date.now() - startTime });
}

const NO_SKILLS: SetAsideSkillNames = { inPlace: [], pluginOnly: [] };

async function prepareBuild(
  cwd: string,
  options: SkillsBuildCommandOptions,
  logger: ReturnType<typeof createLogger>,
  startTime: number,
): Promise<PreparedBuild> {
  const empty = { cwd, skills: [], setAside: NO_SKILLS, dryRun: options.dryRun === true, setAsideIssues: [] };
  // Spec §7: `vat skills build` requires a projectRoot. The resolved root is
  // discarded: config is read from `cwd` (the package dir), not the project root.
  requireProjectRoot(cwd, 'vat skills build');

  const config = loadConfig(cwd);
  if (!config?.skills) {
    // Examined nothing: the writer refuses the command lane's report; `vat
    // build` folds the same report into its sum, where another phase may have
    // examined something (see `runSkillsBuildPhase`).
    logger.info('No skills configuration found — nothing to build');
    return { kind: 'done', report: earlyReport(empty, startTime) };
  }
  const skillsConfig = config.skills;

  logger.info(`Discovering skills from config...`);
  // `'refuse'`: a build that silently ships fewer skills is the drop this
  // command exists to prevent — the coded throw is the report's refusal.
  const discoveredSkills = await discoverSkillsFromConfig(skillsConfig, cwd, 'refuse');
  if (discoveredSkills.length === 0) {
    // Before the staging swap, so a glob typo never promotes an EMPTY dist/skills.
    logger.error(`No SKILL.md files found matching include patterns: ${skillsConfig.include.join(', ')}`);
    return { kind: 'done', report: earlyReport(empty, startTime) };
  }

  // Filter by name, then set the `publish: false` skills aside BEFORE the count
  // is announced: "Found N skill(s) to build" is the number this run bundles.
  // Plugin-local = a skill dir the plugin build packages (the same index the
  // consistency check and `vat verify` ask): such a skill is never in place.
  const { buildSpecs, inPlace, pluginOnly } = partitionInPlaceSkills(
    filterSkillsByName(discoveredSkills, options.skill),
    skillsConfig,
    indexPluginLocalSkills(config, cwd),
  );
  const setAside: SetAsideSkillNames = {
    inPlace: inPlace.map((spec) => spec.skill.name),
    pluginOnly: pluginOnly.map((spec) => spec.skill.name),
  };
  const planned = { ...empty, skills: buildSpecs.map((spec) => spec.skill), setAside };

  const refusal = inPlaceSkillRefusal(options.skill, inPlace) ?? pluginOnlySkillRefusal(options.skill, pluginOnly);
  const target = [...inPlace, ...pluginOnly][0];
  if (refusal !== undefined && target !== undefined) {
    logger.error(refusal.message);
    const issue = notBuildableIssue(refusal.message, reportLocation(cwd, target.skill.sourcePath));
    return { kind: 'done', report: earlyReport({ ...planned, setAsideIssues: [issue] }, startTime) };
  }

  logInPlaceSkills(inPlace, logger);
  logPluginOnlySkills(pluginOnly, logger);
  logger.info(`Found ${buildSpecs.length} skill(s) to build`);

  // Nothing has touched `dist/` yet — the staging directory and the swap live
  // inside `runSkillBuild`, which a dry run never reaches.
  if (options.dryRun) {
    performDryRun(planned.skills, setAside, logger);
    return { kind: 'done', report: earlyReport(planned, startTime) };
  }

  // From the UNFILTERED discovery: `--skill x` narrows the build, not the set
  // of files that count as some skill's declared test input.
  return { kind: 'build', buildSpecs, setAside, projectSkills: collectDeclaredEvalSuites(skillsConfig, discoveredSkills) };
}

/**
 * Run `vat skills build` and hand back its report — the refusal branch when it
 * could not run — printing it nowhere.
 *
 * ONE function for both lanes: the command publishes it with `endWithReport`,
 * and `vat build`'s `skills` phase folds it. The report is the one BEFORE the
 * writer's run-integrity pass: a project with no `skills:` block reports zero
 * skills, which fails `vat skills build` and does not fail a `vat build` whose
 * claude phase built something.
 */
export async function runSkillsBuildPhase(
  pathArg: string | undefined,
  options: SkillsBuildCommandOptions,
): Promise<PhaseOutcome> {
  const { logger, cwd, startTime } = setupCommandContext(pathArg, options.debug);

  try {
    // A `[path]` naming no directory, or none holding a config, is the
    // invocation's mistake (or the input's, when the OS refuses it) — never a
    // silent build of nothing.
    assertScopableSkillsPath(SCOPE_SUBJECT, pathArg);
    const prepared = await prepareBuild(cwd, options, logger, startTime);
    if (prepared.kind === 'done') return prepared;
    const { buildSpecs, setAside, projectSkills } = prepared;

    const run = await runSkillBuild({
      specs: buildSpecs,
      cwd,
      logger,
      projectSkills,
      onlySkill: options.skill,
      verbose: options.verbose === true,
    });
    for (const line of formatRunIssueLines(run.runIssues)) {
      logger.info(line);
    }
    logRunFailures(run, logger);

    const work = skillsBuildWork({
      cwd, skills: buildSpecs.map((spec) => spec.skill), setAside, dryRun: false, run, setAsideIssues: [],
    });
    // The promotion itself failed: the filesystem refused and dist/skills is in
    // a state someone must look at — a refusal (exit 2) carrying everything the
    // run found, `data.promotionError` naming what is on disk and how to recover it.
    if (run.promotionError !== undefined) {
      return { report: refusalReport('RUN_INCOMPLETE', run.promotionError, GATE, work) };
    }
    if (run.outputCommitted) {
      logger.info(formatBuiltSuccessLine(run.results.length, { inPlace: setAside.inPlace.length, pluginOnly: setAside.pluginOnly.length }));
    }
    return { report: buildReport({ ...work, gate: GATE, durationMs: Date.now() - startTime }) };
  } catch (error) {
    return { report: refusalReport(refusalCodeOf(error), error, GATE, NOTHING_FINISHED) };
  }
}

async function buildCommand(
  pathArg: string | undefined,
  options: SkillsBuildCommandOptions,
): Promise<void> {
  // This command offers no `--format`: the report is YAML.
  endWithReport('skills build', (await runSkillsBuildPhase(pathArg, options)).report, 'yaml');
}
