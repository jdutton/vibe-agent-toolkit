/**
 * Shared utilities for top-level phase orchestration commands (vat build, vat verify, vat validate).
 */

import { type SeverityCounts } from '@vibe-agent-toolkit/schema';
import { type Command, Option } from 'commander';

import { createLogger } from '../utils/logger.js';
import { writeYamlOutput } from '../utils/output.js';

/**
 * What one phase produced: the document it publishes, and the exit code it
 * claims for itself.
 *
 * This pair is the whole of what an orchestrator needs from a phase: an exit
 * code, and the document the phase publishes. Naming it as a value is what lets
 * a phase run in the orchestrator's own process — stderr streams directly either
 * way, so nothing else has to cross.
 *
 * `document` is the object the phase PRINTS, not the internal summary it is
 * built from. The distinction is load-bearing: `vat skills build` renders its
 * summary in two pieces and publishes `skillsWithErrors` as a COUNT while the
 * summary object holds an ARRAY under that name.
 *
 * ⚠️ This field is `unknown`, so nothing typechecks it. Handing back the summary
 * object instead of the printed document changes the emitted contract silently.
 */
export interface PhaseOutcome {
  document: unknown;
  exitCode: number;
  /**
   * The phase failed UNEXPECTEDLY, so `document` is the shared error envelope
   * (`{status, error, duration}`) rather than the command's own report.
   *
   * The orchestrated lane does not need this — it folds any document under
   * `phases[].report` the same way. The command-line lane does: each command
   * renders its own report with its own renderer (streamed YAML, `--format
   * json`, a hand-built header), and none of those renderers understand an
   * envelope. Handing one to them silently changes both the channel and the
   * shape of the failure document every `vat … | jq` consumer depends on.
   */
  failed?: boolean;
}

/**
 * One orchestrated phase: a name, and the work to run for it.
 *
 * `run` is a bound closure rather than an argv array because the phase executes
 * in this process. An argv array would mean re-entering Commander to
 * parse arguments this process has already parsed — a second, weaker copy of the
 * orchestrator's own options, and the exact seam through which `vat validate`'s
 * `--verbose` could be forwarded to one phase and dropped by another.
 */
export interface Phase {
  name: string;
  run: () => Promise<PhaseOutcome>;
}

/**
 * Declare `--only` on a command that has RETIRED it, solely so the command can
 * explain itself instead of emitting Commander's bare `error: unknown option
 * '--only'`.
 *
 * This is **not** a backward-compatibility shim — the pre-1.0 policy forbids
 * those and this obeys it. The flag does not work: {@link rejectRetiredOnly}
 * fails the run before any phase is selected, so no caller can keep depending
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
 * Fail the run when a caller passed the retired `--only`, naming what changed.
 *
 * Exit 1, matching both Commander's usage-error convention and the exit code an
 * unroutable `--only` already produced on these commands, so a CI gate that was
 * failing on a bad `--only` keeps failing rather than flipping to green.
 *
 * @param only - The parsed `--only` value; `undefined` when it was not passed.
 * @param command - Command name for the message, e.g. `vat validate`.
 * @param seconds - The measured full-run duration that made the flag not worth
 *   its coverage risk. Cited so the removal reads as a decision with evidence
 *   rather than a preference.
 */
export function rejectRetiredOnly(only: string | undefined, command: string, seconds: number): void {
  if (only === undefined) return;

  process.stderr.write(
    `error: '--only' was removed from '${command}'.\n` +
      `\n` +
      `  A full run measures ~${seconds}s on a 90-skill project, so the flag saved\n` +
      `  little while letting a CI gate silently lose coverage: renaming a config\n` +
      `  key left '--only <that key>' selecting nothing, and the gate stayed green.\n` +
      `\n` +
      `  Fix: drop the flag — '${command}' runs every configured surface.\n` +
      `  Still selective: 'vat build --only <phase>', where a phase is minutes, not seconds.\n`,
  );
  process.exit(1);
}

/**
 * Outcome of one orchestrated phase.
 *
 * `system-error` is a value of its own because **a phase that could not RUN is
 * not a phase that found problems.**
 *
 * ⚠️ Any two-valued mapping — `status === 0 ? 'passed' : 'failed'` and its
 * relatives — collapses it into `error` and makes the documented exit code 2
 * unreachable from every orchestrator, leaving a CI script unable to tell an
 * invalid config from a broken link.
 *
 * `warning` reaches a phase through its own reported `status`, NOT through its
 * exit code — `vat skills validate` exits 0 while reporting `status: warning`,
 * so an exit-code-only mapping answered `success` on the very tree where the
 * phase said otherwise. Phases that hold their own findings (e.g. verify's
 * consistency check) emit it directly.
 */
export type PhaseStatus = 'success' | 'warning' | 'error' | 'system-error';

/** The phase outcome for "we did not learn what this phase would have said". */
export const SYSTEM_ERROR: PhaseStatus = 'system-error';

export interface PhaseResult {
  name: string;
  status: PhaseStatus;
  /** The exit code the phase claimed for itself. */
  exitCode?: number;
  /** Why the phase could not run at all (it threw past its own error handling). */
  error?: string;
  /**
   * Per-severity distribution for phases that hold their own findings and
   * publish no document of their own. Absent for phases that DO publish one:
   * those own their findings, and inventing counts here would be a second,
   * weaker answer — theirs are carried verbatim in {@link PhaseResult.report}.
   */
  issueCounts?: SeverityCounts;
  /**
   * The phase's own document, folded in under its name.
   *
   * Nested under the phase's own entry so the orchestrator's stdout stays ONE
   * parseable document.
   *
   * ⚠️ Phase documents written onto a shared stdout concatenate with no `---`
   * between them: two phases each carrying `status:` and `durationSecs:` become
   * a single map with duplicate keys, and `YAML.parse()` throws "Map keys must
   * be unique".
   */
  report?: unknown;
}

export interface PhaseContext {
  logger: ReturnType<typeof createLogger>;
  startTime: number;
}

/**
 * Create the shared phase command context: logger, startTime, and bin path.
 *
 * Total by design: it builds the context and decides nothing.
 *
 * ⚠️ This runs BEFORE the command's try block, so anything that throws here
 * reaches the user as a raw Node stack trace with zero bytes of stdout and an
 * exit 1 indistinguishable from "validation errors". Phase routing therefore
 * belongs to {@link decidePhaseSelection} and {@link applyPhaseSelection}, which
 * emit the command's normal structured document.
 */
export function createPhaseContext(debugFlag: boolean | undefined): PhaseContext {
  return {
    logger: createLogger(debugFlag ? { debug: true } : {}),
    startTime: Date.now(),
  };
}

/**
 * The decision an orchestrator reaches about what `--only` asked for.
 *
 * Three arms, because the three answers carry different exit codes and none of
 * them may be collapsed into another:
 *   - `run`  — go ahead with these phases.
 *   - `fail` — the caller named a phase that is unrecognized, or recognized but
 *              not configured. Exit 1: a CI gate asked for coverage that cannot
 *              run and must not stay green.
 *   - `noop` — a bare run in a project that configures nothing. Exit 0, but
 *              WARNED, so a config typo is not indistinguishable from success.
 */
export type PhaseSelection =
  | { kind: 'run'; phases: Phase[] }
  | { kind: 'fail'; message: string }
  | { kind: 'noop'; warning: string; note: string };

/** How one orchestrator names the things `--only` selects, for its messages. */
export interface PhaseVocabulary {
  /** Capitalized singular: 'Phase' (build, verify) or 'Surface' (validate). */
  noun: 'Phase' | 'Surface';
  /** The verb in "nothing to <verb>": 'build', 'verify', 'validate'. */
  verb: string;
  /** Every name `--only` accepts, in help order. */
  validNames: readonly string[];
  /** Stderr warning + stdout note for a bare run with nothing configured. */
  noop?: { warning: string; note: string };
}

/**
 * Decide what an orchestrator should do with its `--only` value and the phase
 * list its config produced.
 *
 * THE single decision site for all three orchestrators, so they cannot answer
 * the same question differently. An orchestrator that builds its phase list
 * without consulting the config exits 0 on `--only skills` in a project with no
 * `skills:` block while another exits 1 — opposite verdicts on one question.
 * `vat verify` has retired `--only` and always passes `only: undefined`;
 * `vat validate` and `vat build` route their own `--only` through here.
 *
 * ⚠️ **Nothing may short-circuit ahead of the config-error arm.** A check
 * evaluated before `unreadableConfig` answers a confident "not configured" for a
 * tree whose config could not be parsed — which is the one answer this function
 * must never give, because it is indistinguishable from a correct one.
 *
 * @param unreadableConfig - The config-load error, when the config exists but
 *   could not be parsed. A broken config is NOT "the phase is unconfigured":
 *   we do not know what it declares, so we must not answer with a confident
 *   "not configured". Only `vat verify` passes it, and only defensively — its
 *   phase builder pushes every configured phase when the config is unreadable
 *   (so the phase itself reports the real error), which makes the list non-empty
 *   and this arm unreachable by construction today. It is kept because the arm
 *   that would otherwise catch an empty list is the "not configured" lie.
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
      message: `Unknown ${lower}: ${only}. Valid ${lower}s: ${vocab.validNames.join(', ')}`,
    };
  }

  if (phases.length > 0) {
    return { kind: 'run', phases };
  }

  if (options.unreadableConfig !== undefined) {
    return { kind: 'fail', message: options.unreadableConfig };
  }

  if (only !== undefined) {
    return {
      kind: 'fail',
      message: `${vocab.noun} '${only}' is not configured in vibe-agent-toolkit.config.yaml — nothing to ${vocab.verb}.`,
    };
  }

  return vocab.noop === undefined
    ? { kind: 'fail', message: `No ${lower} to ${vocab.verb}.` }
    : { kind: 'noop', ...vocab.noop };
}

/**
 * Act on a {@link PhaseSelection}: return the phases to run, or emit the
 * command's normal structured document and exit.
 *
 * Both terminal arms go through `writeYamlOutput` deliberately: the YAML
 * document on stdout is the one output a scripted caller parses, so a routing
 * failure has to publish one rather than throw past it.
 */
export function applyPhaseSelection(
  selection: PhaseSelection,
  logger: ReturnType<typeof createLogger>,
  startTime: number,
): Phase[] {
  if (selection.kind === 'run') {
    return selection.phases;
  }

  if (selection.kind === 'fail') {
    logger.error(selection.message);
    writeYamlOutput({
      status: 'error',
      phases: [],
      error: selection.message,
      duration: `${Date.now() - startTime}ms`,
    });
    return process.exit(1);
  }

  logger.warn(selection.warning);
  writeYamlOutput({
    status: 'success',
    phases: [],
    note: selection.note,
    duration: `${Date.now() - startTime}ms`,
  });
  return process.exit(0);
}

/** Rank used by {@link worseOf}: later wins. */
const PHASE_STATUS_ORDER: readonly PhaseStatus[] = ['success', 'warning', 'error', 'system-error'];

/** The worse of two phase statuses, per {@link PHASE_STATUS_ORDER}. */
export function worseOf(a: PhaseStatus, b: PhaseStatus): PhaseStatus {
  return PHASE_STATUS_ORDER.indexOf(b) > PHASE_STATUS_ORDER.indexOf(a) ? b : a;
}

/** Every value a phase may legitimately report as its own `status`. */
const REPORTABLE_STATUSES = new Set<string>(PHASE_STATUS_ORDER);

/** The status an exit code alone implies, before the phase's report is read. */
function statusFromExitCode(status: number): PhaseStatus {
  if (status === 0) return 'success';
  if (status === 1) return 'error';
  return SYSTEM_ERROR;
}

/** The status the phase claimed for itself, when it claimed a recognized one. */
function statusFromReport(report: unknown): PhaseStatus | undefined {
  if (typeof report !== 'object' || report === null) return undefined;
  const claimed = (report as { status?: unknown }).status;
  return typeof claimed === 'string' && REPORTABLE_STATUSES.has(claimed)
    ? (claimed as PhaseStatus)
    : undefined;
}

/**
 * Map what a phase produced to its outcome. The pure core of {@link runPhase}.
 *
 * | exit code             | phase status   | why                                     |
 * |-----------------------|----------------|-----------------------------------------|
 * | 0                     | `success`      | ran, found nothing actionable           |
 * | 1                     | `error`        | ran, found validation errors            |
 * | 2 (or any other)      | `system-error` | the phase itself reported a system error |
 *
 * The exit code is then reconciled with the phase's OWN reported `status`,
 * worst-wins. An exit code has three values and cannot express `warning`:
 * `vat skills validate` exits 0 while reporting `status: warning`, so its exit
 * code alone reads as `success` — including on the tree VAT's CI dogfoods on
 * VAT itself.
 *
 * The table has no row for a signal kill, a missing status code, or a document
 * that fails to parse, and that is the design rather than an omission. A phase
 * runs in this process: there is no serialization step in which to lose a
 * document, and no signal that could take a phase without taking the
 * orchestrator with it.
 */
export function phaseResultFromOutcome(name: string, outcome: PhaseOutcome): PhaseResult {
  const { exitCode, document } = outcome;
  const exitStatus = statusFromExitCode(exitCode);
  const reported = statusFromReport(document);
  const status = reported === undefined ? exitStatus : worseOf(exitStatus, reported);

  return {
    name,
    status,
    exitCode,
    ...(exitStatus === SYSTEM_ERROR
      ? { error: `Phase '${name}' exited with system-error code ${exitCode}` }
      : {}),
    ...(document === undefined ? {} : { report: document }),
  };
}

/**
 * End a command-line run from a phase outcome: publish the document, then exit.
 *
 * THE single place the two lanes diverge, so they cannot diverge anywhere else.
 * A phase hands back the same `{ document, exitCode }` either way; this decides
 * what a *command* does with it, while an orchestrator folds it into
 * `phases[].report` instead.
 *
 * Three cases, and the middle one is the one to get right:
 *   - an unexpected failure publishes the shared envelope through
 *     `writeYamlOutput`, matching `handleCommandError`;
 *   - a command's own report goes through the command's own `render`;
 *   - no document at all (an unconfigured run, a dry run) publishes nothing.
 *
 * @param outcome - What the phase produced
 * @param render - How this command publishes its OWN report shape
 */
export function finishCommand(outcome: PhaseOutcome, render: (document: unknown) => void): never {
  if (outcome.failed === true) {
    writeYamlOutput(outcome.document);
  } else if (outcome.document !== undefined) {
    render(outcome.document);
  }
  return process.exit(outcome.exitCode);
}

/**
 * Run a single phase in THIS process and fold its outcome into a result.
 *
 * In THIS process, because everything an orchestrator reads back from a phase is
 * the {@link PhaseOutcome} pair. A process per phase buys neither half of it and
 * charges, on every phase, a full Node startup and the whole module graph again
 * (~730 ms of remark per isolate), a parse cache whose miss counters restart
 * from zero, and a worker pool built and torn down before the next phase begins.
 * Phases run sequentially, so none of that cost is ever overlapped with work.
 *
 * The `catch` is a BACKSTOP, not the error path. Every phase function reports
 * its own failures through `reportCommandError` and returns them as a document.
 *
 * ⚠️ This arm exists for a throw that escaped that handling. Sharing the
 * orchestrator's process is what makes it load-bearing: an escaped throw aborts
 * the orchestrator itself and silently skips every later phase.
 */
export async function runPhase(phase: Phase): Promise<PhaseResult> {
  try {
    return phaseResultFromOutcome(phase.name, await phase.run());
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      name: phase.name,
      status: SYSTEM_ERROR,
      error: `Phase '${phase.name}' threw past its own error handling: ${detail}`,
    };
  }
}

/**
 * Worst-wins aggregate across phases. `system-error` outranks `error`: "we could
 * not determine the answer" must never be filed under "we determined it is bad".
 */
export function aggregatePhaseStatus(results: readonly PhaseResult[]): PhaseStatus {
  let worst: PhaseStatus = 'success';
  for (const { status } of results) {
    worst = worseOf(worst, status);
  }
  return worst;
}

/**
 * One phase's per-severity distribution, wherever that phase keeps it.
 *
 * A phase that holds its own findings publishes {@link PhaseResult.issueCounts}.
 * A phase that publishes its own document deliberately does not — it owns its
 * findings, and its document rides verbatim in {@link PhaseResult.report}.
 *
 * ⚠️ Both places must be read. Reading only `issueCounts` makes an
 * orchestrator's header report `{0, 0, 0}` over phases that just reported 12
 * warnings.
 *
 * Absent or malformed counts read as zero rather than throwing: a phase that
 * publishes no distribution contributes nothing to the total.
 */
export function phaseIssueCounts(result: PhaseResult): SeverityCounts {
  if (result.issueCounts) return result.issueCounts;
  const counts = (result.report as { issueCounts?: unknown } | undefined)?.issueCounts;
  if (typeof counts !== 'object' || counts === null) return { errors: 0, warnings: 0, info: 0 };
  const { errors, warnings, info } = counts as Record<string, unknown>;
  return {
    errors: typeof errors === 'number' ? errors : 0,
    warnings: typeof warnings === 'number' ? warnings : 0,
    info: typeof info === 'number' ? info : 0,
  };
}

/**
 * Sum every phase's distribution, so an orchestrator's header total reconciles
 * against the phases printed beneath it.
 *
 * The companion to {@link aggregatePhaseStatus}: status is worst-wins ACROSS
 * phases, so a header whose `status` can see the phases while its `issueCounts`
 * cannot publishes a contradiction in one document — `status: warning` beside
 * `warnings: 0`.
 */
export function aggregatePhaseIssueCounts(results: readonly PhaseResult[]): SeverityCounts {
  const total: SeverityCounts = { errors: 0, warnings: 0, info: 0 };
  for (const result of results) {
    const { errors, warnings, info } = phaseIssueCounts(result);
    total.errors += errors;
    total.warnings += warnings;
    total.info += info;
  }
  return total;
}

/**
 * The process exit code for a set of phase outcomes, per the exit-code contract
 * every orchestrator's help text documents: 0 pass, 1 validation failure,
 * 2 system error. Warnings do not fail a run — they are published in the status
 * and counts instead.
 */
export function exitCodeForPhases(results: readonly PhaseResult[]): 0 | 1 | 2 {
  const worst = aggregatePhaseStatus(results);
  if (worst === SYSTEM_ERROR) return 2;
  return worst === 'error' ? 1 : 0;
}
