/**
 * Skills validate command - validate skills for packaging
 *
 * Discovers skills from config yaml skills.include/exclude, validates each
 * using validateSkillForPackaging with merged packaging config.
 *
 * Publishes the `Report<T>` envelope (`validate-schema.ts`): every finding
 * flat with its `location` relative to `data.root`, one `data.skills` row per
 * skill validated, `examined` = skills validated. A run over zero skills is
 * refused by the writer, from the registry's declared denominator — never by
 * a check at this site. `--verbose` decides only how much stderr prints.
 */

import {
  conventionalSuiteProbe,
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
  type SkillsConfig,
} from '@vibe-agent-toolkit/resources';
import {
  allowUnusedIssues,
  buildReport,
  countBySeverity,
  createAllowUsageLedger,
  summarizeIssues,
  toFindings,
  type Finding,
  type SeverityCounts,
  type ValidationIssue,
} from '@vibe-agent-toolkit/schema';
import { findProjectRoot, mapInOrder, safePath } from '@vibe-agent-toolkit/utils';
import { gitFindRoot, GitTracker } from '@vibe-agent-toolkit/utils/git';

import type { DocumentFormat } from '../../report-schemas.js';
import { refusalCodeOf } from '../../utils/command-refusal.js';
import { loadConfig } from '../../utils/config-loader.js';
import { endWithReport, NOTHING_FINISHED, refusalReport } from '../../utils/document-writer.js';
import {
  formatIssueLines,
  formatRunIssueLines,
  formatSeverityBreakdown,
  issuesToRenderAtVerbosity,
  summarizeFindings,
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
import type { PhaseOutcome } from '../phase-utils.js';

import {
  filterSkillsByName,
  setupCommandContext,
  type DiscoveredSkill,
} from './command-helpers.js';
import { assertScopableSkillsPath, type SkillsScopeSubject } from './scope-guard.js';
import { discoverSkillsFromConfig } from './skill-discovery.js';
import type { SkillsValidateData, SkillsValidateReport } from './validate-schema.js';

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

/** `vat skills validate` offers no `--strict`: warnings never fail it. */
const GATE = { strict: false } as const;

/** This command offers no `--format`: its document is YAML. */
const FORMAT: DocumentFormat = 'yaml';

/**
 * What a mis-scoped `vat skills validate` used to do.
 *
 * In a package where the bare invocation validates 13 skills, one mistyped
 * character rescoped it to nothing and still reported success — the same
 * "went wide / went narrow and reported success" defect
 * `rejectPositionalArguments` was added to `vat verify` / `vat validate` /
 * `vat build` for, arrived at from the opposite direction. `vat skills build`
 * carried the identical hole and is guarded by the same module.
 */
const SCOPE_SUBJECT: SkillsScopeSubject = {
  command: 'vat skills validate',
  silentSuccess: 'nothing to validate',
};

/**
 * Every finding a skill published: its emitted issues after severity
 * resolution, minus any the adopter resolved to `ignore`.
 *
 * `allErrors` is the full emitted set INCLUDING info despite the name (see the
 * doc comment on `PackagingValidationResult`), and excluding issues suppressed
 * by `validation.allow` — those live in `ignoredErrors`, counted as `allowed`.
 */
function skillFindings(result: PackagingValidationResult): Finding[] {
  return toFindings(result.allErrors);
}

/**
 * The discovery globs that decided which skills a run validated — named on
 * stderr when they matched nothing ({@link nothingDiscoveredLine}); the
 * document carries only the registry's generic `whenZero`. Only these two keys
 * are read, so a full `SkillsConfig` and a test's two arrays hand in the same thing.
 */
type SkillDiscoveryPatterns = Pick<SkillsConfig, 'include' | 'exclude'>;

/** What {@link buildSkillsValidateReport} needs — the run's results, nothing it has to go and read. */
interface SkillsValidateInput {
  /** The directory the config was read from: the ONE base every `location` is relative to. */
  readonly root: string;
  /** One result per skill the run validated: the denominator. */
  readonly results: readonly PackagingValidationResult[];
  /**
   * Findings about the RUN rather than about any one skill — the
   * `validation.allow` entries no skill in the batch matched (ALLOW_UNUSED).
   * `validation.allow` is declared once per package, so attributing "nothing
   * matched this entry" to whichever skill happened to be validated at the
   * time is what produced 78 warnings from 3 real entries.
   */
  readonly runIssues: readonly ValidationIssue[];
  readonly durationMs: number;
}

/**
 * Build the report. Pure: no file system, no clock, no `process.exit`.
 *
 * Every finding is on the envelope, flat — each skill's, then the run's — so
 * the envelope `summary` is exactly the sum of the `data.skills[].summary`
 * rows plus the run-level findings, by construction. Every validated skill has
 * a row, clean or not: `examined` and `data.skills.length` agree, so a reader
 * never has to guess whether an absent skill was clean or never validated.
 *
 * The run-integrity refusal for a run over zero skills is NOT decided here;
 * the writer adds it from the registry's declared denominator.
 *
 * @param input - The run's results
 * @returns The report, before the writer's run-integrity pass
 */
export function buildSkillsValidateReport(input: SkillsValidateInput): SkillsValidateReport {
  const skills: SkillsValidateData['skills'] = input.results.map((result) => ({
    name: result.skillName,
    ...summarizeIssues(skillFindings(result)),
    allowed: result.ignoredErrors.length,
  }));

  return buildReport({
    examined: input.results.length,
    findings: [...input.results.flatMap(skillFindings), ...toFindings(input.runIssues)],
    data: { root: input.root, skills },
    gate: GATE,
    durationMs: input.durationMs,
  });
}

/** The globs as an operator wrote them, back-quoted and comma-separated. */
function quoteGlobs(globs: readonly string[]): string {
  return globs.map((glob) => `\`${glob}\``).join(', ');
}

/**
 * The stderr half of a run over zero skills: WHICH globs matched nothing.
 *
 * The document's refusal is the registry's generic `whenZero` — the writer
 * cannot see the config — so the globs this run actually used are named here,
 * where the operator reads them.
 */
export function nothingDiscoveredLine(patterns: SkillDiscoveryPatterns | undefined): string {
  if (patterns === undefined) {
    return 'vibe-agent-toolkit.config.yaml declares no `skills:` block, so there is nothing to validate.';
  }
  const exclude = patterns.exclude === undefined || patterns.exclude.length === 0
    ? ''
    : ` after \`skills.exclude\` (${quoteGlobs(patterns.exclude)})`;
  return `The \`skills.include\` globs (${quoteGlobs(patterns.include)}) matched no SKILL.md${exclude}.`;
}

/** Any finding at all, emitted or allow-suppressed — the skills the human report lists. */
function hasFindings(result: PackagingValidationResult): boolean {
  return result.allErrors.length > 0 || result.ignoredErrors.length > 0;
}

/**
 * ONE line for one skill: its severity breakdown, its allowed count, and the
 * codes behind it, dominant first.
 *
 * The skill is the unit the reader acts on: 1,728 of the 1,897 findings on a
 * real 90-skill repo are one code, LINK_DROPPED_BY_DEPTH, whose four remedies
 * are all SKILL-level config edits — so the default stderr report is one row
 * per skill, never one block per finding. The per-issue blocks below are what
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

/** Under `--verbose`: the allow-suppressed records and the references left out of the bundle. */
function verboseDetailLines(result: PackagingValidationResult): string[] {
  const lines: string[] = [];
  if (result.ignoredErrors.length > 0) {
    lines.push(`  Allowed issues (${result.ignoredErrors.length}):`);
    for (const record of result.ignoredErrors) {
      lines.push(`    [${String(record.code)}] ${String(record.location)} (allowed: ${record.reason})`);
    }
  }
  const excluded = result.metadata.excludedReferences;
  if (excluded.length > 0) {
    lines.push(`  Excluded references (${excluded.length}):`);
    for (const reference of excluded) {
      const pattern = reference.matchedPattern === undefined ? '' : `, pattern ${reference.matchedPattern}`;
      lines.push(`    ${reference.path} (${reference.reason}${pattern})`);
    }
  }
  return lines;
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
 * The allow-suppressed records and the excluded references are listed only
 * under `verbose`; by default the row's `(+N allowed by config)` is the receipt.
 */
function skillReportLines(result: PackagingValidationResult, verbose: boolean): string[] {
  const lines = [skillSummaryLine(result)];

  const rendered = issuesToRenderAtVerbosity(result.allErrors, verbose);
  for (const issue of rendered) {
    lines.push(...formatIssueLines(issue, '    '));
  }

  const detail = verbose ? verboseDetailLines(result) : [];
  lines.push(...detail);

  // A trailing blank line only when something was rendered beneath the row —
  // otherwise consecutive one-line rows would be double-spaced.
  if (rendered.length > 0 || detail.length > 0) {
    lines.push('');
  }
  return lines;
}

/**
 * One glyph per severity outcome. Info never rates a warning: the same rule
 * `statusFromEnvelope` applies to a phase, so an info-only skill is `✅` here
 * and `success` in `vat validate`.
 */
function glyphFor(counts: SeverityCounts): string {
  if (counts.errors > 0) return '❌';
  if (counts.warnings > 0) return '⚠️ ';
  return '✅';
}

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
 * beneath it. Keying the claim on a hardcoded list of code names would assert a
 * cause this renderer cannot observe, and would go stale the next time a code
 * is added.
 */
function reportBanner(counts: SeverityCounts): string {
  if (counts.errors > 0) {
    return `\n❌ Validation failed — ${formatSeverityBreakdown(counts)}:\n`;
  }
  if (counts.warnings + counts.info > 0) {
    // Non-blocking (exit 0), which is exactly why this used to print
    // "All validations passed" over the findings.
    return `\n${glyphFor(counts)} Validation passed with findings — ${formatSeverityBreakdown(counts)}:\n`;
  }
  return '\n✅ All validations passed';
}

/**
 * Human-readable report lines for the whole batch.
 *
 * Renders every skill with ANY finding, not just the ones that failed the
 * gate: a warning-only or info-only run used to print the success banner and
 * nothing else, so the findings existed only in the YAML on stdout.
 *
 * Every skill with findings gets its summary row at every verbosity; `verbose`
 * picks only which findings are ALSO rendered in full beneath that row, per
 * {@link issuesToRenderAtVerbosity} — errors always, `warning`/`info` when
 * asked, `ignore` never.
 *
 * `runFindings` are the published run-level findings — the `validation.allow`
 * entries no skill matched, and the writer's run-integrity refusal when the
 * run validated nothing — so the banner counts what the document counts and a
 * run over zero skills cannot print a green banner over a refused document.
 *
 * @param results - One result per skill validated
 * @param runFindings - The run-level findings the document published
 * @param verbose - Render every finding in full, and the per-skill detail
 */
export function formatValidationReportLines(
  results: readonly PackagingValidationResult[],
  runFindings: readonly ValidationIssue[],
  verbose: boolean,
): string[] {
  const counts = countBySeverity([...results.flatMap(skillFindings), ...toFindings(runFindings)]);
  const lines = [reportBanner(counts)];

  for (const result of results) {
    if (!hasFindings(result)) continue;
    lines.push(...skillReportLines(result, verbose));
  }
  const runLines = formatRunIssueLines(runFindings);
  if (runLines.length > 0) {
    lines.push(...runLines, '');
  }
  return lines;
}

/**
 * The human half, on stderr: the report lines and the quality footer.
 */
function reportValidationToStderr(
  results: readonly PackagingValidationResult[],
  runFindings: readonly ValidationIssue[],
  logger: ReturnType<typeof createLogger>,
  verbose: boolean,
): void {
  // Collect all emitted codes across skills and the run to drive the footer.
  const emittedCodes = new Set<string>([
    ...results.flatMap((r) => r.allErrors.map((issue) => issue.code)),
    ...runFindings.map((issue) => issue.code),
  ]);
  const hasSkillFindings = results.some((r) => {
    const counts = countBySeverity(skillFindings(r));
    return counts.errors + counts.warnings > 0;
  });

  for (const line of formatValidationReportLines(results, runFindings, verbose)) {
    logger.info(line);
  }
  renderSkillQualityFooter(logger, hasSkillFindings, emittedCodes);
}

/**
 * Log validation progress for a single skill.
 *
 * The per-skill glyph follows the skill's worst severity (`⚠️` for a
 * warning-only skill), and the severity breakdown is always spelled out. A
 * skill with warnings used to print a bare `✅ <name>`, which is the same
 * reassuring collapse as the batch banner, one line earlier.
 */
export function formatSkillProgressLine(
  skillName: string,
  result: PackagingValidationResult,
): string[] {
  const counts = countBySeverity(skillFindings(result));
  const detail = result.allErrors.length > 0 ? `: ${formatSeverityBreakdown(countBySeverity(result.allErrors))}` : '';
  const lines = [`   ${glyphFor(counts)} ${skillName}${detail}`];

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
      // `vat skills validate` acts on this registry as the whole population: a
      // directory it cannot list refuses the run by name, exit 2.
      unreadable: 'refuse',
      // It only reads the project.
      outputs: [],
      ...(populationSource !== undefined && { populationSource }),
    },
    config === undefined ? undefined : { config },
  );
  registry.resolveLinks();
  return registry;
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

  // The RUN's conventional-suite probe, and it belongs beside the ledger rather
  // than with the two optimizations below: resolving a skill's test input probes
  // `<skill-root>/evals/evals.json` for the subject AND for every entry in
  // `projectSkills`, so a probe minted per skill asks S questions per skill and
  // S² per run about the same S paths. Measured with the lab on a 103-skill
  // adopter: 10,815 probes over 103 distinct paths, half the command's entire
  // filesystem traffic; with the run's probe threaded, ~103.
  //
  // Created here, once, and handed to every skill in the batch — that is the
  // whole contract of `SkillValidationSharedContext.suiteProbe`, whose fallback
  // (`?? conventionalSuiteProbe()`) treats an omitting caller as claiming ITS
  // call is the whole run. This lane loops, so omitting it made that claim
  // falsely and silently.
  //
  // NOT module-scoped: the answer is a filesystem snapshot, and a cache
  // outliving the run keeps answering for a tree that has since changed.
  const suiteProbe = conventionalSuiteProbe();

  // Likewise not an optimization: the test-input rule is project-wide, so this
  // lane must model a bundle that excludes EVERY declared suite, not just the
  // subject's. Present even for an empty batch, so no early return can drop it.
  if (skills.length === 0) {
    return { allowLedger, projectSkills, suiteProbe, unreadable: 'refuse', outputs: [] };
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

  // Validation only reads the project.
  const context: SkillValidationSharedContext = { allowLedger, projectSkills, suiteProbe, unreadable: 'refuse', outputs: [] };

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
        (populationSource) => {
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

/** What one run of the validator produced, before the document is built. */
interface SkillsRun {
  readonly results: PackagingValidationResult[];
  readonly runIssues: ValidationIssue[];
}

/**
 * Validate every skill the `skills:` block declares (narrowed by `--skill`).
 *
 * @param skillsConfig - The config's `skills:` block
 * @param cwd - The directory the config was read from; discovery globs resolve against it
 * @param config - The whole config, handed to the shared registry
 * @param options - `--skill`
 * @param logger - Progress on stderr
 */
async function validateConfiguredSkills(
  skillsConfig: NonNullable<ProjectConfig['skills']>,
  cwd: string,
  config: ProjectConfig,
  options: SkillsValidateCommandOptions,
  logger: ReturnType<typeof createLogger>,
): Promise<SkillsRun> {
  // `'refuse'`: one fewer skill at exit 0 is the drop this command must not
  // make. A directory the OS will not list is refused by code (INPUT_UNREADABLE).
  const discovered = await discoverSkillsFromConfig(skillsConfig, cwd, 'refuse');

  // No early return on `discovered.length === 0`: the empty batch flows through
  // every step below unchanged — the shared context is built for zero skills
  // (its ledger and probe exist regardless), the loop runs zero times, and the
  // writer refuses the zero denominator.
  const { defaults, config: perSkillConfig } = skillsConfig;
  const validatableSkills: ValidatableSkill[] = discovered.map(skill => ({
    ...skill,
    packagingConfig: mergeSkillPackagingConfig(
      defaults as Record<string, unknown> | undefined,
      perSkillConfig?.[skill.name] as Record<string, unknown> | undefined,
    ),
  }));

  const skillsToValidate = filterSkillsByName(validatableSkills, options.skill);
  logger.info(`🔍 Found ${skillsToValidate.length} skill(s) to validate\n`);

  // Every declared skill, not just `skillsToValidate`: `--skill x` narrows what is
  // REPORTED on, never what counts as some skill's declared test input.
  const projectSkills = collectDeclaredEvalSuites(skillsConfig, discovered);
  const sharedContext = await buildSharedValidationContext(skillsToValidate, projectSkills, config, logger);

  // In order: `sharedContext`'s caches and the per-skill progress lines.
  const results: PackagingValidationResult[] = await mapInOrder(skillsToValidate, async (skill) => {
    logger.info(`   Validating: ${skill.name}`);
    logger.debug(`   Source: ${skill.sourcePath}`);

    const result = await validateSkillForPackaging(skill.sourcePath, skill.packagingConfig, 'source', sharedContext);
    // `cwd` is the anchor root: config is read from it and discovery globs
    // resolve against it, so every other location in this report is already
    // relative to it.
    applyConfigVerdicts(result, skill.packagingConfig.targets as readonly Target[] | undefined, skill.sourcePath, cwd);
    logSkillProgress(skill.name, result, logger);
    return result;
  });

  // Drain the run's allow ledger AFTER the last skill — an entry matched by
  // any skill in the batch is used, so this is the first point at which
  // "matched nothing" is answerable.
  const runIssues = sharedContext.allowLedger === undefined ? [] : allowUnusedIssues(sharedContext.allowLedger);
  return { results, runIssues };
}

/**
 * Validate every configured skill and hand back the report, printing it
 * nowhere.
 *
 * The phase entry point for `vat validate` and `vat verify`, and the command's
 * own. The report is the one BEFORE the writer's run-integrity pass: inside an
 * orchestrator, zero examined is judged on the whole run, not on this phase.
 *
 * A run that validated no skill — globs that discover nothing, or a config
 * with no `skills:` block — is not a clean run. It used to take an early
 * return that printed one info line and published NO document at exit 0, and
 * `vat validate` folded that into success: the gate the docs name as THE gate,
 * green forever on a config that checked nothing. Now it reports zero skills,
 * which the writer refuses with `RESOURCE_CHECK_BROKEN` (exit 1) when this is
 * the whole run; stderr names the globs that matched nothing. Both
 * orchestrators skip this phase for a config with no `skills:` block.
 *
 * Every refusal is classified by code: a `[path]` naming nothing, an unknown
 * `--skill`, no project root → `USAGE_INVALID`; an unlistable directory →
 * `INPUT_UNREADABLE`; a config that does not parse → `CONFIG_INVALID`.
 */
export async function runSkillsValidatePhase(
  pathArg: string | undefined,
  options: SkillsValidateCommandOptions
): Promise<PhaseOutcome> {
  const { logger, cwd, startTime } = setupCommandContext(pathArg, options.debug);

  try {
    assertScopableSkillsPath(SCOPE_SUBJECT, pathArg);
    // Spec §7: `vat skills validate` requires a projectRoot. Config is read
    // from `cwd`; the guard exists to satisfy the policy contract.
    requireProjectRoot(cwd, 'vat skills validate');

    // Load config yaml from cwd (not workspace root — config lives next to the package)
    const config = loadConfig(cwd);
    const { results, runIssues } = config?.skills === undefined
      ? { results: [], runIssues: [] }
      : await validateConfiguredSkills(config.skills, cwd, config, options, logger);

    const report = buildSkillsValidateReport({
      root: cwd,
      results,
      runIssues,
      durationMs: Date.now() - startTime,
    });
    reportValidationToStderr(results, runIssues, logger, options.verbose === true);
    if (report.examined === 0) logger.error(nothingDiscoveredLine(config?.skills));
    return { report };
  } catch (error) {
    return { report: refusalReport(refusalCodeOf(error), error, GATE, NOTHING_FINISHED) };
  }
}

/**
 * Skills validate command implementation
 */
export async function validateCommand(
  pathArg: string | undefined,
  options: SkillsValidateCommandOptions
): Promise<void> {
  endWithReport('skills validate', (await runSkillsValidatePhase(pathArg, options)).report, FORMAT);
}
