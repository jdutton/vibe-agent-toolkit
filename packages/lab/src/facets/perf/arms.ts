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

import type { InstrumentVersion } from '../../envelope/coordinate.js';
import type { ArmEnvironment } from '../../harness/arm-env.js';
import type { MeasuredSequenceSpec } from '../../harness/commands.js';
import { judgeLoad, readLoad } from '../../harness/load-guard.js';
import type { StepProvenance } from '../../harness/provenance.js';
import { armRunFailure, commandStep, type RepeatSpec, runInterleaved } from '../../harness/repeat.js';
import type { SequenceResult, SequenceStep } from '../../harness/sequence.js';
import type { CacheMode, InstrumentSource, LoadReadings, ResolvedInstrument } from '../../harness/types.js';

import { type PerfSummary, summarize } from './stats.js';

/** One build under measurement, by the alias its arms name it with. */
export interface ArmsBuild {
  readonly alias: string;
  /** The instrument as the operator named it (`--build alias=<source>`). */
  readonly source: InstrumentSource;
  readonly instrument: ResolvedInstrument;
}

/** What one alias WAS: its coordinate as given and the version, commit and closure it resolved to. */
interface ArmsBuildRecord {
  readonly alias: string;
  readonly source: InstrumentSource;
  readonly instrument: InstrumentVersion;
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
  /** The invocation's arms root (`openArmsRoot`); every arm is a directory directly under it. */
  readonly armsRoot: string;
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
  /** Inherited names the arm's tool steps did not receive. */
  readonly removedToolEnv: readonly string[];
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
  /** Every build, so a bar read later knows which bytes it judged. */
  readonly builds: readonly ArmsBuildRecord[];
  /** The machine load across every round, as `perf run` records it. */
  readonly load: LoadReadings;
  readonly arms: readonly ArmReport[];
}

/**
 * The ONE exit one step of one arm commits to, as the operator set it
 * (`perf arms --expect-exit <build>:<sequence>:<step>=<code>`). A CI step
 * has one committed outcome, so a set of acceptable exits would let a run that
 * did different work pass as the same measurement. A step no expectation names
 * commits to 0.
 */
export interface ExpectedExit {
  readonly build: string;
  /** A {@link MeasuredSequenceSpec.name}. */
  readonly sequence: string;
  /** A step's name within that sequence. */
  readonly step: string;
  /** Never 2: `assertCommittedExits` refuses it before anything runs. */
  readonly exit: number;
}

/**
 * A registered CI sequence as one build's timed steps, each carrying its
 * committed exits and population reader.
 *
 * @param sequence - A {@link MeasuredSequenceSpec}
 * @param build - The build whose arm runs it
 * @param expected - Every operator expectation; only this (build, sequence)'s apply
 * @returns Its steps, in order
 */
export function sequenceSteps(
  sequence: MeasuredSequenceSpec,
  build: string,
  expected: readonly ExpectedExit[],
): SequenceStep[] {
  return sequence.steps.map((spec) => {
    const step = commandStep(spec, spec.args);
    const set = expected.find(
      (candidate) => candidate.build === build && candidate.sequence === sequence.name && candidate.step === step.name,
    );
    return set === undefined ? step : { ...step, expectedExits: [set.exit] };
  });
}

/**
 * Whether every expectation names an arm that will run and a step it runs —
 * an expectation that matches nothing would silently leave the default in force.
 *
 * @param arms - The arms requested, by build and sequence
 * @param expected - The operator's expectations
 * @returns The refusal naming the first that matches nothing, or `null`
 */
export function expectedExitRefusal(
  arms: readonly { readonly build: string; readonly sequence: MeasuredSequenceSpec }[],
  expected: readonly ExpectedExit[],
): string | null {
  for (const expectation of expected) {
    const arm = arms.find((candidate) => candidate.build === expectation.build && candidate.sequence.name === expectation.sequence);
    if (arm === undefined) {
      return `--expect-exit ${expectation.build}:${expectation.sequence} names no --arm of that build and sequence`;
    }
    const names = arm.sequence.steps.map((step) => step.name);
    if (!names.includes(expectation.step)) {
      return `--expect-exit names step '${expectation.step}', which ${expectation.sequence} does not run (its steps: ${names.join(', ')})`;
    }
  }
  return null;
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
      arm: { root: request.armsRoot, build: arm.build, arm: arm.arm, state: arm.state },
      env: request.env,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    };
  });
  const loadBefore = readLoad();
  const runs = await runInterleaved(specs, request.rounds);
  const loadAfter = readLoad();
  return {
    cwd: request.cwd,
    rounds: request.rounds,
    builds: request.builds.map((build) => ({ alias: build.alias, source: build.source, instrument: build.instrument.version })),
    load: judgeLoad(loadBefore.loadAvg1, loadAfter.loadAvg1, loadAfter.cpus),
    arms: request.arms.map((arm, index) => {
      const run = runs[index];
      /* c8 ignore next -- one run per spec; guards noUncheckedIndexedAccess */
      if (run === undefined) throw new Error(`captureArms: no run for arm '${arm.arm}'`);
      const refused = armRunFailure(run);
      return {
        build: arm.build,
        arm: arm.arm,
        state: arm.state,
        removedEnv: run.removed,
        removedToolEnv: run.removedTool,
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
