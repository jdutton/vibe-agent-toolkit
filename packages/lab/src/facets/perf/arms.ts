/**
 * Timing whole CI sequences: several (build, arm, cache state) arms, run
 * INTERLEAVED by round in one prepared tree, each in its own store, `TMPDIR` and
 * home.
 *
 * Every arm reports min, median and IQR over its measured rounds — or, when any
 * repetition broke its sequence rule or a step exited otherwise than committed,
 * the failure and no statistic at all. Each repetition carries what a bar needs
 * to assert on: every step's exit, its full stderr, and the population its
 * document reported. Bars over these numbers are `bars.ts`'s and `gaps.ts`'s.
 *
 * ## Observed repetitions and the edit arm
 *
 * Every measured repetition runs with its own fresh `VAT_WORK_COUNTERS` and
 * `GIT_TRACE2_EVENT` directories (`sequence.ts`); the report keeps each
 * repetition's merged work counters (`readWorkDumps`, the work facet's one
 * reader) and its git spawn count (`countGitTrace`). An edit arm
 * (`warm-edit<N>[:<kind>]`, `edit-step.ts`) is judged here on what only the
 * dump shows: a repetition is valid only when it read the store's extent
 * (`store.reads.extent >= 1`) and wrote the store (`store.writes.persistent >= 1`),
 * and only when its exit equals the same build's clean warm arm's in that
 * round — an edit that moved a finding would time a different run
 * ({@link editRuleViolation}; under an `exact` commitment the step rule
 * already catches a differing exit). An edit arm with no clean arm of its
 * build and sequence in the invocation is refused before anything runs. Each edit
 * arm's gap to that clean arm, and each build's marginal per-file cost, travel
 * in the report (`gaps.ts`).
 */

import { ExitCode } from '@vibe-agent-toolkit/schema';

import type { InstrumentVersion } from '../../envelope/coordinate.js';
import { armRefusal } from '../../harness/arm-dirs.js';
import type { ArmEnvironment } from '../../harness/arm-env.js';
import { armStateName, isEditState } from '../../harness/arm-state.js';
import { exactExit, type MeasuredSequenceSpec } from '../../harness/commands.js';
import { type AppliedEdits, refuseUnplannableEdit } from '../../harness/edit-step.js';
import { type RecordedExit, recordExits } from '../../harness/exit-record.js';
import { countGitTrace } from '../../harness/git-trace.js';
import { judgeLoad, readLoad } from '../../harness/load-guard.js';
import type { StepProvenance } from '../../harness/provenance.js';
import { armRunFailure, commandStep, type RepeatSpec, runInterleaved } from '../../harness/repeat.js';
import type { SequenceResult, SequenceStep } from '../../harness/sequence.js';
import type { ArmState, InstrumentSource, LoadReadings, ResolvedInstrument } from '../../harness/types.js';
import { countOf, type MergedWorkDumps, readWorkDumps } from '../work/dump.js';

import { type ArmGap, armGaps, type MarginalCost, marginalCosts, renderGaps } from './gaps.js';
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
  readonly state: ArmState;
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
  /** The files every edit arm edits (`--edit`); `null`, each edit arm's first N tracked markdown files with no frontmatter. */
  readonly editPaths: readonly string[] | null;
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
  /** What an edit arm's repetition edited, and how many paths git saw changed; `null` for every other run. */
  readonly edits: AppliedEdits | null;
  /** The repetition's work counters, every VAT process's dump summed; `null` when unobserved or unreadable. */
  readonly work: MergedWorkDumps | null;
  /** Why the dumps could not be read (a build that predates work counters), or `null`. */
  readonly workRefusal: string | null;
  /** Git processes the repetition started, every step's; `null` when unobserved or unreadable. */
  readonly gitSpawns: number | null;
  /** {@link ArmRepetition.gitSpawns} by verb. */
  readonly gitByVerb: Readonly<Record<string, number>> | null;
  /** Why the git trace could not be read, or `null`. */
  readonly traceRefusal: string | null;
}

/** One arm's result. */
export interface ArmReport {
  readonly build: string;
  readonly arm: string;
  /** In its spelling: `warm`, `cold`, `warm-edit<N>[:<kind>]`. */
  readonly state: string;
  /** Inherited names the arm's VAT steps did not receive. */
  readonly removedEnv: readonly string[];
  /** Inherited names the arm's tool steps did not receive. */
  readonly removedToolEnv: readonly string[];
  /** Inherited npm network setting names the arm's VAT steps kept — names only, never values. */
  readonly npmNetworkEnv: readonly string[];
  /** Every step's exit commitment (always `exact` here) and the code its repetitions shared. */
  readonly exits: readonly RecordedExit[];
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
  /** Every measured edit arm's gap to its same-build clean arm (`gaps.ts`). */
  readonly gaps: readonly ArmGap[];
  /** Every build's marginal per-file cost, where it has a one-file and a wider edit arm of one kind. */
  readonly marginals: readonly MarginalCost[];
}

/**
 * The ONE exit one step of one arm commits to, as the operator set it
 * (`perf arms --expect-exit <build>:<sequence>:<step>=<code>`). A CI step
 * has one committed outcome, so every arm step is `exact` (`ExitCommitment`):
 * a set of acceptable exits would let a run that did different work pass as
 * the same measurement. A step no expectation names commits to 0.
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
 * A registered CI sequence as one build's timed steps, each committed to
 * exactly one exit (its expectation's, else 0) and carrying its population reader.
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
    return { ...step, exit: exactExit(set?.exit ?? ExitCode.OK) };
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
      observeRepetitions: true,
      editPaths: request.editPaths,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    };
  });
  refuseUnplannableEdits(request);
  const loadBefore = readLoad();
  const runs = await runInterleaved(specs, request.rounds);
  const loadAfter = readLoad();
  const observed = await Promise.all(runs.map((run) => Promise.all(run.results.map((result) => observe(result)))));
  const judged = request.arms.map((arm, index) => {
    // Every edit arm has a clean arm (refused up front otherwise); a clean arm whose priming failed has no
    // repetition this round, its own failure says why, and there is no gap to time.
    const clean = observed[cleanArmIndex(request.arms, arm)];
    return (observed[index] ?? []).map((repetition, round) => judgeEditRepetition(arm.state, repetition, clean?.[round]?.result.exitCode));
  });
  const arms = request.arms.map((arm, index) => {
    const run = runs[index];
    const repetitions = judged[index];
    /* c8 ignore next -- one run per spec; guards noUncheckedIndexedAccess */
    if (run === undefined || repetitions === undefined) throw new Error(`captureArms: no run for arm '${arm.arm}'`);
    const results = repetitions.map((repetition) => repetition.result);
    const refused = armRunFailure({ priming: run.priming, results });
    return {
      build: arm.build,
      arm: arm.arm,
      state: armStateName(arm.state),
      removedEnv: run.removed,
      removedToolEnv: run.removedTool,
      npmNetworkEnv: run.npmNetwork,
      exits: recordExits(arm.steps, results),
      priming: run.priming === null ? null : repetitionOf({ result: run.priming, ...UNOBSERVED }),
      repetitions: repetitions.map((repetition) => repetitionOf(repetition)),
      summary: refused === null ? summarize(results.map((result) => result.wallMs)) : null,
      failure: refused,
    };
  });
  const gaps = armGaps(
    arms.map((arm, index) => {
      const selection = request.arms[index];
      /* c8 ignore next -- one report per selection; guards noUncheckedIndexedAccess */
      if (selection === undefined) throw new Error(`captureArms: no selection for arm '${arm.arm}'`);
      return { ...arm, state: selection.state };
    }),
  );
  return {
    cwd: request.cwd,
    rounds: request.rounds,
    builds: request.builds.map((build) => ({ alias: build.alias, source: build.source, instrument: build.instrument.version })),
    load: judgeLoad(loadBefore.loadAvg1, loadAfter.loadAvg1, loadAfter.cpus),
    arms,
    gaps,
    marginals: marginalCosts(gaps),
  };
}

/**
 * Refuse, before anything runs (priming included), an edit arm that cannot
 * make its edit every round (`refuseUnplannableEdit`), or that has no clean
 * warm arm of its build and sequence to be judged and gapped against.
 *
 * @param request - The capture
 * @throws {VatError} `LAB_ARM_REFUSED` naming the arm, the numbers or the path
 */
function refuseUnplannableEdits(request: CaptureArmsRequest): void {
  for (const arm of request.arms) {
    const { state } = arm;
    if (!isEditState(state)) continue;
    if (cleanArmIndex(request.arms, arm) === -1) {
      throw armRefusal(
        `${arm.build}:${arm.arm}:${armStateName(state)} has no clean arm ${arm.build}:${arm.arm}:warm in the invocation: its exit and its gap have nothing to compare with`,
      );
    }
    refuseUnplannableEdit(request.cwd, { kind: state.kind, count: state.count, paths: request.editPaths }, request.rounds);
  }
}

/**
 * @param arms - Every arm
 * @param arm - An arm
 * @returns The index of the same build's clean warm arm of the same sequence, or -1
 */
function cleanArmIndex(arms: readonly ArmSelection[], arm: ArmSelection): number {
  return arms.findIndex((other) => other.build === arm.build && other.arm === arm.arm && other.state === 'warm');
}

/** One repetition, with what its dumps and trace showed. */
interface ObservedRepetition {
  readonly result: SequenceResult;
  readonly work: MergedWorkDumps | null;
  readonly workRefusal: string | null;
  readonly git: { readonly spawns: number; readonly byVerb: Readonly<Record<string, number>> } | null;
  readonly traceRefusal: string | null;
}

/** What a run nobody observed shows. */
const UNOBSERVED = { work: null, workRefusal: null, git: null, traceRefusal: null } as const;

/**
 * Read one repetition's work dumps and git trace.
 *
 * @param result - A measured repetition
 * @returns It, with what its observation directories hold
 */
async function observe(result: SequenceResult): Promise<ObservedRepetition> {
  const { observed } = result;
  if (observed === null) return { result, ...UNOBSERVED };
  const work = await readWorkDumps(observed.workDir);
  let git: ObservedRepetition['git'] = null;
  let traceRefusal: string | null = null;
  try {
    git = countGitTrace(observed.traceDir);
  } catch (error: unknown) {
    traceRefusal = error instanceof Error ? error.message : String(error);
  }
  return {
    result,
    work: work.ok ? work.merged : null,
    workRefusal: work.ok ? null : work.refusal,
    git,
    traceRefusal,
  };
}

/**
 * The edit rule's half only the dump shows, and the clean arm's exit.
 *
 * @param state - The arm's state
 * @param repetition - One observed repetition
 * @param cleanExit - The same build's clean warm arm's exit in this round; `undefined` when there is no clean arm
 * @returns The repetition, with the violation set when it broke the rule
 */
function judgeEditRepetition(state: ArmState, repetition: ObservedRepetition, cleanExit: number | null | undefined): ObservedRepetition {
  const { result } = repetition;
  if (!isEditState(state) || result.violation !== null) return repetition;
  const violation = editRuleViolation({ work: repetition.work, workRefusal: repetition.workRefusal, exitCode: result.exitCode, cleanExit });
  return violation === null ? repetition : { ...repetition, result: { ...result, violation } };
}

/** What the edit rule's dump and exit halves read from one edit repetition. */
export interface EditRuleInput {
  /** The repetition's merged work dumps, or `null` when they could not be read. */
  readonly work: MergedWorkDumps | null;
  /** Why {@link EditRuleInput.work} is `null`. */
  readonly workRefusal: string | null;
  readonly exitCode: number | null;
  /** The same build's clean warm arm's exit in this round; `undefined` when that arm has no repetition this round. */
  readonly cleanExit: number | null | undefined;
}

/**
 * The edit rule's halves the step documents cannot show: the dump read the
 * store's extent and wrote the store, and the exit equals the clean arm's.
 *
 * Under an `exact` exit commitment a differing exit is already a step
 * violation, so the exit half bites only when a step's commitment admits more
 * than one code; it stays, so no commitment can let an edit that moved a
 * finding time a different run.
 *
 * @param input - See {@link EditRuleInput}
 * @returns The violation, or `null`
 */
export function editRuleViolation(input: EditRuleInput): string | null {
  return editWorkViolation(input.work, input.workRefusal) ?? editExitViolation(input.exitCode, input.cleanExit);
}

/**
 * @param work - The repetition's merged dumps, or `null`
 * @param refusal - Why there are none
 * @returns Why the dump does not show the store read and written, or `null`
 */
function editWorkViolation(work: MergedWorkDumps | null, refusal: string | null): string | null {
  if (work === null) return `edit rule: the repetition's work dumps cannot be read — ${refusal ?? 'it was not observed'}`;
  const reads = countOf(work, 'store.reads.extent') ?? 0;
  const writes = countOf(work, 'store.writes.persistent') ?? 0;
  if (reads >= 1 && writes >= 1) return null;
  return `edit rule: the work dump shows store.reads.extent ${String(reads)} and store.writes.persistent ${String(writes)}; an edit run reads the store's extent and writes the store`;
}

/**
 * @param exit - The edit repetition's exit
 * @param cleanExit - The clean arm's exit in the same round, or `undefined` when there is no clean arm
 * @returns Why the two runs did different work, or `null`
 */
function editExitViolation(exit: number | null, cleanExit: number | null | undefined): string | null {
  if (cleanExit === undefined || exit === cleanExit) return null;
  return `edit rule: the repetition exited ${String(exit)}, the same build's clean arm ${String(cleanExit)} — the edit moved a finding, so it timed a different run`;
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
  return [`perf arms — ${String(report.rounds)} interleaved rounds in ${report.cwd}`, ...lines, ...renderGaps(report.gaps, report.marginals)].join('\n');
}

/**
 * @param repetition - One sequence's outcome, with what its observation showed
 * @returns The report's view of it
 */
function repetitionOf(repetition: ObservedRepetition): ArmRepetition {
  const { result } = repetition;
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
    edits: result.edits,
    work: repetition.work,
    workRefusal: repetition.workRefusal,
    gitSpawns: repetition.git?.spawns ?? null,
    gitByVerb: repetition.git?.byVerb ?? null,
    traceRefusal: repetition.traceRefusal,
  };
}
