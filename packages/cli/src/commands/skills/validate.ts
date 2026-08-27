/**
 * Skills validate command - validate skills for packaging
 *
 * Discovers skills from config yaml skills.include/exclude, validates each
 * using validateSkillForPackaging with merged packaging config.
 */

import {
  validateSkillForPackaging,
  type DeclaredEvalSuite,
  type PackagingValidationResult,
  type SkillPackagingConfig,
  type SkillValidationSharedContext,
} from '@vibe-agent-toolkit/agent-skills';
import type { Target } from '@vibe-agent-toolkit/claude-marketplace';
import {
  ResourceRegistry,
  type ProjectConfig,
  type ResourcePopulationSource,
} from '@vibe-agent-toolkit/resources';
import {
  allowUnusedIssues,
  calculateValidationStatus,
  countBySeverity,
  createAllowUsageLedger,
  type SeverityCounts,
  type ValidationIssue,
} from '@vibe-agent-toolkit/schema';
import { findProjectRoot, safePath } from '@vibe-agent-toolkit/utils';
import { gitFindRoot, GitTracker } from '@vibe-agent-toolkit/utils/git';
import * as yaml from 'yaml';

import { reportCommandError } from '../../utils/command-error.js';
import { loadConfig } from '../../utils/config-loader.js';
import { formatDurationSecs } from '../../utils/duration.js';
import {
  formatIssueLines,
  formatRunIssueLines,
  formatSeverityBreakdown,
  issuesToRenderAtVerbosity,
  summarizeFindings,
  sumSeverityCounts,
} from '../../utils/issue-rendering.js';
import { type createLogger } from '../../utils/logger.js';
import { requireProjectRoot } from '../../utils/project-root-policy.js';
import {
  RESOURCES_CRAWL_ENV,
  RESOURCES_CRAWL_PROJECTION,
  withResourcePopulationSource,
} from '../../utils/resource-loader.js';
import { collectDeclaredEvalSuites, mergeSkillPackagingConfig } from '../../utils/skill-packaging-config.js';
import { renderSkillQualityFooter } from '../../utils/skill-quality-footer.js';
import { applyConfigVerdicts } from '../../utils/verdict-helpers.js';
import { finishCommand, type PhaseOutcome } from '../phase-utils.js';

import {
  filterSkillsByName,
  setupCommandContext,
  type DiscoveredSkill,
} from './command-helpers.js';
import { discoverSkillsFromConfig } from './skill-discovery.js';

/**
 * Skills validate command options
 */
export interface SkillsValidateCommandOptions {
  skill?: string;
  debug?: boolean;
  verbose?: boolean;
}

/**
 * Discovered skill with merged packaging config for validation
 */
export interface ValidatableSkill extends DiscoveredSkill {
  packagingConfig: SkillPackagingConfig;
}

/** The vocabulary of a validation verdict: worst ACTIONABLE severity. */
type ValidationStatus = 'success' | 'warning' | 'error';

/**
 * Every issue emitted across the batch, after severity resolution.
 *
 * `allErrors` is the full emitted set INCLUDING info despite the name (see the
 * doc comment on `PackagingValidationResult`), and excluding issues suppressed
 * by `validation.allow` — those live in `ignoredErrors`.
 */
function batchIssues(results: readonly PackagingValidationResult[]): ValidationIssue[] {
  return results.flatMap((r) => r.allErrors);
}

/**
 * Findings about the RUN rather than about any one skill — currently the
 * `validation.allow` entries no skill in the batch matched (ALLOW_UNUSED).
 *
 * They are a separate parameter, not folded into a skill's result, because
 * that is what they are: `validation.allow` is declared once per package, so
 * attributing "nothing matched this entry" to whichever skill happened to be
 * validated at the time is what produced 78 warnings from 3 real entries.
 */
type RunIssues = readonly ValidationIssue[];

/**
 * One skill's VERBOSE YAML entry: the whole result plus the per-severity counts
 * its two-valued `status` cannot express.
 *
 * The per-skill `status` stays the gate verdict (`error` iff an active error) —
 * that is what the exit code is derived from. `issueCounts` beside it is what
 * makes `success` readable: "nothing you must act on", not "nothing was found".
 *
 * This shape is optimized for `> file` then `grep`, not for reading: on a
 * 90-skill repo it is 17,262 of the 22,156 stdout lines `vat verify` emits.
 */
function toVerboseYamlResult(result: PackagingValidationResult): unknown {
  return { ...result, issueCounts: countBySeverity(result.allErrors) };
}

/**
 * Does this skill have anything to say? Emitted findings OR allow-suppressed
 * ones — the same predicate the human report uses, so the two streams cannot
 * disagree about which skills exist.
 */
function hasFindings(result: PackagingValidationResult): boolean {
  return result.allErrors.length > 0 || result.ignoredErrors.length > 0;
}

/**
 * One skill's DEFAULT YAML entry: which asset has problems, how many, of what
 * code — and nothing else.
 *
 * Why the per-code tally is a summary rather than N findings: 1,728 of the 1,897
 * findings on a real 90-skill repo are one code, LINK_DROPPED_BY_DEPTH, and the
 * four remedies its `fix` hint proposes (`linkFollowDepth`, `files:`,
 * `validation.allow`, `excludeReferencesFromBundle`) are all SKILL-level config
 * edits — so 348 findings on one skill propose the same four edits 348 times.
 * The skill is the unit the reader acts on, so the skill is the unit we publish.
 * Aggregating at EMISSION instead would break `validation.allow`'s per-`paths:`
 * matching and per-path severity overrides, both of which need one issue per
 * link; the collapse therefore has to happen here, after allow-filtering.
 * Downgrading the code to `info` was considered and rejected: it would delete
 * the signal the code exists for (a depth-limited walk may silently omit content
 * the author expected to ship) and would contradict PACKAGED_TEST_INPUT, which
 * `docs/validation-codes.md` keeps at `warning` on identical "this is configured
 * behaviour, here is your receipt" reasoning.
 *
 * `allowed` is a scalar, not a list: an allow-suppressed finding is a fact about
 * the skill a reader must not lose, but it is deliberately NOT in `codes`, which
 * summarizes the EMITTED set.
 */
function toSummaryYamlResult(result: PackagingValidationResult): unknown {
  const { codes, ...counts } = summarizeFindings(result.allErrors);
  const allowedCount = result.ignoredErrors.length;
  return {
    skillName: result.skillName,
    status: result.status,
    ...counts,
    ...(allowedCount > 0 ? { allowed: allowedCount } : {}),
    codes,
  };
}

/**
 * Build the YAML summary object.
 *
 * `status` is the shared `issues → status` collapse over the WHOLE batch, so it
 * can say `warning`. It previously read
 * `results.some(r => r.status === 'error') ? 'error' : 'success'` — a two-value
 * collapse that could never report the warning case, and so reported 33 active
 * warnings as `success`.
 *
 * The header total counts BOTH the per-skill findings and the run-level ones,
 * because the exit code does too — dropping run issues from the header would
 * divorce the published verdict from the code the process actually returns.
 * That is why `runIssueCounts` exists beside them: on a large real repo the
 * header read 1814 warnings against a per-skill sum of 1800, and the missing 14
 * were run-level ALLOW_UNUSED entries published only as a bare LIST. The
 * identity `issueCounts === Σ results[].issueCounts + runIssueCounts` now holds
 * by construction, so a consumer can reconcile the two numbers instead of
 * hand-counting a list to find out whether anything went missing.
 *
 * That identity survives the default mode dropping every finding-free skill from
 * `results[]`, because a dropped row contributes exactly zero to each bucket —
 * and it survives the default row publishing its counts flat with zero buckets
 * omitted, because an absent bucket reads as zero. Only the per-asset ROWS omit
 * zeros: `issueCounts` and `runIssueCounts` keep their complete
 * `{errors, warnings, info}` shape in both modes, because they are the
 * reconciliation identity rather than something a reader scans.
 */
export function buildValidateSummary(
  results: PackagingValidationResult[],
  duration: number,
  verbose: boolean,
  runIssues: RunIssues,
): {
  status: ValidationStatus;
  issueCounts: SeverityCounts;
  runIssueCounts: SeverityCounts;
  skillsValidated: number;
  results: unknown[];
  runIssues: ValidationIssue[];
  durationSecs: number;
} {
  const skillIssues = batchIssues(results);
  const runIssueCounts = countBySeverity(runIssues);
  return {
    status: calculateValidationStatus([...skillIssues, ...runIssues]),
    issueCounts: sumSeverityCounts([countBySeverity(skillIssues), runIssueCounts]),
    runIssueCounts,
    // `skillsValidated` stays the true denominator even though the default
    // `results[]` lists only the skills with something to say.
    //
    // KNOWN, DELIBERATELY NOT FIXED — the denominator and the listing disagree,
    // and nothing in the document explains the gap. A real adopter run published
    // `skillsValidated: 92` beside a `results:` array of 62 rows. Omitting the
    // clean skills is the DESIGN — a report of 92 rows where 30 say nothing is a
    // report nobody reads — but 23 of the omitted were config-DECLARED skills, so
    // a reader reconciling 92 against 62 cannot tell "validated and clean" from
    // "never validated at all". The omission is deliberate; the unexplained
    // difference is the defect. A fix names the omitted population rather than
    // re-listing it (a count of clean skills, or their names on a separate key) —
    // it does not put the empty rows back.
    skillsValidated: results.length,
    results: verbose
      ? results.map((r) => toVerboseYamlResult(r))
      : results.filter((r) => hasFindings(r)).map((r) => toSummaryYamlResult(r)),
    runIssues: [...runIssues],
    durationSecs: formatDurationSecs(duration),
  };
}

/**
 * Output YAML summary to stdout
 */
function writeYamlSummary(summary: ReturnType<typeof buildValidateSummary>): void {
  console.log(yaml.stringify(summary, { indent: 2, lineWidth: 0, aliasDuplicateObjects: false }));
}

/**
 * ONE line for one skill: its severity breakdown, its allowed count, and the
 * codes behind it, dominant first.
 *
 * The stderr counterpart of {@link toSummaryYamlResult} — same unit (the asset),
 * same reason (see that function's comment). The per-issue blocks below are what
 * made this stream 6,261 lines on a 90-skill repo.
 */
function skillSummaryLine(result: PackagingValidationResult): string {
  const { codes } = summarizeFindings(result.allErrors);
  const breakdown = formatSeverityBreakdown(countBySeverity(result.allErrors));
  const allowed = result.ignoredErrors.length > 0
    ? ` (+${result.ignoredErrors.length} allowed by config)`
    : '';
  const tally = Object.entries(codes).map(([code, count]) => `${code}: ${count}`).join(', ');
  const codeSuffix = tally === '' ? '' : ` — ${tally}`;
  return `  ${result.skillName}: ${breakdown}${allowed}${codeSuffix}`;
}

/**
 * Lines for ONE skill: its summary row, then the findings that render in full
 * beneath it at this verbosity.
 *
 * The row is unconditional — it is the only place a collapsed finding is
 * counted, so a mode that replaced it with per-issue blocks would lose the
 * allowed count and the per-code tally. What varies is what hangs below it, and
 * that choice belongs to {@link issuesToRenderAtVerbosity}, not to this lane:
 * an `error` renders in full at every verbosity (the reader must never have to
 * re-run with `-v` to learn what failed the gate), while `warning`/`info`
 * collapse into the row unless asked for.
 *
 * The allow-suppressed records are listed only under `verbose`; by default the
 * row's `(+N allowed by config)` is their receipt.
 */
function skillReportLines(result: PackagingValidationResult, verbose: boolean): string[] {
  const lines = [skillSummaryLine(result)];

  const rendered = issuesToRenderAtVerbosity(result.allErrors, verbose);
  for (const issue of rendered) {
    lines.push(...formatIssueLines(issue, '    '));
  }

  const listAllowed = verbose && result.ignoredErrors.length > 0;
  if (listAllowed) {
    lines.push(`  Allowed issues (${result.ignoredErrors.length}):`);
    for (const record of result.ignoredErrors) {
      lines.push(`    [${String(record.code)}] ${String(record.location)} (allowed: ${record.reason})`);
    }
  }

  // A trailing blank line only when something was rendered beneath the row —
  // otherwise consecutive one-line rows would be double-spaced.
  if (rendered.length > 0 || listAllowed) {
    lines.push('');
  }
  return lines;
}

/**
 * One glyph per status value — total, so a status this renderer has not thought
 * about cannot fall through to the reassuring `✅`.
 */
const STATUS_GLYPHS: Record<ValidationStatus, string> = {
  error: '❌',
  warning: '⚠️ ',
  success: '✅',
};

/**
 * Banner naming what the run actually found.
 *
 * "All validations passed" — with nothing after it — is reserved for a run with
 * NO finding at all. Any non-error finding gets the same "passed with findings"
 * wording whatever its severity, because the banner cannot tell an `info` that
 * is genuinely inert from one whose own message says the build will die on it.
 * The info-only banner used to assert "nothing to act on" and was printed
 * directly above `FILES_GLOB_MATCHED_NOTHING`, whose message reads "`vat skills
 * build` fails on a glob that matches nothing, so the build will fail unless
 * that artifact is produced first" — a headline contradicting the single line
 * beneath it.
 *
 * The severity is right (a glob over an unbuilt `dist/` matching nothing is the
 * expected pre-build state and must not fail CI); only the claim was wrong. It
 * is dropped rather than made conditional because the code registry carries no
 * build-blocking fact to condition it on — `CodeRegistryEntry` in
 * schema/src/validation-codes.ts is exactly `defaultSeverity` /
 * `description` / `fix` / `reference` — and keying the claim
 * on a hardcoded list of code names would assert a cause this renderer cannot
 * observe, and would go stale the next time a code is added.
 */
function reportBanner(status: ValidationStatus, counts: SeverityCounts): string {
  if (status === 'error') {
    return `\n❌ Validation failed — ${formatSeverityBreakdown(counts)}:\n`;
  }
  if (counts.warnings + counts.info > 0) {
    // Non-blocking (exit 0), which is exactly why this used to print
    // "All validations passed" over the findings.
    return `\n${STATUS_GLYPHS[status]} Validation passed with findings — ${formatSeverityBreakdown(counts)}:\n`;
  }
  return '\n✅ All validations passed';
}

/**
 * Human-readable report lines for the whole batch.
 *
 * Renders every skill with ANY emitted finding, not just the ones that failed
 * the gate: a warning-only or info-only run used to print the success banner and
 * nothing else, so the findings existed only in the YAML on stdout.
 *
 * Every skill with findings gets its summary row at every verbosity; `verbose`
 * picks only which findings are ALSO rendered in full beneath that row, per
 * {@link issuesToRenderAtVerbosity} — errors always, `warning`/`info` when
 * asked, `ignore` never. `verbose` deliberately does NOT gate errors: a default
 * run that collapsed the error it exited 1 on into a count line forced the reader
 * to re-run with a flag to learn what broke.
 *
 * Run-level findings and the banner are printed in full either way — there are
 * ~14 of the former, and they belong to the project config rather than to any
 * asset, so there is no row for them to collapse into.
 */
export function formatValidationReportLines(
  results: PackagingValidationResult[],
  runIssues: RunIssues,
  verbose: boolean,
): string[] {
  const issues = [...batchIssues(results), ...runIssues];
  const counts = countBySeverity(issues);
  const status = calculateValidationStatus(issues);
  const lines = [reportBanner(status, counts)];

  for (const result of results) {
    if (!hasFindings(result)) continue;
    lines.push(...skillReportLines(result, verbose));
  }
  const runLines = formatRunIssueLines(runIssues);
  if (runLines.length > 0) {
    lines.push(...runLines, '');
  }
  return lines;
}

/**
 * Output validation report to stdout (YAML) and stderr (human-readable)
 */
function reportValidationToStderr(
  results: PackagingValidationResult[],
  logger: ReturnType<typeof createLogger>,
  verbose: boolean,
  runIssues: RunIssues,
): void {
  // Collect all emitted codes across skills (both errors and warnings) to drive the footer
  const emittedCodes = new Set<string>();
  for (const r of results) {
    for (const issue of r.allErrors) {
      emittedCodes.add(issue.code);
    }
  }
  for (const issue of runIssues) {
    emittedCodes.add(issue.code);
  }
  const hasSkillFindings = results.some(
    (r) => calculateValidationStatus(r.allErrors) !== 'success',
  );

  for (const line of formatValidationReportLines(results, runIssues, verbose)) {
    logger.info(line);
  }
  renderSkillQualityFooter(logger, hasSkillFindings, emittedCodes);
}

/**
 * Log validation progress for a single skill.
 *
 * The per-skill glyph follows the shared collapse (`⚠️` for a warning-only
 * skill), and the severity breakdown is always spelled out. A skill with
 * warnings used to print a bare `✅ <name>`, which is the same reassuring
 * collapse as the batch banner, one line earlier.
 */
export function formatSkillProgressLine(
  skillName: string,
  result: PackagingValidationResult,
): string[] {
  const counts = countBySeverity(result.allErrors);
  const status = calculateValidationStatus(result.allErrors);
  const glyph = STATUS_GLYPHS[status];
  const detail = result.allErrors.length > 0 ? `: ${formatSeverityBreakdown(counts)}` : '';
  const lines = [`   ${glyph} ${skillName}${detail}`];

  if (result.ignoredErrors.length > 0) {
    lines.push(`      (${result.ignoredErrors.length} allowed by config)`);
  }
  const expiredCount = result.allErrors.filter(w => w.code === 'ALLOW_EXPIRED').length;
  if (expiredCount > 0) {
    lines.push(`      (${expiredCount} expired allow entr${expiredCount === 1 ? 'y' : 'ies'})`);
  }
  return lines;
}

function logSkillProgress(
  skillName: string,
  result: PackagingValidationResult,
  logger: ReturnType<typeof createLogger>
): void {
  for (const line of formatSkillProgressLine(skillName, result)) {
    logger.info(line);
  }
}

/**
 * Build a single shared validation context for an entire `vat skills validate`
 * invocation.
 *
 * When every skill in the batch resolves to the same projectRoot (the normal
 * monorepo case), we crawl the resource registry once and hand the same
 * instance to each skill's validation — the per-skill markdown reparse
 * disappears. Similarly, gitignore checks are backed by a single
 * {@link GitTracker} when every skill sits inside the same git repository.
 *
 * When the batch is heterogeneous (e.g. multiple projectRoots), the helper
 * returns an empty context and validators transparently fall back to their
 * legacy per-skill setup — correctness first, perf second.
 */
/**
 * Options for {@link buildSkillsValidateRegistry}.
 */
export interface SkillsValidateRegistryOptions {
  /**
   * The project's configuration, or `undefined` for a project that has none.
   *
   * **Not optional in the sense of "nice to have".** A collection may declare a
   * `mimeType` that overrides the extension tables and decides which parser runs
   * over a file. `ResourceRegistry` routes through `resources.collections` when —
   * and only when — it was handed a config; the projection lane behind
   * `populationSource` reads those same declarations off the root. A registry
   * built without the config therefore reaches a DIFFERENT verdict about whether
   * a file is prose than the population that enumerated it, inside one command.
   *
   * Passed rather than re-read here so this lane cannot answer from a second,
   * later parse of the same file.
   */
  config?: ProjectConfig | undefined;
  /**
   * Where the file list comes from — omit for the incumbent walk, supply one to
   * source it from a projection instead. Enumeration only: `include` below is
   * re-applied to whatever the source offers.
   */
  populationSource?: ResourcePopulationSource | undefined;
}

/**
 * The markdown-only, link-resolved registry `vat skills validate` shares across
 * every skill in one invocation.
 *
 * Exported and named because it had two implementations: this one, and a
 * restatement inside `pipeline-oracles/lanes.ts` whose own comment recorded that
 * it was "the one lane with no reusable builder to point at". A copy of a
 * registry builder is a copy of its ARGUMENTS, and the argument that matters
 * here is `config` — see {@link SkillsValidateRegistryOptions.config}.
 *
 * @param projectRoot - Root every skill in the batch resolves to
 * @param options - The governing config, and optionally the projection-backed
 *   enumeration to build from
 * @returns A crawled registry whose links are already resolved
 */
export async function buildSkillsValidateRegistry(
  projectRoot: string,
  options: SkillsValidateRegistryOptions = {},
): Promise<ResourceRegistry> {
  const { config, populationSource } = options;
  const registry = await ResourceRegistry.fromCrawl(
    {
      baseDir: projectRoot,
      include: ['**/*.md'],
      ...(populationSource !== undefined && { populationSource }),
    },
    config === undefined ? undefined : { config },
  );
  registry.resolveLinks();
  return registry;
}

export async function buildSharedValidationContext(
  skills: ValidatableSkill[],
  projectSkills: readonly DeclaredEvalSuite[],
  config: ProjectConfig | undefined,
  logger: ReturnType<typeof createLogger>,
): Promise<SkillValidationSharedContext> {
  // The allow-entry ledger is not an optimization like the two below — it is
  // what makes ALLOW_UNUSED true. `validation.allow` is declared once for the
  // package and matched per skill, so only the batch can say an entry matched
  // nothing. Always present, so no early return can drop it.
  const allowLedger = createAllowUsageLedger();

  // Likewise not an optimization: the test-input rule is project-wide, so this
  // lane must model a bundle that excludes EVERY declared suite, not just the
  // subject's. Present even for an empty batch, so no early return can drop it.
  if (skills.length === 0) {
    return { allowLedger, projectSkills };
  }

  const projectRoots = new Set<string>();
  const gitRoots = new Set<string>();
  for (const skill of skills) {
    const skillDir = safePath.resolve(skill.sourcePath, '..');
    const root = findProjectRoot(skillDir);
    // Skills with no governing config or git ancestor have no enforceable
    // project root; we skip them rather than degrading to a per-skill dir
    // (which would explode the set and disable the shared-registry path).
    if (root !== null) {
      projectRoots.add(root);
    }
    const gitRoot = gitFindRoot(skillDir);
    if (gitRoot !== null) {
      gitRoots.add(safePath.resolve(gitRoot));
    }
  }

  const context: SkillValidationSharedContext = { allowLedger, projectSkills };

  // One tracker per repo; when the batch spans repos, skip rather than spawn
  // multiple `git ls-files`.
  //
  // Built BEFORE the registry, which is the one ordering constraint in this
  // function: the projection lane below needs an ignore oracle, and without one
  // every realization row reads `gitignored: false` — so the population would
  // admit the ignored half of the tree and this command would start validating
  // generated markdown. Nothing else here depends on the order.
  if (gitRoots.size === 1) {
    const [sharedGitRoot] = [...gitRoots];
    if (sharedGitRoot !== undefined) {
      logger.debug(`Building shared GitTracker rooted at: ${sharedGitRoot}`);
      const tracker = new GitTracker(sharedGitRoot);
      await tracker.initialize();
      context.gitTracker = tracker;
    }
  } else if (gitRoots.size > 1) {
    logger.debug(`Skipping shared tracker — batch spans ${gitRoots.size} git roots`);
  }

  // Only reuse a single registry when every skill shares the same project
  // root. Otherwise the per-skill fallback path is correct and the cost is
  // unchanged from the pre-refactor baseline.
  if (projectRoots.size === 1) {
    const [sharedRoot] = [...projectRoots];
    if (sharedRoot !== undefined) {
      logger.debug(`Building shared resource registry rooted at: ${sharedRoot}`);
      // The lane, and the store that answers it, bracket the crawl and nothing
      // else: the source is called from inside `fromCrawl` and nowhere after it.
      // `include` is unchanged either way — `ResourceRegistry.crawl` re-applies
      // it to whatever the source offers, so this stays a markdown-only registry
      // on both lanes.
      const registry = await withResourcePopulationSource(
        { root: sharedRoot, gitTracker: context.gitTracker },
        async (populationSource) => {
          logger.debug(
            populationSource
              ? `Enumerating via the projection lane (${RESOURCES_CRAWL_ENV}=${RESOURCES_CRAWL_PROJECTION})`
              : `Enumerating via the incumbent walk (${RESOURCES_CRAWL_ENV} unset)`,
          );
          return buildSkillsValidateRegistry(sharedRoot, {
            // The command's OWN config, not a second read of the same file. It
            // governs `sharedRoot` by construction: this command exits early
            // without a config at `cwd`, every skill is discovered relative to
            // `cwd`, and `findProjectRoot` stops at the nearest config — so the
            // root every skill agrees on IS the root this config was loaded
            // from. Withholding it routes parsing by the extension tables while
            // the projection behind `populationSource` routes by the declared
            // `mimeType`, and the two then disagree about which files are prose.
            config,
            ...(populationSource !== undefined && { populationSource }),
          });
        },
      );
      context.registry = registry;
    }
  } else {
    logger.debug(`Skipping shared registry — batch spans ${projectRoots.size} project roots`);
  }

  return context;
}

/**
 * Validate every configured skill and hand back the document and exit code,
 * printing the document nowhere.
 *
 * The phase entry point for `vat validate` and `vat verify`. The two early
 * returns publish NO document — an unconfigured or empty run prints nothing on
 * stdout and exits 0, exactly as the child process did, and
 * `phaseResultFromOutcome` records that as `success` with no `report`.
 */
export async function runSkillsValidatePhase(
  pathArg: string | undefined,
  options: SkillsValidateCommandOptions
): Promise<PhaseOutcome> {
  const { logger, cwd, startTime } = setupCommandContext(pathArg, options.debug);

  try {
    // Spec §7: `vat skills validate` requires a projectRoot — fails fast at
    // the CLI boundary if no config or git ancestor exists. The resolved root
    // is discarded here because config is read from `cwd`; the guard exists
    // to satisfy the policy contract.
    requireProjectRoot(cwd, 'vat skills validate');

    // Load config yaml from cwd (not workspace root — config lives next to the package)
    const config = loadConfig(cwd);

    if (!config?.skills) {
      logger.info('No skills section in config yaml — nothing to validate');
      return { document: undefined, exitCode: 0 };
    }

    // Discover skills from config yaml (relative to cwd where config lives)
    const discovered = await discoverSkillsFromConfig(config.skills, cwd);

    if (discovered.length === 0) {
      logger.info('ℹ️  No skills found matching config yaml skills.include patterns');
      return { document: undefined, exitCode: 0 };
    }

    // Merge packaging config for each skill.
    const { defaults, config: perSkillConfig } = config.skills;
    const validatableSkills: ValidatableSkill[] = discovered.map(skill => ({
      ...skill,
      packagingConfig: mergeSkillPackagingConfig(
        defaults as Record<string, unknown> | undefined,
        perSkillConfig?.[skill.name] as Record<string, unknown> | undefined,
      ),
    }));

    // Filter by name if specified
    const skillsToValidate = filterSkillsByName(validatableSkills, options.skill);
    logger.info(`🔍 Found ${skillsToValidate.length} skill(s) to validate\n`);

    // Build shared context once per invocation. Both the resource registry
    // (for markdown parses) and the git tracker (for gitignore checks) can be
    // shared across every skill whose projectRoot + gitRoot match the derived
    // values, which is the common case for a single-repo `vat skills validate`.
    // Every declared skill, not just `skillsToValidate`: `--skill x` narrows what is
    // REPORTED on, never what counts as some skill's declared test input.
    const projectSkills = collectDeclaredEvalSuites(config.skills, discovered);
    const sharedContext = await buildSharedValidationContext(skillsToValidate, projectSkills, config, logger);

    // Validate each skill
    const results: PackagingValidationResult[] = [];
    for (const skill of skillsToValidate) {
      logger.info(`   Validating: ${skill.name}`);
      logger.debug(`   Source: ${skill.sourcePath}`);

      const result = await validateSkillForPackaging(
        skill.sourcePath,
        skill.packagingConfig,
        'source',
        sharedContext,
      );
      // `cwd` is the anchor root: config is read from it and discovery globs
      // resolve against it, so every other location in this report is already
      // relative to it.
      applyConfigVerdicts(
        result,
        skill.packagingConfig.targets as readonly Target[] | undefined,
        skill.sourcePath,
        cwd,
      );
      logSkillProgress(skill.name, result, logger);
      results.push(result);
    }

    // Drain the run's allow ledger AFTER the last skill — an entry matched by
    // any skill in the batch is used, so this is the first point at which
    // "matched nothing" is answerable.
    const runIssues = sharedContext.allowLedger === undefined
      ? []
      : allowUnusedIssues(sharedContext.allowLedger);

    const duration = Date.now() - startTime;
    const verbose = options.verbose === true;
    const document = buildValidateSummary(results, duration, verbose, runIssues);
    reportValidationToStderr(results, logger, verbose, runIssues);

    const hasErrors = results.some(r => r.status === 'error')
      || runIssues.some(i => i.severity === 'error');
    return { document, exitCode: hasErrors ? 1 : 0 };
  } catch (error) {
    return {
      document: reportCommandError(error, logger, startTime, 'SkillsValidate'),
      exitCode: 2,
      failed: true,
    };
  }
}

/**
 * Skills validate command implementation
 */
export async function validateCommand(
  pathArg: string | undefined,
  options: SkillsValidateCommandOptions
): Promise<void> {
  finishCommand(await runSkillsValidatePhase(pathArg, options), (document) => {
    writeYamlSummary(document as ReturnType<typeof buildValidateSummary>);
  });
}
