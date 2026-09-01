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

import { issuesFromCheckRows, type ResourceCheck } from '@vibe-agent-toolkit/resources';
import {
  calculateValidationStatus,
  countBySeverity,
  type ValidationIssue,
} from '@vibe-agent-toolkit/schema';

import { handleCommandError } from '../../utils/command-error.js';
import { loadConfigCached } from '../../utils/config-loader.js';
import { formatDurationSecs } from '../../utils/duration.js';
import { resolveIssueSeverity, type SeverityOverrides } from '../../utils/issue-severity.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { writeJsonOutput, writeYamlOutput } from '../../utils/output.js';
import { projectRootOrLoudCwd } from '../../utils/project-root-policy.js';
import {
  withQueriedProjection,
  type AskProjection,
  type PopulationExtent,
  type ProjectionProvenance,
} from '../../utils/projection-query.js';

interface CheckOptions {
  debug?: boolean;
  /** Run only this check, by its config key. */
  check?: string;
  /** `yaml` (default) or `json`. Same document either way. */
  format?: string;
}

/** What one run of the checks produced. */
interface CheckOutcome extends ProjectionProvenance, PopulationExtent {
  issues: readonly ValidationIssue[];
  /** How many checks actually ran — the denominator every count below is read against. */
  checksRun: number;
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
 * is misspelled would otherwise read as passing.
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
    // The denominator. See above: without it an empty findings list is ambiguous.
    checksRun: input.checksRun,
    // The OTHER denominator, and the one whose absence shipped a green gate over
    // an empty repository. `checksRun` counts rules; this counts what they ran
    // against. Both are needed, because zero findings is the pass condition and
    // either number at zero makes that pass vacuous.
    membersEnumerated: input.membersEnumerated,
    issueCounts: countBySeverity(issues),
    durationSecs: formatDurationSecs(input.durationMs),
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
 * Run every declared check and collect its findings.
 *
 * @param checks - The project's `resources.checks`
 * @param only - A single check key to run, or undefined for all of them
 * @param ask - Runs one statement against the populated projection
 * @returns The findings, and how many checks ran
 */
function runChecks(
  checks: Readonly<Record<string, ResourceCheck>>,
  only: string | undefined,
  ask: AskProjection,
): { issues: ValidationIssue[]; checksRun: number } {
  const issues: ValidationIssue[] = [];
  let checksRun = 0;

  for (const [name, check] of Object.entries(checks)) {
    if (only !== undefined && name !== only) continue;
    checksRun += 1;
    try {
      issues.push(...issuesFromCheckRows(name, check, ask(check.sql)));
    } catch (error) {
      // 🔑 A finding, not a skip, at `error`, and under its OWN code.
      //
      // The check's declared severity describes how bad a VIOLATION is; it says
      // nothing about how bad it is that the check cannot run, and a `warning`
      // check whose SQL broke would otherwise fail nothing while asserting
      // nothing. That much was always true of the DECLARATION.
      //
      // 🪤 It was never true of an adopter OVERRIDE, and this finding used to
      // carry `customCheckCode(name)` — the same code as a violation of that very
      // check. So `severity: { 'CUSTOM:foo': 'ignore' }`, the documented way to
      // stand down a check you inherited, also silenced "foo could not run", and
      // `'warning'` demoted it below the exit threshold. A renamed projection
      // column then produced exit 0 from a gate. `RESOURCE_CHECK_BROKEN` is a
      // non-overridable code precisely so that config line cannot reach here.
      issues.push({
        code: 'RESOURCE_CHECK_BROKEN',
        severity: 'error',
        message:
          `The check "${name}" could not run, so it is asserting nothing: `
          + (error instanceof Error ? error.message : String(error)),
      });
    }
  }

  return { issues, checksRun };
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
 * @param checksRun - How many checks executed
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
      `The projection enumerated 0 members, so all ${checksRun} declared check(s)`
      + ' asserted nothing: there were no rows for any statement to select and'
      + ' zero findings means only that the corpus was empty.'
      + ' Look at `.gitignore` (one broad pattern declines every file), at whether'
      + ' the checkout is complete rather than shallow or sparse, and at whether'
      + ' `root` in this report is the directory you meant.'
      + ' `vat resources scan` over the same path lists what an enumeration finds.',
  }];
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
 * @param options - The run
 * @param options.checks - The declared checks
 * @param options.only - A single check key, or undefined for all
 * @param options.ask - Runs one statement against the populated projection
 * @param options.validation - The project's severity overrides, or undefined
 * @param options.membersEnumerated - How many members the population enumerated.
 *   Told rather than asked, because no answer can reveal it: an `ask` over an
 *   empty projection and an `ask` over a clean one both return no rows
 * @returns The resolved findings, and how many checks ran
 */
export function runDeclaredChecks(options: {
  checks: Readonly<Record<string, ResourceCheck>>;
  only: string | undefined;
  ask: AskProjection;
  validation: SeverityOverrides | undefined;
  membersEnumerated: number;
}): { issues: ValidationIssue[]; checksRun: number } {
  const { issues, checksRun } = runChecks(options.checks, options.only, options.ask);
  // The run-integrity report leads. An aggregate check selects a row whatever
  // the corpus is, so its findings can outnumber this one — and every one of
  // them is noise until the operator knows the gate ran over nothing.
  const reported = [...emptyCorpusFinding(checksRun, options.membersEnumerated), ...issues];
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
    checksRun,
  };
}

/**
 * Run the project's declared checks against its projection.
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
    });
    const payload = buildCheckOutputData({
      ...outcome,
      root: projectRoot,
      durationMs: Date.now() - startTime,
    });
    if (options.format === 'json') {
      writeJsonOutput(payload);
    } else {
      writeYamlOutput(payload);
    }

    process.exit(payload['status'] === 'error' ? 1 : 0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Check');
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
 * @returns The findings and the provenance of the population behind them
 */
async function runOutcome(options: {
  root: string;
  checks: Readonly<Record<string, ResourceCheck>>;
  only: string | undefined;
  logger: Logger;
  validation: SeverityOverrides | undefined;
}): Promise<CheckOutcome> {
  const { root, checks, only, logger, validation } = options;
  return withQueriedProjection({ root, logger }, (ask, provenance, extent) => ({
    ...runDeclaredChecks({ checks, only, ask, validation, ...extent }),
    ...provenance,
    ...extent,
  }));
}
