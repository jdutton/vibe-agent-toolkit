/**
 * Shared machinery for the phase orchestrators: `vat build`, `vat verify` and
 * `vat validate`.
 *
 * 🔑 **Each phase hands back its report; the orchestrator publishes ONE.** A
 * phase function returns `{ report }` — the `Report<T>` its own command would
 * publish, BEFORE the writer's run-integrity pass — and the orchestrator folds
 * every phase into {@link orchestratorReport}: findings flat on the envelope,
 * `examined` the sum, each phase's status, count, summary and `data` under
 * `data.phases`. The writer then applies run integrity ONCE, to the sum. Applied
 * per phase, a project configuring resources and not skills — or a marketplace
 * of plugin-local skills and no `skills:` pool — failed on the phase that had
 * nothing to look at, and `claude plugin install --build`, which trusts `vat
 * build`'s exit, failed with it.
 *
 * Each phase's report is held to its OWN schema before the fold ({@link Phase}
 * `schema`, parsed by {@link runPhase}): the orchestrator's schema carries a
 * phase's `data` as `unknown`, so nothing downstream could catch a phase
 * publishing data its verb does not describe.
 *
 * There is no second status vocabulary. A phase's status is its envelope's
 * (`ok | findings | error`), the orchestrator's exit derives from its own
 * published document, and a phase that did not finish makes the run `error` /
 * `RUN_INCOMPLETE` with the finished phases still in `data.phases`.
 */

import {
  buildErrorReport,
  buildReport,
  FindingSchema,
  reportSchema,
  type Finding,
  type Gate,
  type RefusalCode,
  type Report,
  type ReportZodSchema,
} from '@vibe-agent-toolkit/schema';
import { type Command, Option } from 'commander';
import { z, type ZodTypeAny } from 'zod';

import type { DocumentFormat } from '../report-schemas.js';
import { CommandRefusalError, refusalCodeOf } from '../utils/command-refusal.js';
import { NOTHING_FINISHED, refusalReport, type FinishedWork } from '../utils/document-writer.js';
import { createLogger } from '../utils/logger.js';

import type { OrchestratorData, OrchestratorPhaseEntry } from './orchestrator-schema.js';

/**
 * What one phase produced: the report its own command would publish, before
 * the writer's run-integrity pass.
 *
 * Before, because integrity is a verdict on a RUN, and inside an orchestrator
 * a phase is not the run: see the header.
 */
export interface PhaseOutcome {
  report: Report<unknown>;
}

/** The schema a phase's report is held to: its own verb's registered report schema. */
export type PhaseReportSchema = ReportZodSchema<ZodTypeAny, ZodTypeAny>;

/**
 * The report schema of a phase that publishes no `data` of its own — verify's
 * `files-config-dests` and `consistency`, build's `shipped-links`: no verb of
 * their own registers one, and their `data` is `null`.
 */
export const DATALESS_PHASE_REPORT_SCHEMA: PhaseReportSchema = reportSchema(z.null(), FindingSchema);

/**
 * One orchestrated phase: a name, the schema its report is held to, and the
 * work to run for it.
 *
 * `schema` is REQUIRED: the orchestrator's own schema holds a phase's `data`
 * as `unknown` (it would otherwise be a second copy of every phase verb's
 * shape), so {@link runPhase} parsing each report against the phase's own
 * schema is the only thing standing between a phase and publishing `data` its
 * verb's schema does not describe. A delegated phase names its verb's
 * registered `<VERB>_REPORT_SCHEMA`; an in-process one names its own.
 *
 * `run` is a bound closure rather than an argv array because the phase executes
 * in this process. An argv array would mean re-entering Commander to
 * parse arguments this process has already parsed — a second, weaker copy of the
 * orchestrator's own options, and the exact seam through which `vat validate`'s
 * `--verbose` could be forwarded to one phase and dropped by another.
 */
export interface Phase {
  name: string;
  schema: PhaseReportSchema;
  run: () => Promise<PhaseOutcome>;
}

/** One phase that ran: its name and its report. */
export interface PhaseResult {
  name: string;
  report: Report<unknown>;
}

/** No orchestrator offers `--strict`: warnings never fail a run. */
export const ORCHESTRATOR_GATE: Gate = Object.freeze({ strict: false });

/**
 * Declare `--only` on a command that has RETIRED it, solely so the command can
 * explain itself instead of emitting Commander's bare `error: unknown option
 * '--only'`.
 *
 * This is **not** a backward-compatibility shim — the pre-1.0 policy forbids
 * those and this obeys it. The flag does not work: {@link rejectRetiredOnly}
 * refuses the run before any phase is selected, so no caller can keep depending
 * on the old behaviour. What it buys is a diagnosis. An unknown-option error
 * names the flag and nothing else; the reader cannot tell a typo from a removal
 * and has no way to learn what replaced it, so the next move is a bug report or
 * a version pin. Naming the removal, the measurement behind it, and the command
 * where `--only` still exists turns a dead end into a one-line fix.
 *
 * Hidden from `--help` on purpose: a retired flag is not a feature to discover,
 * and listing it would suggest it still selects something.
 */
export function addRetiredOnlyOption(command: Command): Command {
  return command.addOption(
    new Option('--only <phase>', 'Retired — a run is now a whole run.').hideHelp(),
  );
}

/**
 * Refuse the run when a caller passed the retired `--only`, naming what changed.
 *
 * `USAGE_INVALID` (exit 2): the invocation is the mistake, and nothing was
 * examined.
 *
 * @param only - The parsed `--only` value; `undefined` when it was not passed.
 * @param command - Command name for the message, e.g. `vat validate`.
 * @param seconds - The measured full-run duration that made the flag not worth
 *   its coverage risk. Cited so the removal reads as a decision with evidence
 *   rather than a preference.
 * @throws CommandRefusalError `USAGE_INVALID` when `--only` was passed
 */
export function rejectRetiredOnly(only: string | undefined, command: string, seconds: number): void {
  if (only === undefined) return;

  throw new CommandRefusalError(
    'USAGE_INVALID',
    `error: '--only' was removed from '${command}'.\n` +
      `\n` +
      `  A full run measures ~${seconds}s on a 90-skill project, so the flag saved\n` +
      `  little while letting a CI gate silently lose coverage: renaming a config\n` +
      `  key left '--only <that key>' selecting nothing, and the gate stayed green.\n` +
      `\n` +
      `  Fix: drop the flag — '${command}' runs every configured surface.\n` +
      `  Still selective: 'vat build --only <phase>', where a phase is minutes, not seconds.`,
  );
}

export interface PhaseContext {
  logger: ReturnType<typeof createLogger>;
}

/**
 * Create the shared phase command context. Total by design: it builds the
 * context and decides nothing, because it runs outside the orchestrator's
 * refusal handling.
 */
export function createPhaseContext(debugFlag: boolean | undefined): PhaseContext {
  return { logger: createLogger(debugFlag ? { debug: true } : {}) };
}

/**
 * The decision an orchestrator reaches about what `--only` asked for.
 *
 *   - `run`  — go ahead with these phases.
 *   - `fail` — the caller named a phase that is unrecognized, or recognized but
 *              not configured, or the config could not be read: a refusal,
 *              carrying which one.
 *   - `noop` — a bare run in a project that configures nothing. It runs no
 *              phase; the writer refuses the zero-examined run, and the stderr
 *              warning names the likely config typo.
 */
export type PhaseSelection =
  | { kind: 'run'; phases: Phase[] }
  | { kind: 'fail'; code: RefusalCode; message: string }
  | { kind: 'noop'; warning: string };

/** How one orchestrator names the things `--only` selects, for its messages. */
export interface PhaseVocabulary {
  /** Capitalized singular: 'Phase' (build, verify) or 'Surface' (validate). */
  noun: 'Phase' | 'Surface';
  /** The verb in "nothing to <verb>": 'build', 'verify', 'validate'. */
  verb: string;
  /** Every name `--only` accepts, in help order. */
  validNames: readonly string[];
  /** Stderr warning for a bare run with nothing configured. */
  noop?: { warning: string };
}

/**
 * Decide what an orchestrator should do with its `--only` value and the phase
 * list its config produced.
 *
 * THE single decision site for all three orchestrators, so they cannot answer
 * the same question differently. `vat verify` and `vat validate` have retired
 * `--only` and always pass `only: undefined`; `vat build` routes its own
 * `--only` through here.
 *
 * ⚠️ **Nothing may short-circuit ahead of the config-error arm.** A check
 * evaluated before `unreadableConfig` answers a confident "not configured" for a
 * tree whose config could not be parsed — which is the one answer this function
 * must never give, because it is indistinguishable from a correct one.
 *
 * @param unreadableConfig - The config-load error, when the config exists but
 *   could not be parsed. Only `vat verify` passes it, and only defensively — its
 *   phase builder pushes every configured phase when the config is unreadable
 *   (so the phase itself reports the real error), which makes the list non-empty
 *   and this arm unreachable by construction today.
 */
export function decidePhaseSelection(
  only: string | undefined,
  phases: Phase[],
  vocab: PhaseVocabulary,
  options: { unreadableConfig?: string | undefined } = {},
): PhaseSelection {
  const lower = vocab.noun.toLowerCase();

  if (only !== undefined && !vocab.validNames.includes(only)) {
    return {
      kind: 'fail',
      code: 'USAGE_INVALID',
      message: `Unknown ${lower}: ${only}. Valid ${lower}s: ${vocab.validNames.join(', ')}`,
    };
  }

  if (phases.length > 0) {
    return { kind: 'run', phases };
  }

  if (options.unreadableConfig !== undefined) {
    return { kind: 'fail', code: 'CONFIG_INVALID', message: options.unreadableConfig };
  }

  if (only !== undefined) {
    return {
      kind: 'fail',
      code: 'USAGE_INVALID',
      message: `${vocab.noun} '${only}' is not configured in vibe-agent-toolkit.config.yaml — nothing to ${vocab.verb}.`,
    };
  }

  return vocab.noop === undefined
    ? { kind: 'fail', code: 'USAGE_INVALID', message: `No ${lower} to ${vocab.verb}.` }
    : { kind: 'noop', ...vocab.noop };
}

/**
 * Act on a {@link PhaseSelection}: the phases to run, or the refusal.
 *
 * @throws CommandRefusalError for a `fail` selection, carrying its code —
 *   the orchestrator's catch publishes it
 */
export function applyPhaseSelection(
  selection: PhaseSelection,
  logger: ReturnType<typeof createLogger>,
): Phase[] {
  if (selection.kind === 'run') return selection.phases;
  if (selection.kind === 'fail') throw new CommandRefusalError(selection.code, selection.message);
  logger.warn(selection.warning);
  return [];
}

/**
 * Run a single phase in THIS process.
 *
 * In THIS process, because everything an orchestrator reads back from a phase is
 * its report. A process per phase charges, on every phase, a full Node startup
 * and the whole module graph again (~730 ms of remark per isolate), a parse
 * cache whose miss counters restart from zero, and a worker pool built and torn
 * down before the next phase begins.
 *
 * The report is held to the phase's own {@link Phase.schema} before it is
 * folded — the check its verb's writer applies when that verb runs alone. A
 * report the schema rejects is VAT's defect: the `ZodError` carries no code, so
 * it becomes the phase's `INTERNAL_ERROR`, never a finished phase.
 *
 * The `catch` is a BACKSTOP, not the error path: every phase function returns
 * its own refusal as a report. A throw that escaped that becomes the phase's
 * refusal — classified by its code, `INTERNAL_ERROR` when it carries none —
 * rather than aborting the orchestrator and silently skipping every later phase.
 */
export async function runPhase(phase: Phase): Promise<PhaseResult> {
  try {
    const { report } = await phase.run();
    phase.schema.parse(report);
    return { name: phase.name, report };
  } catch (error) {
    return { name: phase.name, report: refusalReport(refusalCodeOf(error), error, ORCHESTRATOR_GATE, NOTHING_FINISHED) };
  }
}

/** One phase as `data.phases` publishes it. */
function phaseEntry({ name, report }: PhaseResult): OrchestratorPhaseEntry {
  return {
    name,
    status: report.status,
    examined: report.examined,
    summary: report.summary,
    ...(report.status === 'error' ? { error: report.error } : {}),
    data: report.data,
  };
}

/** What the phases amount to so far: the sum examined, every finding, every entry. */
function finishedPhases(results: readonly PhaseResult[]): { examined: number; findings: Finding[]; data: OrchestratorData } {
  return {
    examined: results.reduce((sum, { report }) => sum + report.examined, 0),
    findings: results.flatMap(({ report }) => report.findings),
    data: { phases: results.map(phaseEntry) },
  };
}

/**
 * Fold the phases into the orchestrator's ONE report.
 *
 * `findings` is every phase's findings with its `location` unchanged; `examined`
 * is the sum of the phases' own; `data.phases` is one entry per phase. Any phase
 * that did not finish makes the run `error` with `RUN_INCOMPLETE`, naming the
 * phases that stopped, and the finished ones stay in `data.phases` — a failed
 * phase never erases what the others found.
 *
 * Pure: the writer applies run integrity to the sum when it publishes.
 *
 * @param results - Every phase that ran, in execution order
 * @param gate - The gate the run is judged by
 * @param durationMs - Wall-clock milliseconds the run took; carried by a completed
 *   run only, as no refusal document carries `durationMs`
 * @returns The report, before the writer's run-integrity pass
 */
export function orchestratorReport(
  results: readonly PhaseResult[],
  gate: Gate,
  durationMs?: number,
): Report<OrchestratorData> {
  const finished = finishedPhases(results);
  const failed = results.filter(({ report }) => report.status === 'error');
  if (failed.length === 0) return buildReport({ ...finished, gate, durationMs });
  const named = failed.map(({ name, report }) => (report.status === 'error' ? `'${name}' (${report.error.code})` : name)).join(', ');
  return buildErrorReport({
    error: {
      code: 'RUN_INCOMPLETE',
      message: `The run did not finish: phase ${named} stopped before it did. The phases that finished are in data.phases.`,
    },
    gate,
    ...finished,
  });
}

/**
 * Run an orchestrator's body and fold it into its ONE report.
 *
 * `body` pushes each phase that ran onto `results`. A throw from it — the
 * refused `--only`, a positional argument, no project root, discovery that
 * could not see the tree — is classified by its code and becomes the
 * envelope's error branch carrying every phase that already finished. The
 * command publishes the result with `endWithReport`.
 *
 * @param body - The run; it records each phase's result as it finishes
 * @returns The orchestrator's report, before the writer's run-integrity pass
 */
export async function orchestrate(body: (results: PhaseResult[]) => Promise<void>): Promise<Report<unknown>> {
  const startTime = Date.now();
  const results: PhaseResult[] = [];
  try {
    await body(results);
  } catch (error) {
    const finished: FinishedWork = results.length === 0 ? NOTHING_FINISHED : finishedPhases(results);
    return refusalReport(refusalCodeOf(error), error, ORCHESTRATOR_GATE, finished);
  }
  const report = orchestratorReport(results, ORCHESTRATOR_GATE, Date.now() - startTime);
  if (report.status === 'error') process.stderr.write(`${report.error.message}\n`);
  return report;
}

/** No orchestrator offers `--format`: the document is YAML. */
export const ORCHESTRATOR_FORMAT: DocumentFormat = 'yaml';
