/**
 * Timing whole CI sequences: several (build, arm, cache state) arms, run
 * INTERLEAVED by round in one prepared tree, each in its own store, `TMPDIR` and
 * home.
 *
 * Every arm reports min, median and IQR over its measured rounds — or, when any
 * repetition broke its sequence rule or a step exited otherwise than committed,
 * the failure and no statistic at all. Each repetition carries what a bar needs
 * to assert on: every step's exit, its full stderr, and the population its
 * document reported. Bars over these numbers are `bars.ts`'s.
 */

import type { ArmEnvironment } from '../../harness/arm-env.js';
import type { MeasuredSequenceSpec } from '../../harness/commands.js';
import type { StepProvenance } from '../../harness/provenance.js';
import { commandStep, type RepeatSpec, runInterleaved, summarizeRepeatFailures } from '../../harness/repeat.js';
import type { SequenceResult, SequenceStep } from '../../harness/sequence.js';
import type { CacheMode, ResolvedInstrument } from '../../harness/types.js';

import { type PerfSummary, summarize } from './stats.js';

/** One build under measurement, by the alias its arms name it with. */
export interface ArmsBuild {
  readonly alias: string;
  readonly instrument: ResolvedInstrument;
}

/** One arm to time: a build, a sequence and a cache state. */
export interface ArmSelection {
  /** A {@link ArmsBuild.alias}. */
  readonly build: string;
  /** The arm's name (`A`, `B`, `C`), part of its directory name. */
  readonly arm: string;
  readonly state: CacheMode;
  readonly steps: readonly SequenceStep[];
}

/** Everything {@link captureArms} needs. */
export interface CaptureArmsRequest {
  /** Arms live under `<out>/arms/`. */
  readonly out: string;
  /** The tree every step runs in — the prepared clone, never the developer's checkout. */
  readonly cwd: string;
  readonly builds: readonly ArmsBuild[];
  readonly arms: readonly ArmSelection[];
  /** Measured rounds; every arm runs once per round. */
  readonly rounds: number;
  /** The caller's own environment, layered over every arm's. */
  readonly env: ArmEnvironment;
  readonly timeoutMs?: number;
}

/** One step of one repetition, as the report keeps it. */
export interface ArmStepRecord {
  readonly name: string;
  readonly timed: boolean;
  readonly exitCode: number | null;
  readonly wallMs: number;
  /** The step's whole stderr, so a bar can assert a line's absence on every run. */
  readonly stderr: string;
  readonly provenance: StepProvenance | null;
}

/** One repetition (or the priming run) of an arm. */
export interface ArmRepetition {
  /** The sum of the timed steps. */
  readonly wallMs: number;
  readonly exitCode: number | null;
  readonly violation: string | null;
  readonly steps: readonly ArmStepRecord[];
}

/** One arm's result. */
export interface ArmReport {
  readonly build: string;
  readonly arm: string;
  readonly state: CacheMode;
  /** Inherited names the arm's VAT steps did not receive. */
  readonly removedEnv: readonly string[];
  readonly priming: ArmRepetition | null;
  readonly repetitions: readonly ArmRepetition[];
  /** Min/median/IQR over the repetitions, or `null` when there is no measurement. */
  readonly summary: PerfSummary | null;
  /** Why the arm has no measurement, or `null`. */
  readonly failure: string | null;
}

/** Every arm, in request order. */
export interface ArmsReport {
  readonly cwd: string;
  readonly rounds: number;
  readonly arms: readonly ArmReport[];
}

/**
 * A registered CI sequence as timed steps, each carrying its command's
 * committed exits and population reader.
 *
 * @param sequence - A {@link MeasuredSequenceSpec}
 * @returns Its steps, in order
 */
export function sequenceSteps(sequence: MeasuredSequenceSpec): SequenceStep[] {
  return sequence.steps.map((spec) => commandStep(spec, spec.args));
}

/**
 * Time every arm, interleaved by round.
 *
 * @param request - See {@link CaptureArmsRequest}
 * @returns One report per arm
 * @throws {Error} when an arm names a build it was not given, or anything
 *   {@link runInterleaved} refuses
 */
export async function captureArms(request: CaptureArmsRequest): Promise<ArmsReport> {
  const specs = request.arms.map((arm): RepeatSpec => {
    const build = request.builds.find((candidate) => candidate.alias === arm.build);
    if (build === undefined) {
      throw new Error(`arm '${arm.arm}' names build '${arm.build}', which was not given`);
    }
    return {
      instrument: build.instrument,
      cwd: request.cwd,
      steps: arm.steps,
      runs: request.rounds,
      arm: { out: request.out, build: arm.build, arm: arm.arm, state: arm.state },
      env: request.env,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    };
  });
  const runs = await runInterleaved(specs, request.rounds);
  return {
    cwd: request.cwd,
    rounds: request.rounds,
    arms: request.arms.map((arm, index) => {
      const run = runs[index];
      /* c8 ignore next -- one run per spec; guards noUncheckedIndexedAccess */
      if (run === undefined) throw new Error(`captureArms: no run for arm '${arm.arm}'`);
      const primingFailure = run.priming?.violation ?? null;
      const failure = primingFailure === null ? summarizeRepeatFailures(run.results) : `priming failed — ${primingFailure}`;
      const refused = failure ?? (run.results.length === 0 ? 'no repeats were requested' : null);
      return {
        build: arm.build,
        arm: arm.arm,
        state: arm.state,
        removedEnv: run.removed,
        priming: run.priming === null ? null : repetitionOf(run.priming),
        repetitions: run.results.map((result) => repetitionOf(result)),
        summary: refused === null ? summarize(run.results.map((result) => result.wallMs)) : null,
        failure: refused,
      };
    }),
  };
}

/**
 * One line per arm: its coordinates and min/median/IQR, or why it has none.
 *
 * @param report - What {@link captureArms} returned
 * @returns The rendered table
 */
export function renderArmsReport(report: ArmsReport): string {
  const ms = (value: number): string => `${value.toFixed(1)}ms`;
  const lines = report.arms.map((arm) => {
    const name = `${arm.build} ${arm.arm} ${arm.state}`;
    if (arm.summary === null) return `${name}: FAILED — ${arm.failure ?? 'no measurement'}`;
    const { minMs, medianMs, iqrMs } = arm.summary;
    return `${name}: min ${ms(minMs)}  median ${ms(medianMs)}  IQR ${ms(iqrMs)}  (${String(arm.repetitions.length)} rounds)`;
  });
  return [`perf arms — ${String(report.rounds)} interleaved rounds in ${report.cwd}`, ...lines].join('\n');
}

/**
 * @param result - One sequence's outcome
 * @returns The report's view of it
 */
function repetitionOf(result: SequenceResult): ArmRepetition {
  return {
    wallMs: result.wallMs,
    exitCode: result.exitCode,
    violation: result.violation,
    steps: result.steps.map((step) => ({
      name: step.name,
      timed: step.timed,
      exitCode: step.exitCode,
      wallMs: step.wallMs,
      stderr: step.stderr,
      provenance: step.provenance,
    })),
  };
}
