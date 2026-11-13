/**
 * The time bound on `vat resources check` — and on `vat resources query` when
 * the operator opts in with `--budget` — enforced from OUTSIDE the process doing
 * the work.
 *
 * Both verbs run one supervisor: the same watchdog, progress log, exit-code
 * table and signal guard, keyed by {@link SupervisedVerb}. `check` is always
 * supervised (`--budget 0` opts out); `query` only under a positive `--budget`,
 * so a query run without it starts no second process and never loads
 * `query-supervision.ts`.
 *
 * ## 🚨 Why an external process, and not any of the cheaper things
 *
 * This verb runs adopter-authored SQL as an unattended CI gate. An accidental
 * cross join, or a `WITH RECURSIVE` with no termination, runs forever — and
 * every in-process lever was tried and MEASURED on Node 24.13.1 before this
 * shape was chosen. Do not re-derive them:
 *
 * - **A worker thread does not work.** `worker.terminate()` never resolves
 *   against a thread blocked in native SQLite, and the parent's own
 *   `process.exit()` does not exit either. V8 can unwind a worker spinning in
 *   JS — which is why the parse pool's `terminate()` genuinely works — but a
 *   thread inside a synchronous native call is not spinning in JS. Do NOT
 *   "align" this design with the parse pool's.
 * - **A signal handler in the process RUNNING THE SQL is a REGRESSION.** A
 *   process blocked in synchronous `node:sqlite` dies INSTANTLY on SIGINT while
 *   no handler is installed, and SURVIVES both SIGINT and SIGTERM once one is —
 *   the handler is a JS callback, and the event loop that would schedule it is
 *   the resource that is blocked. Installing one removes the operator's Ctrl-C.
 *   That process — the supervised child, or this command under `--budget 0` —
 *   must never have a `process.on(<signal>)`, and nothing on its path installs
 *   one.
 *
 *   The SUPERVISING process may, and does: its event loop only waits on the
 *   child, so a handler there fires. It guards every `TERMINATING_SIGNALS`
 *   member (through `handleTerminatingSignals`, the one way a handler is
 *   installed) for exactly the duration of a supervision, only to take the
 *   child down with it and re-raise; see `guardSupervision`.
 * - **The kill is `SIGKILL` because SIGKILL cannot be REGRESSED.** No code the
 *   child runs, now or after any future edit, can handle, ignore or block it.
 *
 *   ⚠️ SIGTERM DOES kill a child blocked in synchronous `node:sqlite` today, but
 *   only because nothing here installs a JS handler — a property one future
 *   edit could silently remove. SIGKILL is not a property anything can remove.
 * - **The database cannot be handed over.** `DatabaseSync` has no `serialize()`
 *   and `:memory:` is per-CONNECTION, so whoever runs the SQL populates its own
 *   projection. That is why the child is a whole `vat resources check` run and
 *   not a query executor.
 *
 * ## 🔑 The budget is ABSENCE OF PROGRESS, not total runtime
 *
 * A total-runtime bound has to be set above the slowest legitimate run on the
 * largest adopter tree, which makes it useless as a hang detector, and it kills
 * healthy runs that are merely large. So the parent watches the child's progress
 * log and resets its clock on every new line — INCLUDING the population line,
 * which is what bounds the population itself without charging it the first
 * check's budget. A gate that can hang forever is the thing being fixed, and
 * that includes hanging before the first statement.
 *
 * 🔑 **The clock starts at the spawn, and the child's first line is `started`.**
 * The spawn is the only instant this process can observe, so the child's own
 * boot — Node's startup and the CLI's module graph — is a unit like any other:
 * bounded by the budget, and closed by the `started` line the child writes
 * before it touches the tree. Without that line the boot was charged to the
 * population, and a loaded runner's slower boot killed a population that was
 * fine. {@link WatchdogState}'s `quietSince` is therefore `startedAt`, and must
 * stay so: starting the clock at the first line instead would leave a child
 * that hangs while booting with no bound at all.
 *
 * Wherever a kill lands — startup, population, a check, the document — the
 * parent publishes the same kind of document and exits 1. A kill is one outcome
 * and gets one exit code; see `buildInterruptedCheckInput`.
 *
 * ⚠️ **That property holds for the CHECKS. It does NOT hold for the population,
 * and the difference is not a detail.** The population emits exactly ONE line,
 * at its end, so for the single longest unit in a cold run the budget degrades
 * to precisely the total-runtime bound this section argues against: a population
 * that takes longer than the budget is killed however healthily it is working.
 *
 * That is not cheap to fix and a half-fix would be worse than saying so.
 * `onContributorTiming` does fire per contributor, but ~88% of a cold population
 * is the BLOB stage — one call, remark-parsing every document, 33-35 s of the
 * 35 s — and it emits nothing. Per-contributor lines would therefore bound the
 * cheap part, leave the expensive part exactly as unbounded as it is now, and
 * make the whole thing LOOK instrumented. So the population stays one
 * un-instrumented unit, the default budget is set well above a cold one, and the
 * per-unit property is claimed only where it is true.
 *
 * ## Why the child is the CLI itself
 *
 * The child is `vat resources check` with a hidden `--supervised-by` flag, running
 * the ordinary in-process path. Forking the logic would give the supervised lane
 * and the unsupervised one two implementations of the same gate — and the one
 * nobody runs interactively is the one that would rot.
 *
 * ## ⚠️ When the SUPERVISOR dies
 *
 * Its signal handlers and `exit` guard take the child down on every ending that
 * runs its code (see `guardSupervision`). SIGKILL, an OOM killer and, on Windows,
 * any outside kill run none of it.
 *
 * - **Windows**: the OS takes the child down. libuv puts every child spawned
 *   without `detached` in a job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
 *   whose only handle this process holds (`uv__init_global_job_handle`,
 *   `src/win/process.c`), so its `TerminateProcess` terminates the child too, at
 *   once and mid-check: none of the child's code runs, nothing is published.
 * - **POSIX**: the child ends ITSELF. Its stdin is a pipe whose write end only
 *   this process holds and never writes or ends, so however this process dies
 *   the OS closes it and the child reads end-of-file (`endWhenSupervisorGone`).
 *   The child notices when its event loop next turns: at once during the
 *   population; during the synchronous check loop, once the LAST check has
 *   returned (a statement blocked inside SQLite reaches nothing until it
 *   returns) — and still before it publishes anything
 *   (`letSupervisorLossSurface`). Either way it exits 2 with one stderr line.
 *   (The pipe is there on Windows too; the job object simply ends the child
 *   first.)
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { ExitCode, exitCodeForReport, type Report, toFindings, withAddedFindings } from '@vibe-agent-toolkit/schema';
import {
  disposeTempDirSync,
  isPathAbsentError,
  requireFollowedStatSync,
  safePath,
  type TempDirOutcome,
  withTempDir,
} from '@vibe-agent-toolkit/utils';
import { handleTerminatingSignals, killProcessTree, type KillProcessTreeOptions } from '@vibe-agent-toolkit/utils/process';

import { CommandRefusalError, errorMessageOf } from '../../utils/command-refusal.js';
import { leftoverIssueOf, readForwardedDocument, type ForwardedDocument } from '../../utils/document-writer.js';
import { isSupervisedChild } from '../../utils/operator-notices.js';
import { resolveVatBinPath } from '../../utils/vat-bin-path.js';

import type { UnitInFlight } from './check-progress.js';

/** The verbs a supervisor runs as a child: `check` always, `query` under `--budget`. */
export type SupervisedVerb = 'resources check' | 'resources query';

/** What each supervised verb's run is called in a sentence: "this checks run", "this query run". */
export const SUPERVISED_RUN_NOUN: Readonly<Record<SupervisedVerb, string>> = {
  'resources check': 'checks',
  'resources query': 'query',
};

/**
 * The bound applied when `--budget` is not passed, in seconds.
 *
 * Deliberately loose, because a FALSE kill is far worse than a slow honest
 * failure: it teaches the operator to pass `--budget 0` and lose the bound
 * entirely. Five minutes still turns an infinite hang into a clean bounded
 * failure, which is the whole objective.
 */
export const DEFAULT_BUDGET_SECONDS = 300;

/**
 * 🔑 THE text that says what interrupting a supervised run does — rendered verbatim into
 * `vat validate --help`, `vat resources check --help` and `vat resources query --help` (a unit test
 * pins that), so they can never describe it differently. Help-text indentation (two spaces), no
 * backticks.
 *
 * Each claim is pinned: POSIX signals by `checks-supervisor-orphan.system.test.ts`, the group
 * Ctrl-C by the same file and `signal-guard-group-ctrl-c.system.test.ts`, the orphan's own ending
 * by `checks-supervisor-orphan.system.test.ts` (population) and
 * `checks-supervisor-orphan-loop.system.test.ts` (the check loop) — on Windows the same two cases
 * pin the job object ending the child with its supervisor — the Windows wrapper by
 * `supervise-cli.test.ts`.
 */
export const SUPERVISION_SIGNAL_CONTRACT = `Interrupting a supervised run (vat resources check, vat validate's checks
phase, vat resources query --budget):
  POSIX: SIGTERM, SIGHUP, SIGINT or SIGQUIT sent to this process, to the
  'vat' wrapper (which forwards it), or to the terminal's process group
  (Ctrl-C) kills the child, removes the progress directory, publishes
  nothing, and dies of the signal (status 128+n; exit 2 where the signal
  cannot kill it, PID 1). A process the child itself started (git) is not
  killed with it; it ends on its own.
  POSIX, ended where it runs no code (SIGKILL, an OOM killer), this process
  cannot kill the child: the child reads end-of-file on the stdin pipe this
  process held and ends itself -- one stderr line, exit 2, nothing
  published -- at once during its population, and during the checks once
  the last check returns (a query: once its statement returns; a statement
  inside SQLite is not reached until it returns). A SIGKILL of the 'vat'
  wrapper kills the wrapper alone: this
  process (whose stdin is the terminal's, so it reads no end-of-file) and
  its child run on to completion, or until --budget seconds pass with no
  progress.
  Windows: a console Ctrl-C, Ctrl-Break or window close reaches every process
  on the console; this one kills the child and exits 2, no document. An
  outside kill (TerminateProcess, taskkill /F) of the 'vat' wrapper or of
  this process runs no handler and ends the processes it started with it
  (the OS job object Node puts them in): exit 1, nothing published, the
  progress directory left behind.`;

/** How many times per budget the parent looks at the log. */
const POLLS_PER_BUDGET = 10;

/** Poll bounds, so a huge budget still notices promptly and a tiny one is cheap. */
const MIN_POLL_MS = 50;
const MAX_POLL_MS = 250;

/**
 * How many refused SIGKILLs the watchdog sends before it stops trying and
 * REPORTS instead.
 *
 * A retry count, not a bound on anything stored. A kill of a child that has
 * already exited never reaches here: Node's `subprocess.kill()` swallows
 * `ESRCH` and emits no `error` for it. What does arrive is any other refusal —
 * `EPERM`, in practice — and that may be transient (a refusal raced against the
 * child's own exit, an OS that briefly refuses) or permanent (a permission fact
 * that will be just as true on the thousandth attempt). Retrying a handful of
 * times covers the transient case at negligible cost; continuing past that
 * would turn the supervisor into a second unbounded hang, which is the thing
 * this module exists to abolish. So it escalates to an honest report naming
 * the pid.
 */
const KILL_ATTEMPTS_BEFORE_REPORTING = 5;

/**
 * How many polls after the first ACCEPTED SIGKILL the watchdog waits for the child's `exit`
 * before it REPORTS the kill as one that did not land.
 *
 * The kernel accepting SIGKILL is not the child ending: a process in uninterruptible I/O (state
 * `D` on Linux — a hung NFS mount, a wedged disk) takes the signal and does not die until the I/O
 * returns, which may be never. Without this the watchdog re-sent SIGKILL forever and the
 * supervisor became the second unbounded hang. 20 polls is 1-5 s at the poll bounds — far beyond
 * the moment a SIGKILLed process normally takes to be reaped.
 */
const KILL_POLLS_BEFORE_REPORTING_UNREAPED = 20;

/** What the watchdog remembers between polls. */
export interface WatchdogState {
  /** How large the progress log was when it last changed. */
  readonly bytesSeen: number;
  /** When that was — the instant the budget is counted from. */
  readonly quietSince: number;
}

/**
 * Decide whether the child has gone quiet for longer than the budget.
 *
 * Pure, and separated from the timer for exactly that reason: the interesting
 * behaviour is "a run that keeps making progress is never killed, however long
 * it takes", and a test of that against a real timer would be a twenty-second
 * test that flakes. Here it is twenty function calls.
 *
 * 🪤 Growth is measured in BYTES rather than parsed lines. A partially written
 * line also grows the file, and treating that as progress is the safe direction:
 * the child is demonstrably alive and writing. Counting lines instead would mean
 * a very slow write could look like silence.
 *
 * @param state - What the previous poll saw
 * @param observation - The run
 * @param observation.bytes - The progress log's current size
 * @param observation.now - The clock, in milliseconds
 * @param observation.budgetMs - How long silence is allowed to last
 * @returns The state to carry forward, and whether the budget was blown
 */
export function pollWatchdog(
  state: WatchdogState,
  observation: { bytes: number; now: number; budgetMs: number },
): { state: WatchdogState; breach: boolean } {
  if (observation.bytes !== state.bytesSeen) {
    return { state: { bytesSeen: observation.bytes, quietSince: observation.now }, breach: false };
  }
  return { state, breach: observation.now - state.quietSince >= observation.budgetMs };
}

/**
 * Read `--budget`, or supply the default.
 *
 * 🪤 A typo is REFUSED rather than defaulted. `--budget 2O` (letter O) would
 * otherwise run with a five-minute bound while the operator believed they had
 * set two seconds — and they would only find out from a CI job that hung for
 * five minutes instead of two. Thrown, so it exits 2 as an operator error, in
 * line with this command's existing contract for an unknown `--check` name.
 *
 * 🚨 **A BLANK value is refused before `Number` ever sees it, and that is the
 * more important half.** `Number('')`, `Number(' ')` and `Number('\n')` are all
 * `0` — finite, non-negative, and therefore accepted by the range guard below —
 * and `0` is this flag's documented escape hatch meaning *no bound at all*. So
 * `--budget "$CHECK_BUDGET"` with the variable unset did not shorten the bound
 * and did not complain: it silently REMOVED it, on the one flag whose entire
 * purpose is to stop an unattended job hanging forever. An unset shell variable
 * is a far more common CI accident than the typo the guard was written for.
 *
 * 🚨 **The blank string was only the visible half of the hazard, and the guard
 * below it is the rest.** What actually removes the bound is `Number(raw) === 0`
 * for a raw string nobody would recognise as a zero — `--budget 1e-400`
 * underflows to `0`, and `--budget -0` is negative zero, which sails past the
 * `seconds < 0` test because `-0 < 0` is false. Both were MEASURED to run
 * completely unbounded, in process, exiting 0 with no supervision and no word
 * said. So a value that PARSES to zero is refused unless the operator literally
 * wrote a zero: `raw.trim() !== '0'` and it is an operator error. The escape
 * hatch is still there, it just has to be spelled the one unambiguous way.
 *
 * ⚠️ That deliberately refuses `0.0` and `0x0` as well. They are not accidents
 * an operator can fall into, they cost one character to rewrite, and a guard
 * with an exception list is a guard whose next exception nobody argues about.
 *
 * 🔑 **Non-zero hex is deliberately KEPT.** `Number('0x10')` is 16 and
 * `--budget 0x10` runs with a sixteen-second bound. That is unambiguous, it
 * cannot arise by accident the way an empty variable can, and refusing it would
 * buy nothing — recorded here so the next reader does not "fix" it into a
 * refusal.
 *
 * @param raw - Whatever Commander parsed, or undefined
 * @returns The budget in seconds; 0 means no bound
 * @throws When the value is blank, means zero without saying so, or is not a
 *   non-negative number
 */
export function parseBudgetSeconds(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_BUDGET_SECONDS;
  if (raw.trim() === '') {
    throw new CommandRefusalError(
      'USAGE_INVALID',
      '--budget was given an empty value. That is almost always an unset shell'
      + ' variable (`--budget "$CHECK_BUDGET"`), and it is refused rather than read'
      + ' as `--budget 0` — which would remove the bound entirely and let the run'
      + ' hang forever. Pass a number of seconds, or `--budget 0` explicitly if that'
      + ' is really what you mean.',
    );
  }

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new CommandRefusalError(
      'USAGE_INVALID',
      `--budget must be a non-negative number of seconds, not "${raw}".`
      + ` It bounds how long the run may go without completing a unit of work;`
      + ` --budget 0 removes the bound entirely (and can then hang forever).`,
    );
  }
  if (seconds === 0 && raw.trim() !== '0') {
    throw new CommandRefusalError(
      'USAGE_INVALID',
      `--budget "${raw}" is a number that means ZERO — and 0 is this flag's escape`
      + ' hatch for "no bound at all", so the run would have gone entirely'
      + ' unsupervised and could hang forever. `1e-400` underflows to zero and `-0`'
      + ' is negative zero, neither of which reads as a request to remove the bound.'
      + ' Pass a positive number of seconds, or exactly `--budget 0` if removing it'
      + ' is really what you mean.',
    );
  }
  return seconds;
}

/**
 * Who asked for the supervised run: the operator, as `vat resources check`, or an orchestrator,
 * as its `checks` phase. It decides how a kill's remedy is worded, and whether the child owes the
 * operator the store notice (see `operator-notices.ts`).
 */
export type CheckInvocation = 'standalone' | 'phase';

/**
 * What the hidden `--supervised-by` flag carries, read: everything a supervisor tells the child it
 * spawned, in ONE value so no half of it can arrive without the other.
 */
export interface SupervisedChild {
  /** Who started the supervision. */
  readonly invoker: CheckInvocation;
  /**
   * The supervisor's pid — this process's parent when it started, checked once at boot (see
   * {@link requireSupervisableFlags}) and named in the line the child prints when it ends itself
   * because the supervisor is gone (`endWhenSupervisorGone`, which watches stdin, not this pid).
   */
  readonly supervisorPid: number;
  /** The progress log both processes watch; the child appends to it. */
  readonly progressLog: string;
}

/** The hidden flag a supervisor hands the child it spawns, and nothing else passes. */
export const SUPERVISED_BY_FLAG = '--supervised-by';

/**
 * The value of {@link SUPERVISED_BY_FLAG} for a child this process is about to spawn:
 * `<invoker>:<this process's pid>:<progress log>`.
 *
 * The pid is what makes the flag unforgeable by accident: the child refuses it unless the pid
 * named is its own parent's — see {@link requireSupervisableFlags}.
 *
 * @param child - Who asked, and where the progress goes (the supervisor is always this process)
 * @returns The flag's value
 */
export function supervisedByValue(child: Omit<SupervisedChild, 'supervisorPid'>): string {
  return `${child.invoker}:${String(process.pid)}:${child.progressLog}`;
}

/**
 * Does this process do the work, or supervise a child that does?
 *
 * 🚨 **The recursion guard, and the reason it is a named function.** `--supervised-by` is what a
 * supervising parent hands its child, and it must WIN against the budget — a child that consulted
 * the budget first would spawn a child of its own, which would spawn a child of its own. A
 * condition inline in the command would be a fork bomb one refactor away with nothing asserting
 * on it.
 *
 * `--budget 0` also runs here: there is nothing to supervise, and a spawn would cost a second
 * process startup to buy no bound at all.
 *
 * @param options - The run
 * @param options.supervisedBy - The hidden `--supervised-by` value, or undefined
 * @param options.budgetSecs - The bound in seconds; 0 means none
 * @returns True when the checks run in this process
 */
export function runsInThisProcess(
  options: { supervisedBy: string | undefined; budgetSecs: number },
): boolean {
  return isSupervisedChild(options) || options.budgetSecs === 0;
}

/**
 * Read `--supervised-by` into the child it describes, refusing it unless this process really is
 * the child of the supervisor it names — and refuse a `--budget` it would silently ignore.
 *
 * 🚨 **Not an operator's flag, and passing it by hand is refused, not tolerated**: a flag that
 * silently removes the bound is the shape an operator never discovers until the hang. So the
 * value names its supervisor's pid, and a process whose parent is not that pid is refused
 * `USAGE_INVALID` in plain words.
 *
 * 🔑 **One value, so an invalid combination cannot be written**: the invoker and the progress
 * log are fields of one value, and the only thing left to refuse is one that does not parse.
 *
 * 🚨 **`--budget` beside it is refused.** The flag wins the fork in {@link runsInThisProcess}
 * unconditionally, so `--budget 60` with it would run UNBOUNDED and say nothing. The RAW
 * `--budget` is the discriminator, not the parsed seconds: the real spawn path never forwards
 * `--budget`, so the child's `budgetSecs` is the default, not anything an operator typed.
 * `--budget 0` beside it is allowed: both say "nobody is supervising this".
 *
 * @param options - The run
 * @param options.supervisedBy - The hidden `--supervised-by` value, or undefined
 * @param options.budgetRaw - What the operator actually typed for `--budget`
 * @param options.budgetSecs - The parsed bound; 0 means none
 * @returns The supervised child this process is, or undefined when it is not one
 * @throws When the flag does not parse, names a supervisor that is not this process's parent, or
 *   comes with a `--budget` it would ignore
 */
export function requireSupervisableFlags(options: {
  supervisedBy: string | undefined;
  budgetRaw: string | undefined;
  budgetSecs: number;
}): SupervisedChild | undefined {
  if (!isSupervisedChild(options)) return undefined;
  const child = parseSupervisedBy(options.supervisedBy);
  if (options.budgetRaw !== undefined && options.budgetSecs !== 0) {
    throw new CommandRefusalError(
      'USAGE_INVALID',
      `--budget cannot be combined with ${SUPERVISED_BY_FLAG}. ${SUPERVISED_BY_FLAG} means "you are`
      + ' the child a supervisor already spawned", so this process does the work rather than'
      + ` bounding it, and the budget would be silently ignored. Drop ${SUPERVISED_BY_FLAG}:`
      + ' it is not an operator\'s flag, and --budget alone gets you the bound.',
    );
  }
  return child;
}

/** `<invoker>:<supervisor pid>:<progress log>` — the log last, since a Windows path holds a colon. */
const SUPERVISED_BY_SHAPE = /^(?<invoker>standalone|phase):(?<pid>\d+):(?<progressLog>.+)$/;

/**
 * Parse `--supervised-by`, and refuse it unless this process's parent is the supervisor it names.
 *
 * @param raw - The flag's value
 * @returns The supervised child
 * @throws `USAGE_INVALID` for a value that does not parse or names another process
 */
function parseSupervisedBy(raw: string): SupervisedChild {
  const notAnOperatorsFlag = `${SUPERVISED_BY_FLAG} is not an operator's flag: it is how`
    + ' `vat resources check`, `vat validate` and `vat resources query --budget` hand the work to'
    + ' the child process they spawn and supervise.';
  const remedy = ' Run the command without it — `--budget <seconds>` sets the bound, and'
    + ' `--budget 0` runs the work in this process with none.';
  const fields = SUPERVISED_BY_SHAPE.exec(raw)?.groups as
    | { invoker: CheckInvocation; pid: string; progressLog: string }
    | undefined;
  if (fields === undefined) {
    throw new CommandRefusalError(
      'USAGE_INVALID',
      `${notAnOperatorsFlag} "${raw}" is not a value a supervisor writes.${remedy}`,
    );
  }
  const { invoker, pid, progressLog } = fields;
  if (Number(pid) !== process.ppid) {
    throw new CommandRefusalError(
      'USAGE_INVALID',
      `${notAnOperatorsFlag} This process was not spawned by the supervisor it names (pid ${pid};`
      + ` this process's parent is ${String(process.ppid)}), so nothing is watching it: it would`
      + ` run with no bound and print none of the run's notices.${remedy}`,
    );
  }
  return { invoker, supervisorPid: process.ppid, progressLog };
}

/**
 * Why a child ended without completing.
 *
 * Structured rather than a prose string because the two common signals point at
 * DIFFERENT remedies — `SIGABRT` is Node's own heap abort and wants a narrower
 * statement, `SIGKILL` from outside wants a bigger runner — and the message that
 * says so belongs beside the other findings, not here.
 */
export type AbnormalDeath =
  | { readonly kind: 'signal'; readonly signal: string }
  | { readonly kind: 'spawn-failed'; readonly binary: string; readonly detail: string }
  /**
   * The watchdog fired and the KILL DID NOT END THE CHILD — so the child is, as
   * far as this process can tell, still running. `refused` says which way: the
   * kernel refused the SIGKILL (`EPERM`, in practice), or accepted it and the
   * child still had not ended {@link KILL_POLLS_BEFORE_REPORTING_UNREAPED} polls
   * later (uninterruptible I/O).
   *
   * 🚨 Distinct from `spawn-failed` and that distinction is the whole point.
   * Both arrive on `child.on('error')`; this one started, ran past its budget,
   * and would not die.
   *
   * `pid` is carried because it is the only handle the operator has left on a
   * process this command could not stop.
   */
  | {
    readonly kind: 'kill-failed';
    readonly detail: string;
    readonly pid: number | undefined;
    readonly refused: boolean;
  }
  | { readonly kind: 'no-status' }
  /**
   * The child exited with a CODE, and published nothing at all.
   *
   * 🚨 The Windows half of the signal-death defect, and it survived the fix for
   * the POSIX half. A fatal abort — Node's own heap limit among them — has no
   * signal to report on a platform that has none, so `exit` fires with
   * `(134, null)` where macOS and Linux give `(null, 'SIGABRT')`. That shape is
   * indistinguishable from an ordinary nonzero exit to
   * {@link resolveChildEnding}, which read it as a COMPLETED run and handed the
   * parent an empty string to forward. Measured on `windows-latest`: exit 134,
   * zero bytes of stdout, on precisely the runaway the bound exists to catch.
   *
   * It did not fail OPEN — 134 is not 0 — so a gate still went red. But the
   * report was absent, which is the other half of what the original defect did.
   *
   * `code` is carried because it is the only thing left that says HOW the child
   * died: 128 + n is the conventional encoding of a fatal signal, and
   * `deathRemedy` reads the signal back out of it.
   */
  | { readonly kind: 'no-output'; readonly code: number }
  /**
   * The child exited with a code and wrote something that is not this verb's
   * document — cut off mid-write, most often. The sibling of `no-output`: the
   * same situation (no usable report), so the same ending (the interrupted
   * document from the progress log), never an internal error.
   */
  | { readonly kind: 'unparseable-output'; readonly code: number; readonly detail: string }
  /**
   * The child published a whole, valid document — and then exited with a code that document does
   * not imply.
   *
   * 🚨 The document alone decided the forwarded exit, so a complete `ok` report followed by a
   * non-zero exit was forwarded as a clean pass. Every path through the command ends on the code
   * its own document derives, so a disagreement means something ended the child AFTER it wrote —
   * a crash in teardown, a termination from outside that left an exit code — or a defect in vat.
   * Which of the two is the truth cannot be known here, so neither is forwarded.
   */
  | { readonly kind: 'exit-disagrees'; readonly code: number; readonly documentExit: number };

/** The supervisor's kind for a child whose exit contradicts its own complete document. */
const EXIT_DISAGREES = 'exit-disagrees' satisfies AbnormalDeath['kind'];
/** The supervisor's kind for a child that was never started. */
const SPAWN_FAILED = 'spawn-failed' satisfies AbnormalDeath['kind'];
/** The supervisor's kind for a kill that did not end the child. */
const KILL_FAILED = 'kill-failed' satisfies AbnormalDeath['kind'];
/** The supervisor's kind for a completion whose document did not survive the trip. */
const UNPARSEABLE_OUTPUT = 'unparseable-output' satisfies AbnormalDeath['kind'];

/** A watchdog SIGKILL that did not end the child — the fields of the `kill-failed` death. */
type KillFailure = Omit<Extract<AbnormalDeath, { kind: 'kill-failed' }>, 'kind'>;

/** What a child's ending MEANT, once the watchdog's belief is reconciled with it. */
export type RunResolution =
  | { readonly kind: 'completed'; readonly code: number }
  | { readonly kind: 'killed' }
  | { readonly kind: 'abnormal'; readonly death: AbnormalDeath };

/**
 * Read `exit`'s two arguments, and the watchdog's belief, into one answer.
 *
 * ## 🚨 The defect this closes: a signal death READ AS SUCCESS
 *
 * `exit` fires with `(code, signal)`, and a process that dies from a signal has
 * `code === null` with `signal` set, and a signal death must never be coerced
 * to a COMPLETED run with exit code 0 (which a CI gate reads as a clean pass).
 * Every memory death arrives here: Node's own heap abort (an unbounded result
 * set filling `.all()`), a kernel OOM killer on a memory-capped runner (which
 * picks the large CHILD, never the idle parent), and a container limit.
 *
 * ## 🪤 A kill only counts if it LANDED
 *
 * `killed` says the watchdog fired, not that the child died of it. libuv runs
 * timers BEFORE the poll phase that reaps the child, so the timer can fire in
 * the same loop turn as a child that has already exited cleanly. A NORMAL ending
 * — a non-null code with no signal — is therefore honoured whatever `killed`
 * says: that run finished on its own terms and its answer is real. Reporting it
 * as killed fails closed, but it discards a correct result, which is its own
 * kind of wrong.
 *
 * ## 🚨 The ORDER of the tests below is load-bearing
 *
 * Node emits `error` on the ChildProcess when `subprocess.kill()` itself fails,
 * so testing `spawnError` first would report a refused SIGKILL as a child that
 * "could not be started at all".
 *
 * So: a real ending first, then what the SUPERVISOR did (a refused kill, then a
 * kill), and only then a failure to start. A run whose kill was refused must
 * never claim the watchdog was uninvolved.
 *
 * @param ending - What `exit` reported, plus what the supervisor did and saw
 * @param ending.code - `exit`'s first argument
 * @param ending.signal - `exit`'s second argument
 * @param ending.killed - Whether the watchdog sent SIGKILL
 * @param ending.spawnError - Set when the child never started at all
 * @param ending.killFailure - Set when the watchdog's SIGKILL was refused, or did not end the child
 * @returns What actually happened
 */
export function resolveChildEnding(ending: {
  code: number | null;
  signal: string | null;
  killed: boolean;
  spawnError?: { binary: string; detail: string } | undefined;
  killFailure?: KillFailure | undefined;
}): RunResolution {
  if (ending.code !== null && ending.signal === null) {
    return { kind: 'completed', code: ending.code };
  }
  if (ending.killFailure !== undefined) {
    return { kind: 'abnormal', death: { kind: KILL_FAILED, ...ending.killFailure } };
  }
  if (ending.killed) return { kind: 'killed' };
  if (ending.spawnError !== undefined) {
    return { kind: 'abnormal', death: { kind: SPAWN_FAILED, ...ending.spawnError } };
  }
  return ending.signal === null
    ? { kind: 'abnormal', death: { kind: 'no-status' } }
    : { kind: 'abnormal', death: { kind: 'signal', signal: ending.signal } };
}

/**
 * Reconcile "how the process ended" with "what it left behind".
 *
 * ## 🚨 A completion that PUBLISHED NOTHING did not complete
 *
 * {@link resolveChildEnding} answers a question about the process — what `exit`
 * reported, reconciled with what the supervisor did. This answers a DIFFERENT
 * one, about the artifact, and the two disagree in exactly one place: a child
 * that exited with a code and wrote no document.
 *
 * Every in-process path through `checkCommand` ends at `endWithReport` or at
 * `endWithRefusal`, and both write to stdout — a clean pass, a violation, a
 * bricked config, a mistyped `--check`. There is no exit this command can take
 * that legitimately publishes nothing. So an empty stdout is not a quiet run, it
 * is a run that was cut off before it could say anything, and forwarding its
 * exit code verbatim tells the operator a number and nothing else.
 *
 * ## 🪤 Why this is not folded into {@link resolveChildEnding}
 *
 * That function's branch ORDER is load-bearing and reasoned entirely about
 * process endings and supervisor beliefs. The emptiness of stdout belongs to
 * neither, and threading it through would put an artifact test inside an
 * ordering argument that has already been got wrong twice. It runs AFTER, on the
 * one branch it can change, and it changes no other.
 *
 * ⚠️ **Blank, not unparseable.** This asks only whether anything was written.
 * Whether the bytes parse is asked next, by {@link readCompletedDocument}, which
 * knows the format: a truncated document — an abort that landed mid-write — is
 * the sibling `unparseable-output` death, and ends the same way.
 *
 * @param resolution - How the process ended
 * @param stdout - Everything the child wrote to stdout
 * @returns The resolution, with a silent completion re-read as abnormal
 */
export function resolveSilentCompletion(
  resolution: RunResolution,
  stdout: string,
): RunResolution {
  if (resolution.kind !== 'completed' || stdout.trim() !== '') return resolution;
  return { kind: 'abnormal', death: { kind: 'no-output', code: resolution.code } };
}

/** How a supervised run ended. */
export type SupervisedRun =
  | { readonly outcome: 'completed'; readonly document: ForwardedDocument }
  | { readonly outcome: 'killed'; readonly log: string; readonly elapsedMs: number }
  | {
    readonly outcome: 'abnormal';
    readonly death: AbnormalDeath;
    readonly log: string;
    readonly elapsedMs: number;
  };

/**
 * Run a supervised verb as a child, bounded by the budget.
 *
 * `stdio` is `['pipe', 'pipe', 'inherit']`. Its stdin is a pipe this process
 * holds open and NEVER writes to or ends: it exists only so that the child reads
 * end-of-file the moment this process is gone, however it went (see
 * `endWhenSupervisorGone`). Node closes this end itself once the child has
 * exited. The child's stdout is accumulated so the parent can forward the
 * document verbatim, and its stderr is INHERITED so warnings and blob-stage
 * refusals stream live exactly as they do today.
 *
 * ⚠️ Asynchronous `spawn`, never `spawnSync`. The parent's event loop is the
 * thing holding the watchdog timer; a synchronous spawn would block it for
 * precisely as long as the run it is supposed to be bounding.
 *
 * 🚨 There is an `error` listener as well as an `exit` one, and it is not
 * optional politeness: without it an unspawnable binary is an unhandled `error`
 * event, which Node turns into a stack dump instead of a report. It fails
 * closed, so this is legibility — but a stack dump is not a report.
 *
 * ## 🚨 `error` is NOT only a spawn-failure listener, and reading it as one
 * ABANDONED A LIVE CHILD
 *
 * Node emits `error` on the ChildProcess when `subprocess.kill()` itself fails.
 * The shipped function ends `else { /* Other error, almost certainly EPERM. *\/
 * this.emit('error', new ErrnoException(err, 'kill')); }`. So: the watchdog
 * breached, `killed` was set, the SIGKILL was refused, `error` fired, the
 * handler recorded a SPAWN failure and resolved immediately — which cleared the
 * watchdog timer, so no further kill could ever be attempted — and the parent
 * published a report saying the child "could not be started at all" and "the
 * watchdog never fired" while the runaway was still executing. The bound this
 * module exists to enforce became an orphaned unbounded hang, described as its
 * own opposite.
 *
 * The handler therefore forks on `killed`, and the two arms are deliberately
 * asymmetric:
 *
 * - **Before the watchdog fired**, an `error` means the child never started.
 *   Resolve at once: there is nothing alive to wait for.
 * - **After it fired**, an `error` means the KILL failed and the child is,
 *   as far as this process can tell, still running. Do NOT resolve. Resolving
 *   is what clears the timer, and clearing the timer is what makes the failure
 *   permanent. The poll keeps breaching (the log is not growing and
 *   `quietSince` is not reset), so it keeps re-sending SIGKILL, and a transient
 *   refusal still lands. Only after {@link KILL_ATTEMPTS_BEFORE_REPORTING}
 *   refusals does it give up — and it gives up by REPORTING, naming the pid,
 *   never by claiming the child never started.
 *
 * ⚠️ Reachability of `EPERM` on one's own child is REASONED rather than
 * reproduced — it is rare on macOS and Linux. Nothing in production was
 * contorted to make it testable; the branch ordering and the message
 * composition are pure functions and are pinned as such.
 *
 * ⏱️ Every interval is read off `performance.now()`, the monotonic clock: a
 * wall clock stepped by NTP or an operator would grow or shrink the budget.
 *
 * 🚨 **`spawn` can THROW, not only emit `error`.** An argument list longer than
 * the platform allows (a query's statement travels on the command line) throws
 * `E2BIG` synchronously — measured on Node 26.7 with one 4 MB argument. Uncaught,
 * that escaped as whatever refusal the throw became; it is the same failure as an
 * `error` event and ends the same way, as `spawn-failed`.
 *
 * @param options - The run
 * @param options.verb - The verb the child runs, whose document it must publish
 * @param options.args - The child's argv after the node binary, `--supervised-by` included
 * @param options.log - The progress log both sides agreed on, and the guard {@link withProgressLog} holds over it
 * @param options.budgetMs - How long silence is allowed to last
 * @param options.format - The format the child was asked for, to read its document in
 * @returns How the child ended, and what it left behind
 */
export async function superviseRun(options: {
  verb: SupervisedVerb;
  args: readonly string[];
  log: ProgressLog;
  budgetMs: number;
  format: 'yaml' | 'json';
}): Promise<SupervisedRun> {
  const logPath = options.log.path;
  const startedAt = performance.now();
  const binary = resolveVatBinPath();
  const wreckage = (): { log: string; elapsedMs: number } =>
    ({ log: readLog(logPath), elapsedMs: performance.now() - startedAt });
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [binary, ...options.args], {
      // ⛔ Never `detached`. A process-group leader is outside the terminal's job control: Ctrl-Z
      // does not stop it, and under `stty tostop` its stderr write stops it with SIGTTOU, so the
      // watchdog false-kills a healthy run. In this process's group it receives a terminal Ctrl-C
      // itself — see `CHECKS_CHILD_TREE` for what that costs.
      stdio: ['pipe', 'pipe', 'inherit'],
    });
  } catch (error) {
    // The `error` event's ending, through the same resolver: nothing was started.
    const failed = resolveChildEnding({ code: null, signal: null, killed: false, spawnError: { binary, detail: errorMessageOf(error) } });
    if (failed.kind !== 'abnormal') throw error;
    return { outcome: 'abnormal', death: failed.death, ...wreckage() };
  }
  // The guard `withProgressLog` installed now takes this child down with the process too.
  options.log.guard.watch(child);

  const chunks: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));

  let exited = false;
  let killed = false;
  let killAttempts = 0;
  let killFailure: KillFailure | undefined;
  let spawnError: { binary: string; detail: string } | undefined;
  let state: WatchdogState = { bytesSeen: 0, quietSince: startedAt };
  // 🪤 Declared out here and started INSIDE the promise, so the watchdog can
  // settle the run itself when it runs out of kills. Starting it outside would
  // put the escalation out of the timer's reach and force the `error` handler
  // back into resolving on a child that is still alive.
  let timer: NodeJS.Timeout | undefined;

  const resolution = await new Promise<RunResolution>((resolve, reject) => {
    // 🪤 `error` does not always end the process, and it is not always followed
    // by `exit` — so a SPAWN failure is remembered and resolved on immediately.
    // A promise settles once, so whichever event arrives first wins and the
    // other is a no-op. A failed KILL is the opposite case: see this function's
    // header for why it must not settle here.
    child.on('error', (cause: Error) => {
      if (killed) {
        killFailure = { detail: cause.message, pid: child.pid, refused: true };
        return;
      }
      spawnError = { binary, detail: cause.message };
      resolve(resolveChildEnding({ code: null, signal: null, killed, spawnError }));
    });
    // ⛔ BOTH arguments. `exitCode ?? 0` here read every signal death as a
    // successful run — see {@link resolveChildEnding}.
    //
    // 🔑 The child's death is its `exit`, never its `close`: `close` waits for every holder of its
    // stdout, and a grandchild (a `git` it spawned) can hold that for ever — the watchdog then
    // went on killing a child already dead and reported a kill that "did not land". `close` only
    // collects the rest of stdout, and gets a bounded grace to do it (`awaitStdout`).
    child.on('exit', (code, signal) => {
      exited = true;
      awaitStdout(child, () => {
        resolve(resolveChildEnding({ code, signal, killed, spawnError, killFailure }));
      });
    });

    const poll = (): void => {
      if (exited) return;
      const reading = pollWatchdog(state, {
        bytes: logSize(logPath),
        now: performance.now(),
        budgetMs: options.budgetMs,
      });
      state = reading.state;
      if (!reading.breach) return;
      killed = true;
      killAttempts += 1;
      // SIGKILL, because no code the child could ever gain can handle, ignore
      // or block it. See this module's header — and note the reason is NOT that
      // SIGTERM fails to reach a blocked process, which was measured false.
      killProcessTree(child, CHECKS_CHILD_TREE);
      const unended = unendedKill(killAttempts, killFailure, child.pid);
      if (unended !== undefined) resolve(resolveChildEnding({ code: null, signal: null, killed, killFailure: unended }));
    };
    // 🚨 A poll that THROWS — a progress log this process can no longer stat — has no reading,
    // and the timer is outside every caller's `try`: uncaught, it reached the CLI's last-resort
    // handler, which exits 2 with NO document, and `vat validate` lost the phases that had
    // finished. So the throw ends the supervision here, the one place that can: kill the child
    // (nothing bounds it once the timer stops), stop the timer, and REJECT, so the caller
    // publishes it — `vat validate` as RUN_INCOMPLETE, `vat resources check` as its refusal.
    // The `exit` guard stays behind this as the second line.
    timer = setInterval(() => {
      try {
        poll();
      } catch (error) {
        clearInterval(timer);
        killProcessTree(child, CHECKS_CHILD_TREE);
        reject(error as Error);
      }
    }, pollIntervalMs(options.budgetMs));
  });
  clearInterval(timer);

  const stdout = Buffer.concat(chunks).toString('utf-8');
  // 🚨 AFTER the ending is resolved, never inside it. A child that exited with a
  // code and published nothing did not complete, whatever `exit` said — see
  // {@link resolveSilentCompletion} for the platform this is about.
  const ending = resolveSilentCompletion(resolution, stdout);

  if (ending.kind === 'completed') {
    // Read while the progress log still exists: a document that is not one is
    // a death, and the log is what its interrupted document is built from.
    const read = readCompletedDocument(options.verb, stdout, ending.code, options.format);
    return 'document' in read
      ? { outcome: 'completed', document: read.document }
      : { outcome: 'abnormal', death: read.death, ...wreckage() };
  }
  return ending.kind === 'killed'
    ? { outcome: 'killed', ...wreckage() }
    : { outcome: 'abnormal', death: ending.death, ...wreckage() };
}

/**
 * How long, once the child has exited, the rest of its stdout is given to arrive.
 *
 * The child writes its document synchronously before it exits, so all that can still be in flight
 * is one pipe buffer, read in milliseconds. A wait past this is a GRANDCHILD holding the write end
 * open — and that wait has no end.
 */
const STDOUT_GRACE_AFTER_EXIT_MS = 2000;

/**
 * Call `settle` once the exited child's stdout has closed — or once
 * {@link STDOUT_GRACE_AFTER_EXIT_MS} has passed, with whatever was read by then, and the stream
 * destroyed so a grandchild holding it cannot hold this process open either.
 *
 * @param child - A child that has emitted `exit`
 * @param settle - Called exactly once
 */
function awaitStdout(child: ChildProcess, settle: () => void): void {
  const grace = setTimeout(() => {
    child.removeListener('close', onClose);
    child.stdout?.destroy();
    settle();
  }, STDOUT_GRACE_AFTER_EXIT_MS);
  function onClose(): void {
    clearTimeout(grace);
    settle();
  }
  child.once('close', onClose);
}

/**
 * The kill that did not end the child, once the watchdog has tried long enough to say so — or
 * undefined while it should keep trying.
 *
 * A REFUSED kill is reported after {@link KILL_ATTEMPTS_BEFORE_REPORTING} attempts; an ACCEPTED one
 * that has not ended the child after {@link KILL_POLLS_BEFORE_REPORTING_UNREAPED}. Either way the
 * supervision settles, naming the pid, rather than polling forever.
 *
 * @param killAttempts - SIGKILLs sent so far, one per breaching poll
 * @param refusal - Set when the kernel refused a SIGKILL
 * @param pid - The child's pid
 * @returns The failure to settle on, or undefined to keep trying
 */
function unendedKill(
  killAttempts: number,
  refusal: KillFailure | undefined,
  pid: number | undefined,
): KillFailure | undefined {
  if (refusal !== undefined) return killAttempts >= KILL_ATTEMPTS_BEFORE_REPORTING ? refusal : undefined;
  if (killAttempts < KILL_POLLS_BEFORE_REPORTING_UNREAPED) return undefined;
  return {
    detail: `SIGKILL was accepted ${String(killAttempts)} times and the process had still not ended`,
    pid,
    refused: false,
  };
}

/**
 * The guard {@link withProgressLog} holds over one supervision: what {@link superviseRun} tells it.
 */
export interface SupervisionGuard {
  /** From now on, every ending of this process takes `child` down with it. */
  watch(child: ChildProcess): void;
}

/** A progress log, and the guard over its whole life — one value, so neither travels without the other. */
export interface ProgressLog {
  /** The log's path, alone in a directory minted for this run. */
  readonly path: string;
  /** The guard over the log's directory and the child that writes it. */
  readonly guard: SupervisionGuard;
}

/**
 * While a supervision lives, make every way THIS process ends take the child and the progress
 * directory with it.
 *
 * ## 🚨 The defect: a supervisor that ended without its child orphaned an unbounded run
 *
 * The bound is enforced by this process's timer. Anything that ends this process ends the timer —
 * and the child it was bounding was reparented and kept running with nothing left to stop it: the
 * exact unbounded hang the supervisor exists to abolish. Measured ways in: a SIGTERM, SIGHUP or
 * SIGINT sent to this pid alone; an uncaught throw anywhere in this process (the last-resort handler
 * ends it with `process.exit` — the poll's own throw is caught in {@link superviseRun}, so this is
 * the second line for it); and a kill the kernel refused, which settles the run while the child
 * lives on.
 *
 * So for the supervision's WHOLE life — from before the progress directory is minted until after
 * it is removed, see {@link withProgressLog}:
 *
 * - **`exit`** SIGKILLs the child (`CHECKS_CHILD_TREE`), once there is one and while it runs, and removes the progress directory, once there is one — every ending of this process that
 *   runs any of its code passes through it, a last-resort `process.exit` included, and
 *   `process.exit` runs no `finally`.
 * - **Every `TERMINATING_SIGNALS` member**, through `handleTerminatingSignals`: does the same,
 *   synchronously, and RE-RAISES the signal. On POSIX this process then dies of it (status 128 + n),
 *   as a shell and a CI runner expect. On Windows, or where the signal cannot kill it (PID 1), it
 *   exits 2 with no document. A repeat with the first is swallowed. The child shares this
 *   process's group, so a terminal's Ctrl-C reaches it directly too and, with no handler of its
 *   own, ends it; this guard kills it all the same.
 *
 * The release waits for the child's `exit`, not for the run to settle, so a run settled with its
 * child still alive (a refused kill, a poll that threw) still takes the child down however this
 * process then ends.
 *
 * The module header gives why SIGKILL, and why the CHILD must never install a handler. This
 * process may: its event loop is never blocked, which is what makes a handler fire at all.
 *
 * ## ⚠️ What no guard here reaches
 *
 * An ending that runs none of this process's code: SIGKILL, an OOM killer, and on Windows ANY
 * outside kill — `process.kill(pid, <signal>)` there is `TerminateProcess`, which runs neither a
 * signal handler nor the `exit` guard. On Windows the OS ends the child with this process (libuv's
 * kill-on-close job object — see the module header). On POSIX the child covers those itself: it
 * reads end-of-file on the stdin pipe this process held (`endWhenSupervisorGone`). A child blocked
 * inside one SQLite statement reaches nothing until the statement returns.
 *
 * @returns The guard: `cover` names the progress log once it exists, `watch` the child once it is
 *   spawned, and `release` ends the guard — at once, or at the watched child's `exit`
 */
function guardSupervision(): SupervisionGuard & { cover(logPath: string): void; release(): void } {
  let child: ChildProcess | undefined;
  let logPath: string | undefined;
  let takenDown = false;
  // Synchronous, so a signal ends this process inside its own turn — nothing publishes meanwhile.
  const takeDown = (): void => {
    if (takenDown) return;
    takenDown = true;
    // 🚨 Only a child still running: one that has exited may be reaped, and its pid reused by a
    // stranger the kill would then reach.
    if (child?.exitCode === null && child.signalCode === null) killProcessTree(child, CHECKS_CHILD_TREE);
    if (logPath !== undefined) disposeProgressDir(logPath);
  };
  const signals = handleTerminatingSignals({ cleanup: takeDown, fallbackExitCode: ExitCode.ERROR });
  function releaseAll(): void {
    signals.release();
    process.off('exit', takeDown);
  }
  process.once('exit', takeDown);

  return {
    cover: (path) => {
      logPath = path;
    },
    watch: (spawned) => {
      child = spawned;
    },
    release: () => {
      // Still running: hold every handler until it is gone — its `exit`, not its `close`, which a
      // grandchild holding its stdout can delay for ever. Gone, never started, or never spawned:
      // nothing left to take down.
      if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) child.once('exit', releaseAll);
      else releaseAll();
    },
  };
}

/**
 * How the checks child is killed.
 *
 * POSIX: its pid alone. It shares this process's group (never `detached`, see
 * {@link superviseRun}), so there is no group of its own to kill: a process it started (`git`)
 * is not killed with it and ends on its own. It is killed through `child.kill` FIRST, because that
 * is the call whose refusal Node reports as the child's `error` — the arm the watchdog retries and
 * then reports — and, on Windows, the only kill whose signal `exit` then reports: a `taskkill`
 * first made the watchdog's kill read as the child exiting 1 on its own. Windows then sweeps the
 * tree with `taskkill /T`, best-effort (see `killProcessTree`).
 */
const CHECKS_CHILD_TREE: KillProcessTreeOptions = { groupLeader: false, throughChild: true };

/**
 * Remove the progress log's directory, synchronously, on the way out of this process — and say so
 * on stderr when the OS would not, since no report will carry it. `disposeTempDirSync` retries a
 * transient refusal briefly: on Windows the child just terminated still holds its handles for a
 * moment.
 *
 * @param logPath - The progress log
 */
function disposeProgressDir(logPath: string): void {
  const leftover = disposeTempDirSync(dirname(logPath));
  if (leftover !== undefined) process.stderr.write(`${errorMessageOf(leftover)}\n`);
}

/**
 * How often to look at the log.
 *
 * Derived from the budget rather than fixed, so `--budget 2` notices in 200 ms
 * while `--budget 600` does not wake the event loop 12,000 times for nothing.
 *
 * @param budgetMs - The budget
 * @returns The poll interval in milliseconds
 */
function pollIntervalMs(budgetMs: number): number {
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, budgetMs / POLLS_PER_BUDGET));
}

/**
 * The progress log's size, or 0 before the child has written anything.
 *
 * 🪤 A missing file is 0, not an error. The child creates the log on its first
 * emission, so every poll before that legitimately finds nothing — and throwing
 * there would kill the supervisor instead of the runaway.
 *
 * ONLY a missing file. The log lives in a directory this process minted, so a
 * refusal to stat it is not a state the watchdog has a reading for — and the
 * reading "0 forever" would mean "the child has gone quiet" and kill a healthy
 * child as a runaway. So it throws,
 * and {@link superviseRun} ends the supervision on the throw: the child killed,
 * the run reported as one that did not finish.
 *
 * @param path - The progress log
 * @returns Its size in bytes
 */
function logSize(path: string): number {
  try {
    // A file in a directory this process minted: its own `within`.
    return requireFollowedStatSync(path, path).size;
  } catch (error) {
    if (isPathAbsentError(error)) return 0;
    throw error;
  }
}

/**
 * Whatever of the log survived the kill.
 *
 * @param path - The progress log
 * @returns Its contents, or the empty string when the child never wrote one
 */
function readLog(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch (error) {
    if (isPathAbsentError(error)) return '';
    throw error;
  }
}

/**
 * Run `work` with a fresh progress log, and remove it however that ends — a signal included.
 *
 * ⚠️ Ephemeral, per run, and it carries NO format version — see
 * `check-progress.ts`. It is written and read by one process pair within one run
 * of one build, so the reader's own `.strict()` schema is the entire contract.
 *
 * 🔑 The guard ({@link guardSupervision}) is installed BEFORE the directory is
 * minted and released only AFTER it is removed, so a signal in either window —
 * not only while the child runs — still removes it. One guard, one lifetime.
 *
 * @param verb - The supervised verb, which names the directory (`vat-check-…`, `vat-query-…`)
 * @param work - Given the log
 * @returns What `work` returned, with the log's directory as a `leftover` when the OS
 *   would not remove it (see `withTempDir`) — for the caller to report as a warning
 */
export async function withProgressLog<T>(
  verb: SupervisedVerb,
  work: (log: ProgressLog) => Promise<T>,
): Promise<TempDirOutcome<T>> {
  const guard = guardSupervision();
  try {
    return await withTempDir(`vat-${verb.replace('resources ', '')}-`, (dir) => {
      const path = safePath.join(dir, 'progress.jsonl');
      guard.cover(path);
      return work({ path, guard });
    });
  } finally {
    guard.release();
  }
}

/**
 * Read what a COMPLETED child wrote as its verb's document, or name the death
 * when it is not one — or when the child's exit disagrees with it.
 *
 * 🔑 The exit is compared with the one the document itself derives. The parent
 * forwards the DOCUMENT's code, never the process's, so a child that wrote a
 * clean report and then exited non-zero would otherwise be published as a pass.
 *
 * @param verb - The verb the child ran, whose document it must have published
 * @param stdout - Everything the child wrote (known not to be blank)
 * @param code - The child's exit code
 * @param format - The format the child was asked for
 * @returns The forwardable document, or the `unparseable-output` / `exit-disagrees` death
 */
export function readCompletedDocument(
  verb: SupervisedVerb,
  stdout: string,
  code: number,
  format: 'yaml' | 'json',
): { readonly document: ForwardedDocument } | { readonly death: AbnormalDeath } {
  let document: ForwardedDocument;
  try {
    document = readForwardedDocument(verb, stdout, format);
  } catch (error) {
    return { death: { kind: UNPARSEABLE_OUTPUT, code, detail: errorMessageOf(error) } };
  }
  const documentExit = exitCodeForReport(document.report);
  return documentExit === code
    ? { document }
    : { death: { kind: 'exit-disagrees', code, documentExit } };
}

/**
 * Who a supervised run's kill and death sentences are written for: an operator's
 * `vat resources check`, `vat validate`'s checks phase, or `vat resources query --budget`.
 *
 * 🔑 One key, so every sentence below is chosen from the same fact: a remedy names only a flag
 * the verb that ran accepts, and only `check` has rules to name.
 */
export type RunInvocation = CheckInvocation | 'query';

/**
 * Why a supervised run ended without its own document: the watchdog's kill, or a death the
 * watchdog had no part in — and who ran it.
 *
 * 🔑 Carried as a union because the two point at opposite remedies. A budget kill means *the bound
 * was reached* — the remedy may genuinely be a larger bound. An abnormal death means *the run
 * died* — most often out of memory — and there the budget was never involved, so advice to raise
 * it is a false diagnosis that makes the situation worse.
 */
export type RunEnding<I extends RunInvocation = RunInvocation> =
  | { readonly kind: 'budget'; readonly budgetSecs: number; readonly invocation: I }
  | { readonly kind: 'abnormal'; readonly death: AbnormalDeath; readonly invocation: I };

/**
 * What a supervised run decided to publish: the child's own document, or one the parent built.
 */
export type SupervisedEnding<R extends Report<unknown>> =
  | { readonly forward: ForwardedDocument }
  | { readonly payload: R };

/**
 * `ending` with the progress log's directory, when the OS would not remove it, as one
 * `TREE_CLEANUP_INCOMPLETE` warning beside what ran. A forwarded document is then published
 * re-built rather than byte for byte: it gained a finding the child never knew of.
 *
 * @param ending - What the supervision decided to publish
 * @param leftover - The directory `withProgressLog` could not remove, or undefined
 * @returns The ending to publish
 */
export function withLeftover<T>(
  ending: SupervisedEnding<Report<T>>,
  leftover: unknown,
): SupervisedEnding<Report<T>> {
  if (leftover === undefined) return ending;
  const added = toFindings([leftoverIssueOf(leftover)]);
  // The child's document was validated against its verb's schema when it was read.
  const report = 'forward' in ending ? (ending.forward.report as Report<T>) : ending.payload;
  return { payload: withAddedFindings(report, added) };
}

/**
 * The exit code Node uses for its own fatal abort, on EVERY platform.
 *
 * 🚨 **This is measured, and it is NOT the local platform's signal number.** On
 * macOS and Linux 134 is the shell encoding `128 + SIGABRT`, where `SIGABRT` is
 * 6. On Windows `os.constants.signals.SIGABRT` is **22** — MSVC numbers it
 * differently — so deriving the code from that table gives 150 and matches
 * nothing Node ever emits. A `windows-latest` run of the heap-abort case
 * reported exactly **134**, the same as Unix: the number comes from Node's own
 * abort path, not from the platform's signal table.
 *
 * 🪤 Pinned as a measured fact, and a test asserts the number itself: a test
 * that re-derived it from `os.constants.signals` would agree with wrong code.
 *
 * ⛔ Not a version constant: it decides nothing about whether stored data is
 * still valid. It is an external protocol value, like an API header.
 */
export const NODE_FATAL_ABORT_EXIT_CODE = 134;

/**
 * The sentence that says why the run ended without its own document, and what to do about it.
 *
 * @param inFlight - What the progress log's last state says
 * @param ending - Which way the run ended, and who ran it
 * @returns The message body
 */
export function interruptionMessage(inFlight: UnitInFlight, ending: RunEnding): string {
  const where = inFlightPhrase(inFlight, ending.invocation);
  return ending.kind === 'budget'
    ? budgetKillMessage(inFlight, ending, where)
    : deathMessage(ending.death, where, ending.invocation);
}

/**
 * How to give the run more time, as one sentence — by who ran it.
 *
 * 🔑 A kill remedy names a flag only the verb that accepts it can be given. `--budget` is
 * `vat resources check`'s and `vat resources query`'s, and in this release `vat validate` has NO
 * way to give its checks phase more time: the phase always runs under {@link DEFAULT_BUDGET_SECONDS}.
 * So the phase's sentence says exactly that — what the bound measures, its value, and that running
 * the checks standalone with a larger `--budget` lets THEM pass but does not make `vat validate`
 * pass. A remedy promising otherwise sends the operator round a loop that cannot end. A query has
 * a bound only because its operator asked for one, so its sentence says how to drop it too.
 *
 * @param invocation - Who ran it
 * @returns The sentence, with a leading space
 */
function raiseBoundSentence(invocation: RunInvocation): string {
  if (invocation === 'query') return ' Raise it with `--budget <seconds>`, or omit `--budget` to run unbounded.';
  return invocation === 'standalone'
    ? ' Raise it with `--budget <seconds>`.'
    : ' `vat validate` cannot give it more time: its checks phase always runs under the default'
      + ` bound of ${DEFAULT_BUDGET_SECONDS}s WITHOUT PROGRESS (a total bound on the population,`
      + ' which reports progress only when it finishes), and this release has no way to change'
      + ' it. Running the same checks on their own with `vat resources check --budget <seconds>`'
      + ' can let them pass there, but `vat validate` will still fail on this tree.';
}

/**
 * Where the run was when it stopped, as a phrase.
 *
 * 🔑 A query writes no `start` line — it has one statement — so its statement runs in what the log
 * reads as `idle`, and `reporting` is its answer being written. A checks run's `idle` is the gap
 * between two statements.
 *
 * @param inFlight - What the log's last state says
 * @param invocation - Who ran it
 * @returns A clause naming the unit
 */
function inFlightPhrase(inFlight: UnitInFlight, invocation: RunInvocation): string {
  if (inFlight.kind === 'startup') return 'before the child process had finished starting';
  if (inFlight.kind === 'population') return 'before its population completed';
  if (invocation === 'query') {
    return inFlight.kind === 'reporting'
      ? 'after the statement had returned, while its answer was being written'
      : 'while the statement was running';
  }
  return checkInFlightPhrase(inFlight);
}

/**
 * {@link inFlightPhrase} for a checks run, once startup and population are ruled out.
 *
 * @param inFlight - What the log's last state says
 * @returns A clause naming the unit
 */
function checkInFlightPhrase(inFlight: UnitInFlight): string {
  if (inFlight.kind === 'check') return `while the check "${inFlight.name}" was running`;
  if (inFlight.kind === 'examining') {
    return `after the check "${inFlight.name}" had finished its violations statement (${String(inFlight.rows)} rows),`
      + ' while its examined statement was running';
  }
  if (inFlight.kind === 'converting') {
    return `after the check "${inFlight.name}" had finished its statement (${String(inFlight.rows)} rows),`
      + ' while its rows were being converted';
  }
  if (inFlight.kind === 'reporting') {
    return 'after the last check had finished, while its document was being assembled';
  }
  // 🔑 Conversion has its own `converting` state, so `idle` is only the gap
  // before the first statement or after the last cost and before `statements-complete`.
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
  if (death.kind === SPAWN_FAILED) {
    return `the child process could not be started at all (${death.binary}: ${death.detail})`;
  }
  if (death.kind === KILL_FAILED) {
    return death.refused
      ? `the budget was blown and the SIGKILL that should have ended the run was REFUSED (${death.detail})`
      : `the budget was blown and the SIGKILL that should have ended the run DID NOT END IT (${death.detail})`;
  }
  if (death.kind === 'no-output') {
    return `the child process exited ${death.code} and published no report at all`;
  }
  if (death.kind === UNPARSEABLE_OUTPUT) {
    return `the child process exited ${death.code} and published a report that is not this`
      + ` command's document, most likely cut off mid-write (${death.detail})`;
  }
  if (death.kind === EXIT_DISAGREES) {
    return `the child process published a complete report whose own verdict is exit ${death.documentExit},`
      + ` and then exited ${death.code}`;
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
 * 🚨 **Nor is it the thing to tell a statement too long to pass.** `E2BIG` (POSIX) and
 * `ENAMETOOLONG` (Windows) mean the child's command line is longer than the platform allows — a
 * query's statement and parameters travel on it. The in-process run carries no command line.
 *
 * @param detail - What `spawn` reported
 * @param invocation - Who ran it
 * @returns The remedy sentence
 */
function spawnFailedRemedy(detail: string, invocation: RunInvocation): string {
  if (/\b(?:EAGAIN|ENOMEM)\b/.test(detail)) {
    return ' The child could not be started because the RUNNER had nothing left to start it'
      + ' with — EAGAIN is "no free process slot" and ENOMEM is "no free memory" — so this is'
      + ' about how loaded the machine is, not about the installation and not about the SQL.'
      + ' Give the job a less contended runner, or reduce what else is running beside it.';
  }
  if (/\b(?:E2BIG|ENAMETOOLONG)\b/.test(detail)) {
    return ' The child could not be started because its command line is longer than this platform'
      + ' allows' + (invocation === 'query'
      ? ' — it carries the statement and every `--param`. `--budget 0`, or no `--budget`, runs the'
        + ' statement in this process, where no command line carries it.'
      : ', which is about the paths and options it was given, not about the SQL.');
  }
  return ' Nothing ran at all, so this is an installation or PATH problem rather than'
    + ' anything about the SQL.';
}

/**
 * What to do about a kill that did not end the child — refused, or accepted and ineffective.
 *
 * ⛔ This must never be composed from the spawn-failure sentence, however
 * similar the plumbing is. The two are opposites: one child never existed, and
 * this one is, as far as this process can tell, STILL RUNNING.
 *
 * @param death - The kill that failed, and the pid it left behind
 * @returns The remedy sentence
 */
function killFailedRemedy(death: Extract<AbnormalDeath, { kind: 'kill-failed' }>): string {
  const handle = death.pid === undefined
    ? ' The child\'s pid is not known to this process.'
    : ` The child was process ${death.pid}.`;
  const how = death.refused
    ? ` SIGKILL and the kernel would not deliver it (${death.detail}), which normally means EPERM.`
    : ` SIGKILL, the kernel accepted it, and the process still did not end (${death.detail}) —`
      + ' which normally means it is stuck in uninterruptible I/O (a hung network mount, a wedged disk).';
  return ' The run started, ran past its budget, and then REFUSED TO DIE: the watchdog sent'
    + how
    + handle
    + ' It may still be running and still holding whatever the statement was holding, so'
    + ' look for it and end it by hand before starting another run. Nothing about the SQL'
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
 * cancelled job, a container stopping.
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
 * What to do about a child that exited with a code and said nothing.
 *
 * 🚨 **This is the SAME event as a signal death, seen on a platform without
 * signals.** Windows has none, so Node reports its own fatal abort — the heap
 * limit among them — as an exit code with `signal === null`, where macOS and
 * Linux report `SIGABRT` with no code at all. An operator hitting the heap limit
 * on Windows CI deserves the identical remedy as one hitting it on Linux, so the
 * abort is recognised by its code and {@link signalRemedy} answers both.
 *
 * ⚠️ Every OTHER code gets a deliberately non-committal sentence. This command
 * cannot tell an external termination it has no name for from a bug of its own,
 * and claiming either would send half its readers to the wrong place — the exact
 * defect {@link signalRemedy}'s fall-through was written to fix.
 *
 * @param code - The exit code the child reported
 * @returns The remedy sentence
 */
function noOutputRemedy(code: number): string {
  if (code === NODE_FATAL_ABORT_EXIT_CODE) {
    return ` Exit ${code} is Node's own fatal abort. A platform with no signal to report — Windows`
      + ' — surfaces as an exit code what macOS and Linux report as SIGABRT itself, and it is the'
      + ' same event.' + signalRemedy('SIGABRT');
  }
  return ` Exit ${code} is not Node's abort code, and the child published no usable copy of the document`
    + ' every path through this command ends by writing — so this is either a termination from'
    + ' outside that left an exit code instead of a signal, or a defect in vat. The child\'s stderr'
    + ' was inherited, so whatever it managed to say is above this report; if there is nothing'
    + ' there either, report this exit code with the platform and the statement that was running.';
}

/**
 * What to DO about it — and the reason the death is carried this far as a union
 * rather than as a string.
 *
 * 🔑 Every kind wants a DIFFERENT file looked at: SIGABRT is the statement,
 * SIGKILL is the runner's memory, SIGTERM is the job's own timeout, a failed
 * spawn is either the installation, the runner's load or the command line's length, and a refused
 * kill is a process still running. A message that conflated any two of them would send
 * half its readers to the wrong place.
 *
 * ⛔ **The last line is for `no-status` and nothing else.** It is the only
 * ending about which this command genuinely knows nothing.
 *
 * @param death - The ending the supervisor resolved
 * @param invocation - Who ran it
 * @returns The remedy sentence
 */
function deathRemedy(death: AbnormalDeath, invocation: RunInvocation): string {
  if (death.kind === KILL_FAILED) return killFailedRemedy(death);
  if (death.kind === SPAWN_FAILED) return spawnFailedRemedy(death.detail, invocation) + WATCHDOG_UNINVOLVED;
  if (death.kind === 'signal') return signalRemedy(death.signal) + WATCHDOG_UNINVOLVED;
  if (death.kind === 'no-output' || death.kind === UNPARSEABLE_OUTPUT) {
    return noOutputRemedy(death.code) + WATCHDOG_UNINVOLVED;
  }
  if (death.kind === EXIT_DISAGREES) return EXIT_DISAGREES_REMEDY + WATCHDOG_UNINVOLVED;
  return ' The cause is outside anything this command can observe; the child left no exit code'
    + ' to report.' + WATCHDOG_UNINVOLVED;
}

/**
 * Why a child whose exit disagrees with its own document is not forwarded, and where to look.
 *
 * ⚠️ It does not guess which of the two is true. Every path through this command ends on the code
 * its document derives, so the disagreement is either something ending the child after it wrote
 * (a crash in teardown, an external termination that left a code) or a defect in vat — and the
 * report cannot tell them apart.
 */
const EXIT_DISAGREES_REMEDY
  = ' Every path through this command ends on the exit code its own document derives, so the two'
  + ' should never disagree: either something ended the child AFTER it wrote its report — a crash'
  + ' during shutdown, or a termination from outside that left an exit code — or vat has a defect.'
  + ' Which one cannot be told from here, so the report is withheld rather than forwarded as the'
  + ' verdict. The child\'s stderr was inherited, so whatever it said is above this report; re-run'
  + ' it, and if the disagreement repeats, report the exit code with the platform.';

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
 * What an abnormal death means.
 *
 * 🪤 A child whose exit disagrees with its document did NOT die mid-run — it finished every
 * statement and wrote a whole report — so it gets its own sentence rather than "DIED before it
 * finished …", which would be false about it.
 *
 * @param death - The ending the supervisor resolved
 * @param where - The clause naming the unit, from {@link inFlightPhrase}
 * @param invocation - Who ran it
 * @returns The message body
 */
function deathMessage(death: AbnormalDeath, where: string, invocation: RunInvocation): string {
  if (death.kind === EXIT_DISAGREES) {
    return `This run's exit contradicts its own report: ${deathPhrase(death)}, so neither can be`
      + ' trusted as the verdict and this document replaces the report.' + deathRemedy(death, invocation);
  }
  const consequence = invocation === 'query'
    ? ', so there is no answer.'
    : ', so the checks after it never executed and this document is not a verdict.';
  return `This run DIED before it finished: ${deathPhrase(death)} ${where}${consequence}`
    + deathRemedy(death, invocation);
}

/**
 * Why a statement that will not finish is killed rather than stopped — the remedy for a kill while
 * one was running, `check`'s and `query`'s alike.
 */
const CANNOT_STOP_IN_PROCESS
  = ' A statement that will not finish cannot be stopped from inside the process —'
  + ' the query is synchronous and holds the event loop — so the bound is enforced by'
  + ' killing the run. If the work is legitimately slow, it needs more time.';

/**
 * What a WATCHDOG kill means, which depends entirely on what was in flight.
 *
 * 🚨 **The `reporting` state must not get the statement-hang body**: a run
 * whose statements ALL completed and whose document blew the budget has no hanging
 * statement to hunt.
 *
 * ⚠️ It is easy to reach on a real gate, not a curiosity: serialising 2,000,000
 * issues takes ~17 s after `statements-complete` is filed, which is one budget
 * window on its own.
 *
 * 🔑 Every remedy names the bound through {@link raiseBoundSentence}, so a phase is never told to
 * pass a flag its own verb (`vat validate`) rejects, nor promised a way to raise its bound.
 *
 * @param inFlight - What the log's last state says
 * @param ending - The kill: the bound that was blown, and who ran it
 * @param where - The clause naming the unit, from {@link inFlightPhrase}
 * @returns The message body
 */
function budgetKillMessage(
  inFlight: UnitInFlight,
  ending: Extract<RunEnding, { kind: 'budget' }>,
  where: string,
): string {
  const { budgetSecs, invocation } = ending;
  const raise = raiseBoundSentence(invocation);
  const killed = `This run made no progress for ${budgetSecs}s and was killed ${where}`;
  if (inFlight.kind === 'startup' || inFlight.kind === 'population') {
    const remedy = inFlight.kind === 'startup' ? startupRemedy(raise) : populationRemedy(raise);
    return invocation === 'query'
      ? `${killed}, so there is no answer.${remedy}`
      : `${killed}, so no check ran and this document is not a verdict. There is no projection, so the`
        + ' population fields in `data` are null and `examined` is 0.' + remedy;
  }
  if (invocation === 'query') {
    return inFlight.kind === 'reporting'
      ? `${killed}, so there is no answer. The statement had returned, so the result's size, not the`
        + ` SQL, outlasted the bound: narrow it (a \`LIMIT\`).${raise}`
      : `${killed}, so there is no answer.${CANNOT_STOP_IN_PROCESS}${raise}`;
  }
  return checkBudgetKillMessage(inFlight, killed, raise, invocation);
}

/**
 * {@link budgetKillMessage} for a checks run, once startup and population are ruled out.
 *
 * @param inFlight - What the log's last state says
 * @param killed - The opening clause: the bound and where it was blown
 * @param raise - How to raise the bound, from {@link raiseBoundSentence}
 * @param invocation - Who ran the checks
 * @returns The message body
 */
function checkBudgetKillMessage(inFlight: UnitInFlight, killed: string, raise: string, invocation: RunInvocation): string {
  if (inFlight.kind === 'converting') {
    return `${killed}.`
      + ' That statement had FINISHED, so this is not a rule that would not return: turning'
      + ' its rows into findings — the conversion runs in this process — outlasted the bound,'
      + ' and the checks after it never executed. A check that selects a very large number of'
      + ` rows is what makes that step long.${raise}`;
  }
  if (inFlight.kind === 'reporting') {
    return `${killed}.`
      + ' Every declared check had already finished and filed its cost, so no statement was'
      + ' running and there was nothing left to execute: the cause is the SIZE of the document'
      + ' being assembled, not a rule that would not return. Serialising a large result is'
      + ' linear in how much there is — 2,000,000 issues take about 17 seconds — so look at'
      + ' the rules under `checks` that produced the most rows and narrow them (a `LIMIT`, or'
      + ' one row per violation rather than one per member), or give the document more time to'
      + ` be written.${raise}`;
  }
  return `${killed}, so the checks after it never executed and this document is not a verdict.`
    + CANNOT_STOP_IN_PROCESS
    + raise
    + (invocation === 'standalone'
      ? ' `--budget 0` removes it (the run can then hang forever).'
      : '');
}

/**
 * What to do about a kill that landed before the child had BOOTED.
 *
 * Nothing had touched the tree yet — Node and the CLI were still loading — so
 * sizing the budget against the population would be advice about a unit that
 * never began. A boot that outlasts the budget is a saturated machine or a bound
 * too small to be one.
 *
 * @param raise - How to raise the bound, from {@link raiseBoundSentence}
 * @returns The remedy sentence
 */
function startupRemedy(raise: string): string {
  return ' Node and vat were still loading, so neither your tree nor your SQL is implicated: a'
    + ' boot that outlasts the bound means a heavily loaded machine or a bound far smaller than'
    + ` any run can meet.${raise}`;
}

/**
 * What to do about a kill that landed during the population.
 *
 * 🔑 The measured numbers are labelled as someone else's trees. An operator
 * given one number reads it as a promise about theirs.
 *
 * @param raise - How to raise the bound, from {@link raiseBoundSentence}
 * @returns The remedy sentence
 */
function populationRemedy(raise: string): string {
  return ' Population is legitimately slow on a large tree, and it reports progress only when it'
    + ' FINISHES, so the budget is a total bound for that one unit — a crawl that outlasts it is'
    + ` not necessarily stuck.${raise}`
    + ' For scale, two MEASURED trees, neither of them yours: VAT\'s own repository is ~1.2s'
    + ' warm and 33-35s with a cold parse cache; a 10,000-file adopter tree is ~5s warm and'
    + ' 16.5s cold. Your tree is a third number.';
}

/** Test-facing seam: the pure decisions of this module, reached by its unit tests. */
export const __internal = {
  pollIntervalMs,
  guardSupervision,
  KILL_ATTEMPTS_BEFORE_REPORTING,
  KILL_POLLS_BEFORE_REPORTING_UNREAPED,
  STDOUT_GRACE_AFTER_EXIT_MS,
};
