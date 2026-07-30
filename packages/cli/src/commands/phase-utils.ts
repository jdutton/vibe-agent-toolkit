/**
 * Shared utilities for top-level phase orchestration commands (vat build, vat verify, vat validate).
 */

import { spawnSync } from 'node:child_process';

import { type SeverityCounts } from '@vibe-agent-toolkit/agent-schema';
import { safePath } from '@vibe-agent-toolkit/utils';

import { createLogger } from '../utils/logger.js';

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
 * `warning` cannot arrive from a subprocess — an exit code cannot express it —
 * but in-process phases (e.g. verify's consistency check) emit it.
 */
export type PhaseStatus = 'success' | 'warning' | 'error' | 'system-error';

/** The phase outcome for "we did not learn what this phase would have said". */
const SYSTEM_ERROR: PhaseStatus = 'system-error';

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
   * findings. Absent for subprocess phases: the child owns and prints its own
   * findings, and inventing counts here would be a second, weaker answer.
   */
  issueCounts?: SeverityCounts;
}

/** The subset of a `spawnSync` return that decides a phase's outcome. */
export interface PhaseSpawnOutcome {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error | undefined;
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
 * Create the shared phase command context: logger, startTime, and validated bin path.
 * Throws if the phases list is empty (indicating an unknown --only value).
 *
 * @param debugFlag - Whether debug logging is enabled
 * @param phases - Pre-built list of phases to validate
 * @param onlyValue - The --only flag value (for the error message)
 * @param validPhaseNames - Human-readable list of valid phase names (for error message)
 * @returns Initialized phase context
 * @throws Error if phases list is empty
 */
export function createPhaseContext(
  debugFlag: boolean | undefined,
  phases: Phase[],
  onlyValue: string | undefined,
  validPhaseNames: string
): PhaseContext {
  if (phases.length === 0) {
    throw new Error(`Unknown phase: ${onlyValue ?? ''}. Valid phases: ${validPhaseNames}`);
  }
  return {
    logger: createLogger(debugFlag ? { debug: true } : {}),
    startTime: Date.now(),
    binPath: resolveBinPath(),
  };
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
 * | exit 0                   | `success`      | ran, found nothing actionable              |
 * | exit 1                   | `error`        | ran, found validation errors               |
 * | exit 2 (or any other)    | `system-error` | the child itself reported a system error    |
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
  if (outcome.status === 0) {
    return { name, status: 'success', exitCode: 0 };
  }
  if (outcome.status === 1) {
    return { name, status: 'error', exitCode: 1 };
  }
  return {
    name,
    status: SYSTEM_ERROR,
    exitCode: outcome.status,
    error: `Phase '${name}' exited with system-error code ${outcome.status}`,
  };
}

/**
 * Run a single phase by spawning the vat binary with the phase args.
 */
export function runPhase(binPath: string, phase: Phase): PhaseResult {
  const result = spawnSync(process.execPath, [binPath, ...phase.args], {
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  return phaseResultFromSpawn(phase.name, result);
}

/** Rank used by {@link aggregatePhaseStatus}: later wins. */
const PHASE_STATUS_ORDER: readonly PhaseStatus[] = ['success', 'warning', 'error', 'system-error'];

/**
 * Worst-wins aggregate across phases. `system-error` outranks `error`: "we could
 * not determine the answer" must never be filed under "we determined it is bad".
 */
export function aggregatePhaseStatus(results: readonly PhaseResult[]): PhaseStatus {
  let worst: PhaseStatus = 'success';
  for (const { status } of results) {
    if (PHASE_STATUS_ORDER.indexOf(status) > PHASE_STATUS_ORDER.indexOf(worst)) {
      worst = status;
    }
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
