/**
 * Shared utilities for top-level phase orchestration commands (vat build, vat verify, vat validate).
 */

import { spawnSync } from 'node:child_process';

import { type SeverityCounts } from '@vibe-agent-toolkit/agent-schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import * as YAML from 'yaml';

import { createLogger } from '../utils/logger.js';
import { writeYamlOutput } from '../utils/output.js';

export interface Phase {
  name: string;
  args: string[];
}

/**
 * Outcome of one orchestrated phase.
 *
 * `system-error` is a value of its own because **a phase that could not RUN is
 * not a phase that found problems.** Collapsing it into `error` (which is what
 * `result.status === 0 ? 'passed' : 'failed'` did) made the documented exit
 * code 2 unreachable from every orchestrator, so a CI script could not tell an
 * invalid config or a killed child from a broken link.
 *
 * `warning` reaches a subprocess phase through the child's own reported
 * `status`, NOT through its exit code — `vat skills validate` exits 0 while
 * reporting `status: warning`, so an exit-code-only mapping answered `success`
 * on the very tree where the child said otherwise. In-process phases (e.g.
 * verify's consistency check) emit it directly.
 */
export type PhaseStatus = 'success' | 'warning' | 'error' | 'system-error';

/** The phase outcome for "we did not learn what this phase would have said". */
export const SYSTEM_ERROR: PhaseStatus = 'system-error';

export interface PhaseResult {
  name: string;
  status: PhaseStatus;
  /** Child exit code, when the child ran and exited on its own. */
  exitCode?: number;
  /** POSIX signal that killed the child, when one did (then `exitCode` is absent). */
  signal?: string;
  /** Why the phase could not run at all (the spawn itself failed). */
  error?: string;
  /**
   * Per-severity distribution for in-process phases that hold their own
   * findings. Absent for subprocess phases: the child owns its own findings,
   * and inventing counts here would be a second, weaker answer — the child's
   * are carried verbatim in {@link PhaseResult.report} instead.
   */
  issueCounts?: SeverityCounts;
  /**
   * The child's own YAML document, parsed and folded in.
   *
   * The child used to write this straight onto the parent's stdout (`stdio:
   * 'inherit'`), which concatenated N documents with no `---` between them: two
   * phases produced one map carrying `status:` and `durationSecs:` twice, and
   * `YAML.parse()` threw "Map keys must be unique". Nesting each child's
   * document under its own phase makes the parent's stdout one parseable
   * document again and loses nothing.
   */
  report?: unknown;
}

/** The subset of a `spawnSync` return that decides a phase's outcome. */
export interface PhaseSpawnOutcome {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error | undefined;
  /** The child's captured stdout, when it was piped rather than inherited. */
  stdout?: string | null | undefined;
}

/**
 * Resolve the absolute path to the vat binary.
 * This file lives in commands/, one level above bin/.
 */
export function resolveBinPath(): string {
  // Use bin.js directly (not the vat.js wrapper) so phase subprocesses always
  // run the same binary that is currently executing, regardless of cwd or
  // context detection (which would pick up the adopter project's local install).
  return safePath.resolve(safePath.join(import.meta.dirname, '../bin.js'));
}

export interface PhaseContext {
  logger: ReturnType<typeof createLogger>;
  startTime: number;
  binPath: string;
}

/**
 * Create the shared phase command context: logger, startTime, and bin path.
 *
 * It used to THROW when the phase list came out empty — and it was called
 * before the command's try block, so an unroutable `--only` reached the user as
 * a raw Node stack trace with zero bytes of stdout and an exit 1 that looked
 * like "validation errors". `--only` routing is decided by
 * {@link decidePhaseSelection} and reported by {@link applyPhaseSelection} now,
 * which emit the command's normal structured document.
 */
export function createPhaseContext(debugFlag: boolean | undefined): PhaseContext {
  return {
    logger: createLogger(debugFlag ? { debug: true } : {}),
    startTime: Date.now(),
    binPath: resolveBinPath(),
  };
}

/**
 * The decision an orchestrator reaches about what `--only` asked for.
 *
 * Three arms, because the three answers carry different exit codes and none of
 * them may be collapsed into another:
 *   - `run`  — go ahead with these phases (possibly none, when the requested
 *              phase runs in-process rather than as a subprocess).
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
 * Shared by all three orchestrators because they used to disagree: `vat verify`
 * built its phase list without consulting the config at all, so `vat verify
 * --only skills` in a project with no `skills:` block exited 0 while `vat
 * validate --only skills` on the same project exited 1 — opposite verdicts on
 * the same question.
 *
 * @param emptyIsValid - True when an empty subprocess list is a legitimate
 *   outcome (verify's `--only consistency` runs in-process).
 * @param unreadableConfig - The config-load error, when the config exists but
 *   could not be parsed. A broken config is NOT "the phase is unconfigured":
 *   we do not know what it declares, so we must not answer with a confident
 *   "not configured".
 */
export function decidePhaseSelection(
  only: string | undefined,
  phases: Phase[],
  vocab: PhaseVocabulary,
  options: { emptyIsValid?: boolean; unreadableConfig?: string | undefined } = {},
): PhaseSelection {
  const lower = vocab.noun.toLowerCase();

  if (only !== undefined && !vocab.validNames.includes(only)) {
    return {
      kind: 'fail',
      message: `Unknown ${lower}: ${only}. Valid ${lower}s: ${vocab.validNames.join(', ')}`,
    };
  }

  if (phases.length > 0 || options.emptyIsValid === true) {
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
 * Both terminal arms go through `writeYamlOutput` deliberately. A `--only`
 * failure used to be an uncaught throw, so the one output a scripted caller
 * parses — the YAML document on stdout — was never written at all.
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

/** Every value a child may legitimately report as its own `status`. */
const REPORTABLE_STATUSES = new Set<string>(PHASE_STATUS_ORDER);

/** Outcome of reading the child's stdout: a document, nothing, or a failure. */
interface ChildReport {
  report?: unknown;
  parseError?: string;
}

/**
 * Parse the child's captured stdout into its reported document.
 *
 * Takes the LAST non-empty document in the stream: every orchestrated child
 * writes its summary last, and a child that happens to emit more than one
 * document must not make the summary unreadable.
 *
 * Empty stdout is NOT a failure — `vat skills validate` legitimately exits 0
 * printing nothing when there is no `skills:` block. Stdout that exists but
 * cannot be parsed IS a failure: the child crashed mid-answer, and the phase
 * must degrade to `system-error` rather than throw an unhandled exception out
 * of the orchestrator.
 */
function parseChildReport(name: string, stdout: string | null | undefined): ChildReport {
  if (stdout === undefined || stdout === null || stdout.trim() === '') {
    return {};
  }

  let documents;
  try {
    documents = YAML.parseAllDocuments(stdout);
  } catch (error) {
    return { parseError: unparseableMessage(name, error) };
  }

  const last = documents.findLast((doc) => doc.contents !== null);
  if (last === undefined) {
    return {};
  }
  if (last.errors.length > 0) {
    return { parseError: unparseableMessage(name, last.errors[0]) };
  }
  return { report: last.toJS() };
}

function unparseableMessage(name: string, cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return `Phase '${name}' wrote unparseable output on stdout: ${detail}`;
}

/** The status an exit code alone implies, before the child's report is read. */
function statusFromExitCode(status: number): PhaseStatus {
  if (status === 0) return 'success';
  if (status === 1) return 'error';
  return SYSTEM_ERROR;
}

/** The status the child claimed for itself, when it claimed a recognized one. */
function statusFromReport(report: unknown): PhaseStatus | undefined {
  if (typeof report !== 'object' || report === null) return undefined;
  const claimed = (report as { status?: unknown }).status;
  return typeof claimed === 'string' && REPORTABLE_STATUSES.has(claimed)
    ? (claimed as PhaseStatus)
    : undefined;
}

/**
 * Map a spawn outcome to a phase outcome. The pure core of {@link runPhase}.
 *
 * Every branch that is NOT "the child ran and told us what it found" is a
 * system error, because the orchestrator learned nothing about the artifact:
 *
 * | spawn outcome            | phase status   | why                                        |
 * |--------------------------|----------------|--------------------------------------------|
 * | `error` set              | `system-error` | the child never ran                        |
 * | killed by a signal       | `system-error` | the child was cut off mid-answer           |
 * | no exit code, no signal  | `system-error` | there is no answer to read                 |
 * | stdout not parseable     | `system-error` | the child's answer cannot be read          |
 * | exit 0                   | `success`      | ran, found nothing actionable              |
 * | exit 1                   | `error`        | ran, found validation errors               |
 * | exit 2 (or any other)    | `system-error` | the child itself reported a system error    |
 *
 * The exit code is then reconciled with the child's OWN reported `status`,
 * worst-wins. An exit code has three values and cannot express `warning`, so
 * `vat skills validate` — which exits 0 while reporting `status: warning` —
 * was being recorded as `success` by every orchestrator, including the one
 * VAT's CI dogfoods on VAT itself.
 */
export function phaseResultFromSpawn(name: string, outcome: PhaseSpawnOutcome): PhaseResult {
  if (outcome.error !== undefined) {
    return { name, status: SYSTEM_ERROR, error: `Failed to spawn phase: ${outcome.error.message}` };
  }
  if (outcome.signal !== null) {
    return {
      name,
      status: SYSTEM_ERROR,
      signal: outcome.signal,
      error: `Phase '${name}' was killed by signal ${outcome.signal}`,
    };
  }
  if (outcome.status === null) {
    return { name, status: SYSTEM_ERROR, error: `Phase '${name}' exited without a status code` };
  }

  const exitCode = outcome.status;
  const { report, parseError } = parseChildReport(name, outcome.stdout);
  if (parseError !== undefined) {
    return { name, status: SYSTEM_ERROR, exitCode, error: parseError };
  }

  const exitStatus = statusFromExitCode(exitCode);
  const reported = statusFromReport(report);
  const status = reported === undefined ? exitStatus : worseOf(exitStatus, reported);

  return {
    name,
    status,
    exitCode,
    ...(exitStatus === SYSTEM_ERROR
      ? { error: `Phase '${name}' exited with system-error code ${exitCode}` }
      : {}),
    ...(report === undefined ? {} : { report }),
  };
}

/**
 * Cap on a captured child document, well above the ~2.3 MB a large real project
 * produces. spawnSync's 1 MB default would set ENOBUFS and hand back a
 * TRUNCATED (and therefore unparseable) document; exceeding this cap surfaces
 * as a loud `system-error`, never as a silently shortened report.
 */
const MAX_PHASE_STDOUT_BYTES = 256 * 1024 * 1024;

/**
 * Run a single phase by spawning the vat binary with the phase args.
 *
 * stdout is CAPTURED, not inherited: the child's YAML document belongs in this
 * phase's `report`, and letting it stream onto the parent's stdout is what made
 * `vat validate`'s output a run of documents with no `---` between them.
 * stderr stays inherited — progress output is on stderr by design and must keep
 * streaming live rather than arriving in one lump at the end.
 */
export function runPhase(binPath: string, phase: Phase): PhaseResult {
  const result = spawnSync(process.execPath, [binPath, ...phase.args], {
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: MAX_PHASE_STDOUT_BYTES,
  });
  return phaseResultFromSpawn(phase.name, {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout,
  });
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
