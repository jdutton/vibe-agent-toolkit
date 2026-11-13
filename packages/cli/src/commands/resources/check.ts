/**
 * `vat resources check` — run the project's own assertions over its resource
 * projection, as a gate.
 *
 * The invariants this file implements are written down once, in
 * `docs/architecture/cli.md` under "`vat resources check [path]`". Read that
 * before changing anything here; the headlines, so a reader knows when to:
 *
 * - 🔑 **Four ways to check nothing are all refusals**, at error severity under
 *   the non-overridable `RESOURCE_CHECK_BROKEN`: a statement that will not run
 *   (the `catch` in `timed`, reported by `runUnit`), a corpus that enumerated empty
 *   ({@link emptyCorpusFinding}), a `--check` name nothing declares
 *   (`requireKnownCheck`), and not one check executed at all
 *   ({@link noCheckRanFinding}, derived in {@link buildCheckOutputData} so an
 *   emptied `BUILTIN_CHECKS` cannot publish a clean document).
 * - ⚠️ That last one does NOT make the step always able to fail: the only
 *   built-in ships at `info`. Do not invent a second refusal for it — that
 *   would refuse the no-config run the default set exists to serve.
 * - 🔑 **A fifth, per CHECK:** a declared `examined` that counts zero
 *   ({@link examinedNothingFinding}); only the check's `allowEmpty: true` exempts it.
 * - 🔑 **No built-in check may be SQL.** {@link checkCommand} reads
 *   `config?.resources?.checks` and nothing else for statements; built-ins are
 *   TypeScript predicates over the row model, and a built-in's `sqlTwin` is
 *   documentation an adopter copies, never executed here.
 * - 🔑 **The default set belongs to the pipeline, not the config file.**
 *   `BUILTIN_CHECKS` reaches {@link runProjectChecks} as a REQUIRED `builtins`
 *   argument via {@link runOutcome}; nothing on that path reads `config`.
 * - 🚨 **Adopter SQL runs unsandboxed on purpose, and contributed SQL is not
 *   adopter SQL** — a contributed statement ships as a reviewed example.
 * - ⛔ A TypeScript/SQL twin is documentation and a differential oracle, never
 *   a runtime optimizer to schedule between.
 */

import { performance } from 'node:perf_hooks';

import {
  bindBuiltinChecks,
  BUILTIN_CHECK_NAMES,
  checkStatements,
  describeUninterpretableExamined,
  describeUninterpretableRows,
  examinedCount,
  issuesFromCheckRows,
  nearMissesOf,
  notAdmittedFindings,
  notAdmittedRealizations,
  uninterpretableRowsReason,
  type BoundBuiltinCheck,
  type CheckIssue,
  type CheckRowConversion,
  type ExaminedShapeReason,
  type NearMiss,
  type ResourceCheck,
} from '@vibe-agent-toolkit/resources';
import {
  buildErrorReport,
  buildReport,
  createRegistryIssue,
  CUSTOM_CHECK_CODE_PREFIX,
  isCustomCheckCode,
  type RefusalCode,
  resolveFindings,
  toFindings,
  type ValidationConfig,
  type ValidationIssue,
} from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';

import { CommandRefusalError, refusalCodeOf } from '../../utils/command-refusal.js';
import { loadConfigCached } from '../../utils/config-loader.js';
import {
  announceErrorOf,
  endWithForwardedDocument,
  endWithRefusal,
  endWithReport,
  leaveFindingsToSupervisor,
  NOTHING_FINISHED,
} from '../../utils/document-writer.js';
import { formatDurationSecs } from '../../utils/duration.js';
import { reportFindings } from '../../utils/issue-rendering.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { EVERY_NOTICE, type NoticeAudience, withNoticeAudience } from '../../utils/operator-notices.js';
import { assertDirectoryArgument, projectRootOrLoudCwd, projectRootOrNull } from '../../utils/project-root-policy.js';
import {
  RelationRefusedError,
  withQueriedProjection,
  type AskProjection,
  type ColumnsOfStatement,
  type PopulationExtent,
  type ProjectionProvenance,
} from '../../utils/projection-query.js';
import { relationBoundsFor } from '../../utils/relation-limits.js';
import { RUN_INTEGRITY_CODE, runIntegrityFinding } from '../../utils/run-integrity.js';
import type { PhaseOutcome } from '../phase-utils.js';

import {
  createProgressWriter,
  endWhenSupervisorGone,
  letSupervisorLossSurface,
  parseProgressLog,
  populationEntry,
  unitInFlight,
  type ProgressEntry,
  type UnitInFlight,
} from './check-progress.js';
import type { CheckData, CheckReport } from './check-schema.js';
import {
  DEFAULT_BUDGET_SECONDS,
  interruptionMessage,
  parseBudgetSeconds,
  requireSupervisableFlags,
  runsInThisProcess,
  SUPERVISED_BY_FLAG,
  superviseRun,
  supervisedByValue,
  withLeftover,
  withProgressLog,
  type CheckInvocation,
  type RunEnding,
  type SupervisedChild,
  type SupervisedEnding,
  type SupervisedVerb,
} from './check-supervisor.js';

/** The verb this module runs, as the supervisor keys it. */
const CHECK_VERB = 'resources check' satisfies SupervisedVerb;

/**
 * Where a supervised run announces what it is doing, one unit at a time.
 *
 * A plain callback rather than the writer itself, so the loop knows nothing
 * about files: the unit suite hands it an array, the supervised child hands it
 * {@link createProgressWriter}'s append, and `--budget 0` hands it nothing.
 */
export type ProgressSink = (entry: ProgressEntry) => void;

interface CheckOptions {
  debug?: boolean;
  /** Report warning and info findings on stderr too, not only the errors. */
  verbose?: boolean;
  /** Run only this check, by its config key. */
  check?: string;
  /** `yaml` (default) or `json`. Same document either way. */
  format?: string;
  /** `--base <ref>`: what `changed_files` compares this tree with. */
  base?: string;
  /**
   * How long the run may go WITHOUT completing a unit of work, in seconds.
   * `0` removes the bound and keeps everything in this process.
   */
  budget?: string;
  /**
   * Hidden: `--supervised-by <invoker>:<supervisor pid>:<progress log>`. By its mere presence, the
   * instruction to do the work here rather than supervise a child that does; its value says who
   * started the supervision (which decides the notices this child owes — see
   * {@link noticeAudienceOf}) and where to append progress. Set by {@link childArgs} and by nothing
   * else. Passed by hand it is REFUSED (`USAGE_INVALID`): the supervisor it names is not this
   * process's parent, and a run nothing watches would be unbounded and print none of its notices —
   * see `requireSupervisableFlags`.
   */
  supervisedBy?: string;
}

/**
 * What one declared check cost, and what it found.
 *
 * 🚨 **The population is charged to NOBODY, and that is deliberate.**
 * {@link durationMs} is the STATEMENT alone; the shared setup is published as
 * `populationSecs`. Why, and the pooled-arm defect this avoids:
 * `docs/architecture/cli.md`, "The population is charged to NOBODY".
 */
export interface CheckCost {
  /** The check's key in `resources.checks`, or a built-in's name. */
  readonly name: string;
  /** Wall time of this check's selection, and of nothing it shares with others. */
  readonly durationMs: number;
  /** Rows the selection returned. Present exactly when the statement completed. */
  readonly rows?: number;
  /** Could not report. Without `rows`: the statement threw; with: `examined` or conversion failed. */
  readonly broken?: true;
  /**
   * Set when VAT supplied this check rather than the project. 🔑 Without it a
   * reader whose config declares nothing finds a rule they never wrote in
   * `checks[]` with no way to tell a default from a stale declaration — or, when
   * a project declares a check of the same name, to tell the two entries apart.
   */
  readonly builtin?: true;
  /** The count the declared `examined` statement returned; absent (never 0) unless it completed. */
  readonly examined?: number;
  /** Set when the check declares that an `examined` count of 0 is legitimate. */
  readonly allowEmpty?: true;
  /** Selected columns that nearly name a reserved one ({@link nearMissesOf}), as spelled; absent when none. */
  readonly nearMisses?: string[];
}

/** What one run of the checks produced. */
interface CheckOutcome extends ProjectionProvenance, PopulationExtent {
  issues: readonly CheckIssue[];
  /**
   * One record per check that actually ran — the denominator every count below
   * is read against, and what each of them cost.
   *
   * 🔑 A LIST rather than a count beside a list: `checksRun` is derived from
   * `costs.length`, because two numbers that must agree are a drift bug.
   */
  costs: readonly CheckCost[];
}

/** What a completed population reported: where it came from, what it cost, what it covered. */
export type PopulatedRun = ProjectionProvenance & PopulationExtent;

export interface CheckPayloadInput {
  root: string;
  durationMs: number;
  issues: readonly CheckIssue[];
  /** One record per check that EXECUTED — see {@link CheckOutcome.costs}. */
  costs: readonly CheckCost[];
  /**
   * The population, or `null` when the run was interrupted before it completed.
   *
   * 🔑 Required, and ONE field rather than five nullable ones. A run either has
   * a projection or it does not, so the population's origin, costs, lenses and
   * extent are null together or present together — five independently nullable
   * fields would make half a population representable. `null` is what an
   * interrupted run publishes when its child never wrote the population line:
   * every value here would otherwise have to be invented, and
   * `membersEnumerated: 0` or `lensesEvaluated: []` already MEAN something else.
   */
  populated: PopulatedRun | null;
}

/**
 * The refusal for a run in which NO check executed.
 *
 * 🚨 **The defect this closes shipped, and it is the shape by which a gate gets
 * silently deleted.** A project with a valid `vibe-agent-toolkit.config.yaml`
 * and no `checks:` block produced `status: success`, `checksRun: 0`, exit 0 — a
 * passing gate document. Delete the `checks:` block and the CI step keeps going
 * green forever; the only thing that said otherwise was a stderr warning nothing
 * parses. **A gate that checked nothing is indistinguishable from a gate that
 * was removed, and the whole argument for having these gates is that you never
 * let those two look alike.**
 *
 * It is the third instance of the shape in this release — `vat claude budget`
 * answered `success` on a path that matched no working location, and the repo's
 * audit quality gate had a green path over zero parsed findings — so it is
 * closed the way those were rather than a third way: a non-overridable
 * `RUN_INTEGRITY_CODE` at `error`, derived in the report builder.
 *
 * 🔑 **Derived in {@link buildCheckOutputData}, not asserted by the handler.**
 * That placement is the guarantee. The builder is where `checksRun` is computed
 * and every lane's document goes through it — the completed run, the recovered
 * document of an interrupted one, the child a supervisor forwards — so "the
 * denominator is zero and the status is clean" is unrepresentable by
 * construction, and a fourth lane added later inherits the refusal instead of
 * having to remember it. It also lands after `resolveFindings`, which is
 * belt and braces: the code is already unreachable from a `severity` key.
 *
 * The writer refuses a run that examined no RESOURCE; this is the other
 * denominator, CHECKS, which only this verb knows — so it asks that count,
 * never the config, and stands down behind an existing run-integrity finding
 * (one report per situation). The stand-down matters here for an interrupted run, which recovers zero costs when
 * the kill landed before the first statement finished and already carries
 * {@link interruptedRunFinding}, the more specific of the two claims. A `--check`
 * filter that matched nothing is refused earlier by {@link requireKnownCheck},
 * and must stay refused even if that guard is ever widened.
 *
 * 🔑 **An absent `checks:` block does not empty the denominator** — the built-in
 * set is in the pipeline, so reaching zero here means not even a default ran and
 * the remedy is not "declare some checks". The guard stays because it is the
 * mechanism-level guarantee that `checksRun: 0` can never be published clean,
 * whatever empties it.
 *
 * @param costs - One record per check that EXECUTED; its length is `checksRun`
 * @param issues - What the run already found, so an existing run-integrity
 *   report is not duplicated
 * @returns The finding, or nothing when at least one check ran
 */
function noCheckRanFinding(
  costs: readonly CheckCost[],
  issues: readonly ValidationIssue[],
): readonly ValidationIssue[] {
  if (costs.length > 0 || issues.some((issue) => issue.code === RUN_INTEGRITY_CODE)) return [];
  return [runIntegrityFinding(
    'No check ran at all, so this document is not a verdict: a gate that checked nothing'
    + ' produces the same report as a gate that was removed, and this run cannot tell'
    + ' you which happened.'
    + ' This is not an absent `resources.checks` block — VAT\'s own built-in checks run'
    + ' whether or not a project declares any, so reaching zero means not even those'
    + ' executed. Re-run with --debug and report it; if the run was filtered, check that'
    + ' --check named a rule this build still ships.')];
}

/**
 * Build the check report.
 *
 * Pure: no file system, no clock, no `process.exit` — the same contract every
 * other payload builder here follows, so the document's shape stays under unit
 * test rather than only under a CLI spawn.
 *
 * `checksRun` is published beside the counts and is not decoration: zero
 * findings from four checks and zero findings from **no** checks are the same
 * document without it, and they mean opposite things. A project whose config key
 * is misspelled would otherwise read as passing. It is DERIVED from the `checks`
 * list rather than carried alongside it, so the denominator and the entries that
 * account for it cannot disagree.
 *
 * 🚨 `populationSecs` and the per-check `durationSecs` do not overlap and do not
 * sum to `durationMs`. The population is paid once and shared by every check;
 * see {@link CheckCost} for why it is charged to none of them.
 *
 * 🔑 A denominator of zero is refused HERE rather than published — see
 * {@link noCheckRanFinding}. This is the one function every lane's document
 * passes through, so deriving the refusal in it is what makes "checked nothing,
 * status clean" unrepresentable rather than merely unwritten.
 *
 * 🔑 **A run with no population is `status: error`, and that is decided HERE.**
 * Nothing was examined, so it is not a gate that failed (exit 1) but a command
 * that could not do its job (exit 2) — the exit code follows from the document
 * through `exitCodeForReport`, so no caller can publish one and exit the other.
 * The document is still published, with the population fields `null`, and the
 * reason moves from `findings` to `error` as the envelope's error branch requires.
 *
 * 🪤 The findings are NOT run through `relativizePathEntries`. Every other
 * payload builder re-bases here because its producer keeps absolute paths
 * internally; these arrive project-relative instead, and re-basing an
 * already-relative path would resolve it against the wrong base and silently
 * corrupt it. The guarantee is `locationOf` in `sql-checks.ts` — the one place
 * a projection column becomes a finding's `location`, and which refuses an
 * absolute or backslashed value there. Nothing on this path parses findings
 * through the schema at runtime, and do not "fix" that by parsing at this
 * boundary: it would convert a slip in `locationOf` from "this finding loses
 * its anchor" into "the whole run throws", which is strictly worse for a gate.
 *
 * @param input - The findings and the provenance of the run behind them
 * @returns The document to serialize
 */
export function buildCheckOutputData(input: CheckPayloadInput): CheckReport {
  const issues = [...noCheckRanFinding(input.costs, input.issues), ...input.issues];
  const { populated } = input;
  const report = buildReport<CheckData>({
    // `vat resources check` offers no `--strict`: warnings never fail it.
    gate: { strict: false },
    // The OTHER denominator, and the one whose absence shipped a green gate over
    // an empty repository. `checksRun` counts rules; this counts what they ran
    // against. 🔑 0 for a run with no population is not a placeholder: nothing
    // WAS examined, and the interrupted run's own finding says why.
    examined: populated === null ? 0 : populated.membersEnumerated,
    findings: toFindings(issues),
    durationMs: input.durationMs,
    data: {
      root: input.root,
      ...populationData(populated),
      // The denominator of rules. Derived from `checks`, never carried beside it.
      checksRun: input.costs.length,
      // What each rule cost, directly under the denominator it is a breakdown
      // of. A SQL surface is an unbounded cost — a project can declare a
      // statement that scans every row of every table — and a single total
      // attributes nothing: ten seconds is one expensive rule, a slow
      // population, or forty cheap rules, and only this list tells them apart.
      //
      // 🪤 `rows` and `broken` are spread conditionally rather than defaulted.
      // `rows: 0` on a statement that never returned would read as a clean pass,
      // which is the exact confusion `RESOURCE_CHECK_BROKEN` exists to prevent —
      // so a check that threw publishes no row count at all.
      checks: input.costs.map((cost) => ({
        name: cost.name,
        // Three significant figures, so a 0.4 ms rule serializes as 0.0004 rather
        // than rounding to a zero that reads as "not measured".
        durationSecs: formatDurationSecs(cost.durationMs),
        ...(cost.rows === undefined ? {} : { rows: cost.rows }),
        ...(cost.broken === undefined ? {} : { broken: cost.broken }),
        // Absent, never `false`, on a declared rule — so the key's presence is
        // the whole claim and a reader never has to tell `false` from unset.
        ...(cost.builtin === undefined ? {} : { builtin: cost.builtin }),
        ...(cost.examined === undefined ? {} : { examined: cost.examined }),
        ...(cost.allowEmpty === undefined ? {} : { allowEmpty: cost.allowEmpty }),
        ...(cost.nearMisses === undefined ? {} : { nearMisses: cost.nearMisses }),
        // The predicate that emits the refusal, so entry and finding cannot disagree.
        ...(examinedNothing(cost) ? { examinedNothing: true as const } : {}),
      })),
    },
  });
  return populated === null ? couldNotRun(report) : report;
}

/**
 * The error branch of the envelope, for a run that never had a population.
 *
 * `status: error`, and the reason in `error` under the registered refusal `RUN_INCOMPLETE` — the
 * run started and stopped before its population completed — and `data` is KEPT: it names the root
 * and says, with `null`, that there was no projection, which is more than `data: null` could. No
 * `durationMs`: no refusal document carries one.
 *
 * 🔑 Only the run-integrity sentences become the message. Any other finding — a file the population
 * did not admit, recorded on its own line just before the population's — stays a finding: it is a
 * fact about the tree that finished before the run stopped, and folding it into the refusal's prose
 * would lose its code and its location.
 *
 * @param report - The document as the findings would have built it
 * @returns The same document on the error branch
 */
function couldNotRun(report: CheckReport): CheckReport {
  const isIntegrity = (finding: CheckReport['findings'][number]): boolean => finding.code === RUN_INTEGRITY_CODE;
  // The one construction of the error branch — the same `buildErrorReport`
  // every refusal the writer publishes goes through.
  return buildErrorReport({
    error: { code: 'RUN_INCOMPLETE', message: report.findings.filter(isIntegrity).map((finding) => finding.message).join('\n') },
    gate: report.gate,
    examined: report.examined,
    findings: report.findings.filter((finding) => !isIntegrity(finding)),
    data: report.data,
  });
}

/**
 * The document's population fields — all present, or all `null`.
 *
 * @param populated - What the population reported, or null when it never completed
 * @returns The fields to spread into `data`
 */
function populationData(populated: PopulatedRun | null): Pick<
  CheckData,
  'population' | 'populationSecs' | 'lensSecs' | 'lensesEvaluated' | 'lensPopulation' | 'boundsStatement' | 'limits'
> {
  if (populated === null) {
    return { population: null, populationSecs: null, lensSecs: null, lensesEvaluated: null, lensPopulation: null };
  }
  return {
    population: populated.population,
    // Beside the origin, because a `population: store` a reader cannot price is
    // a label taken on faith. Charged to no check — see {@link CheckCost}.
    populationSecs: formatDurationSecs(populated.populationMs),
    // Published here too, and not only by `query`, because this verb pays it
    // identically — the lens is evaluated before the first statement runs. A
    // document that priced the population but not the lens would attribute the
    // lens's cost to whichever rule the reader happened to be looking at, which
    // is the same defect `populationSecs` exists to prevent.
    lensSecs: formatDurationSecs(populated.lensMs),
    // What that number covers — see `CheckDataSchema.lensesEvaluated`. Copied
    // into a plain array so the published document owns no reference into the
    // run's own state.
    lensesEvaluated: [...populated.lensesEvaluated],
    // Where those lenses' own populations came from — see `CheckDataSchema.lensPopulation`.
    lensPopulation: populated.lensPopulation,
    // The bounds of the rows those lenses produced, stated ONCE and only when
    // a bounded lens ran. This is the verb an adopter makes GATE, so it is the
    // one that most owes them — `utils/relation-limits.ts` carries why.
    // Copied out of the readonly registry lists: the published document owns
    // no reference into module state a later render could mutate.
    ...relationBoundsFor(populated.lensesEvaluated),
  };
}

/**
 * A value and what producing it cost, or the throw and what reaching it cost.
 *
 * Both arms carry the duration: a statement that failed still spent time, and
 * the caller owes exactly one cost record per check on either path.
 */
type Timed<T> =
  | { readonly ok: true; readonly value: T; readonly durationMs: number }
  | { readonly ok: false; readonly error: unknown; readonly durationMs: number };

/**
 * Run a thunk between two readings of the clock, and report both.
 *
 * ## 🚨 Why this is a helper and not a stopwatch inline in the loop
 *
 * An inline `startedAt` / subtract pair has no guard: moving the subtraction
 * below the row-to-finding mapping widens the span and keeps every unit test
 * green.
 *
 * No cleverer fake clock closes it. The injected clock advances per READING, so
 * every mutation that keeps two readings per check yields the same number; a
 * clock that advanced only inside `ask` could not tell the two positions apart
 * either, because the real mapping never touches the clock — and making the
 * mapping slow in real time would buy a flake, not a guard.
 *
 * So the span is a THUNK. What is timed is what is passed in, and widening it
 * stops being a one-line move of a subtraction and becomes a visible rewrite of
 * the call site.
 *
 * 🪤 The throw is CAUGHT rather than propagated, so the failing path has a
 * duration too. Keep it that way: a `try` in the caller around a helper that
 * only times the happy path re-opens the two-read stopwatch this closes.
 *
 * @param now - The clock, in milliseconds
 * @param run - The work whose duration is wanted, and nothing else
 * @returns What `run` produced or threw, and how long that took
 */
function timed<T>(now: () => number, run: () => T): Timed<T> {
  const startedAt = now();
  try {
    return { ok: true, value: run(), durationMs: now() - startedAt };
  } catch (error) {
    return { ok: false, error, durationMs: now() - startedAt };
  }
}

/**
 * The finding for a statement that would not run.
 *
 * 🔑 A finding, not a skip, at `error`, and under its OWN code.
 *
 * The check's declared severity describes how bad a VIOLATION is; it says
 * nothing about how bad it is that the check cannot run, and a `warning` check
 * whose SQL broke would otherwise fail nothing while asserting nothing. That
 * much was always true of the DECLARATION.
 *
 * 🪤 It was never true of an adopter OVERRIDE: `RESOURCE_CHECK_BROKEN` is a
 * non-overridable code so `severity: { 'CUSTOM:foo': 'ignore' }` cannot also
 * silence "foo could not run".
 *
 * 🪤 Only `ask` reaches this. Turning the selected rows INTO findings is not a
 * statement failure, and reporting it as one told the operator a working rule
 * was broken — see the append in {@link runUnits}.
 *
 * @param name - The check's key in `resources.checks`
 * @param error - Whatever the statement threw
 * @returns The run-integrity finding
 */
function brokenCheckFinding(name: string, error: unknown): CheckIssue {
  return withRelationRefusal(ofCheck(name, runIntegrityFinding(
    `The check "${name}" could not run, so it is asserting nothing: `
    + (error instanceof Error ? error.message : String(error)),
  )), error);
}

/**
 * A broken finding whose statement read a derived relation the run could not evaluate, carrying
 * that relation's refusal code as `reason.refusal` — what `vat resources query` exits with for the
 * same statement — so the fault is machine-readable here too, and not only in the message.
 */
function withRelationRefusal(issue: CheckIssue, error: unknown): CheckIssue {
  return error instanceof RelationRefusedError ? { ...issue, reason: { refusal: error.refusal } } : issue;
}

/** A finding about one check, naming it. A finding about the whole RUN carries no `check`. */
function ofCheck(name: string, issue: ValidationIssue): CheckIssue {
  return { ...issue, check: name };
}

/** A check whose rows could not be read: `RESOURCE_CHECK_BROKEN`, as {@link brokenCheckFinding}. */
function uninterpretableRowsFinding(name: string, refusal: Extract<CheckRowConversion, { ok: false }>): CheckIssue {
  return { ...ofCheck(name, runIntegrityFinding(describeUninterpretableRows(name, refusal))), reason: uninterpretableRowsReason(refusal) };
}

/** A check whose `examined` statement would not run: `RESOURCE_CHECK_BROKEN`, worded apart. */
function brokenExaminedFinding(name: string, error: unknown): CheckIssue {
  return withRelationRefusal(ofCheck(name, runIntegrityFinding(
    `The check "${name}" ran its violations statement, but its examined statement could not run, so`
    + ' nothing says what it ranged over and none of its rows were reported: '
    + (error instanceof Error ? error.message : String(error)),
  )), error);
}

/** A check whose `examined` statement returned something other than one count: `RESOURCE_CHECK_BROKEN`. */
function uninterpretableExaminedFinding(name: string, reason: ExaminedShapeReason): CheckIssue {
  return { ...ofCheck(name, runIntegrityFinding(describeUninterpretableExamined(name, reason))), reason };
}

/** The refusal a check's `examined` statement earns — it threw, or returned no count — if any. */
function examinedRefusal(name: string, examined: Timed<ExaminedCount> | undefined): CheckIssue | undefined {
  if (examined === undefined) return undefined;
  if (!examined.ok) return brokenExaminedFinding(name, examined.error);
  return examined.value.ok ? undefined : uninterpretableExaminedFinding(name, examined.value.reason);
}

/** The code for a check that declared what it examined and counted zero. */
const EXAMINED_NOTHING_CODE = 'RESOURCE_CHECK_EXAMINED_NOTHING' satisfies RefusalCode;

/**
 * A check whose declared `examined` statement counted zero rows. Per check,
 * because the run-level count hides one empty check behind busy neighbours. A
 * REFUSAL, so only `allowEmpty: true` escapes it; the check's violations still report.
 */
function examinedNothingFinding(name: string): CheckIssue {
  return ofCheck(name, createRegistryIssue(
    EXAMINED_NOTHING_CODE,
    `The check "${name}" declares what it examined, and its examined statement counted 0, so`
      + ' its pass asserts nothing. Fix the `examined` statement or the population it reads; if zero is'
      + ' a legitimate answer for this check, declare `allowEmpty: true` on it.',
  ));
}

/**
 * Whether a cost record earns {@link examinedNothingFinding}. 🔑 The ONE decision:
 * the emitter, the interrupted-run rebuild and the published `examinedNothing`
 * flag all read it. A `broken` record never qualifies — its earlier refusal wins.
 */
function examinedNothing(cost: CheckCost): boolean {
  return cost.examined === 0 && cost.allowEmpty === undefined && cost.broken === undefined;
}

/** The one stderr line for a check that selects a near miss of a reserved column. */
function nearMissWarning(name: string, misses: readonly NearMiss[]): string {
  const pairs = misses.map(({ column, reserved }) => `"${column}" (reserved: "${reserved}")`).join(', ');
  return `The check "${name}" selects ${pairs}. Reserved columns are matched exactly, so these are`
    + ' evidence only; rename them if you meant the finding\'s own path, finding_severity, finding_line or'
    + ' finding_column.';
}

/**
 * What one check's selection produced: how many violations, and how to report
 * them.
 *
 * 🔑 **Two members because only the first half is TIMED.** A SQL check's cost is
 * `ask(sql)`, not the row-to-finding conversion that follows it — the conversion
 * is unbounded in the issue count, so charging it to the statement would make a
 * cheap rule that selected a lot of rows look slow.
 */
interface CheckSelection {
  /** How many violating rows the check selected. */
  readonly rows: number;
  /** Set for a statement: its rows convert after the timed span, announced as `converting`. */
  readonly converts: boolean;
  /** Turn them into findings. Deliberately OUTSIDE the timed span. */
  readonly report: () => CheckRowConversion;
}

/** What an `examined` statement's result read as: one count, or why not. */
type ExaminedCount = ReturnType<typeof examinedCount>;

/**
 * One runnable check — a name and the selection that IS its cost.
 *
 * 🔑 **The seam that lets a built-in and a declared statement share one loop**,
 * so a built-in cannot quietly miss the `--check` filter, the progress log, the
 * cost list or the broken-check refusal. Only the selection differs.
 */
interface CheckUnit {
  readonly name: string;
  /** Set for a rule VAT supplied — carried onto the cost record. */
  readonly builtin?: true;
  /**
   * Select the violations. Timed by {@link timed}, and so is {@link examine}. A statement names
   * its near misses to `noteNearMisses` FIRST — from its result columns, before it runs — so a
   * check that then throws still carries them.
   */
  readonly select: (noteNearMisses: (misses: readonly NearMiss[]) => void) => CheckSelection;
  /** Run its declared `examined` statement and read its one count. Absent when it declares none. */
  readonly examine?: () => ExaminedCount;
  /** Set when an examined count of 0 is declared legitimate. Only alongside {@link examine}. */
  readonly allowEmpty?: true;
}

/**
 * One declared statement, as a unit.
 *
 * @param name - The check's key in `resources.checks`
 * @param check - Its declaration
 * @param query - Runs one statement against the populated projection, and names a statement's columns
 * @returns The runnable unit
 */
function sqlCheckUnit(name: string, check: ResourceCheck, query: CheckQuery): CheckUnit {
  const { examined } = check;
  const { ask } = query;
  return {
    name,
    select: (noteNearMisses) => {
      // 🔑 Columns BEFORE rows: a statement that compiles but throws as it steps has still
      // misspelled its column, and its broken cost record must say so.
      noteNearMisses(nearMissesOf(query.columnsOf(check.sql)));
      const rows = ask(check.sql);
      return { rows: rows.length, converts: true, report: () => issuesFromCheckRows(name, check, rows) };
    },
    // 🪤 Only the count leaves: the statement's result is never a finding or evidence.
    ...(examined === undefined ? {} : { examine: () => examinedCount(ask(examined)) }),
    ...(check.allowEmpty === undefined ? {} : { allowEmpty: check.allowEmpty }),
  };
}

/**
 * One built-in predicate, as a unit.
 *
 * 🪤 Its `rows` is the finding count, and that is the same quantity a statement
 * reports: one finding per violating row. There is no conversion step to leave
 * outside the clock, so the whole predicate is timed.
 *
 * @param builtin - The built-in, already bound to this run's projection
 * @returns The runnable unit
 */
function builtinCheckUnit(builtin: BoundBuiltinCheck): CheckUnit {
  return {
    name: builtin.name,
    builtin: true,
    select: () => {
      const found = builtin.run();
      return {
        rows: found.length,
        converts: false,
        report: () => ({ ok: true, issues: found.map((issue) => ofCheck(builtin.name, issue)) }),
      };
    },
  };
}

/**
 * Every check this run will attempt, in the order it will attempt them.
 *
 * 🔑 **Built-ins FIRST, and never interleaved with the declared ones**, so the
 * document's `checks[]` opens with the same rules in the same order for every
 * project and a reader comparing two runs compares like with like.
 *
 * A declared check never shares a built-in's name: the config refuses it, so every finding,
 * progress line and cost record is keyed on one check.
 *
 * @param builtins - The default set, bound to this run's projection
 * @param checks - The project's `resources.checks`
 * @param query - Runs one statement against the populated projection, and names its columns
 * @returns The units, built-ins first
 */
function checkUnits(
  builtins: readonly BoundBuiltinCheck[],
  checks: Readonly<Record<string, ResourceCheck>>,
  query: CheckQuery,
): CheckUnit[] {
  return [
    ...builtins.map((builtin) => builtinCheckUnit(builtin)),
    ...Object.entries(checks).map(([name, check]) => sqlCheckUnit(name, check, query)),
  ];
}

/** How a declared check reaches the projection: its rows, and its result columns without its rows. */
interface CheckQuery {
  readonly ask: AskProjection;
  readonly columnsOf: ColumnsOfStatement;
}

/** A completed check's progress line. */
type CheckLine = Extract<ProgressEntry, { kind: 'check' }>;

/** What a `converting` line carries: the cost record so far, without its kind. */
type ConvertingLine = Omit<Extract<ProgressEntry, { kind: 'converting' }>, 'kind'>;

/** Convert a selection. 🔑 `converting` is announced first, so a kill there names the conversion. */
function convertSelection(
  selection: CheckSelection,
  line: ConvertingLine,
  sinks: { onProgress: ProgressSink | undefined; warn: (message: string) => void },
): CheckRowConversion {
  if (selection.converts) sinks.onProgress?.({ kind: 'converting', ...line });
  return selection.report();
}

/** A statement's near misses as every record after them carries them: absent, never `[]`, when none. */
function nearMissesField(misses: readonly NearMiss[]): { nearMisses?: string[] } {
  return misses.length === 0 ? {} : { nearMisses: misses.map(({ column }) => column) };
}

/** Where one unit reports what it is doing: the progress log, and a near miss's warning. */
interface UnitSinks {
  readonly onProgress: ProgressSink | undefined;
  readonly warn: (message: string) => void;
}

/** What one unit produced. The refusal is apart so the loop can put it FIRST without copying. */
interface UnitResult {
  readonly cost: CheckCost;
  readonly refusal?: CheckIssue;
  readonly issues: readonly CheckIssue[];
}

/** Run a unit's `examined` statement, timed. 🔑 Announced first, so a hang there names it. */
function examineUnit(
  name: string,
  examine: () => ExaminedCount,
  now: () => number,
  violations: { durationMs: number; rows: number; allowEmpty?: true; nearMisses?: string[] },
  onProgress: ProgressSink | undefined,
): Timed<ExaminedCount> {
  onProgress?.({ kind: 'examining', name, ...violations });
  return timed(now, examine);
}

/**
 * Run one unit — violations statement, examined statement, conversion — and price it.
 *
 * 🚨 Only `unit.select()` and `unit.examine()` are timed; the conversion never is.
 * 🔑 One refusal per check, earliest wins; only examined-nothing keeps the
 * check's findings, because every other arm means its rows cannot be trusted.
 */
function runUnit(unit: CheckUnit, now: () => number, sinks: UnitSinks): UnitResult {
  const { name, examine } = unit;
  // Spread onto every cost record and progress line this unit files, so they cannot disagree.
  const allowEmpty = unit.allowEmpty === undefined ? {} : { allowEmpty: unit.allowEmpty };
  const origin = { ...(unit.builtin === undefined ? {} : { builtin: unit.builtin }), ...allowEmpty };
  let misses: readonly NearMiss[] = [];
  const outcome = timed(now, () => unit.select((noted) => {
    misses = noted;
  }));
  // From the statement's columns, so on every record after them — broken or not, thrown or not, any row count.
  const nearMisses = nearMissesField(misses);
  if (misses.length > 0) sinks.warn(nearMissWarning(name, misses));
  if (!outcome.ok) {
    // Priced up to the throw, and with NO row count: a check that did not
    // complete selected nothing, and `rows: 0` would say it selected nothing
    // and passed. A built-in reaches this arm too — a defect in VAT's own
    // predicate must fail the gate rather than vanish.
    const cost = { name, durationMs: outcome.durationMs, broken: true as const, ...origin, ...nearMisses };
    return { cost, refusal: brokenCheckFinding(name, outcome.error), issues: [] };
  }

  const { rows } = outcome.value;
  const examined = examine === undefined
    ? undefined
    : examineUnit(name, examine, now, { durationMs: outcome.durationMs, rows, ...allowEmpty, ...nearMisses }, sinks.onProgress);
  const durationMs = outcome.durationMs + (examined?.durationMs ?? 0);
  const unexamined = examinedRefusal(name, examined);
  if (unexamined !== undefined) {
    // `rows` is real; `examined` is absent, never a refusable 0.
    const cost = { name, durationMs, rows, broken: true as const, ...origin, ...nearMisses };
    return { cost, refusal: unexamined, issues: [] };
  }

  const counted = examined?.ok === true && examined.value.ok ? { examined: examined.value.count } : {};
  const converted = convertSelection(outcome.value, { name, durationMs, rows, ...counted, ...allowEmpty, ...nearMisses }, sinks);
  if (!converted.ok) {
    const cost = { name, durationMs, rows, broken: true as const, ...counted, ...origin, ...nearMisses };
    return { cost, refusal: uninterpretableRowsFinding(name, converted), issues: [] };
  }
  const cost = { name, durationMs, rows, ...counted, ...origin, ...nearMisses };
  return {
    cost,
    ...(examinedNothing(cost) ? { refusal: examinedNothingFinding(name) } : {}),
    issues: converted.issues,
  };
}

/** A broken check's refusal as its `check` line carries it; examined-nothing is re-derived from the cost. */
function loggedRefusal(refusal: CheckIssue | undefined): { refusal?: NonNullable<CheckLine['refusal']> } {
  if (refusal?.code !== RUN_INTEGRITY_CODE) return {};
  return { refusal: { message: refusal.message, ...(refusal.reason === undefined ? {} : { reason: refusal.reason }) } };
}

/** The finding a logged broken check stands for — the one {@link loggedRefusal} wrote. */
function refusalFromLine(line: CheckLine): CheckIssue | undefined {
  if (line.refusal === undefined) return undefined;
  const { message, reason } = line.refusal;
  return { ...ofCheck(line.name, runIntegrityFinding(message)), ...(reason === undefined ? {} : { reason }) };
}

/**
 * Run every unit, collect its findings, and price it.
 *
 * 🚨 **Only the statements are timed** (see {@link runUnit}). 🚨 **And the loop
 * announces a check BEFORE it can be stopped**, because a runaway statement can only be
 * ended by an external `SIGKILL` that publishes nothing of the killed process's
 * memory. Both, with the clock-granularity and one-record-per-check rules they
 * rest on: `docs/architecture/cli.md`, "The population is charged to NOBODY" and
 * "Why the loop announces a check before it can be stopped".
 *
 * @param units - Every check this run will attempt, built-ins first
 * @param only - A single check name to run, or undefined for all of them
 * @param now - The clock, in milliseconds; injected so a test can assert an
 *   exact duration rather than a range that passes on a timer that never started
 * @param onProgress - Told what is about to run and what it cost, or undefined
 *   when nothing is watching (the in-process lane, and `--budget 0`)
 * @param warn - Where a near miss of a reserved column is said, once per check
 * @returns The findings, and one cost record per check that ran
 */
function runUnits(
  units: readonly CheckUnit[],
  only: string | undefined,
  now: () => number,
  onProgress: ProgressSink | undefined,
  warn: (message: string) => void,
): { issues: CheckIssue[]; costs: CheckCost[] } {
  const issues: CheckIssue[] = [];
  const costs: CheckCost[] = [];

  for (const unit of units) {
    if (only !== undefined && unit.name !== only) continue;
    // 🪤 BEFORE `timed`, and not one line later. `ask` is where a runaway
    // statement never returns from, so an announcement below it is filed by
    // every check except the one whose name the operator needs.
    onProgress?.({ kind: 'start', name: unit.name });
    const { cost, refusal, issues: found } = runUnit(unit, now, { onProgress, warn });
    costs.push(cost);
    onProgress?.({ kind: 'check', ...cost, ...loggedRefusal(refusal) });
    if (refusal !== undefined) issues.push(refusal);
    // 🪤 Appended one at a time, NEVER `issues.push(...findings)`. A spread
    // becomes an ARGUMENT LIST, which throws `RangeError: Maximum call stack
    // size exceeded` past roughly 125,000 elements on the main thread — and a
    // check's result set is unbounded by construction. VAT's own
    // `blob_references` table already holds 29,645 rows, so `SELECT * FROM
    // blob_references` over a repository a few times this size reached it, and
    // the throw landed in the broken-statement arm: a rule that ran perfectly
    // was reported as one that "could not run, so it is asserting nothing". A
    // loop does not put the argument limit in play at all.
    for (const issue of found) issues.push(issue);
  }

  return { issues, costs };
}

/**
 * Refuse a `--check` name that names neither a built-in nor a declared check.
 *
 * 🔑 **An unknown name is otherwise a silent green.** With nothing comparing the
 * flag against the known names, `--check nope` filters every check away, runs
 * none, and exits 0 with `checksRun: 0` and `issues: []` on empty stderr — and
 * the "no checks are declared" warning does not fire, because it asks whether
 * the `checks` MAP is empty, never whether the FILTER matched anything. Not a
 * hypothetical typo: rename or delete a check and the CI step keeps passing
 * forever while asserting nothing.
 *
 * Thrown rather than reported as a finding, because it is an OPERATOR error and
 * not a content violation — the two have different exit codes in this command's
 * contract (2 versus 1) and different audiences. Thrown before the projection is
 * populated, so a mistyped flag costs no crawl.
 *
 * 🔑 **A built-in is nameable here exactly like a declared one.** A guard that
 * only knew the config would refuse the very rules that run when there is no
 * config at all. The refusal names both sets.
 *
 * @param builtinNames - The default set's names — {@link BUILTIN_CHECK_NAMES} in
 *   production, and passed in rather than imported here so a test can prove the
 *   guard rather than restate the constant
 * @param checks - The project's `resources.checks`
 * @param only - The `--check` value, or undefined
 * @throws When `only` names no check this run would attempt
 */
export function requireKnownCheck(
  builtinNames: readonly string[],
  checks: Readonly<Record<string, ResourceCheck>>,
  only: string | undefined,
): void {
  // 🪤 `Object.hasOwn`, not `only in checks`. `in` walks the prototype chain, so
  // `--check toString` would have looked declared, matched nothing, and restored
  // the exact silent green this guard closes.
  if (only === undefined || builtinNames.includes(only) || Object.hasOwn(checks, only)) return;

  const declared = Object.keys(checks);
  throw new CommandRefusalError(
    'USAGE_INVALID',
    `No check named "${only}" exists. `
    + `Built in: ${builtinNames.join(', ')}. `
    + (declared.length === 0
      ? 'This project declares none of its own — add them under `resources.checks` in'
        + ' vibe-agent-toolkit.config.yaml.'
      : `Declared under \`resources.checks\`: ${declared.join(', ')}.`),
  );
}

/**
 * Name every `CUSTOM:` severity override that overrides nothing.
 *
 * 🔑 **The same silent-green shape as an unknown `--check` name, one surface
 * over.** {@link requireKnownCheck} refuses `--check nope` because a filter
 * that matched nothing ran nothing and exited 0. A `validation.severity` entry
 * keyed `CUSTOM:<name>` for a check that is not declared is the mirror image: it
 * parses (the schema validates the KEY's shape and cannot see
 * `resources.checks`), applies to no finding, and says nothing. An adopter
 * renames a check and leaves the override behind, or mistypes it while standing
 * down an inherited one — and in the second direction the check they meant to
 * silence keeps failing their build with no clue why.
 *
 * ⚠️ **A warning, not a refusal, and the asymmetry with `--check` is
 * deliberate.** `--check` is a flag typed for THIS run, so a mistake is an
 * operator error and exiting 2 costs nothing. A `severity` entry lives in a
 * committed config that may legitimately be shared across repositories or
 * outlive a check through a rename in flight; refusing it would be a new
 * breaking config error, which is exactly the change this release already
 * decided not to make twice (see `ResourcesConfigSchema`). Stderr, so the
 * document on stdout stays parseable — the same channel and the same reasoning
 * as the "no checks are declared" warning in {@link checkCommand}.
 *
 * 📌 The registry half of the key space needs no equivalent: a misspelled
 * REGISTRY code is already refused by `SeverityOverrideCodeSchema`, whose
 * `SEVERITY_KEY_PATTERN` alternates every registry code name with the `CUSTOM:`
 * namespace — so a key has to BE one of the shipped codes to match that half.
 * Only the open `CUSTOM:` half can name something that does not exist, because
 * only it matches on shape rather than on identity.
 *
 * @param checks - The project's `resources.checks`
 * @param validation - The project's `resources.validation`, or undefined
 * @param logger - Where the warning goes (stderr)
 */
export function warnUndeclaredOverrides(
  checks: Readonly<Record<string, ResourceCheck>>,
  validation: ValidationConfig | undefined,
  logger: Logger,
): void {
  const stale = Object.keys(validation?.severity ?? {})
    .filter((code) => isCustomCheckCode(code))
    // 🪤 `Object.hasOwn`, not `in` — same reason {@link requireKnownCheck}
    // uses it: `in` walks the prototype chain, so an override keyed
    // `CUSTOM:toString` would look declared and stay silent.
    .filter((code) => !Object.hasOwn(checks, code.slice(CUSTOM_CHECK_CODE_PREFIX.length)));
  if (stale.length === 0) return;

  const declared = Object.keys(checks);
  logger.warn(
    `resources.validation.severity names ${stale.length} check(s) this project does not declare,`
    + ` so ${stale.length === 1 ? 'it overrides' : 'they override'} nothing: ${stale.join(', ')}.`
    + (declared.length === 0
      ? ' No checks are declared at all.'
      : ` Declared under \`resources.checks\`: ${declared.join(', ')}.`)
    + ' Correct the spelling, or delete the entry — a severity override for a check that no longer'
    + ' exists is not silencing anything, and a MISTYPED one leaves the check you meant to stand'
    + ' down still failing the build.',
  );
}

/**
 * The finding for a run whose checks executed over an empty corpus.
 *
 * 🔑 **The defect this closes shipped.** A scratch repository with
 * `.gitignore = *` and two declared checks reported `checksRun: 2`,
 * `status: success`, exit 0 and empty stderr over a corpus of ZERO files. The
 * rules reported nothing because there was nothing to report on, and the
 * document could not say so: `checksRun` is the denominator of rules, not of
 * rows, so a gate over eight thousand files and a gate over none serialized
 * identically. A broad ignore pattern, a shallow or sparse CI checkout, a root
 * that resolved to the wrong directory, or an extent source that enumerated
 * nothing all produce it — and because population DECLINES ignored members
 * rather than flagging them, the tables carry no trace of the difference.
 *
 * The precedent is `populateAndReport` in `population-wiring.ts`, which names
 * a tree whose every document was declined as binary rather than letting it
 * populate as empty and report success. That report covers blob refusals only;
 * this guard covers the extent.
 *
 * 🪤 **Only when checks actually RAN.** A run with no rules at all is refused
 * too — it is the same class one level further out — but by
 * {@link noCheckRanFinding}, whose message is about the missing RULES rather
 * than about the missing rows. Firing both would hand the operator two reports
 * about one situation, and this is the less specific of the two: "the 0 checks
 * that ran asserted nothing over 0 members" sends them to inspect a
 * `.gitignore` when what they are missing is a `checks:` block.
 *
 * 🪤 **`RUN_INTEGRITY_CODE`, not a code of its own** — see that constant
 * for why all four refusals in this verb share one.
 *
 * @param checksRun - How many checks EXECUTED. Under `--check` that is fewer
 *   than the project declares, which is why the message says "ran" and not
 *   "declared": the number is the size of the filtered run
 * @param membersEnumerated - How many members the population enumerated
 * @returns The finding, or nothing when the run had a corpus (or no checks)
 */
function emptyCorpusFinding(
  checksRun: number,
  membersEnumerated: number,
): readonly ValidationIssue[] {
  if (checksRun === 0 || membersEnumerated > 0) return [];

  return [runIntegrityFinding(
    `The projection enumerated 0 members, so the ${checksRun} check(s) that ran`
    + ' asserted nothing: there were no rows for any statement to select and'
    + ' zero findings means only that the corpus was empty.'
    + ' Look at `.gitignore` (one broad pattern declines every file), at whether'
    + ' the checkout is complete rather than shallow or sparse, and at whether'
    + ' `root` in this report is the directory you meant.'
    + ' `vat resources scan` over the same path lists what an enumeration finds.',
  )];
}

/** How a supervised checks run stopped short of publishing its own document — see `RunEnding`. */
export type CheckRunEnding = RunEnding<CheckInvocation>;

/**
 * The sentence that says what this document does NOT contain.
 *
 * @param checksCompleted - How many checks filed a cost before the run stopped
 * @returns The sentence
 *
 * 🚨 Load-bearing, and shared by both endings. The progress log records COSTS,
 * not findings: a check that completed contributes its `rows` (how many rows its
 * statement selected) but not the violations those rows would have become,
 * because the child never got to turn them into issues. A reader who took the
 * issue list as the complete account would conclude the finished rules found
 * nothing.
 */
function incompleteNotice(checksCompleted: number): string {
  // 🚨 Only when something completed: an EMPTY `checks` list "DID complete" nothing.
  if (checksCompleted === 0) {
    return ' No check completed before the run stopped, so `checks` is empty and no result'
      + ' of this run is missing from `issues` — there were none.';
  }
  return ' ⚠️ The checks listed under `checks` DID complete and `rows` is what each'
    + ' statement selected, but their individual violations are NOT in `issues`: the'
    + ' progress log records costs, not findings. Read that list as incomplete.';
}

/**
 * The finding for a run that was interrupted, however it was interrupted.
 *
 * 🪤 **`RUN_INTEGRITY_CODE`, for the reason that constant gives.** An
 * interrupted run must never be silenceable by the config of the very project
 * whose SQL hung.
 *
 * 🔑 **This is the MORE SPECIFIC of two claims that can be true at once.** A run
 * killed before its first statement completed recovers zero costs, which
 * {@link noCheckRanFinding} also refuses — so that one stands down when this
 * one is present. The dedupe there is order-independent (`issues.some(code ===
 * RUN_INTEGRITY_CODE)`), so this finding only has to be IN the issue list of an
 * interrupted document, not first in it.
 *
 * @param inFlight - What the run was doing when the log stopped growing
 * @param ending - Which way the run ended, and what the operator can do
 * @param checksCompleted - How many checks filed a cost before it stopped
 * @returns The run-integrity finding
 */
function interruptedRunFinding(
  inFlight: UnitInFlight,
  ending: CheckRunEnding,
  checksCompleted: number,
): ValidationIssue {
  return runIntegrityFinding(interruptionMessage(inFlight, ending) + incompleteNotice(checksCompleted));
}

/**
 * The check a run stopped while `examining` or `converting`, as a `broken` cost
 * with its completed statement's rows — so `checks` is never silently one short.
 */
function stoppedMidCheck(
  entries: readonly ProgressEntry[],
  inFlight: UnitInFlight,
): { cost: CheckCost; finding: CheckIssue } | undefined {
  if (inFlight.kind !== 'converting' && inFlight.kind !== 'examining') return undefined;
  const line = entries.findLast(
    (entry): entry is Extract<ProgressEntry, { kind: 'converting' | 'examining' }> =>
      entry.kind === inFlight.kind && entry.name === inFlight.name,
  );
  if (line === undefined) return undefined;
  const stopped = inFlight.kind === 'examining'
    ? 'its examined statement was running, so nothing says what it ranged over and none of them were reported.'
    : 'they were being converted into findings, so none of them were reported.';
  // The line carries the cost record so far, so the rebuilt entry is the completed run's.
  const examined = 'examined' in line && line.examined !== undefined ? { examined: line.examined } : {};
  return {
    cost: {
      name: line.name,
      durationMs: line.durationMs,
      rows: line.rows,
      broken: true,
      ...examined,
      ...(line.allowEmpty === undefined ? {} : { allowEmpty: line.allowEmpty }),
      ...(line.nearMisses === undefined ? {} : { nearMisses: line.nearMisses }),
    },
    finding: ofCheck(line.name, runIntegrityFinding(
      `The check "${line.name}" ran and selected ${String(line.rows)} ${line.rows === 1 ? 'row' : 'rows'}, but the run`
        + ` stopped while ${stopped}`,
    )),
  };
}

/**
 * Rebuild the document from what an INTERRUPTED run left on disk.
 *
 * Both interruptions come here — the watchdog's kill and an abnormal death —
 * because everything below this line is identical for them: the same recovered
 * costs, the same non-overridable finding, the same refusal when there is no
 * population. Only the sentences differ, and {@link CheckRunEnding} carries that.
 *
 * 🔑 It feeds {@link buildCheckOutputData}, the SAME builder a completed run
 * uses. A second payload builder for this lane would be a second shape to
 * keep in step with every future field — and the failure mode is silent, because
 * nobody reads an interrupted run's document until the day they need it.
 *
 * 🚨 **The exit code follows the CAUSE, and the cause is what was in flight.**
 * A run killed or dead while a check's statement ran examined the tree, and
 * that check is broken: `status: findings`, `RESOURCE_CHECK_BROKEN`, exit 1. A
 * run stopped during STARTUP or POPULATION examined nothing: it is a command
 * that could not do its job — `status: error`, exit 2 — decided by
 * {@link buildCheckOutputData} from `populated: null`, never by the caller. The
 * document is published, with the population's fields `null` rather than
 * invented, and the reason in `error`.
 *
 * @param options - The wreckage
 * @param options.entries - What `parseProgressLog` recovered
 * @param options.root - The corpus root the parent resolved
 * @param options.ending - Which way the run was interrupted
 * @param options.durationMs - Wall time from spawn to ending
 * @returns The input to {@link buildCheckOutputData}
 */
export function buildInterruptedCheckInput(options: {
  entries: readonly ProgressEntry[];
  root: string;
  ending: CheckRunEnding;
  durationMs: number;
}): CheckPayloadInput {
  const { entries, root, ending, durationMs } = options;
  const population = entries.find((entry) => entry.kind === 'population');
  const notAdmitted = entries.find((entry) => entry.kind === 'not-admitted')?.findings ?? [];
  // 🪤 Rebuilt field by field rather than passed through. The log's check
  // entry carries a `kind` discriminator that `CheckCost` does not, and the
  // conditional spreads keep `rows`/`broken` ABSENT rather than `undefined` —
  // which is what makes `rows: 0` on a statement that never returned
  // impossible, exactly as it is on the completed path.
  const lines = entries.filter((entry): entry is CheckLine => entry.kind === 'check');
  const completed: CheckCost[] = lines.map((entry) => ({
    name: entry.name,
    durationMs: entry.durationMs,
    ...(entry.rows === undefined ? {} : { rows: entry.rows }),
    ...(entry.broken === undefined ? {} : { broken: entry.broken }),
    ...(entry.builtin === undefined ? {} : { builtin: entry.builtin }),
    ...(entry.examined === undefined ? {} : { examined: entry.examined }),
    ...(entry.allowEmpty === undefined ? {} : { allowEmpty: entry.allowEmpty }),
    ...(entry.nearMisses === undefined ? {} : { nearMisses: entry.nearMisses }),
  }));
  const inFlight = unitInFlight(entries);
  const stopped = stoppedMidCheck(entries, inFlight);
  const costs = stopped === undefined ? completed : [...completed, stopped.cost];
  // 🔑 Re-derived per check, as a completed run publishes them: the child's findings died with it.
  const refused = lines.flatMap((line, index) => {
    const cost = completed[index];
    const finding = refusalFromLine(line) ?? (cost !== undefined && examinedNothing(cost) ? examinedNothingFinding(line.name) : undefined);
    return finding === undefined ? [] : [finding];
  });

  return {
    root,
    durationMs,
    populated: population === undefined
      ? null
      : {
        population: population.population,
        lensPopulation: population.lensPopulation,
        populationMs: population.populationMs,
        lensMs: population.lensMs,
        lensesEvaluated: population.lensesEvaluated,
        membersEnumerated: population.membersEnumerated,
      },
    // Earlier checks' refusals before the in-flight check's, as a completed run files them —
    // and through the one finding resolver a completed run's findings go through, so a
    // re-derived finding carries the same registry fields (`reference`) as the one that died.
    // Every code here is a refusal, which no `severity` key reaches: no config is needed.
    // The population's not-admitted findings lead, as on a completed run, and are
    // NOT resolved again: the child resolved them through `resources.validation`,
    // and a second pass with no config would put a configured severity back to its default.
    issues: [
      ...notAdmitted,
      ...resolveFindings([
        interruptedRunFinding(inFlight, ending, completed.length),
        ...refused,
        ...(stopped === undefined ? [] : [stopped.finding]),
      ], {}),
    ],
    costs,
  };
}

/**
 * Run this project's checks — VAT's default set plus whatever the project
 * declared — and resolve their severities: the whole of this verb's logic, with
 * the database taken out.
 *
 * 🔑 **`builtins` is a required argument beside `checks`, never a default inside
 * this function.** That is what makes "the default set belongs to the pipeline,
 * not to the config file" a property of the signature — nobody can get the
 * defaults by omitting an argument or lose them by supplying no config.
 *
 * Exported and pure so the loop is provable without a spawn. It was not: every
 * spawned case declared ONE check (the `--check` case declares two and filters
 * to one, which the loop cannot distinguish), so `checksRun` was never observed
 * above 1 and a `break` at the end of the loop would have left the suite green.
 *
 * Pure in the same sense the payload builder is, with ONE seam: it reads a
 * clock. That is why the clock is a parameter — the measurement is the point of
 * the `costs` it returns, and a duration nothing can pin is a number nobody can
 * trust.
 *
 * @param options - The run
 * @param options.builtins - The default set, already bound to this run's
 *   projection. Required, and `[]` is a deliberate statement rather than an
 *   omission
 * @param options.checks - The declared checks
 * @param options.only - A single check name, or undefined for all
 * @param options.ask - Runs one statement against the populated projection
 * @param options.validation - The project's severity overrides, or undefined
 * @param options.membersEnumerated - How many members the population enumerated.
 *   Told rather than asked, because no answer can reveal it: an `ask` over an
 *   empty projection and an `ask` over a clean one both return no rows
 * @param options.now - The measurement clock in milliseconds, defaulting to
 *   `performance.now()`. Injected only so a unit test can pin an exact per-check
 *   duration; nothing in production passes it
 * @param options.onProgress - Where each check's `start` and cost are announced
 *   so an outside supervisor can see them, or undefined when the run is not
 *   supervised. Optional rather than required because `--budget 0` and every
 *   unit case run with nobody watching
 * @returns The resolved findings, and one cost record per check that ran
 */
export function runProjectChecks(options: {
  builtins: readonly BoundBuiltinCheck[];
  checks: Readonly<Record<string, ResourceCheck>>;
  only: string | undefined;
  ask: AskProjection;
  columnsOf: ColumnsOfStatement;
  validation: ValidationConfig | undefined;
  membersEnumerated: number;
  now?: () => number;
  // `| undefined` explicitly, not merely optional: under
  // `exactOptionalPropertyTypes` the production caller — which has a sink or has
  // none, depending on a flag — could not pass `undefined` otherwise, and would
  // be pushed into a conditional spread. This repo has already shipped a defect
  // where a conditional spread silently dropped a renamed field, because a
  // spread gets no excess-property check.
  onProgress?: ProgressSink | undefined;
  /**
   * Where a near miss of a reserved row column is said — stderr in production. REQUIRED: an
   * omitted sink would drop the only signal that a misspelt reserved column was read as evidence.
   */
  warn: (message: string) => void;
}): { issues: CheckIssue[]; costs: CheckCost[] } {
  const now = options.now ?? (() => performance.now());
  const { issues, costs } = runUnits(
    checkUnits(options.builtins, options.checks, options),
    options.only,
    now,
    options.onProgress,
    options.warn,
  );
  // 🚨 HERE, and this line moved to get here. `statements-complete` buys the phase
  // after the last statement a fresh watchdog window, and three places
  // documented that phase as "resolving severities and serialising". It was
  // emitted a level up, by `runOutcome`, AFTER this function returned — so
  // `resolveFindings` below ran inside the LAST CHECK's window and the
  // documented claim was false for the half of the phase that grows with the
  // issue count. Emitting it before that call is what makes the claim true,
  // which is the useful direction: the alternative was to weaken three docs.
  //
  options.onProgress?.({ kind: 'statements-complete' });
  // The run-integrity report leads. An aggregate check selects a row whatever
  // the corpus is, so its findings can outnumber this one — and every one of
  // them is noise until the operator knows the gate ran over nothing.
  const reported = [...emptyCorpusFinding(costs.length, options.membersEnumerated), ...issues];
  return {
    // The adopter's own `resources.validation.severity` still applies, so a
    // check inherited from a shared config can be downgraded or ignored without
    // editing it. Applied AFTER the run, never before: a check that is going to
    // be ignored must still be EXECUTED, or "ignored" would quietly become
    // "never checked" and those are different claims.
    //
    // It reaches a check's VIOLATIONS only. `RESOURCE_CHECK_BROKEN` is not an
    // overridable code, so the news that a check stopped checking survives every
    // override an adopter can write about the check itself.
    //
    // 🔑 A BUILT-IN's findings pass through the identical call, under their
    // ordinary registry code: `severity: { CLAUDE_RULE_GLOB_INERT: ignore }`
    // silences the default exactly as it silences any other code VAT emits, with
    // no `CUSTOM:` spelling and no second override surface. That the two lanes
    // share this one line is the reason there is nothing to keep in step.
    issues: resolveFindings(reported, options.validation ?? {}),
    costs,
  };
}

/**
 * The child's argv — this very command, plus the hidden flag that stops it
 * spawning a child of its own.
 *
 * 🚨 `--supervised-by` is ALWAYS appended, and that is the recursion guard. Its
 * presence is the sole discriminator between "supervise a child" and "do the
 * work"; a path that built these arguments without it would fork bomb. Its one
 * value carries who started the child (which decides the notices the child owes
 * the operator), this process's pid (which the child checks is its parent's) and
 * the progress log — see `supervisedByValue`.
 *
 * 🔑 The operand is the root the PARENT resolved, always. The child is spawned
 * with no `cwd`, so without it the child would resolve its own root from the
 * INHERITED working directory — which differs from the parent's root whenever
 * the operator named the project rather than standing in it: `vat resources
 * check <inner>` run from an outer project would check the outer tree and
 * report it as the inner one. (`vat validate` takes no operand and resolves its
 * root from the working directory the child inherits, so for it the operand
 * restates what the child would have found — it is passed so the phase cannot
 * depend on that coincidence.)
 *
 * 🔑 Every value travels as `--name=value` and the operand comes last, after `--`: a value or a
 * root that begins with `-` is then never read as an option. (`--supervised-by` keeps two tokens:
 * its value always begins with the invoker's name.)
 *
 * @param root - The project root the parent resolved
 * @param request - What the child is asked to run, and in which format
 * @param logPath - The progress log both sides watch
 * @returns The child's arguments after the CLI entry point
 */
function childArgs(root: string, request: ChildRequest, logPath: string): string[] {
  return [
    'resources',
    'check',
    ...(request.check === undefined ? [] : [`--check=${request.check}`]),
    `--format=${request.format}`,
    ...(request.debug ? ['--debug'] : []),
    ...(request.base === undefined ? [] : [`--base=${request.base}`]),
    SUPERVISED_BY_FLAG,
    supervisedByValue({ invoker: request.invocation, progressLog: logPath }),
    '--',
    root,
  ];
}

/**
 * What a supervising parent asks its child to run. Every field is required: the
 * parent reads the child's stdout in `format`, so a format it did not send is a
 * format it would misread.
 */
interface ChildRequest {
  /** One check's key, or undefined for every check. */
  readonly check: string | undefined;
  readonly format: 'yaml' | 'json';
  readonly debug: boolean;
  /** The ref `changed_files` compares with, forwarded verbatim; undefined when none was given. */
  readonly base: string | undefined;
  /**
   * Who asked. Decides how a kill's remedy is worded here, and — handed to the
   * child — whether the child owes the operator the store notice.
   */
  readonly invocation: CheckInvocation;
}

/**
 * Run the checks in a child bounded by `budgetSecs`, and report either what it
 * said or what killing it revealed.
 *
 * 🪤 The endings are RETURNED rather than exited on from inside
 * `withProgressLog`. `process.exit` skips a `finally`, so exiting in there would
 * leak the temp directory on every single run — and it is the successful runs,
 * which are all of them but one, that would accumulate.
 *
 * @param options - The run
 * @param options.root - The project root the caller resolved. REQUIRED: the
 *   child checks exactly this tree, and a killed run's document is labelled with it
 * @param options.request - What the child is asked to run, and who asked
 * @param options.budgetSecs - The bound, in seconds
 * @returns What to publish, and with what exit code
 */
async function superviseCheckRun(options: {
  root: string;
  request: ChildRequest;
  budgetSecs: number;
}): Promise<SupervisedEnding<CheckReport>> {
  const { root, request } = options;
  const { value: ending, leftover } = await withProgressLog(CHECK_VERB, async (log): Promise<SupervisedEnding<CheckReport>> => {
    const run = await superviseRun({
      verb: CHECK_VERB,
      args: childArgs(root, request, log.path),
      log,
      budgetMs: options.budgetSecs * 1000,
      format: request.format,
    });
    if (run.outcome === 'completed') return { forward: run.document };

    return {
      payload: buildCheckOutputData(buildInterruptedCheckInput({
        entries: parseProgressLog(run.log),
        root,
        // 🚨 The abnormal ending reaches the SAME fail-closed document the
        // watchdog's kill does, never `{ outcome: 'completed', code: 0 }`.
        ending: run.outcome === 'killed'
          ? { kind: 'budget', budgetSecs: options.budgetSecs, invocation: request.invocation }
          : { kind: 'abnormal', death: run.death, invocation: request.invocation },
        durationMs: run.elapsedMs,
      })),
    };
  });
  return withLeftover(ending, leftover);
}

/**
 * The `checks` phase of an orchestrator: the same supervised child `vat resources check` runs,
 * over the whole project, and its report is the phase's report.
 *
 * 🔑 **The report is the ending's own, in both arms** — the child's forwarded document, or the
 * document a killed or dead child's progress log rebuilt. There is no per-arm exit mapping: the
 * report's status already says what was in flight (findings with `RESOURCE_CHECK_BROKEN` once
 * the population was recorded, `error` before it), and the orchestrator derives the exit from it
 * as it does for every phase.
 *
 * @param options - The phase
 * @param options.root - The project root the orchestrator resolved. REQUIRED, so no caller can
 *   fall back to the working directory and check a different project from the one it validated
 * @param options.debug - Whether the orchestrator was run with `--debug`, forwarded to the child
 * @param options.verbose - Whether the orchestrator was run with `--verbose`: the warning and info
 *   rows are reported on stderr too, not only the errors
 * @returns The phase's report
 */
export async function runResourcesCheckPhase(
  options: { root: string; debug: boolean; verbose: boolean; base: string | undefined },
): Promise<PhaseOutcome> {
  const ending = await superviseCheckRun({
    root: options.root,
    request: { check: undefined, format: 'json', debug: options.debug, base: options.base, invocation: 'phase' },
    budgetSecs: DEFAULT_BUDGET_SECONDS,
  });
  const report = 'forward' in ending ? ending.forward.report : ending.payload;
  // The human half, on this process's stderr: the child's own stdout is the document it forwarded.
  reportFindings(report.findings, { verbose: options.verbose, write: createLogger().error });
  return { report };
}

/**
 * Warn, on the invoked process's stderr, that the project declares no checks of its own.
 *
 * 🪤 Stderr only, and it decides NOTHING — the document is what the exit code is computed from
 * and what CI parses. ⚠️ It does not stand beside a refusal: the built-in set runs, so the run
 * DID assert something. What the operator needs to know is that the project is relying entirely
 * on VAT's defaults, which is what a deleted `checks:` block looks like.
 *
 * Printed only by the process the operator ran as `vat resources check` — never by a supervised
 * child (any `--supervised-by` process) and so never by an orchestrator's `checks` phase, where a
 * project with `resources:` and no `resources.checks` still runs the built-ins and "no checks of
 * its own" is not news on every run.
 *
 * @param checks - The project's declared checks, or undefined
 * @param logger - Where the warning goes
 */
function warnWhenNoOwnChecks(checks: Readonly<Record<string, ResourceCheck>> | undefined, logger: Logger): void {
  if (checks !== undefined && Object.keys(checks).length > 0) return;
  logger.warn(
    `No checks of this project's own are declared, so this run asserted only VAT's`
    + ` built-in set (${BUILTIN_CHECK_NAMES.join(', ')}).`
    + ' Add your own under `resources.checks` in vibe-agent-toolkit.config.yaml;'
    + ' each is a description plus one SQL statement selecting the rows that VIOLATE it.'
    + ' `vat resources check --help` prints the SQL each built-in is equivalent to,'
    + ' as a starting point.',
  );
}

/**
 * Run the project's declared checks against its projection.
 *
 * ## 🚨 Why this verb spawns a child by default and `vat resources query` only under `--budget`
 *
 * Both verbs run SQL an adopter wrote, over the same projection, through the
 * same `withQueriedProjection` — which does NOT diverge here, and must not. The
 * fork is this function and nothing below it (and `queryCommand`'s, for `query`).
 *
 * `query`'s author is at the keyboard, and Ctrl-C already works for them, so a
 * query pays for a second process only when its operator asks for a bound with
 * `--budget` — then it runs under this verb's supervisor, through
 * `query-supervision.ts`, which a query without it never loads. Ctrl-C
 * works for one reason worth stating, because it is fragile: NO signal handler
 * is installed in a process that runs the SQL. A process blocked in synchronous
 * `node:sqlite` dies instantly on SIGINT while that remains true, and SURVIVES
 * SIGINT and SIGTERM the moment a handler exists — the handler is a JS callback
 * and the event loop that would schedule it is the blocked resource. Adding one
 * would take Ctrl-C away from `query`, and from `check`'s child and its
 * `--budget 0` run. (`check`'s SUPERVISING process does install handlers while
 * it supervises — its event loop is free — only to take its child down with it;
 * see `check-supervisor.ts`.)
 *
 * `check` runs unattended in CI, where nobody is there to press it. So it gets a
 * bound enforced from outside itself, and a hang becomes a bounded failure
 * instead of a job that burns its runner minutes and reports nothing.
 *
 * ## `[path]` locates the project; a `WHERE` clause is the only scope a check has
 *
 * Same contract as `vat resources query`, for the same reason (see
 * `queryCommand`): the projection is the whole tracked tree, so the argument is
 * where root discovery starts and nothing more. A locator that names no
 * directory is refused HERE, before the fork below — the parent would otherwise
 * resolve it silently to the cwd's project and spawn a child to run every check
 * over a tree the operator did not name, at exit 0.
 *
 * @param pathArg - Where to look for the project, or omitted for the current directory
 * @param options - Parsed command-line options
 */
export async function checkCommand(
  pathArg: string | undefined,
  options: CheckOptions,
): Promise<void> {
  const logger = createLogger({ debug: options.debug ?? false });
  const startTime = Date.now();
  // The two formats this verb offers (Commander refuses any other).
  const format = options.format === 'json' ? 'json' : 'yaml';

  try {
    if (pathArg !== undefined) assertDirectoryArgument(pathArg);
    const budgetSecs = parseBudgetSeconds(options.budget);
    // Before anything is spawned: a budget the fork below would silently ignore
    // is an operator error, not a bound.
    const child = requireSupervisableFlags({
      supervisedBy: options.supervisedBy,
      budgetRaw: options.budget,
      budgetSecs,
    });
    // The process the operator ran — never a supervised child — says when the
    // project declares no checks of its own, and prints the config's warnings
    // with it. See {@link warnWhenNoOwnChecks}.
    const root = standaloneRoot(pathArg);
    if (child === undefined) {
      warnWhenNoOwnChecks(loadConfigCached(root, 'source')?.resources?.checks, logger);
    } else {
      leaveFindingsToSupervisor();
    }
    // The presence of `--supervised-by` says "you ARE the child". `--budget 0` says
    // the operator declined the bound; both run the work here, and the second
    // can therefore hang forever, which its help text says.
    const ending: SupervisedEnding<CheckReport> = runsInThisProcess({ supervisedBy: options.supervisedBy, budgetSecs })
      ? { payload: await withNoticeAudience(noticeAudienceOf(child), () => runChecksHere(pathArg, options, child, logger, startTime)) }
      : await superviseStandalone(root, options, format, budgetSecs);
    // The human half, on stderr, by the process the operator ran — as every verb does. A
    // supervised child prints no finding, here or in its writer: its supervisor reports them all.
    if (child === undefined) {
      const report = 'forward' in ending ? ending.forward.report : ending.payload;
      // An error document's message first, as every refusal says it; the writer then skips it.
      announceErrorOf(report);
      reportFindings(report.findings, { verbose: options.verbose === true, write: logger.error });
    }
    if ('forward' in ending) {
      // Verbatim (unless `withLeftover` had to add a finding to it) — the supervisor already checked it is
      // this verb's document — and on the code that document derives. The child already built what the operator's `--format` asked for, and
      // re-serializing it here would be a second place for that shape to live.
      //
      // ⚠️ `durationSecs` in it is therefore the CHILD's wall time and does
      // not include this process's own startup and spawn (~0.15 s measured).
      // Deliberate: the field is a breakdown that `populationSecs` and the
      // per-rule costs have to reconcile against, and folding in a supervisor
      // overhead none of them can account for would leave a remainder a
      // reader would attribute to whichever rule they were looking at — the
      // exact defect `CheckCost` documents.
      //
      // 🪤 `return` it, though its type is `never`: under a test's returning
      // exit spy a bare call would fall through to the second ending below.
      return endWithForwardedDocument(ending.forward);
    }
    // A killed child is never OK and never decided here: its document carries
    // a RUN_INTEGRITY finding (exit 1) or the error branch (exit 2), and the
    // writer derives the code from it, as everywhere else.
    endWithReport(CHECK_VERB, ending.payload, format);
  } catch (error) {
    // `vat resources check` offers no `--strict`: warnings never fail it.
    endWithRefusal(CHECK_VERB, refusalCodeOf(error), error, format, { strict: false }, NOTHING_FINISHED);
  }
}

/**
 * Which notices the process running the checks prints.
 *
 * Any process that is not a supervised child prints every notice. A supervised child prints no
 * config warning — its invoking process loaded the same config and printed them — and prints the
 * store notice only when a standalone `vat resources check` started it: that supervisor opens no
 * store (keying one is a git snapshot, unbounded work it must not do before its watchdog exists),
 * while `vat validate` opened its store scope, and printed the notice, before any phase ran.
 *
 * @param child - The supervised child this process is, or undefined when it is not one
 * @returns The audience
 */
function noticeAudienceOf(child: SupervisedChild | undefined): NoticeAudience {
  if (child === undefined) return EVERY_NOTICE;
  return { config: false, store: child.invoker === 'standalone' };
}

/**
 * Supervise the checks child for a standalone `vat resources check`.
 *
 * 🔑 Nothing unbounded runs here before the spawn: no store is opened and no tree is snapshotted,
 * so the watchdog exists before any work that could hang. The store notice is the child's to print
 * (see {@link noticeAudienceOf}).
 *
 * @param root - The project root this process resolved, which the child checks
 * @param options - Parsed command-line options
 * @param format - The document format the operator asked for
 * @param budgetSecs - The bound, in seconds
 * @returns What to publish
 */
function superviseStandalone(
  root: string,
  options: CheckOptions,
  format: 'yaml' | 'json',
  budgetSecs: number,
): Promise<SupervisedEnding<CheckReport>> {
  return superviseCheckRun({
    root,
    request: { check: options.check, format, debug: options.debug === true, base: options.base, invocation: 'standalone' },
    budgetSecs,
  });
}

/**
 * The project root a standalone `vat resources check` names, resolved SILENTLY.
 *
 * 🪤 Silent deliberately. `projectRootOrLoudCwd` warns on stderr when there is
 * no project ancestor, and the process that runs the checks (the child, or this
 * one under `--budget 0`) runs that policy for real — resolving loudly here too
 * would print the same warning twice for one run.
 *
 * @param pathArg - Where to look for the project, or omitted for the current directory
 * @returns The project root, or the resolved start directory when there is none
 */
function standaloneRoot(pathArg: string | undefined): string {
  const startDir = pathArg ?? process.cwd();
  return projectRootOrNull(startDir) ?? safePath.resolve(startDir);
}

/**
 * Run the checks in this process and build the document.
 *
 * @param pathArg - Where to look for the project, or omitted for the current directory
 * @param options - Parsed command-line options
 * @param child - The supervised child this process is (its progress log), or undefined
 * @param logger - Where warnings go
 * @param startTime - When the command started (from Date.now())
 * @returns The document
 */
async function runChecksHere(
  pathArg: string | undefined,
  options: CheckOptions,
  child: SupervisedChild | undefined,
  logger: Logger,
  startTime: number,
): Promise<CheckReport> {
  // 🔑 FIRST, before anything that touches the tree: the child has booted.
  // The watchdog's clock started at the spawn, so without this line Node's
  // startup and the CLI's import were charged to the population — the one
  // unit the budget is already a total bound for. See `StartedEntrySchema`.
  // And before that line: the child that outlives its supervisor ends itself — see
  // `endWhenSupervisorGone` for when that can and cannot be noticed.
  if (child !== undefined) endWhenSupervisorGone(CHECK_VERB, child.supervisorPid, process.stdin);
  const onProgress = child === undefined
    ? undefined
    : createProgressWriter(child);
  onProgress?.({ kind: 'started' });

  const projectRoot = projectRootOrLoudCwd(pathArg ?? process.cwd(), logger);
  const config = loadConfigCached(projectRoot, 'source');
  const checks = config?.resources?.checks;

  // Before the crawl: a mistyped flag is an operator error and pays nothing.
  requireKnownCheck(BUILTIN_CHECK_NAMES, checks ?? {}, options.check);
  // Also before the crawl, and for the same reason: an override that overrides
  // nothing is knowable from the config alone, and the operator should read it
  // beside the other config news rather than after a full population.
  warnUndeclaredOverrides(checks ?? {}, config?.resources?.validation, logger);

  const outcome = await runOutcome({
    root: projectRoot,
    checks: checks ?? {},
    only: options.check,
    base: options.base,
    logger,
    validation: config?.resources?.validation,
    onProgress,
  });
  const { issues, costs, ...populated } = outcome;
  // The checks ran synchronously: a supervisor lost meanwhile ends this child HERE, unpublished.
  if (child !== undefined) await letSupervisorLossSurface();
  return buildCheckOutputData({
    issues,
    costs,
    populated,
    root: projectRoot,
    durationMs: Date.now() - startTime,
  });
}

/**
 * Populate once, run the checks, resolve their severities.
 *
 * @param options - The run
 * @param options.root - Absolute corpus root
 * @param options.checks - The declared checks
 * @param options.only - A single check key, or undefined for all
 * @param options.base - The ref `changed_files` compares with, or undefined when none was given
 * @param options.logger - Where blob-stage refusals are reported
 * @param options.validation - The project's severity overrides, or undefined
 * @param options.onProgress - Where each unit is announced for a supervisor
 *   outside this process, or undefined when nothing is watching
 * @returns The findings and the provenance of the population behind them
 */
function runOutcome(options: {
  root: string;
  checks: Readonly<Record<string, ResourceCheck>>;
  only: string | undefined;
  base: string | undefined;
  logger: Logger;
  validation: ValidationConfig | undefined;
  onProgress: ProgressSink | undefined;
}): Promise<CheckOutcome> {
  const { root, checks, only, base, logger, validation, onProgress } = options;
  // 🪤 **No `preflight` here, deliberately.** `withQueriedProjection` can compile
  // statements against the empty schema before populating — `vat resources query`
  // passes its one statement and gets a typo back in milliseconds instead of
  // after a full population. This verb must NOT, because a check that cannot run
  // is not an operator error here: it is a `RESOURCE_CHECK_BROKEN` finding naming
  // the check, at `error`, in a document that also reports how big the corpus was
  // and what the population cost. Failing early would trade that document for a
  // bare throw, and the finding exists precisely so a renamed column cannot end a
  // gate quietly. The population is the price of an honest report, and it is
  // charged once for every check rather than per broken one.
  // 🔑 `statements` IS passed, and it is a different question from `preflight`:
  // it only decides which derived relations are evaluated. Every declared
  // statement goes in, including one `--check` narrows away — the lens is per
  // RUN, and narrowing it would make `--check foo` and a full run disagree about
  // which relations exist.
  // 🪤 `examined` statements included, or a relation only they name is absent, so the statement
  // fails with "no such table".
  const statements = Object.values(checks).flatMap((check) => checkStatements(check));
  return withQueriedProjection({ root, logger, statements, base }, (ask, provenance, extent, projection, columnsOf) => {
    // 🔑 Emitted HERE, inside the callback, because this is the one place where
    // the provenance and the extent are both exactly in hand — and emitted the
    // INSTANT population completes, because its arrival is what tells a
    // supervisor that a kill has a projection to report on. It also resets the
    // watchdog, so the population is bounded by the budget without being charged
    // the first check's share of it.
    //
    // The files it did not admit are findings BEFORE any check runs, written on
    // their own line immediately before the population's, so a run killed
    // mid-check still fails on them (`buildInterruptedCheckInput`).
    const notAdmitted = notAdmittedPopulationFindings(projection, root, validation);
    onProgress?.({ kind: 'not-admitted', findings: notAdmitted });
    onProgress?.(populationEntry(provenance, extent));
    // 🪤 `statements-complete` is NOT emitted here: `runProjectChecks` emits it the
    // instant the last statement is done, before `resolveFindings` runs.
    //
    // 🔑 The DEFAULT SET enters HERE, from a module constant bound to the
    // projection — never from `config`, which this line does not read. That is
    // the placement the "defaults belong to the pipeline" invariant is about.
    const ran = runProjectChecks({
      builtins: bindBuiltinChecks(projection),
      checks,
      only,
      ask,
      columnsOf,
      validation,
      ...extent,
      onProgress,
      warn: (message) => logger.warn(message),
    });
    // The refusals lead the checks' own findings: every one of those is a
    // statement about a corpus with these files missing from it.
    const issues = [...notAdmitted, ...ran.issues];
    return { ...ran, issues, ...provenance, ...extent };
  });
}

/**
 * One finding per file the population enumerated and did not admit — unreadable,
 * too large to decode, changed under the run, its parser threw, or its parse
 * refused this run (`notAdmittedRealizations`) — through the one not-admitted
 * contract every crawling verb reports such a file with (`notAdmittedFindings`):
 * the same code and sentence, located at the file's own project-relative path,
 * resolved through `resources.validation` — its allow list first, then its
 * severity.
 *
 * No check can see such a file's rows — it has none this run — so a clean
 * verdict over the population would be a claim about a corpus the checks never
 * read: the file counts against the verdict instead (error by default). A store
 * hit cannot hide a per-run refusal: none is ever filed, so its key is held by
 * nothing and the hit's coverage check re-derives it.
 *
 * @param projection - The populated projection
 * @param root - The absolute root its realization paths are relative to
 * @param validation - The project's `resources.validation`, or undefined
 * @returns The findings left after the allow filter, each at its resolved severity
 */
function notAdmittedPopulationFindings(
  projection: Parameters<typeof notAdmittedRealizations>[0],
  root: string,
  validation: ValidationConfig | undefined,
): ValidationIssue[] {
  return notAdmittedFindings(
    notAdmittedRealizations(projection, root),
    { locationRoot: root, consequence: "no check saw its rows and this run's verdict does not cover it" },
    validation ?? {},
  );
}

/** The test-facing seam: helpers the unit tests reach that are not part of this module's API. */
export const __internal = { noticeAudienceOf };
