/**
 * One repetition of an arm: a SEQUENCE of steps, run in order, in the arm's own
 * store, `TMPDIR` and home — and judged by the one rule its cache state names.
 *
 * - **A step is any command.** A VAT step runs the build under the arm's
 *   cleared environment; a `tool` step (`pnpm install`, a build) runs under the
 *   developer's minus every `VAT_*` name (see `arm-env.ts`).
 * - **The time is the sum of the TIMED steps.** An untimed step is setup.
 * - **Every step has an exit commitment** (`ExitCommitment`: one exact code, or
 *   any completed exit its verb declares, uniform across repetitions), and
 *   exit 2 is never in one. A repetition whose any step exits otherwise is a
 *   failed measurement, never a time: a fast broken run (a child that cannot
 *   spawn, a refused store) must not pass a time bar.
 * - **The steps run as CI's `&&` chain does**: the first non-zero exit ends the
 *   sequence, and that exit is the sequence's own. When it is the step's
 *   committed exit the sequence completed — CI runs nothing after it either —
 *   so the steps after it never run, and the report says so by their absence.
 * - **One rule per cache state.** Cold: the arm's cache directory (`store/`) is
 *   deleted and `tmp/` emptied before the sequence (asserted), and a populating
 *   first step must leave a projection store in the build's cache namespace and
 *   at least one shard in the build's parse directory.
 *   Warm: one priming run leaves both non-empty — checked however the priming
 *   sequence ended — and every step that reads a population must report
 *   `store` (see `provenance.ts`). A warm sequence that stops before such a
 *   step is a violation: the rule it exists to check was never checked.
 *   An edit arm (`warm-edit<N>`, see `edit-step.ts`) primes the same way; each
 *   measured repetition then edits the tree (untimed), runs its steps, and
 *   restores the tree (untimed). Its rule inverts the clean one: an edit moves
 *   the tree key, so the repetition's FIRST step that reads or fills a
 *   population must report `derived` when it has a reader — a step served from
 *   the store did not see the edit. Steps after it read what it refilled from
 *   the edited tree, so they may report `store` and need not run (`ci-b`:
 *   `resources validate` writes, `resources check` reads). (Its work dump's store
 *   read and write are judged by the arms facet, which reads the dump.)
 * - **An observed repetition** (`SequenceContext.observe`) runs with a fresh
 *   `VAT_WORK_COUNTERS` directory for its VAT steps and a fresh
 *   `GIT_TRACE2_EVENT` directory for every step, under the arm's
 *   `repetitions/`; the result names both, for the facet to read.
 */

import { mkdtempSync } from 'node:fs';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { mkdirSyncReal, safePath, WORK_COUNTERS_ENV } from '@vibe-agent-toolkit/utils';

import { type ArmDirectories, armRefusal, entriesOf, resetArmHome, resetColdArm } from './arm-dirs.js';
import { type ArmEnvironment, mergeArmEnvironments } from './arm-env.js';
import type { PreparationGit } from './arm-git.js';
import { isEditState } from './arm-state.js';
import { type ExitCommitment, exitCommitmentViolation, MAX_EXIT_CODE } from './commands.js';
import { type AppliedEdits, applyEdits, editCandidates, type EditAction, planEdits, restoreEdits } from './edit-step.js';
import { type ParseDirectoryResolution } from './parse-cache.js';
import type { PopulationExpectation } from './population-expectation.js';
import { type ProvenanceReader, provenanceViolation, readProvenance, type StepProvenance } from './provenance.js';
import { runCommand } from './run.js';
import type { ArmState, ResolvedInstrument, RunResult } from './types.js';

/** The variable git writes one trace file per process under, when it names a directory. */
const GIT_TRACE_VARIABLE = 'GIT_TRACE2_EVENT';

/** The population every step that reads one must report on an edit arm's measured repetition. */
const DERIVED_POPULATION = 'derived';

/** How much of a failing step's stderr travels with the violation — the one excerpt length every lab failure uses. */
export const STDERR_EXCERPT_CHARS = 200;

/** What one step runs. */
export type StepCommand =
  /** The arm's build, with these arguments. */
  | { readonly kind: 'vat'; readonly args: readonly string[] }
  /** Any other command, resolved like any spawn (a bare name is looked up on PATH). */
  | { readonly kind: 'tool'; readonly command: string; readonly args: readonly string[] };

/** One step of a sequence. */
export interface SequenceStep {
  /** The step's name in the report and in every violation. */
  readonly name: string;
  readonly command: StepCommand;
  /** Whether the step's wall time counts toward the sequence's time. */
  readonly timed: boolean;
  /** What this step exits when it did its work. Never 2. */
  readonly exit: ExitCommitment;
  /** Which document reader the step's stdout goes through. */
  readonly provenance: ProvenanceReader;
  /**
   * Whether this step populates a projection: a cold run of it as the FIRST step,
   * and a priming run, are checked for what the arm's environment says it writes.
   */
  readonly populates: boolean;
  /** The subject-relative directories this step writes; see `MeasuredCommandSpec.writes`. */
  readonly writes: readonly string[];
}

/** One step's outcome. */
export interface StepResult extends RunResult {
  readonly name: string;
  readonly timed: boolean;
  /** What the step's document says about its population; `null` for a step with no reader. */
  readonly provenance: StepProvenance | null;
}

/**
 * One repetition's outcome.
 *
 * As a {@link RunResult}: `wallMs` is the sum of the timed steps; `exitCode` the
 * first non-zero step exit (0 when all are 0, `null` when a step produced none);
 * `stdout`/`stderr` the steps' streams joined; `spawnError` the first.
 */
export interface SequenceResult extends RunResult {
  /** Every step that ran, in order. */
  readonly steps: readonly StepResult[];
  /** Why this repetition fails the measurement, or `null`. */
  readonly violation: string | null;
  /** What an edit arm's measured repetition changed before its steps; `null` for every other run. */
  readonly edits: AppliedEdits | null;
  /** Where an observed repetition's dumps and traces are; `null` when it was not observed. */
  readonly observed: RepetitionObservation | null;
}

/** One observed repetition's directories, made fresh for it. */
export interface RepetitionObservation {
  /** `VAT_WORK_COUNTERS` for its VAT steps. */
  readonly workDir: string;
  /** `GIT_TRACE2_EVENT` for every step. */
  readonly traceDir: string;
}

/** Everything one repetition needs, prepared once per arm. */
export interface SequenceContext {
  readonly instrument: ResolvedInstrument;
  readonly cwd: string;
  readonly steps: readonly SequenceStep[];
  readonly dirs: ArmDirectories;
  /** Git under the arm's environment: every git an edit arm runs on its tree (`arm-git.ts`). */
  readonly git: PreparationGit;
  readonly state: ArmState;
  /** The files an edit arm edits (`--edit`), or `null` for the first N tracked markdown files. Read by edit arms only. */
  readonly editPaths: readonly string[] | null;
  /** Whether each measured repetition gets fresh work-dump and trace directories ({@link RepetitionObservation}). */
  readonly observe: boolean;
  /** The environment for VAT steps. */
  readonly vatEnv: ArmEnvironment;
  /** The environment for tool steps. */
  readonly toolEnv: ArmEnvironment;
  readonly timeoutMs: number;
  /** The build's parse directory under the arm's `store/` or `tmp/`, resolved lazily and once. */
  readonly parseDirectory: () => ParseDirectoryResolution;
  /** What a populating run of THIS arm writes, from its VAT environment. */
  readonly population: PopulationExpectation;
}

/** Which run of an arm this is: the priming run, or a measured one. */
type SequenceRole =
  | { readonly kind: 'priming' }
  | {
      readonly kind: 'measured';
      readonly vatEnv: ArmEnvironment;
      /** The measured round, 0-based: an edit arm's bytes differ per round. */
      readonly round: number;
    };

/** The environments one run's steps get. */
interface StepEnvironments {
  readonly vat: ArmEnvironment;
  readonly tool: ArmEnvironment;
}

/**
 * Refuse a step whose commitment admits vat's system-error exit, or a code no
 * process can exit with.
 *
 * @param step - A step
 * @throws {Error} when the step commits to exit 2 or to a code outside 0..255
 */
export function assertCommittedExits(step: SequenceStep): void {
  const codes = step.exit.kind === 'exact' ? [step.exit.code] : step.exit.completed;
  // vat's system-error exit: a run that did not complete, and so never a committed exit.
  if (codes.includes(ExitCode.ERROR)) {
    throw armRefusal(`step '${step.name}' commits to exit 2 — a system error is never an expected exit`);
  }
  const impossible = codes.find((code) => !Number.isInteger(code) || code < 0 || code > MAX_EXIT_CODE);
  if (impossible !== undefined) {
    throw armRefusal(`step '${step.name}' commits to exit ${String(impossible)} — an exit code is a whole number from 0 to ${String(MAX_EXIT_CODE)}`);
  }
}

/**
 * Run one repetition of an arm's sequence.
 *
 * @param context - The arm, prepared
 * @param role - Priming (unmeasured) or measured, with the measured run's VAT environment
 * @returns The repetition's outcome
 */
export async function runSequence(context: SequenceContext, role: SequenceRole): Promise<SequenceResult> {
  if (context.state === 'cold') {
    const violation = await resetColdArm(context.dirs);
    if (violation !== null) return aggregate([], violation);
  }
  await resetArmHome(context.dirs);
  const observed = role.kind === 'measured' && context.observe ? openObservation(context.dirs) : null;
  const envs = stepEnvironments(context, role, observed);
  const actions = role.kind === 'measured' ? plannedEdits(context, role.round) : null;
  if (actions === null) return { ...runSteps(context, role, envs), observed };
  // Untimed both ways: the edit is setup, and the tree is restored however the apply or the steps ended.
  const reached: EditAction[] = [];
  let applied: AppliedEdits;
  let ran: SequenceResult;
  let restored: string | null;
  try {
    applied = applyEdits(context.git, context.cwd, actions, reached);
    ran = runSteps(context, role, envs);
  } finally {
    restored = restoreEdits(context.git, context.cwd, reached);
  }
  const missed =
    applied.changed === actions.length
      ? null
      : `edit rule: editing ${String(actions.length)} file(s) left ${String(applied.changed)} changed path(s) in git's view`;
  return { ...ran, violation: ran.violation ?? missed ?? restored, edits: applied, observed };
}

/**
 * Run a repetition's steps in order, stopping as CI's `&&` chain does.
 *
 * @param context - The arm
 * @param role - Which run
 * @param envs - The environments its steps get
 * @returns The repetition, with no edit and no observation recorded
 */
function runSteps(context: SequenceContext, role: SequenceRole, envs: StepEnvironments): SequenceResult {
  const steps: StepResult[] = [];
  for (const [index, step] of context.steps.entries()) {
    const ran = runStep(context, envs, step);
    steps.push(ran);
    const violation = stepViolation(context, role, step, ran, index);
    if (violation !== null) return aggregate(steps, violation);
    // A committed non-zero exit ends the sequence as CI's `&&` does: completed, with nothing after it run.
    if (ran.exitCode !== 0) return finish(context, role, steps, skippedReaderViolation(context, index));
  }
  return finish(context, role, steps, null);
}

/** Each arm's edit candidates, read once per arm: the tree is restored after every round. */
const candidatesByArm = new WeakMap<SequenceContext, readonly string[]>();

/**
 * @param context - The arm
 * @param round - The measured round
 * @returns The round's edits, or `null` for an arm that edits nothing
 */
function plannedEdits(context: SequenceContext, round: number): EditAction[] | null {
  const { state } = context;
  if (!isEditState(state)) return null;
  let tracked = candidatesByArm.get(context);
  if (tracked === undefined) {
    tracked = context.editPaths ?? editCandidates(context.git, context.cwd);
    candidatesByArm.set(context, tracked);
  }
  return planEdits(tracked, { kind: state.kind, count: state.count, paths: context.editPaths }, round);
}

/**
 * Make a measured repetition's fresh dump and trace directories under the arm's `repetitions/`.
 *
 * @param dirs - The arm
 * @returns The directories
 */
function openObservation(dirs: ArmDirectories): RepetitionObservation {
  const parent = safePath.join(dirs.root, 'repetitions');
  mkdirSyncReal(parent, { recursive: true, mode: 0o700 });
  const holder = mkdtempSync(safePath.join(parent, 'rep-'));
  const observation = { workDir: safePath.join(holder, 'work'), traceDir: safePath.join(holder, 'trace') };
  // Both exist first: git treats a GIT_TRACE2_EVENT that is no directory as one file to append to.
  for (const dir of [observation.workDir, observation.traceDir]) mkdirSyncReal(dir, { mode: 0o700 });
  return observation;
}

/**
 * @param context - The arm
 * @param role - Which run
 * @param observed - The repetition's observation directories, or `null`
 * @returns The VAT steps' and tool steps' environments
 */
function stepEnvironments(context: SequenceContext, role: SequenceRole, observed: RepetitionObservation | null): StepEnvironments {
  const vat = role.kind === 'measured' ? role.vatEnv : context.vatEnv;
  if (observed === null) return { vat, tool: context.toolEnv };
  const trace = { [GIT_TRACE_VARIABLE]: observed.traceDir };
  return {
    vat: mergeArmEnvironments(vat, { set: { ...trace, [WORK_COUNTERS_ENV]: observed.workDir }, unset: [] }),
    tool: mergeArmEnvironments(context.toolEnv, { set: trace, unset: [] }),
  };
}

/**
 * End a repetition on every path that completed its steps: a priming run's
 * population is checked whether the sequence ran to its end or stopped at a
 * committed exit.
 *
 * @param context - The arm
 * @param role - Which run
 * @param steps - Every step that ran
 * @param stopped - Why stopping where it did fails the measurement, or `null`
 * @returns The repetition
 */
function finish(context: SequenceContext, role: SequenceRole, steps: readonly StepResult[], stopped: string | null): SequenceResult {
  const primed = role.kind === 'priming' ? populationViolation(context, 'warm rule: after priming') : null;
  return aggregate(steps, stopped ?? primed);
}

/**
 * @param context - The arm
 * @param index - The step whose committed non-zero exit stopped the sequence
 * @returns The warm-rule violation naming the first skipped step that reads a population, or `null`
 */
function skippedReaderViolation(context: SequenceContext, index: number): string | null {
  if (context.state === 'cold') return null;
  // An edit arm judges only its first population step; a reader after it is never required to run.
  const judged = isEditState(context.state) ? context.steps.slice(0, editJudgedIndex(context.steps) + 1) : context.steps;
  const skipped = judged.slice(index + 1).find((step) => step.provenance !== 'none');
  if (skipped === undefined) return null;
  const stopper = context.steps[index]?.name ?? String(index);
  return `warm rule: step '${skipped.name}' never ran — the sequence stopped at step '${stopper}' — so its population was never shown to be the store`;
}

/**
 * @param context - The arm
 * @param envs - The run's environments
 * @param step - The step to run
 * @returns Its outcome, with its provenance read
 */
function runStep(context: SequenceContext, envs: StepEnvironments, step: SequenceStep): StepResult {
  const options = { cwd: context.cwd, timeoutMs: context.timeoutMs };
  const raw =
    step.command.kind === 'vat'
      ? runCommand(context.instrument, step.command.args, { ...options, env: envs.vat })
      : runCommand({ command: step.command.command, leadingArgs: [] }, step.command.args, { ...options, env: envs.tool });
  return { ...raw, name: step.name, timed: step.timed, provenance: readProvenance(step.provenance, raw.stdout) };
}

/**
 * Judge one step that just ran.
 *
 * @param context - The arm
 * @param role - Which run
 * @param step - The step
 * @param ran - Its outcome
 * @param index - Its position in the sequence
 * @returns The violation, or `null`
 */
function stepViolation(
  context: SequenceContext,
  role: SequenceRole,
  step: SequenceStep,
  ran: StepResult,
  index: number,
): string | null {
  const failure = exitFailure(ran, step.exit);
  if (failure !== null) return `step '${step.name}' ${failure}`;
  if (index === 0 && step.populates && context.state === 'cold') {
    const violation = populationViolation(context, `cold rule: after step '${step.name}'`);
    if (violation !== null) return violation;
  }
  if (role.kind !== 'measured') return null;
  return isEditState(context.state)
    ? editProvenanceViolation(context.steps, index, ran.provenance)
    : provenanceViolation(step.name, step.provenance, ran.provenance, context.state, context.population.store);
}

/** What the edit rule reads of a step. */
type EditJudgedStep = Pick<SequenceStep, 'name' | 'provenance' | 'populates'>;

/**
 * @param steps - An edit arm's sequence
 * @returns The position of its first step that reads or fills a population — the
 *   one step whose tree key the edit moved before anything refilled it — or -1
 */
function editJudgedIndex(steps: readonly EditJudgedStep[]): number {
  return steps.findIndex((step) => step.populates || step.provenance !== 'none');
}

/**
 * The half of the edit rule a step's document shows: the repetition's first
 * step that reads or fills a population publishes `derived` (see this module's
 * header). A later step reads what that step refilled from the edited tree, so
 * `store` there is the edit seen, not missed (`ci-b`'s `resources check`).
 *
 * @param steps - The arm's sequence
 * @param index - The step that ran
 * @param provenance - What its document said
 * @returns The violation, or `null`
 */
export function editProvenanceViolation(steps: readonly EditJudgedStep[], index: number, provenance: StepProvenance | null): string | null {
  const step = steps[index];
  if (step === undefined || index !== editJudgedIndex(steps) || step.provenance === 'none') return null;
  const population = provenance?.resources ?? null;
  if (population === null) return `edit rule: step '${step.name}' published no resources population (absent is never a pass)`;
  return population === DERIVED_POPULATION
    ? null
    : `edit rule: step '${step.name}' reports population '${population}', not '${DERIVED_POPULATION}' — the run did not see the edit`;
}

/**
 * Whether a step's exit is one it committed to.
 *
 * @param ran - The step's outcome
 * @param commitment - Its exit commitment
 * @returns Why not, or `null`
 */
function exitFailure(ran: RunResult, commitment: ExitCommitment): string | null {
  if (ran.spawnError !== null) return `did not run: ${ran.spawnError}`;
  const violation = ran.exitCode === null ? 'exited with no code' : exitCommitmentViolation(commitment, ran.exitCode);
  return violation === null ? null : `${violation}: ${ran.stderr.trim().slice(0, STDERR_EXCERPT_CHARS)}`;
}

/**
 * Whether the build's cache namespace holds what this arm's environment says a
 * populating run writes — and nothing where it says the cache is off.
 *
 * The store is judged in the BUILD's namespace (the parent of its parse
 * directory), never by the arm's cache directory being non-empty: a current
 * build keeps its parse cache in that directory too (`VAT_CACHE_DIR`), so a
 * store-off arm leaves it non-empty, while a build that predates the variable
 * keeps its whole namespace under the arm's `tmp/` and leaves it empty.
 *
 * @param context - The arm
 * @param when - What the message says this was checked after
 * @returns The violation, or `null`
 */
function populationViolation(context: SequenceContext, when: string): string | null {
  if (!context.steps.some((step) => step.populates)) return null;
  const { store, parseShard } = context.population;
  if (!parseShard) return writtenWhenCachesOff(context, when);
  const parse = context.parseDirectory();
  if (!parse.ok) return `${when}: ${parse.reason}`;
  const namespace = namespaceOf(parse.dir);
  const stored = holdsAProjectionStore(namespace);
  if (store && !stored) return `${when} the build's namespace '${namespace}' holds no projection store`;
  if (!store && stored) return storeWrittenWhenOff(namespace, when);
  if (!holdsAFile(parse.dir)) return `${when} the build's parse directory '${parse.dir}' holds no shard`;
  return null;
}

/**
 * @param context - An arm whose environment turned every cache off
 * @param when - What the message says this was checked after
 * @returns The violation when the build wrote a store or a parse shard anyway;
 *   `null` when it wrote neither or the build cannot say where its cache is (nothing is claimed)
 */
function writtenWhenCachesOff(context: SequenceContext, when: string): string | null {
  const parse = context.parseDirectory();
  if (!parse.ok) return null;
  const namespace = namespaceOf(parse.dir);
  if (holdsAProjectionStore(namespace)) return storeWrittenWhenOff(namespace, when);
  if (!holdsAFile(parse.dir)) return null;
  return `${when} the build's parse directory '${parse.dir}' was written though the arm turned the parse cache off`;
}

/**
 * @param namespace - The build's cache namespace
 * @param when - What the message says this was checked after
 * @returns The violation for a store written though the arm turned it off
 */
function storeWrittenWhenOff(namespace: string, when: string): string {
  return `${when} the build's namespace '${namespace}' holds a projection store though the arm turned the store off`;
}

/**
 * @param parseDirectory - The build's parse directory, `<cache root>/<namespace>/parse`
 * @returns Its namespace, where the build also keeps its `projection-<shape>/` store
 */
function namespaceOf(parseDirectory: string): string {
  return safePath.join(parseDirectory, '..');
}

/**
 * The prefix every build's projection store directory carries
 * (`projection-<shape>`). The lab's own reading of the on-disk layout, never
 * an import of the lab's `@vibe-agent-toolkit/resources`: the namespace judged
 * here is ANOTHER build's, and the lab asks a build only what it can answer
 * (its parse directory — see `parse-cache.ts`). Every build that has a store
 * names it this way, older ones included, and none exports a name builder the
 * lab could ask for.
 */
const STORE_DIRECTORY_PREFIX = 'projection-';

/**
 * @param namespace - A build's cache namespace
 * @returns True when a `projection-*` directory in it holds a file
 */
function holdsAProjectionStore(namespace: string): boolean {
  return entriesOf(namespace).some(
    (entry) => entry.isDirectory() && entry.name.startsWith(STORE_DIRECTORY_PREFIX) && holdsAFile(safePath.join(namespace, entry.name)),
  );
}

/**
 * @param dir - A directory
 * @returns True when it holds at least one non-directory entry at any depth; a link is never followed
 */
function holdsAFile(dir: string): boolean {
  return entriesOf(dir).some((entry) =>
    entry.isDirectory() ? holdsAFile(safePath.join(dir, entry.name)) : true,
  );
}

/**
 * Fold the steps into one repetition's outcome.
 *
 * @param steps - Every step that ran
 * @param violation - Why it fails the measurement, or `null`
 * @returns The repetition
 */
function aggregate(steps: readonly StepResult[], violation: string | null): SequenceResult {
  const exits = steps.map((step) => step.exitCode);
  const exitCode = exits.includes(null) || steps.length === 0 ? null : (exits.find((code) => code !== 0) ?? 0);
  return {
    wallMs: steps.filter((step) => step.timed).reduce((sum, step) => sum + step.wallMs, 0),
    exitCode,
    // A repetition started when every step it reached did.
    started: steps.length > 0 && steps.every((step) => step.started),
    stdout: steps.map((step) => step.stdout).join(''),
    stderr: steps.map((step) => step.stderr).join(''),
    spawnError: steps.find((step) => step.spawnError !== null)?.spawnError ?? null,
    steps,
    violation,
    edits: null,
    observed: null,
  };
}
