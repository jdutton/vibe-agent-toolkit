/**
 * `vat resources check` — run the project's own SQL assertions over its
 * resource projection.
 *
 * ## Why this verb exists when `vat resources query` already runs SQL
 *
 * A query answers a question once. A question worth asking twice is a rule, and
 * a rule that lives in someone's shell history is not enforced — it decays into
 * a comment. This verb runs the statements a project wrote into
 * `resources.checks`, turns each violating row into an ordinary validation
 * finding, and exits non-zero when any of them is an error. That is the whole
 * difference, and it is the difference between a tool and a gate.
 *
 * ## 🔑 A broken check is an ERROR, never a skip
 *
 * VAT ships no schema version, so a renamed column simply breaks a check's SQL.
 * The tempting handling — log it and carry on — is the one thing this must never
 * do: a check that stopped running looks exactly like a check that passed, and
 * the project keeps reporting green over an assertion nobody is making any more.
 * So a statement that will not run is reported as a finding at **error**
 * severity, with the columns the projection actually has, and it fails the run.
 *
 * That report carries its OWN code (`RESOURCE_CHECK_BROKEN`), which no
 * `validation.severity` entry can reach. A check's severity override is about how
 * bad a VIOLATION is; while the two shared the code `CUSTOM:<name>`, the
 * documented way to stand down an inherited check also silenced the news that it
 * had stopped checking. See the `catch` in `runChecks`.
 *
 * ## 🔑 An empty CORPUS is a refusal too, not a pass
 *
 * The same class one level further out, and the one that shipped. `checksRun` is
 * the denominator of RULES; nothing counted the ROWS, so a repository whose
 * enumeration came back empty — a broad `.gitignore`, a shallow or sparse CI
 * checkout, a root that resolved somewhere else — ran every declared check over
 * nothing and reported `status: success` on exit 0 with empty stderr. Population
 * declines ignored members rather than flagging them, so the tables held no
 * trace of it either.
 *
 * So the population's size is published (`membersEnumerated`), and a run whose
 * checks executed over zero members is an ERROR under the same non-overridable
 * code as a broken statement — see {@link emptyCorpusFinding}. A gate that
 * asserts nothing over nothing has not passed.
 *
 * ## 🔑 An unknown `--check` name is a refusal, not an empty pass
 *
 * The same failure class one flag over: a filter that matched nothing ran nothing
 * and exited 0. `requireDeclaredCheck` refuses it before the crawl, naming the
 * declared set. A gate that cannot fail is worse than no gate.
 *
 * ## What this does NOT do
 *
 * It does not fold into `vat resources validate`. That command is on every
 * adopter's pre-commit path, and adding a store-backed population to it is a
 * cost and a risk that deserves its own decision with its own evidence. Wiring
 * this into CI is one line in a workflow; making it unavoidable is not this
 * change's call to make.
 */

import { performance } from 'node:perf_hooks';

import { issuesFromCheckRows, type ResourceCheck } from '@vibe-agent-toolkit/resources';
import {
  calculateValidationStatus,
  countBySeverity,
  type ValidationIssue,
} from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';

import { handleCommandError } from '../../utils/command-error.js';
import { loadConfigCached } from '../../utils/config-loader.js';
import { formatDurationSecs } from '../../utils/duration.js';
import { resolveIssueSeverity, type SeverityOverrides } from '../../utils/issue-severity.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { writeJsonOutput, writeStdoutSync, writeYamlOutput } from '../../utils/output.js';
import { projectRootOrLoudCwd, projectRootOrNull } from '../../utils/project-root-policy.js';
import {
  withQueriedProjection,
  type AskProjection,
  type PopulationExtent,
  type ProjectionProvenance,
} from '../../utils/projection-query.js';

import {
  createProgressWriter,
  parseProgressLog,
  unitInFlight,
  type ProgressEntry,
  type UnitInFlight,
} from './check-progress.js';
import {
  parseBudgetSeconds,
  requireSupervisableFlags,
  runsInThisProcess,
  superviseCheck,
  withProgressLog,
  type AbnormalDeath,
} from './check-supervisor.js';

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
  /** Run only this check, by its config key. */
  check?: string;
  /** `yaml` (default) or `json`. Same document either way. */
  format?: string;
  /**
   * How long the run may go WITHOUT completing a unit of work, in seconds.
   * `0` removes the bound and keeps everything in this process.
   */
  budget?: string;
  /**
   * Hidden. Where to append progress — and, by its mere presence, the
   * instruction to do the work here rather than supervise a child that does.
   * Set by {@link childArgs} and by nothing else; an operator passing it by hand
   * gets an unsupervised run and a log file, which is harmless.
   */
  costLog?: string;
}

/**
 * What one declared check cost, and what it found.
 *
 * ## 🚨 The population is charged to NOBODY, and that is deliberate
 *
 * {@link durationMs} is the STATEMENT alone. The git tracker, the projection
 * build and the load into the ephemeral database happen ONCE and serve every
 * check in the run, so folding that shared setup into each rule would make N
 * cheap rules look expensive and make the per-rule numbers sum to N times a cost
 * paid once. It is published separately instead — `populationSecs` beside
 * `population` in the document — so a reader can reconcile the parts against
 * `durationSecs` rather than inferring the remainder and attributing it to
 * whichever rule they happen to be reading.
 *
 * 🪤 This repo has already shipped the opposite mistake once, in another
 * instrument: `parse ab` reported a pooled arm BACKWARDS because its estimate
 * was thread-summed, and the report surfaced no caveat that would have told the
 * reader. A shared cost silently attributed to one participant is the same
 * defect wearing different clothes. If you ever want the population inside these
 * numbers, divide it out explicitly and say so in the field name.
 */
export interface CheckCost {
  /** The check's key in `resources.checks`. */
  readonly name: string;
  /** Wall time of this check's statement, and of nothing it shares with others. */
  readonly durationMs: number;
  /** Rows the statement returned — the violations it selected. Absent when the statement did not run. */
  readonly rows?: number;
  /** Set when the statement threw. A statement that did not complete has no row count. */
  readonly broken?: true;
}

/** What one run of the checks produced. */
interface CheckOutcome extends ProjectionProvenance, PopulationExtent {
  issues: readonly ValidationIssue[];
  /**
   * One record per check that actually ran — the denominator every count below
   * is read against, and what each of them cost.
   *
   * 🔑 A LIST rather than a count beside a list. `checksRun` used to be carried
   * separately and is now derived from `costs.length`, because two numbers that
   * must agree are a drift bug with no gate on it: nothing fails when a new
   * `continue` skips the record but not the counter, and the document then
   * reports a denominator no published entry accounts for.
   */
  costs: readonly CheckCost[];
}

export interface CheckPayloadInput extends CheckOutcome {
  root: string;
  durationMs: number;
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
 * sum to `durationSecs`. The population is paid once and shared by every check;
 * see {@link CheckCost} for why it is charged to none of them.
 *
 * @param input - The findings and the provenance of the run behind them
 * @returns The document to serialize
 */
export function buildCheckOutputData(input: CheckPayloadInput): Record<string, unknown> {
  const issues = [...input.issues];
  return {
    status: calculateValidationStatus(issues),
    root: input.root,
    population: input.population,
    // Beside the origin, because a `population: store` a reader cannot price is
    // a label taken on faith. Charged to no check — see {@link CheckCost}.
    populationSecs: formatDurationSecs(input.populationMs),
    // The denominator. See above: without it an empty findings list is
    // ambiguous. Derived from `checks`, never carried beside it.
    checksRun: input.costs.length,
    // The OTHER denominator, and the one whose absence shipped a green gate over
    // an empty repository. `checksRun` counts rules; this counts what they ran
    // against. Both are needed, because zero findings is the pass condition and
    // either number at zero makes that pass vacuous.
    membersEnumerated: input.membersEnumerated,
    issueCounts: countBySeverity(issues),
    durationSecs: formatDurationSecs(input.durationMs),
    // What each rule cost, directly under the total it is a breakdown of. A SQL
    // surface is an unbounded cost — a project can declare a statement that
    // scans every row of every table — and a single total attributes nothing:
    // ten seconds is one expensive rule, a slow population, or forty cheap
    // rules, and only this list tells them apart.
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
    })),
    // 🪤 NOT run through `relativizePathEntries`. Every other payload builder
    // re-bases here because its producer keeps absolute paths internally; these
    // arrive project-relative instead, and re-basing an already-relative path
    // would resolve it against the wrong base and silently corrupt it.
    //
    // 🪤 The guarantee is `locationOf` in `sql-checks.ts` — the one place a
    // projection column becomes a finding's `location`, and which refuses an
    // absolute or backslashed value there. It is NOT the type: nothing on this
    // path parses issues through `ValidationIssueSchema` (this module imports the
    // `ValidationIssue` TYPE only, and the schema's sole consumers are in
    // `packages/schema/test/`), so the refinement is documentation here rather
    // than enforcement. Do not "fix" that by parsing at this boundary: it would
    // convert a slip in `locationOf` from "this finding loses its anchor" into
    // "the whole run throws", which is strictly worse for a gate.
    //
    // A finding may also carry no path at all (an aggregate check has no file to
    // name), which `PathEntry` cannot represent — one more reason this list is
    // not that shape.
    issues: issues.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
      ...(issue.location === undefined ? {} : { path: issue.location }),
    })),
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
 * The loop used to read the clock into a `startedAt`, call `ask`, and subtract
 * two lines later — and the claim below that "the span is `ask(check.sql)` and
 * nothing else" had NO guard behind it. A reviewer moved the subtraction below
 * the row-to-finding mapping, widening the measured span to cover work that is
 * not the statement, and **the entire unit suite stayed green (36/36)**. That is
 * measured, not assumed.
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
 * 🪤 It was never true of an adopter OVERRIDE, and this finding used to carry
 * `customCheckCode(name)` — the same code as a violation of that very check. So
 * `severity: { 'CUSTOM:foo': 'ignore' }`, the documented way to stand down a
 * check you inherited, also silenced "foo could not run", and `'warning'`
 * demoted it below the exit threshold. A renamed projection column then produced
 * exit 0 from a gate. `RESOURCE_CHECK_BROKEN` is a non-overridable code
 * precisely so that config line cannot reach here.
 *
 * 🪤 Only `ask` reaches this. Turning the selected rows INTO findings is not a
 * statement failure, and reporting it as one told the operator a working rule
 * was broken — see the append in {@link runChecks}.
 *
 * @param name - The check's key in `resources.checks`
 * @param error - Whatever the statement threw
 * @returns The run-integrity finding
 */
function brokenCheckFinding(name: string, error: unknown): ValidationIssue {
  return {
    code: 'RESOURCE_CHECK_BROKEN',
    severity: 'error',
    message:
      `The check "${name}" could not run, so it is asserting nothing: `
      + (error instanceof Error ? error.message : String(error)),
  };
}

/**
 * Run every declared check, collect its findings, and price it.
 *
 * ## What the clock measures, and what it must not
 *
 * The span is `ask(check.sql)` and nothing else — structurally, because it is
 * the thunk handed to {@link timed}, which exists for that reason and documents
 * the mutation that proved an inline stopwatch unguardable. Everything before
 * the loop — the git tracker, `buildResourceProjection`, loading the ephemeral
 * database — is paid ONCE for all of them and reaches the document as
 * `populationSecs`; see {@link CheckCost} for why charging it here would be a
 * lie in N places.
 *
 * ⚠️ `performance.now()`, never `Date.now()`. A rule over a small projection is
 * routinely sub-millisecond, and a millisecond-granularity clock reports every
 * one of them as `0` — which reads as "not measured" and makes the whole
 * attribution worthless exactly where it is cheapest to get right.
 *
 * 🪤 Exactly one cost record per executed check, on both paths, because
 * `checksRun` is this list's length. The record is filed before the rows become
 * findings, so nothing between the two can leave a check unpriced.
 *
 * ## 🚨 Why the loop announces itself before it can be stopped
 *
 * {@link ProgressSink} is told a check is about to run, and told again when it
 * is priced. That ordering is not decoration: this verb runs adopter-authored
 * SQL unattended, an accidental cross join or an unterminated `WITH RECURSIVE`
 * runs forever, and NOTHING in-process can interrupt it — the query is
 * synchronous, it holds the event loop, and `node:sqlite` exposes no interrupt.
 * The supervisor's only lever is an external `SIGKILL`, which publishes nothing
 * of the killed process's memory. So the name of the rule that hangs has to be
 * on disk BEFORE it is entered, or it is not recoverable at all.
 *
 * @param checks - The project's `resources.checks`
 * @param only - A single check key to run, or undefined for all of them
 * @param ask - Runs one statement against the populated projection
 * @param now - The clock, in milliseconds; injected so a test can assert an
 *   exact duration rather than a range that passes on a timer that never started
 * @param onProgress - Told what is about to run and what it cost, or undefined
 *   when nothing is watching (the in-process lane, and `--budget 0`)
 * @returns The findings, and one cost record per check that ran
 */
function runChecks(
  checks: Readonly<Record<string, ResourceCheck>>,
  only: string | undefined,
  ask: AskProjection,
  now: () => number,
  onProgress: ProgressSink | undefined,
): { issues: ValidationIssue[]; costs: CheckCost[] } {
  const issues: ValidationIssue[] = [];
  const costs: CheckCost[] = [];
  /** File the cost with the observer as well as with the caller — one place. */
  const price = (cost: CheckCost): void => {
    costs.push(cost);
    onProgress?.({ kind: 'check', ...cost });
  };

  for (const [name, check] of Object.entries(checks)) {
    if (only !== undefined && name !== only) continue;
    // 🪤 BEFORE `timed`, and not one line later. `ask` is where a runaway
    // statement never returns from, so an announcement below it is filed by
    // every check except the one whose name the operator needs.
    onProgress?.({ kind: 'start', name });
    const outcome = timed(now, () => ask(check.sql));

    if (!outcome.ok) {
      // Priced up to the throw, and with NO row count: a statement that did not
      // complete selected nothing, and `rows: 0` would say it selected nothing
      // and passed.
      price({ name, durationMs: outcome.durationMs, broken: true });
      issues.push(brokenCheckFinding(name, outcome.error));
      continue;
    }

    price({ name, durationMs: outcome.durationMs, rows: outcome.value.length });
    // 🪤 Appended one at a time, NEVER `issues.push(...findings)`. A spread
    // becomes an ARGUMENT LIST, which throws `RangeError: Maximum call stack
    // size exceeded` past roughly 125,000 elements on the main thread — and a
    // check's result set is unbounded by construction. VAT's own
    // `blob_references` table already holds 29,645 rows, so `SELECT * FROM
    // blob_references` over a repository a few times this size reached it, and
    // the throw landed in the arm above: a rule that ran perfectly was reported
    // as one that "could not run, so it is asserting nothing". A loop does not
    // put the argument limit in play at all.
    for (const issue of issuesFromCheckRows(name, check, outcome.value)) issues.push(issue);
  }

  return { issues, costs };
}

/**
 * Refuse a `--check` name the project does not declare.
 *
 * 🔑 **An unknown name used to be a silent green.** The filter was a bare
 * `if (only !== undefined && name !== only) continue;` and nothing compared the
 * flag against the declared keys, so `--check nope` filtered every check away,
 * ran none, and exited 0 with `checksRun: 0` and `issues: []` on empty stderr.
 * The loud "no checks are declared" warning never fired, because it asks whether
 * the `checks` MAP is empty, never whether the FILTER matched anything.
 *
 * That is not a hypothetical typo: `vat resources check --check orphan-skills`
 * is the example in this command's own help text. Rename or delete that check
 * and the CI step keeps passing forever while asserting nothing.
 *
 * Thrown rather than reported as a finding, because it is an OPERATOR error and
 * not a content violation — the two have different exit codes in this command's
 * contract (2 versus 1) and different audiences. Thrown before the projection is
 * populated, so a mistyped flag costs no crawl.
 *
 * @param checks - The project's `resources.checks`
 * @param only - The `--check` value, or undefined
 * @throws When `only` names no declared check
 */
export function requireDeclaredCheck(
  checks: Readonly<Record<string, ResourceCheck>>,
  only: string | undefined,
): void {
  // 🪤 `Object.hasOwn`, not `only in checks`. `in` walks the prototype chain, so
  // `--check toString` would have looked declared, matched nothing, and restored
  // the exact silent green this guard closes.
  if (only === undefined || Object.hasOwn(checks, only)) return;

  const declared = Object.keys(checks);
  throw new Error(
    `No check named "${only}" is declared. `
    + (declared.length === 0
      ? 'This project declares none — add them under `resources.checks` in'
        + ' vibe-agent-toolkit.config.yaml.'
      : `Declared under \`resources.checks\`: ${declared.join(', ')}.`),
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
 * The precedent is `population-wiring.ts`, which makes `onBlobPopulation`
 * mandatory because "a tree whose every document was declined as binary
 * otherwise populates as empty and reports success". That guard covers blob
 * refusals only; this one covers the extent.
 *
 * 🪤 **Only when checks actually RAN.** Declaring no checks is a legitimate
 * state that {@link checkCommand} answers with a loud stderr warning and a
 * deliberate exit 0. Firing here as well would turn that legitimate state into
 * an error and hand the operator two reports about one situation.
 *
 * 🪤 **`RESOURCE_CHECK_BROKEN`, not a code of its own.** It is the same
 * run-integrity claim as a statement that would not compile — *these assertions
 * did not execute meaningfully, so the green means nothing* — and it needs the
 * identical non-overridability, which `ValidationConfigSchema` grants by refusing
 * that code as a `severity` key. A sibling code would buy a consumer nothing the
 * message does not already say, while adding a second thing an adopter's CI has
 * to know to look for.
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

  return [{
    code: 'RESOURCE_CHECK_BROKEN',
    severity: 'error',
    message:
      `The projection enumerated 0 members, so the ${checksRun} check(s) that ran`
      + ' asserted nothing: there were no rows for any statement to select and'
      + ' zero findings means only that the corpus was empty.'
      + ' Look at `.gitignore` (one broad pattern declines every file), at whether'
      + ' the checkout is complete rather than shallow or sparse, and at whether'
      + ' `root` in this report is the directory you meant.'
      + ' `vat resources scan` over the same path lists what an enumeration finds.',
  }];
}

/**
 * How a supervised run stopped short of publishing its own document.
 *
 * Two endings, and telling them apart is the whole reason this is a type rather
 * than a number. A watchdog kill means *no progress within the budget*, and the
 * remedy may genuinely be a larger bound. An abnormal death means *the run
 * died* — most often out of memory — and there the budget was never involved,
 * so advice to raise it is a false diagnosis that makes the situation worse.
 */
export type CheckRunEnding =
  | { readonly kind: 'budget'; readonly budgetSecs: number }
  | { readonly kind: 'abnormal'; readonly death: AbnormalDeath };

/**
 * Where the run was when it stopped, as a phrase.
 *
 * @param inFlight - What the log's last state says
 * @returns A clause naming the unit
 */
function inFlightPhrase(inFlight: UnitInFlight): string {
  if (inFlight.kind === 'check') return `while the check "${inFlight.name}" was running`;
  if (inFlight.kind === 'reporting') {
    return 'after the last check had finished, while its document was being assembled';
  }
  // 🪤 The HEDGE is load-bearing and was once deleted on the strength of
  // `checks-complete`. It does not cover this window. `price()` files the last
  // check's cost BEFORE `issuesFromCheckRows` turns its rows into issues, and
  // `checks-complete` is written after that conversion — so a kill in between
  // leaves a log of nothing but completed checks, which reads as `idle`. The
  // unhedged sentence then told an operator whose run had finished every rule
  // that it died before the first statement. The window is narrow (the
  // conversion runs ~0.74x the statement it follows, so a budget that survived
  // the statement survives the conversion) but a narrow window is not a closed
  // one, and the sentence costs nothing to keep honest.
  return 'while no check was running — either between the population and the first'
    + ' statement, or after the last one had filed its cost';
}

/**
 * What ended the child, as a phrase.
 *
 * @param death - The ending the supervisor resolved
 * @returns A clause naming the mechanism
 */
function deathPhrase(death: AbnormalDeath): string {
  if (death.kind === 'signal') return `the child process was terminated by ${death.signal}`;
  if (death.kind === 'spawn-failed') {
    return `the child process could not be started at all (${death.binary}: ${death.detail})`;
  }
  if (death.kind === 'kill-failed') {
    return 'the budget was blown and the SIGKILL that should have ended the run was REFUSED'
      + ` (${death.detail})`;
  }
  return 'the child process ended with neither an exit code nor a signal';
}

/**
 * What to do about a child that never started.
 *
 * 🚨 **"Check your PATH" is the wrong thing to tell a saturated runner.**
 * `spawn` fails with `EAGAIN` when the machine has no free process slot and
 * `ENOMEM` when it has no free memory — which is precisely the memory-pressured
 * environment this whole feature exists for, and precisely where an operator
 * least deserves to be sent hunting an installation problem that is not there.
 *
 * @param detail - What `spawn` reported
 * @returns The remedy sentence
 */
function spawnFailedRemedy(detail: string): string {
  if (/\b(?:EAGAIN|ENOMEM)\b/.test(detail)) {
    return ' The child could not be started because the RUNNER had nothing left to start it'
      + ' with — EAGAIN is "no free process slot" and ENOMEM is "no free memory" — so this is'
      + ' about how loaded the machine is, not about the installation and not about the SQL.'
      + ' Give the job a less contended runner, or reduce what else is running beside it.';
  }
  return ' Nothing ran at all, so this is an installation or PATH problem rather than'
    + ' anything about the SQL.';
}

/**
 * What to do about a kill the kernel refused.
 *
 * ⛔ This must never be composed from the spawn-failure sentence, however
 * similar the plumbing is. The two are opposites: one child never existed, and
 * this one is, as far as this process can tell, STILL RUNNING.
 *
 * @param death - The refused kill, and the pid it left behind
 * @returns The remedy sentence
 */
function killFailedRemedy(detail: string, pid: number | undefined): string {
  const handle = pid === undefined
    ? ' The child\'s pid is not known to this process.'
    : ` The child was process ${pid}.`;
  return ' The run started, ran past its budget, and then REFUSED TO DIE: the watchdog sent'
    + ` SIGKILL and the kernel would not deliver it (${detail}), which normally means EPERM.`
    + handle
    + ' It may still be running and still holding whatever the statement was holding, so'
    + ' check for it and end it by hand before starting another run. Nothing about the SQL'
    + ' or the installation is implicated by the refusal itself — but the bound could not be'
    + ' enforced, so treat this run as unsupervised.'
    // 🚨 Its OWN budget-role sentence, because the generic one below is false
    // here: this is the single abnormal death the watchdog causes. Saying "the
    // watchdog never fired" would repeat, in the report, the exact confusion
    // that produced the defect.
    + ' The watchdog DID fire — the budget is what decided this run should stop — but the'
    + ' kill was refused, so raising the budget only moves when the refusal happens. It does'
    + ' not make the run stoppable.';
}

/**
 * What to do about a particular signal.
 *
 * 🚨 **The defect this closes: the fallback contradicted the sentence beside
 * it.** Only `SIGABRT` and `SIGKILL` were partitioned on and everything else
 * fell through to a sentence written for `no-status` — so a real `kill -TERM`
 * produced "terminated by SIGTERM … The cause is outside anything this command
 * can observe; the child left no exit code to report". It names the signal, and
 * then says it can see nothing and was told nothing. SIGSEGV, SIGBUS, SIGHUP and
 * SIGXCPU read the same way.
 *
 * ⚠️ **SIGTERM is not exotic; it is how CI kills things** — `timeout(1)`, a
 * cancelled job, a container stopping. The old claim that "SIGABRT and SIGKILL
 * are the two that actually happen" was wrong about the commonest one.
 *
 * @param signal - The signal `close` reported
 * @returns The remedy sentence
 */
function signalRemedy(signal: string): string {
  if (signal === 'SIGABRT') {
    return ' SIGABRT here is Node aborting on its own heap limit: the run exhausted memory'
      + ' MATERIALISING a result set, which is what an unbounded statement does as soon as it'
      + ' selects rows rather than an aggregate. The remedy is a narrower statement or a'
      + ' `LIMIT`, not a bigger machine.';
  }
  if (signal === 'SIGKILL') {
    return ' Nothing inside this run sends SIGKILL except the budget watchdog, and the watchdog'
      + ' did not fire — so something OUTSIDE killed the child: a kernel OOM killer on a'
      + ' memory-capped runner (it picks the largest process, which is this child and never the'
      + ' idle parent), a container memory limit, or an operator. Give the job more memory, or'
      + ' narrow the statement so it needs less.';
  }
  if (signal === 'SIGTERM' || signal === 'SIGINT' || signal === 'SIGHUP') {
    return ` Nothing inside this run sends ${signal}: something OUTSIDE asked the child to stop.`
      + ' On CI that is almost always a step or job timeout (`timeout(1)`, a workflow'
      + ' `timeout-minutes`), a cancelled pipeline, or a container being shut down. Look at the'
      + ' job\'s own time limit and at whether the run was cancelled — not at the SQL, which was'
      + ' still working when it was interrupted.';
  }
  if (signal === 'SIGSEGV' || signal === 'SIGBUS') {
    return ` ${signal} is a CRASH inside native code, not anything an adopter's SQL can express:`
      + ' the process was killed by the kernel for touching memory it should not have. That'
      + ' points at a native module (`node:sqlite` is one) or at the platform, and it is worth'
      + ' reporting with the Node version, the platform and the statement that was running.';
  }
  return ` ${signal} was not sent by anything inside this run, and this command has no specific`
    + ' remedy for it: look at what else on this machine signals its child processes — a'
    + ' supervisor, a resource limit, or an operator.';
}

/**
 * What to DO about it — and the reason the death is carried this far as a union
 * rather than as a string.
 *
 * 🔑 Every kind wants a DIFFERENT file looked at: SIGABRT is the statement,
 * SIGKILL is the runner's memory, SIGTERM is the job's own timeout, a failed
 * spawn is either the installation or the runner's load, and a refused kill is a
 * process still running. A message that conflated any two of them would send
 * half its readers to the wrong place.
 *
 * ⛔ **The last line is for `no-status` and nothing else.** It is the only
 * ending about which this command genuinely knows nothing, and it used to be
 * the fall-through for every unpartitioned signal — which produced messages
 * that named a signal and then denied having any information about it.
 *
 * @param death - The ending the supervisor resolved
 * @returns The remedy sentence
 */
function deathRemedy(death: AbnormalDeath): string {
  if (death.kind === 'kill-failed') return killFailedRemedy(death.detail, death.pid);
  if (death.kind === 'spawn-failed') return spawnFailedRemedy(death.detail) + WATCHDOG_UNINVOLVED;
  if (death.kind === 'signal') return signalRemedy(death.signal) + WATCHDOG_UNINVOLVED;
  return ' The cause is outside anything this command can observe; the child left no exit code'
    + ' to report.' + WATCHDOG_UNINVOLVED;
}

/**
 * The sentence that keeps an abnormal death from being blamed on the bound.
 *
 * ⛔ Appended by every arm of {@link deathRemedy} EXCEPT the refused kill, which
 * writes its own — because there the watchdog is exactly what fired, and this
 * sentence would repeat in the report the confusion that produced the defect:
 * an `error` event read as a spawn failure, so `killed` was never consulted.
 */
const WATCHDOG_UNINVOLVED
  = ' The budget was not what ended this run — the watchdog never fired — so raising it'
  + ' would not help.';

/**
 * The sentence that says what this document does NOT contain.
 *
 * 🚨 Load-bearing, and shared by both endings. The progress log records COSTS,
 * not findings: a check that completed contributes its `rows` (how many rows its
 * statement selected) but not the violations those rows would have become,
 * because the child never got to turn them into issues. A reader who took the
 * issue list as the complete account would conclude the finished rules found
 * nothing.
 */
const INCOMPLETE_NOTICE
  = ' ⚠️ The checks listed under `checks` DID complete and `rows` is what each'
  + ' statement selected, but their individual violations are NOT in `issues`: the'
  + ' progress log records costs, not findings. Read that list as incomplete.';

/**
 * The finding for a run that was interrupted, however it was interrupted.
 *
 * 🪤 **`RESOURCE_CHECK_BROKEN`, and for the reason {@link emptyCorpusFinding}
 * gives.** It is the same run-integrity claim — *these assertions did not
 * execute, so the green means nothing* — and it needs the identical
 * non-overridability, which `ValidationConfigSchema` grants by refusing that
 * code as a `severity` key. An interrupted run must never be silenceable by the
 * config of the very project whose SQL hung.
 *
 * @param inFlight - What the run was doing when the log stopped growing
 * @param ending - Which way the run ended, and what the operator can do
 * @returns The run-integrity finding
 */
function interruptedRunFinding(inFlight: UnitInFlight, ending: CheckRunEnding): ValidationIssue {
  const where = inFlightPhrase(inFlight);
  const message = ending.kind === 'budget'
    ? budgetKillMessage(inFlight, ending.budgetSecs, where)
    : `This run DIED before it finished: ${deathPhrase(ending.death)} ${where}, so the checks`
      + ' after it never executed and this document is not a verdict.'
      + deathRemedy(ending.death);

  return { code: 'RESOURCE_CHECK_BROKEN', severity: 'error', message: message + INCOMPLETE_NOTICE };
}

/**
 * What a WATCHDOG kill means, which depends entirely on what was in flight.
 *
 * 🚨 **The defect this closes: the `reporting` state got the statement-hang
 * body.** Creating that state adapted only the *where* clause, so a run whose
 * ten checks had ALL completed and whose 1,000,000-issue document blew the
 * budget was told "the checks after it never executed" and "a statement that
 * will not finish cannot be stopped from inside the process — the query is
 * synchronous and holds the event loop". Measured on that run: `checksRun: 10`,
 * all ten costs present, no statement running, nothing holding the loop for any
 * SQL reason. The operator was sent to hunt a hanging rule that does not exist,
 * and the message never mentioned the thing that actually killed the run.
 *
 * ⚠️ It is easy to reach on a real gate, not a curiosity: serialising 2,000,000
 * issues takes ~17 s after `checks-complete` is filed, which is one budget
 * window on its own.
 *
 * @param inFlight - What the log's last state says
 * @param budgetSecs - The bound that was blown
 * @param where - The clause naming the unit, from {@link inFlightPhrase}
 * @returns The message body
 */
function budgetKillMessage(inFlight: UnitInFlight, budgetSecs: number, where: string): string {
  if (inFlight.kind === 'reporting') {
    return `This run made no progress for ${budgetSecs}s and was killed ${where}.`
      + ' Every declared check had already finished and filed its cost, so no statement was'
      + ' running and there was nothing left to execute: the cause is the SIZE of the document'
      + ' being assembled, not a rule that would not return. Serialising a large result is'
      + ' linear in how much there is — 2,000,000 issues take about 17 seconds — so look at'
      + ' the rules under `checks` that produced the most rows and narrow them (a `LIMIT`, or'
      + ' one row per violation rather than one per member), or raise the bound with'
      + ' `--budget <seconds>` so the document has time to be written.';
  }
  return `This run made no progress for ${budgetSecs}s and was killed ${where}, so the`
    + ' checks after it never executed and this document is not a verdict.'
    + ' A statement that will not finish cannot be stopped from inside the process —'
    + ' the query is synchronous and holds the event loop — so the bound is enforced by'
    + ' killing the run. Raise it with `--budget <seconds>` if the work is legitimately'
    + ' slow, or `--budget 0` to remove it (the run can then hang forever).';
}

/**
 * The refusal when there is no population line to build a document from.
 *
 * Separate wording per ending for the same reason the finding is: telling an
 * operator whose child was OOM-killed to raise `--budget` sends them to change
 * the one thing that had nothing to do with it.
 *
 * @param ending - Which way the run ended
 * @returns The operator-error message
 */
function noPopulationMessage(ending: CheckRunEnding): string {
  const tail = ' There is no projection to report on and no honest document to publish.';
  if (ending.kind === 'abnormal') {
    return `This run DIED before its population completed: ${deathPhrase(ending.death)}.`
      + tail + deathRemedy(ending.death);
  }
  return `The run made no progress for ${ending.budgetSecs}s and was killed before its`
    + ' population completed.' + tail
    + ' Population is legitimately slow on a large tree, and it reports progress only when it'
    + ' FINISHES, so the budget is a total bound for that one unit — raise it with'
    + ' `--budget <seconds>` before assuming the crawl is stuck.'
    + ' For scale, two MEASURED trees, neither of them yours: VAT\'s own repository is ~1.2s'
    + ' warm and 33-35s with a cold parse cache; a 10,000-file adopter tree is ~5s warm and'
    + ' 16.5s cold. Your tree is a third number.';
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
 * 🚨 **A run interrupted during POPULATION gets no document at all.** There is no
 * projection, so `population`, `populationSecs` and `membersEnumerated` have no
 * honest value — and inventing `membersEnumerated: 0` would be worse than a
 * blank, because that value already MEANS "this gate ran over an empty corpus",
 * which is a different and wrong claim. The throw becomes an operator error
 * (exit 2) through the same `handleCommandError` path everything else here uses.
 *
 * @param options - The wreckage
 * @param options.entries - What `parseProgressLog` recovered
 * @param options.root - The corpus root the parent resolved
 * @param options.ending - Which way the run was interrupted
 * @param options.durationMs - Wall time from spawn to ending
 * @returns The input to {@link buildCheckOutputData}
 * @throws When the child never reported a completed population
 */
export function buildInterruptedCheckInput(options: {
  entries: readonly ProgressEntry[];
  root: string;
  ending: CheckRunEnding;
  durationMs: number;
}): CheckPayloadInput {
  const { entries, root, ending, durationMs } = options;
  const population = entries.find((entry) => entry.kind === 'population');
  if (population === undefined) throw new Error(noPopulationMessage(ending));

  return {
    root,
    durationMs,
    population: population.population,
    populationMs: population.populationMs,
    membersEnumerated: population.membersEnumerated,
    issues: [interruptedRunFinding(unitInFlight(entries), ending)],
    // 🪤 Rebuilt field by field rather than passed through. The log's check
    // entry carries a `kind` discriminator that `CheckCost` does not, and the
    // conditional spreads keep `rows`/`broken` ABSENT rather than `undefined` —
    // which is what makes `rows: 0` on a statement that never returned
    // impossible, exactly as it is on the completed path.
    costs: entries.filter((entry) => entry.kind === 'check').map((entry) => ({
      name: entry.name,
      durationMs: entry.durationMs,
      ...(entry.rows === undefined ? {} : { rows: entry.rows }),
      ...(entry.broken === undefined ? {} : { broken: entry.broken }),
    })),
  };
}

/**
 * Run the declared checks and resolve their severities — the whole of this
 * verb's logic, with the database taken out.
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
 * @param options.checks - The declared checks
 * @param options.only - A single check key, or undefined for all
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
export function runDeclaredChecks(options: {
  checks: Readonly<Record<string, ResourceCheck>>;
  only: string | undefined;
  ask: AskProjection;
  validation: SeverityOverrides | undefined;
  membersEnumerated: number;
  now?: () => number;
  // `| undefined` explicitly, not merely optional: under
  // `exactOptionalPropertyTypes` the production caller — which has a sink or has
  // none, depending on a flag — could not pass `undefined` otherwise, and would
  // be pushed into a conditional spread. This repo has already shipped a defect
  // where a conditional spread silently dropped a renamed field, because a
  // spread gets no excess-property check.
  onProgress?: ProgressSink | undefined;
}): { issues: ValidationIssue[]; costs: CheckCost[] } {
  const now = options.now ?? (() => performance.now());
  const { issues, costs } = runChecks(
    options.checks, options.only, options.ask, now, options.onProgress,
  );
  // 🚨 HERE, and this line moved to get here. `checks-complete` buys the phase
  // after the last statement a fresh watchdog window, and three places
  // documented that phase as "resolving severities and serialising". It was
  // emitted a level up, by `runOutcome`, AFTER this function returned — so
  // `resolveIssueSeverity` below ran inside the LAST CHECK's window and the
  // documented claim was false for the half of the phase that is quadratic in
  // the issue count. Emitting it before that call is what makes the claim true,
  // which is the useful direction: the alternative was to weaken three docs.
  //
  // ⚠️ It does NOT cover the last check's row-to-issue conversion, which
  // `runChecks` does after filing that check's cost — see {@link inFlightPhrase}
  // for why the `idle` sentence still has to hedge for that window.
  options.onProgress?.({ kind: 'checks-complete' });
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
    issues: resolveIssueSeverity(reported, options.validation),
    costs,
  };
}

/**
 * Serialize the document in the format the operator asked for.
 *
 * Extracted because BOTH endings publish one — a completed run and a killed one
 * — and two copies of a two-branch format switch is how one of them ends up
 * ignoring `--format json`.
 *
 * @param payload - The document
 * @param format - `json`, or anything else for YAML
 */
function emitCheckDocument(payload: Record<string, unknown>, format: string | undefined): void {
  if (format === 'json') {
    writeJsonOutput(payload);
  } else {
    writeYamlOutput(payload);
  }
}

/**
 * The child's argv — this very command, plus the hidden flag that stops it
 * spawning a child of its own.
 *
 * 🚨 `--cost-log` is ALWAYS appended, and that is the recursion guard. Its
 * presence is the sole discriminator between "supervise a child" and "do the
 * work"; a path that built these arguments without it would fork bomb.
 *
 * @param pathArg - The corpus root the operator named, or undefined
 * @param options - What the operator passed
 * @param logPath - The progress log both sides watch
 * @returns The child's arguments after the CLI entry point
 */
function childArgs(
  pathArg: string | undefined,
  options: CheckOptions,
  logPath: string,
): string[] {
  return [
    'resources',
    'check',
    ...(pathArg === undefined ? [] : [pathArg]),
    ...(options.check === undefined ? [] : ['--check', options.check]),
    ...(options.format === undefined ? [] : ['--format', options.format]),
    ...(options.debug === true ? ['--debug'] : []),
    '--cost-log',
    logPath,
  ];
}

/** What a supervised run decided to publish. */
type SupervisedEnding =
  | { readonly forward: string; readonly code: number }
  | { readonly payload: Record<string, unknown> };

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
 * @param options.pathArg - The corpus root the operator named, or undefined
 * @param options.options - What the operator passed
 * @param options.budgetSecs - The bound, in seconds
 * @returns What to publish, and with what exit code
 * @throws When the child was killed before its population completed
 */
async function superviseCheckRun(options: {
  pathArg: string | undefined;
  options: CheckOptions;
  budgetSecs: number;
}): Promise<SupervisedEnding> {
  const startDir = options.pathArg ?? process.cwd();
  // 🪤 The SILENT resolution, deliberately. `projectRootOrLoudCwd` warns on
  // stderr when there is no project ancestor, and the CHILD runs that policy for
  // real — a parent that ran it too would print the same warning twice for one
  // run. The parent needs a root only to label a KILLED run's document.
  const root = projectRootOrNull(startDir) ?? safePath.resolve(startDir);

  return withProgressLog(async (logPath) => {
    const run = await superviseCheck({
      args: childArgs(options.pathArg, options.options, logPath),
      logPath,
      budgetMs: options.budgetSecs * 1000,
    });
    if (run.outcome === 'completed') return { forward: run.stdout, code: run.code };

    return {
      payload: buildCheckOutputData(buildInterruptedCheckInput({
        entries: parseProgressLog(run.log),
        root,
        // 🚨 The abnormal ending reaches the SAME fail-closed document the
        // watchdog's kill does. It used to reach `{ outcome: 'completed', code:
        // 0 }` instead, because the close handler never read `close`'s signal
        // argument — so a child that aborted on its heap limit printed nothing
        // and exited 0, on precisely the runaway shape the bound exists for.
        ending: run.outcome === 'killed'
          ? { kind: 'budget', budgetSecs: options.budgetSecs }
          : { kind: 'abnormal', death: run.death },
        durationMs: run.elapsedMs,
      })),
    };
  });
}

/**
 * Run the project's declared checks against its projection.
 *
 * ## 🚨 Why this verb spawns a child and `vat resources query` does not
 *
 * Both verbs run SQL an adopter wrote, over the same projection, through the
 * same `withQueriedProjection` — which does NOT diverge here, and must not. The
 * fork is this function and nothing below it.
 *
 * `query`'s author is at the keyboard, and Ctrl-C already works for them. It
 * works for one reason worth stating, because it is fragile: NO signal handler
 * is installed anywhere on this path. A process blocked in synchronous
 * `node:sqlite` dies instantly on SIGINT while that remains true, and SURVIVES
 * SIGINT and SIGTERM the moment a handler exists — the handler is a JS callback
 * and the event loop that would schedule it is the blocked resource. Adding one
 * would take Ctrl-C away from `query` without adding anything to `check`.
 *
 * `check` runs unattended in CI, where nobody is there to press it. So it gets a
 * bound enforced from outside itself, and a hang becomes a bounded failure
 * instead of a job that burns its runner minutes and reports nothing.
 *
 * @param pathArg - The corpus root, or omitted for the current directory
 * @param options - Parsed command-line options
 */
export async function checkCommand(
  pathArg: string | undefined,
  options: CheckOptions,
): Promise<void> {
  const logger = createLogger({ debug: options.debug ?? false });
  const startTime = Date.now();

  try {
    const budgetSecs = parseBudgetSeconds(options.budget);
    // Before anything is spawned: a budget the fork below would silently ignore
    // is an operator error, not a bound.
    requireSupervisableFlags({
      costLog: options.costLog,
      budgetRaw: options.budget,
      budgetSecs,
    });
    // The presence of `--cost-log` says "you ARE the child". `--budget 0` says
    // the operator declined the bound; both run the work here, and the second
    // can therefore hang forever, which its help text says.
    if (!runsInThisProcess({ costLog: options.costLog, budgetSecs })) {
      const ending = await superviseCheckRun({ pathArg, options, budgetSecs });
      if ('forward' in ending) {
        // Verbatim. The child already built the document the operator's
        // `--format` asked for, and re-serializing it here would be a second
        // place for that shape to live.
        //
        // ⚠️ `durationSecs` in it is therefore the CHILD's wall time and does
        // not include this process's own startup and spawn (~0.15 s measured).
        // Deliberate: the field is a breakdown that `populationSecs` and the
        // per-rule costs have to reconcile against, and folding in a supervisor
        // overhead none of them can account for would leave a remainder a
        // reader would attribute to whichever rule they were looking at — the
        // exact defect `CheckCost` documents.
        writeStdoutSync(ending.forward);
        process.exit(ending.code);
      }
      emitCheckDocument(ending.payload, options.format);
      // ⛔ Never 0. A run that did not finish — killed by the watchdog OR dead of
      // its own memory — must not look like a pass.
      process.exit(1);
    }

    const projectRoot = projectRootOrLoudCwd(pathArg ?? process.cwd(), logger);
    const config = loadConfigCached(projectRoot);
    const checks = config?.resources?.checks;

    if (checks === undefined || Object.keys(checks).length === 0) {
      // Loud, and exit 0. Declaring no checks is a legitimate state — most
      // projects have none — but a run that silently printed a passing report
      // would let a config typo read as a green gate forever.
      logger.warn(
        'No checks are declared. Add them under `resources.checks` in'
        + ' vibe-agent-toolkit.config.yaml; each is a description plus one SQL'
        + ' statement selecting the rows that VIOLATE it.',
      );
    }

    // Before the crawl: a mistyped flag is an operator error and pays nothing.
    requireDeclaredCheck(checks ?? {}, options.check);

    const outcome = await runOutcome({
      root: projectRoot,
      checks: checks ?? {},
      only: options.check,
      logger,
      validation: config?.resources?.validation,
      onProgress: options.costLog === undefined
        ? undefined
        : createProgressWriter(options.costLog),
    });
    const payload = buildCheckOutputData({
      ...outcome,
      root: projectRoot,
      durationMs: Date.now() - startTime,
    });
    emitCheckDocument(payload, options.format);

    process.exit(payload['status'] === 'error' ? 1 : 0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Check', options.format);
  }
}

/**
 * Populate once, run the checks, resolve their severities.
 *
 * @param options - The run
 * @param options.root - Absolute corpus root
 * @param options.checks - The declared checks
 * @param options.only - A single check key, or undefined for all
 * @param options.logger - Where blob-stage refusals are reported
 * @param options.validation - The project's severity overrides, or undefined
 * @param options.onProgress - Where each unit is announced for a supervisor
 *   outside this process, or undefined when nothing is watching
 * @returns The findings and the provenance of the population behind them
 */
async function runOutcome(options: {
  root: string;
  checks: Readonly<Record<string, ResourceCheck>>;
  only: string | undefined;
  logger: Logger;
  validation: SeverityOverrides | undefined;
  onProgress: ProgressSink | undefined;
}): Promise<CheckOutcome> {
  const { root, checks, only, logger, validation, onProgress } = options;
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
  return withQueriedProjection({ root, logger }, (ask, provenance, extent) => {
    // 🔑 Emitted HERE, inside the callback, because this is the one place where
    // the provenance and the extent are both exactly in hand — and emitted the
    // INSTANT population completes, because its arrival is what tells a
    // supervisor that a kill has a projection to report on. It also resets the
    // watchdog, so the population is bounded by the budget without being charged
    // the first check's share of it.
    onProgress?.({
      kind: 'population',
      population: provenance.population,
      populationMs: provenance.populationMs,
      membersEnumerated: extent.membersEnumerated,
    });
    // 🪤 `checks-complete` is NOT emitted here. It used to be, and that put
    // `resolveIssueSeverity` — which runs inside `runDeclaredChecks` — on the
    // wrong side of the line, still charged to the last check's budget window
    // while three separate docs said otherwise. It is emitted by
    // `runDeclaredChecks` itself now, the instant the last statement is done.
    const ran = runDeclaredChecks({ checks, only, ask, validation, ...extent, onProgress });
    return { ...ran, ...provenance, ...extent };
  });
}
