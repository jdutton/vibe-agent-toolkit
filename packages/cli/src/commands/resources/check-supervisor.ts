/**
 * The time bound on `vat resources check`, enforced from OUTSIDE the process
 * doing the work.
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
 *   ⚠️ This header used to claim, as measured fact, that "SIGTERM does not kill
 *   the child either, for the same reason". **That is false and was measured to
 *   be false**: `kill -TERM` on a child blocked inside synchronous `node:sqlite`
 *   `.all()` killed it instantly. The measurement above is about a process that
 *   HAS a JS handler installed — a handler is a JS callback and the blocked
 *   event loop is what would schedule it — and with no handler installed
 *   SIGTERM's default disposition is kernel-delivered termination that needs no
 *   cooperation at all. So SIGTERM works today only because nothing here
 *   installs a handler, which is a property one future edit could silently
 *   remove; SIGKILL is not a property anything can remove. The design did not
 *   change, only the reason for it — recorded because a false claim is at its
 *   worst in a section that tells the next reader not to re-derive it.
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
 * any outside kill run none of it; for those the child ends ITSELF. The child's
 * stdin is a pipe whose write end only this process holds and never writes or
 * ends, so however this process dies the OS closes it and the child reads
 * end-of-file (`endWhenSupervisorGone`). The child notices when its event loop
 * next turns: at once during the population; during the synchronous check loop,
 * once the LAST check has returned (a statement blocked inside SQLite reaches
 * nothing until it returns) — and still before it publishes anything
 * (`letSupervisorLossSurface`). Either way it exits 2 with one stderr line.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { ExitCode, exitCodeForReport } from '@vibe-agent-toolkit/schema';
import {
  disposeTempDirSync,
  isPathAbsentError,
  isProcessGoneError,
  requireFollowedStatSync,
  safePath,
  type TempDirOutcome,
  withTempDir,
} from '@vibe-agent-toolkit/utils';
import { handleTerminatingSignals } from '@vibe-agent-toolkit/utils/process';

import { CommandRefusalError, errorMessageOf } from '../../utils/command-refusal.js';
import { readForwardedDocument, type ForwardedDocument } from '../../utils/document-writer.js';
import { isSupervisedChild } from '../../utils/operator-notices.js';
import { resolveVatBinPath } from '../../utils/vat-bin-path.js';

/**
 * The bound applied when `--budget` is not passed, in seconds.
 *
 * Not a round number chosen for looks, and no longer sized against this
 * repository alone. Population is ~1.2 s warm here and 33-35 s with a cold parse
 * cache; on a real adopter tree of 9,992 tracked files it is ~5 s warm and
 * **16.5 s cold**, which is the first time the default was checked outside VAT.
 * So 300 s is ~18× the worst thing anyone has actually measured — deliberately
 * loose, because a FALSE kill is far worse than a slow honest failure: it
 * teaches the operator to pass `--budget 0` and lose the bound entirely. Five
 * minutes still turns an infinite hang into a clean bounded failure, which is
 * the whole objective. A tree ten times that adopter's lands near 165 s, still
 * inside the default but no longer comfortably.
 */
export const DEFAULT_BUDGET_SECONDS = 300;

/**
 * 🔑 THE text that says what interrupting a supervised checks run does — rendered verbatim into
 * BOTH `vat validate --help` and `vat resources check --help` (a unit test pins that), so the two
 * can never describe it differently. Help-text indentation (two spaces), no backticks.
 *
 * Each claim is pinned: POSIX signals by `checks-supervisor-orphan.system.test.ts`, the group
 * Ctrl-C by the same file and `signal-guard-group-ctrl-c.system.test.ts`, the orphan's own ending
 * by `checks-supervisor-orphan.system.test.ts` (population) and
 * `checks-supervisor-orphan-loop.system.test.ts` (the check loop), the Windows wrapper by
 * `supervise-cli.test.ts`.
 */
export const SUPERVISION_SIGNAL_CONTRACT = `Interrupting a supervised checks run:
  POSIX: SIGTERM, SIGHUP, SIGINT or SIGQUIT sent to this process, to the
  'vat' wrapper (which forwards it), or to the terminal's process group
  (Ctrl-C) kills the checks child and every process it started, removes the
  progress directory, publishes nothing, and dies of the signal (status
  128+n; exit 2 where the signal cannot kill it, PID 1).
  Windows: a console Ctrl-C, Ctrl-Break or window close reaches every process
  on the console; this one kills the child and exits 2, no document. An
  outside kill (taskkill /F) is TerminateProcess: no handler runs, exit 1.
  Ended where it runs no code (SIGKILL, an OOM killer, a Windows outside
  kill), this process cannot kill the child: the child reads end-of-file on
  the stdin pipe this process held and ends itself -- one stderr line, exit
  2, nothing published -- at once during its population, and during the
  checks once the last check returns (a statement inside SQLite is not
  reached until it returns).
  A SIGKILL of the 'vat' wrapper kills the wrapper alone: this process and
  its child (whose stdin is the terminal's) run on until the checks bound
  ends them.`;


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
 * 🚨 **Not an operator's flag, and passing it by hand is refused, not tolerated.** It used to be
 * harmless-looking: the process ran the checks unbounded, printed none of the notices its
 * supervisor would have, and appended to a log nobody watched. A flag that silently removes the
 * bound is the shape an operator never discovers until the hang it was meant to prevent. So the
 * value names its supervisor's pid, and a process whose parent is not that pid is refused
 * `USAGE_INVALID` in plain words.
 *
 * 🔑 **One value, so an invalid combination cannot be written.** The invoker and the progress log
 * used to be two hidden flags that had to arrive together, refused when one came alone. Now they
 * are fields of one value, and the only thing left to refuse is a value that does not parse.
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
    + ' `vat resources check` and `vat validate` hand the checks to the child process they'
    + ' spawn and supervise.';
  const remedy = ' Run `vat resources check` without it — `--budget <seconds>` sets the bound,'
    + ' and `--budget 0` runs the checks in this process with none.';
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
   * Both arrive on `child.on('error')` and the handler used to read every one of
   * them as a spawn failure, which reported the exact opposite of what happened:
   * "could not be started at all", "nothing ran at all", "the watchdog never
   * fired". It started, it ran past its budget, the watchdog fired, and it would
   * not die.
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
 * `code === null` with `signal` set. This handler used to read only the code and
 * coerce it — `resolve(exitCode ?? 0)` — so every signal death became a
 * COMPLETED run with exit code 0. The parent then forwarded an empty stdout and
 * exited 0, and a CI gate reads that as a clean pass.
 *
 * It needed no external actor. A check whose statement materialises an unbounded
 * result set — `SELECT i FROM <infinite recursive CTE>`, the row-returning twin
 * of the aggregate this whole module exists for — makes `.all()` fill the heap
 * until V8 gives up and Node ABORTS. Measured: `PARENT_EXIT=0`, zero bytes of
 * stdout, on precisely the input the bound exists to catch. Through the
 * unsupervised lane the identical input exits 134.
 *
 * Every memory death arrives here: Node's own heap abort, a kernel OOM killer on
 * a memory-capped runner (which picks the large CHILD, never the idle parent),
 * and a container limit. `?? 0` turned all of them into a pass.
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
 * `spawnError` used to be tested FIRST, so `killed` was never consulted on that
 * branch — and `child.on('error')` is not only a spawn-failure listener. Node
 * emits `error` on the ChildProcess when `subprocess.kill()` itself fails, so a
 * refused SIGKILL landed on the spawn-failure branch and the report said the
 * child "could not be started at all", that "nothing ran at all, so this is an
 * installation or PATH problem", and that "the watchdog never fired". Three
 * statements, all false, about a runaway that was still executing.
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
    return { kind: 'abnormal', death: { kind: 'kill-failed', ...ending.killFailure } };
  }
  if (ending.killed) return { kind: 'killed' };
  if (ending.spawnError !== undefined) {
    return { kind: 'abnormal', death: { kind: 'spawn-failed', ...ending.spawnError } };
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
 * Run `vat resources check` as a child, bounded by the budget.
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
 * @param options - The run
 * @param options.args - The child's argv after the node binary, `--supervised-by` included
 * @param options.log - The progress log both sides agreed on, and the guard {@link withProgressLog} holds over it
 * @param options.budgetMs - How long silence is allowed to last
 * @param options.format - The format the child was asked for, to read its document in
 * @returns How the child ended, and what it left behind
 */
export async function superviseCheck(options: {
  args: readonly string[];
  log: ProgressLog;
  budgetMs: number;
  format: 'yaml' | 'json';
}): Promise<SupervisedRun> {
  const logPath = options.log.path;
  const startedAt = performance.now();
  const binary = resolveVatBinPath();
  const child = spawn(process.execPath, [binary, ...options.args], {
    stdio: ['pipe', 'pipe', 'inherit'],
    // POSIX: a process-group leader, so every kill reaches what it spawns too (`killChildTree`).
    // Never on Windows, where `detached` opens a new console instead.
    detached: process.platform !== 'win32',
  });
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
      killChildTree(child);
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
        killChildTree(child);
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

  const wreckage = (): { log: string; elapsedMs: number } =>
    ({ log: readLog(logPath), elapsedMs: performance.now() - startedAt });
  if (ending.kind === 'completed') {
    // Read while the progress log still exists: a document that is not one is
    // a death, and the log is what its interrupted document is built from.
    const read = readCompletedDocument(stdout, ending.code, options.format);
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
 * The guard {@link withProgressLog} holds over one supervision: what {@link superviseCheck} tells it.
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
 * ends it with `process.exit` — the poll's own throw is caught in {@link superviseCheck}, so this is
 * the second line for it); and a kill the kernel refused, which settles the run while the child
 * lives on.
 *
 * So for the supervision's WHOLE life — from before the progress directory is minted until after
 * it is removed, see {@link withProgressLog}:
 *
 * - **`exit`** SIGKILLs the child and, on POSIX, its process group (`killChildTree`), once there is
 *   one, and removes the progress directory, once there is one — every ending of this process that
 *   runs any of its code passes through it, a last-resort `process.exit` included, and
 *   `process.exit` runs no `finally`.
 * - **Every `TERMINATING_SIGNALS` member**, through `handleTerminatingSignals`: does the same,
 *   synchronously, and RE-RAISES the signal. On POSIX this process then dies of it (status 128 + n),
 *   as a shell and a CI runner expect. On Windows, or where the signal cannot kill it (PID 1), it
 *   exits 2 with no document. A repeat is swallowed. The child is in its own process group on
 *   POSIX, so a terminal's Ctrl-C does not reach it directly: this guard is what kills it.
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
 * signal handler nor the `exit` guard. The child covers those itself: it reads end-of-file on the
 * stdin pipe this process held (`endWhenSupervisorGone`). A child blocked inside one SQLite
 * statement reaches nothing until the statement returns.
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
    if (child !== undefined) killChildTree(child);
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
 * SIGKILL the checks child — and, on POSIX, everything it spawned.
 *
 * The child is spawned as a process-group leader there (`detached`, see {@link superviseCheck}), so
 * the group kill reaches the `git` it runs as well: a kill of the leader alone left those
 * grandchildren running on. The leader is ALSO killed directly, through `child.kill`, because that
 * is the call whose refusal Node reports as the child's `error` — the arm the watchdog retries and
 * then reports. A group that is already gone, or that the OS will not let this process signal,
 * leaves nothing more this kill can reach.
 *
 * On Windows there are no process groups to kill: `child.kill` is `TerminateProcess` of the child
 * alone, and a grandchild runs on until it ends (documented in the help's signal paragraph).
 *
 * @param child - The checks child
 */
function killChildTree(child: ChildProcess): void {
  child.kill('SIGKILL');
  if (process.platform === 'win32' || child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (!isProcessGoneError(error)) throw error;
  }
}

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
 * reading it used to take, 0 forever, is "the child has gone quiet", which
 * kills a child that may be doing fine and reports it as a runaway. So it throws,
 * and {@link superviseCheck} ends the supervision on the throw: the child killed,
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
 * @param work - Given the log
 * @returns What `work` returned, with the log's directory as a `leftover` when the OS
 *   would not remove it (see `withTempDir`) — for the caller to report as a warning
 */
export async function withProgressLog<T>(work: (log: ProgressLog) => Promise<T>): Promise<TempDirOutcome<T>> {
  const guard = guardSupervision();
  try {
    return await withTempDir('vat-check-', (dir) => {
      const path = safePath.join(dir, 'progress.jsonl');
      guard.cover(path);
      return work({ path, guard });
    });
  } finally {
    guard.release();
  }
}

/**
 * Read what a COMPLETED child wrote as `resources check`'s document, or name
 * the death when it is not one — or when the child's exit disagrees with it.
 *
 * 🔑 The exit is compared with the one the document itself derives. The parent
 * forwards the DOCUMENT's code, never the process's, so a child that wrote a
 * clean report and then exited non-zero would otherwise be published as a pass.
 *
 * @param stdout - Everything the child wrote (known not to be blank)
 * @param code - The child's exit code
 * @param format - The format the child was asked for
 * @returns The forwardable document, or the `unparseable-output` / `exit-disagrees` death
 */
export function readCompletedDocument(
  stdout: string,
  code: number,
  format: 'yaml' | 'json',
): { readonly document: ForwardedDocument } | { readonly death: AbnormalDeath } {
  let document: ForwardedDocument;
  try {
    document = readForwardedDocument('resources check', stdout, format);
  } catch (error) {
    return { death: { kind: 'unparseable-output', code, detail: errorMessageOf(error) } };
  }
  const documentExit = exitCodeForReport(document.report);
  return documentExit === code
    ? { document }
    : { death: { kind: 'exit-disagrees', code, documentExit } };
}

/** Test-facing seam: the pure decisions of this module, reached by its unit tests. */
export const __internal = {
  pollIntervalMs,
  guardSupervision,
  KILL_ATTEMPTS_BEFORE_REPORTING,
  KILL_POLLS_BEFORE_REPORTING_UNREAPED,
  STDOUT_GRACE_AFTER_EXIT_MS,
};
