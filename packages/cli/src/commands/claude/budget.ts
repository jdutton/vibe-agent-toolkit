/**
 * `vat claude budget [paths...]` — is the always-loaded context at a working
 * location over its budget?
 *
 * ## Why this is a command and not a check inside `vat resources validate`
 *
 * It used to be one: default-on, with a `--no-context-budget` opt-out. That is
 * gone, in both directions — `vat resources validate` has no knowledge of the
 * budget at all any more, not a flag, not a default. The ruling behind the move
 * is short: *a validation run must not emit findings nobody asked for.* An
 * `info` finding attached to a lane people run for link and anchor errors is a
 * finding they scroll past, and a check people scroll past is a check they
 * eventually silence.
 *
 * ## The sibling split: `context` QUERIES, `budget` CHECKS
 *
 * `vat claude context` answers a question and
 * never gates — totals, admissions, the declared limits, no verdict, always
 * exit 0. This command is the other half of that pair: it applies a THRESHOLD,
 * produces findings with severities an adopter can configure, and lets an
 * adopter who promotes the code to `error` fail their build with it. Two verbs
 * because they are two acts, and folding a verdict into the query would make
 * the query's number a number people learn to stop reading.
 *
 * ## Everything below is orchestration — deliberately
 *
 * Which directories exist, what each pays, and whether that is over budget are
 * all decided in `@vibe-agent-toolkit/resources` (`buildClaudeContextPopulation`
 * and `sweepAlwaysLoadedBudgets`); the wording and grouping of the findings in
 * `utils/context-budget-issues.ts`; severity resolution in the two shared
 * filters every other lane runs. This module populates one tree, calls them in
 * order, and renders. It decides nothing about context loading of its own,
 * which is the CLI-stays-dumb rule applied to the lane where the temptation is
 * strongest.
 *
 * ⛔ The threshold is never re-spelled here. It is a MEASURED quantity that
 * lives beside the detector (`DEFAULT_ALWAYS_LOADED_CONTEXT_TOKENS`), and a
 * literal in this package would be a second source of truth that nothing
 * compares.
 *
 * ## The stated bounds ride ONCE on the REPORT, in every format
 *
 * The sibling query publishes 23 stated limits; this command applies a threshold
 * to the same measurement, so it publishes {@link ALWAYS_LOADED_BUDGET_LIMITS}
 * and {@link CLAUDE_CONTEXT_BOUNDS_STATEMENT} beside its verdict — the half that
 * GATES is the half whose bounds a reader most needs. Both are imported, never
 * restated: the sentence is domain content owned beside the list it frames.
 *
 * ⛔ They belong to the REPORT, never to a finding. A per-finding copy is the
 * defect this lane already shipped once on the query side, and it is invisible to
 * any assertion that checks presence rather than counting occurrences.
 */

import {
  ALWAYS_LOADED_BUDGET_LIMITS,
  buildClaudeContextPopulation,
  CLAUDE_CONTEXT_BOUNDS_STATEMENT,
  DEFAULT_ALWAYS_LOADED_CONTEXT_TOKENS,
  sweepAlwaysLoadedBudgets,
  type BudgetSweep,
  type StatedLimit,
} from '@vibe-agent-toolkit/resources';
import {
  applyAllowFilter,
  calculateValidationStatus,
  countBySeverity,
  type SeverityCounts,
  type ValidationIssue,
} from '@vibe-agent-toolkit/schema';
import { findProjectRoot } from '@vibe-agent-toolkit/utils';
import { Command, Option } from 'commander';

import { handleCommandError } from '../../utils/command-error.js';
import { loadConfig } from '../../utils/config-loader.js';
import { contextBudgetIssues, scopeSweepToPaths } from '../../utils/context-budget-issues.js';
import { targetPathWithin } from '../../utils/corpus-target.js';
import { resolveIssueSeverity } from '../../utils/issue-severity.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { writeJsonOutput, writeStdoutSync, writeYamlOutput } from '../../utils/output.js';
import { populationWiring } from '../../utils/population-wiring.js';
import { withPopulationCache } from '../../utils/projection-store.js';
import { runIntegrityFinding } from '../../utils/run-integrity.js';
import { gitTrackerForProjectRoot } from '../audit/distributed-tree.js';

/** How this command names itself in a refusal. */
const COMMAND_NAME = 'vat claude budget';

/** Soft wrap width for the printed limit statements. */
const WRAP_COLUMNS = 96;

/** How the corpus root itself is named to a reader — it has no path of its own. */
const CORPUS_ROOT_LABEL = '<corpus root>';

/** How the report is rendered. `text` is for a person; the other two are for a program. */
export type BudgetOutputFormat = 'text' | 'yaml' | 'json';

/** Flags `vat claude budget` accepts. */
export interface ClaudeBudgetOptions {
  format?: BudgetOutputFormat;
  debug?: boolean;
}

/**
 * The report one run emits.
 *
 * The three sweep counters ride beside the findings and describe the WHOLE
 * tree, not the scope: a scope narrows what is reported, never what was
 * measured. Publishing them is what keeps an empty `findings` legible — "9
 * chains checked, none over budget" and "nothing was checked" are different
 * answers and must not render identically.
 */
export interface BudgetReport {
  readonly root: string;
  /** The budget every chain was measured against, in tokens. */
  readonly threshold: number;
  /** The root-relative directories asked about. `''` is the whole tree. */
  readonly scope: readonly string[];
  /** Requested paths that named no working location — see `scopeSweepToPaths`. */
  readonly unmatchedScope: readonly string[];
  readonly status: 'success' | 'warning' | 'error';
  readonly issueCounts: SeverityCounts;
  /** Working locations the sweep evaluated, across the whole tree. */
  readonly workingLocations: number;
  /** Distinct instruction chains among them — the queries the sweep really issued. */
  readonly distinctChains: number;
  /** Locations whose representative the projection never realized. Counted, never zeroed. */
  readonly skippedUnknownLocations: number;
  /**
   * One finding per over-budget chain — plus, ahead of them, the run-integrity
   * refusal when part of what was asked about was never measured. See
   * {@link buildReport}: the second kind is DERIVED here rather than passed in,
   * so no report can carry an unmatched path and a clean status.
   */
  readonly findings: readonly ValidationIssue[];
  /**
   * What this verdict does not settle, in either direction. Stated ONCE.
   *
   * ⛔ On the report beside `threshold`, never on a finding. These bound the
   * MEASUREMENT METHOD, not any one chain — a finding carrying its own copy
   * reads as though that chain had caveats of its own, and repeated across a
   * sweep it is pure byte-identical duplication.
   */
  readonly boundsStatement: string;
  /** The signed over/under-report bounds on the method. Stated ONCE. */
  readonly limits: readonly StatedLimit[];
}

/**
 * Create the `vat claude budget [paths...]` command.
 *
 * @returns The configured Commander command
 */
export function createBudgetCommand(): Command {
  const command = new Command('budget');
  command
    .description('Check whether the always-loaded context at a working location exceeds its budget')
    .argument(
      '[paths...]',
      'Directories to check, with everything beneath them (default: the whole tree)',
    )
    .addOption(
      new Option('--format <format>', 'Output format: text (default), yaml, or json').choices([
        'text',
        'yaml',
        'json',
      ]).default('text'),
    )
    .option('--debug', 'Verbose logging to stderr')
    .action(claudeBudgetCommand)
    .addHelpText('after', `
Description:
  Reports ALWAYS_LOADED_CONTEXT_BUDGET for each instruction chain whose
  always-loaded context exceeds the budget. The measured chain is the
  repo-root CLAUDE.md, every CLAUDE.md on the path down to the working
  location, one level of @ imports from each, and any unscoped rules file in
  the root .claude/rules/. An AGENTS.md is measured only where a CLAUDE.md
  imports it (@AGENTS.md) — Claude Code does not load it by name, so a repo
  standardised on AGENTS.md alone has nothing here to measure. Path-scoped
  rules (a paths: list) are excluded: they load when the agent touches a
  matching file, not at launch.

  ONE finding per chain, not per directory: directories loading the same files
  share a finding, which names how many working locations pay it. Naming paths
  narrows WHICH chains are reported; the payer count stays the whole tree's,
  because that is the number that was measured.

  This is the CHECK. 'vat claude context' is the QUERY — same lane, no
  threshold and no verdict.

Configuration (vibe-agent-toolkit.config.yaml):
  resources.validation.thresholds.alwaysLoadedContextTokens moves the budget
  (default ${String(DEFAULT_ALWAYS_LOADED_CONTEXT_TOKENS)}). resources.validation.severity.ALWAYS_LOADED_CONTEXT_BUDGET
  silences it (ignore) or promotes it to warning/error. A project with no
  config file is checked at the same default budget.

Output:
  - threshold:          the budget every chain was measured against
  - scope/unmatchedScope: what was asked about, and what matched nothing.
                        A path that matched nothing was NOT checked, so it is
                        reported as a RESOURCE_CHECK_BROKEN error rather than
                        passing quietly -- and that code is not configurable
  - status/issueCounts: the worst actionable severity, plus every severity
  - workingLocations, distinctChains, skippedUnknownLocations: whole-tree
                        facts, so an empty findings list is legible
  - findings:           one per over-budget chain, ascending by directory
  - limits/boundsStatement: what this verdict does not settle, signed
                        over-report or under-report. On the REPORT, never on a
                        finding — they bound the method, not any one chain, so
                        they are stated exactly once however many chains flag

  Text to stdout by default; --format yaml|json for a program. Diagnostics
  and blob-stage refusals go to stderr.

Exit Codes:
  0 - Reported (findings at the default info severity do not gate)
  1 - A finding resolved to error severity via config, or a requested path
      matched no working location so nothing was checked there
  2 - System error (a path outside the corpus root, unreadable tree)

Example:
  $ vat claude budget packages/cli      # is it over budget where I work?
`);
  return command;
}

/**
 * Action handler for `vat claude budget [paths...]`.
 *
 * @param pathArgs - Directories to check; empty means the whole tree
 * @param options - The command's flags
 */
export async function claudeBudgetCommand(
  pathArgs: readonly string[],
  options: ClaudeBudgetOptions,
): Promise<void> {
  const logger = createLogger(options.debug === true ? { debug: true } : {});
  const startTime = Date.now();
  try {
    const root = findProjectRoot(process.cwd()) ?? process.cwd();
    // 🔑 Every argument is resolved BEFORE the population. A path outside the
    // corpus is a usage error, and finding it afterwards would charge the caller
    // a full population — minutes on a cold cache — to be told they mistyped.
    const scope = scopeWithin(root, pathArgs);
    const config = loadConfig(root);
    const validation = config?.resources?.validation;
    const threshold = validation?.thresholds?.alwaysLoadedContextTokens
      ?? DEFAULT_ALWAYS_LOADED_CONTEXT_TOKENS;

    const sweep = await sweepBudgets(root, threshold, logger);
    const scoped = scopeSweepToPaths(sweep, scope);
    // The same two shared mechanisms every other lane uses, in the same order:
    // `validation.allow` suppresses by path glob, then `validation.severity`
    // resolves — BOTH directions, so an adopter promoting this code to `error`
    // gets an error, which is the case that gets forgotten.
    const findings = resolveIssueSeverity(
      applyAllowFilter(contextBudgetIssues(scoped.sweep), validation ?? {}).emitted,
      validation,
    );
    warnUnmatched(scoped.unmatchedScope, logger);

    const report = buildReport({ root, threshold, scope, sweep, scoped, findings });
    emit(report, options.format ?? 'text');
    // `error` gates, and it is reachable two ways: an adopter promoted
    // ALWAYS_LOADED_CONTEXT_BUDGET, or the run checked nothing — see
    // {@link nothingCheckedFindings}. At the code's `info` default the first
    // never fires, so the budget cannot fail a build unless an adopter asked it
    // to; the second is not a severity anybody may configure away.
    process.exit(report.issueCounts.errors > 0 ? 1 : 0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'claude budget', options.format);
  }
}

/** Everything {@link buildReport} needs, bundled past the lint gate's parameter ceiling. */
export interface ReportInput {
  readonly root: string;
  readonly threshold: number;
  readonly scope: readonly string[];
  readonly sweep: BudgetSweep;
  readonly scoped: { readonly unmatchedScope: readonly string[] };
  /** The BUDGET findings only. The run-integrity refusal is derived, not passed. */
  readonly findings: readonly ValidationIssue[];
}

/**
 * Assemble the report from the run's parts.
 *
 * ⛔ The counters come from the UNSCOPED sweep. They answer "what was measured",
 * and a scope changes only what is reported — sourcing them from the narrowed
 * view would let `vat claude budget docs` claim the tree has one chain.
 *
 * ⛔ This is the ONE place the stated bounds enter the machine-readable output,
 * and keeping it a single assignment is what makes "stated once" structural
 * rather than a habit: there is no per-finding site left where a copy could be
 * reintroduced. They are attached unconditionally — a run that flagged nothing
 * used the same method, and a reader acting on "within budget" needs them most.
 *
 * ⛔ Exported so it can be TESTED. What has to be pinned is a COUNT — that the
 * block appears exactly once across a MULTI-finding report — and a presence
 * check passes identically with a copy per finding.
 *
 * ⛔ The run-integrity refusal is DERIVED here from `scoped.unmatchedScope`
 * rather than assembled by the caller, which is what makes "a run that checked
 * nothing never reports success" unrepresentable instead of merely observed:
 * there is no pipeline step left in which a later edit could drop it. See
 * {@link nothingCheckedFindings}.
 *
 * @param input - The run's parts
 * @returns The report, ready to serialize
 */
export function buildReport(input: ReportInput): BudgetReport {
  const { root, threshold, scope, sweep, scoped, findings } = input;
  // The run-integrity report LEADS: every budget finding beneath it is noise
  // until the operator knows part of what they asked about was never measured.
  const reported = [...nothingCheckedFindings(scoped.unmatchedScope), ...findings];
  return {
    root,
    threshold,
    scope,
    unmatchedScope: scoped.unmatchedScope,
    status: calculateValidationStatus(reported),
    issueCounts: countBySeverity(reported),
    workingLocations: sweep.evaluatedDirectories,
    distinctChains: sweep.queriedDirectories,
    skippedUnknownLocations: sweep.skippedUnknownLocations,
    findings: reported,
    boundsStatement: CLAUDE_CONTEXT_BOUNDS_STATEMENT,
    limits: ALWAYS_LOADED_BUDGET_LIMITS,
  };
}

/**
 * Resolve the requested scope, defaulting to the whole tree.
 *
 * ⚠️ No arguments means the WHOLE TREE, not the current directory — the
 * opposite of `vat claude context`'s default, and deliberately so. This is a
 * check: the useful bare invocation is "tell me about everything", the way a
 * linter run from a subdirectory still lints the project. Naming a directory is
 * how a caller asks the narrower question.
 *
 * @param root - The discovered project root
 * @param pathArgs - The path arguments, possibly empty
 * @returns Root-relative directories; `['']` for the whole tree
 */
function scopeWithin(root: string, pathArgs: readonly string[]): string[] {
  if (pathArgs.length === 0) return [''];
  return pathArgs.map((pathArg) => targetPathWithin(root, pathArg, COMMAND_NAME));
}

/**
 * Say so, loudly, when a requested path named no working location.
 *
 * ⛔ `warn` (stderr), never `debug`. The human half of
 * {@link nothingCheckedFindings} — the same fact, on the channel a person reads,
 * ahead of the report rather than inside it.
 *
 * @param unmatched - The requested paths that matched nothing
 * @param logger - Where the warning goes
 */
function warnUnmatched(unmatched: readonly string[], logger: Logger): void {
  if (unmatched.length === 0) return;
  logger.warn(
    `Warning: no working location matched ${unmatched.join(', ')} — nothing was checked there.`
    + ' This is NOT a report that those paths are within budget.',
  );
}

/**
 * The refusal for a run whose requested paths named no working location.
 *
 * 🔑 **A gate that checked nothing must never answer `success`.** This shipped:
 * `vat claude budget no/such/dir` reported `status: success` on exit 0, because
 * an unmatched scope measures zero chains and zero findings serializes
 * identically to "everything you asked about is within budget". The command
 * already knew — it warned on stderr that nothing had been checked — and then
 * published a document saying the opposite. Only the document gates a build, so
 * the two channels disagreed on the half that matters.
 *
 * 🪤 {@link warnUnmatched} still says the same thing on stderr, and that is not
 * the duplication this file bans elsewhere: stderr is the human channel and
 * stdout is the parsed document, so the two are one statement per audience. What
 * was wrong was never that the warning existed — it was that the DOCUMENT
 * contradicted it, and the exit code was computed from the document.
 *
 * ⛔ Not repeated a THIRD time inside the text rendering, though. That shares a
 * channel with the finding, which {@link renderReportText} already prints.
 *
 * The precedent is `vat resources check`'s `emptyCorpusFinding`, and this
 * follows it through the shared {@link runIntegrityFinding} rather than
 * inventing a third convention — `RESOURCE_CHECK_BROKEN` at `error`, derived in
 * {@link buildReport} rather than assembled in the handler, so it bypasses
 * `applyAllowFilter` and `resolveIssueSeverity` by construction and no report
 * carrying an unmatched path can be built with a clean status. The reasoning
 * behind each of those lives with the mechanism, in `run-integrity.ts`.
 *
 * ⛔ ONE finding however many paths went unmatched. The claim is about the RUN,
 * and one per argument is the per-finding duplication this report is built to
 * make impossible. It is not routed through `nothingCheckedFinding` because the
 * denominator here is not a count but a list of names the message must carry.
 *
 * @param unmatched - The requested paths that matched no working location
 * @returns The finding, or nothing when everything asked about was checked
 */
function nothingCheckedFindings(unmatched: readonly string[]): readonly ValidationIssue[] {
  if (unmatched.length === 0) return [];

  const named = unmatched.map((path) => (path === '' ? CORPUS_ROOT_LABEL : path)).join(', ');
  return [runIntegrityFinding(
    `No working location matched ${named}, so nothing was checked there and this`
    + ' report is NOT a statement that those paths are within budget.'
    + ' A working location is any non-ignored directory holding an enumerated file,'
    + ' so a path matching none is usually a typo, a directory that is empty, or one'
    + ' `.gitignore` declines — and the whole corpus root matching none means the'
    + ' enumeration came back empty, which a broad ignore pattern or a shallow or'
    + ' sparse checkout produces.'
    + ' `vat resources scan` over the same path lists what an enumeration finds.',
  )];
}

/**
 * Populate the Claude-context lane for one tree and sweep every location.
 *
 * ⚠️ Roots at the discovered project root and NOWHERE else, whatever paths were
 * named. A budget is a property of a position in the directory tree, and rooting
 * a population at a subdirectory would compute one against a corpus whose
 * ancestors are missing — a confidently wrong number.
 *
 * @param root - The absolute corpus root; the ONLY tree populated
 * @param threshold - The always-loaded token budget
 * @param logger - Where blob-stage refusals go. **stderr**, never stdout: this
 *   command's stdout is the document a caller parses
 * @returns Every working location's budget
 */
async function sweepBudgets(
  root: string,
  threshold: number,
  logger: Logger,
): Promise<BudgetSweep> {
  const projection = await withPopulationCache({ root }, async (cache) => {
    const gitTracker = await gitTrackerForProjectRoot(root);
    return buildClaudeContextPopulation({ root, ...populationWiring(logger, gitTracker, cache, root) });
  });
  return sweepAlwaysLoadedBudgets(projection, threshold);
}

/**
 * Write the report in the requested format.
 *
 * @param report - The report
 * @param format - The selected format
 */
function emit(report: BudgetReport, format: BudgetOutputFormat): void {
  if (format === 'json') {
    writeJsonOutput(report);
    return;
  }
  if (format === 'yaml') {
    writeYamlOutput(report);
    return;
  }
  writeStdoutSync(renderReportText(report));
}

/**
 * Render the report for a person.
 *
 * ⛔ Exported so the "stated once" property can be pinned in TEXT as well as in
 * json. The two renderings are separate code paths and this lane has already
 * shipped a defect where they disagreed while each looked right alone.
 *
 * @param report - The report
 * @returns The text rendering, newline-terminated
 */
export function renderReportText(report: BudgetReport): string {
  const lines = [
    `Always-loaded context budget at ${report.root}`,
    `  budget ${count(report.threshold)} tokens`
    + ` · ${count(report.workingLocations)} working locations`
    + ` · ${count(report.distinctChains)} distinct chains`
    + ` · ${count(report.skippedUnknownLocations)} unrealized`,
    '',
    ...findingLines(report.findings),
    ...limitLines(report),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * The stated bounds, printed once at the foot of the report.
 *
 * ⛔ Never omitted, and never per finding. A clean report is subject to exactly
 * the same signed bounds as a flagged one — more so, since "within budget" is the
 * verdict a reader is most likely to act on without reading further.
 *
 * The sibling `vat claude context` prints a section of the same shape from its
 * own list. They are deliberately NOT sharing a renderer: two commands, two
 * report types, and the query additionally prints the modelled-behaviour
 * citations that no bound of this verdict rests on.
 *
 * @param report - The report carrying the bounds
 * @returns The section's lines
 */
function limitLines(report: BudgetReport): string[] {
  const lines = ['What this verdict does not settle', ...wrapped(report.boundsStatement, '  '), ''];
  for (const limit of report.limits) {
    lines.push(`  ${limit.direction}: ${limit.id}`);
    lines.push(...wrapped(limit.statement, '    '));
  }
  return lines;
}

/**
 * Soft-wrap a statement under a fixed indent.
 *
 * The statements run to several sentences and are the part of this output a
 * reader has to actually read; unwrapped they arrive as one 500-column line that
 * a terminal breaks mid-word. A word longer than the width overflows its own line
 * rather than being split — no character of a statement is ever dropped.
 *
 * @param text - The statement
 * @param indent - Leading whitespace for every produced line
 * @returns One or more indented lines
 */
function wrapped(text: string, indent: string): string[] {
  const width = Math.max(WRAP_COLUMNS - indent.length, 24);
  const lines: string[] = [];
  let pending = '';
  for (const word of text.split(' ')) {
    const candidate = pending === '' ? word : `${pending} ${word}`;
    if (pending !== '' && candidate.length > width) {
      lines.push(indent + pending);
      pending = word;
    } else {
      pending = candidate;
    }
  }
  if (pending !== '') lines.push(indent + pending);
  return lines;
}

/**
 * The findings, or the sentence that says there were none.
 *
 * ⛔ The empty case is a SENTENCE, not blank output. A command that prints
 * nothing is indistinguishable from one that failed to run.
 *
 * @param findings - The reported findings
 * @returns The lines, blank-terminated
 */
function findingLines(findings: readonly ValidationIssue[]): string[] {
  if (findings.length === 0) return ['Every instruction chain checked is within budget.', ''];
  const lines: string[] = [];
  for (const finding of findings) {
    lines.push(`${finding.severity} ${finding.code} at ${finding.location ?? CORPUS_ROOT_LABEL}`);
    lines.push(`  ${finding.message}`);
    if (finding.fix !== undefined) lines.push(`  Fix: ${finding.fix}`);
    lines.push('');
  }
  return lines;
}

/**
 * A count as a reader reads it.
 *
 * Pinned to `en-US` rather than left to the host locale, so the same run renders
 * byte-identically on two developers' machines — the same rule the findings
 * themselves follow in `utils/context-budget-issues.ts`.
 *
 * @param value - The number
 * @returns Its thousands-separated form
 */
function count(value: number): string {
  return value.toLocaleString('en-US');
}
