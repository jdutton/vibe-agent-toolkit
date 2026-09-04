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
 * - **A signal handler is a REGRESSION.** A process blocked in synchronous
 *   `node:sqlite` dies INSTANTLY on SIGINT while no handler is installed, and
 *   SURVIVES both SIGINT and SIGTERM once one is — the handler is a JS callback,
 *   and the event loop that would schedule it is the resource that is blocked.
 *   Installing one removes the operator's Ctrl-C. There is no
 *   `process.on('SIGINT')` here and there must never be.
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
 * The child is `vat resources check` with a hidden `--cost-log` flag, running
 * the ordinary in-process path. Forking the logic would give the supervised lane
 * and the unsupervised one two implementations of the same gate — and the one
 * nobody runs interactively is the one that would rot.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';

import { resolveVatBinPath } from '../../utils/vat-bin-path.js';

/**
 * The bound applied when `--budget` is not passed, in seconds.
 *
 * Not a round number chosen for looks. Population alone is ~1.2 s warm on this
 * repository but 33-35 s with a cold parse cache, and a big adopter tree is
 * larger again — so a tight default would kill healthy runs, and a FALSE kill is
 * far worse than a slow honest failure: it teaches the operator to pass
 * `--budget 0` and lose the bound entirely. Five minutes still turns an infinite
 * hang into a clean bounded failure, which is the whole objective.
 */
const DEFAULT_BUDGET_SECONDS = 300;

/** How many times per budget the parent looks at the log. */
const POLLS_PER_BUDGET = 10;

/** Poll bounds, so a huge budget still notices promptly and a tiny one is cheap. */
const MIN_POLL_MS = 50;
const MAX_POLL_MS = 250;

/**
 * How many refused SIGKILLs the watchdog sends before it stops trying and
 * REPORTS instead.
 *
 * A retry count, not a bound on anything stored. It exists because the two ways
 * a kill can fail want opposite responses: `ESRCH` is a race that resolves
 * itself the instant `close` arrives, while `EPERM` is a permission fact that
 * will be just as true on the thousandth attempt. Retrying a handful of times
 * covers the first at negligible cost; continuing past that would turn the
 * supervisor into a second unbounded hang, which is the thing this module
 * exists to abolish. So it escalates to an honest report naming the pid.
 */
const KILL_ATTEMPTS_BEFORE_REPORTING = 5;

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
    throw new Error(
      '--budget was given an empty value. That is almost always an unset shell'
      + ' variable (`--budget "$CHECK_BUDGET"`), and it is refused rather than read'
      + ' as `--budget 0` — which would remove the bound entirely and let the run'
      + ' hang forever. Pass a number of seconds, or `--budget 0` explicitly if that'
      + ' is really what you mean.',
    );
  }

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(
      `--budget must be a non-negative number of seconds, not "${raw}".`
      + ` It bounds how long the run may go without completing a unit of work;`
      + ` --budget 0 removes the bound entirely (and can then hang forever).`,
    );
  }
  if (seconds === 0 && raw.trim() !== '0') {
    throw new Error(
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
 * Does this process do the work, or supervise a child that does?
 *
 * 🚨 **The recursion guard, and the reason it is a named function.** `--cost-log`
 * is what a supervising parent hands its child, and it must WIN against the
 * budget — a child that consulted the budget first would spawn a child of its
 * own, which would spawn a child of its own. A condition inline in the command
 * would be a fork bomb one refactor away with nothing asserting on it.
 *
 * `--budget 0` also runs here: there is nothing to supervise, and a spawn would
 * cost a second process startup to buy no bound at all.
 *
 * @param options - The run
 * @param options.costLog - The hidden `--cost-log` value, or undefined
 * @param options.budgetSecs - The bound in seconds; 0 means none
 * @returns True when the checks run in this process
 */
export function runsInThisProcess(
  options: { costLog: string | undefined; budgetSecs: number },
): boolean {
  return options.costLog !== undefined || options.budgetSecs === 0;
}

/**
 * Refuse a combination where one flag the operator passed would do nothing.
 *
 * 🚨 **The defect: `--cost-log` wins the fork above unconditionally**, so
 * `vat resources check --budget 60 --cost-log /tmp/x` ran entirely UNBOUNDED and
 * said nothing about it. That is harmless to the recursion guard — a child must
 * keep winning — but an explicitly-passed, documented flag that is silently
 * inert is exactly the shape an operator never discovers until the hang it was
 * meant to prevent.
 *
 * ⚠️ **The real spawn path must survive this.** {@link runsInThisProcess}'s
 * caller builds the child's argv with `--cost-log` and does NOT forward
 * `--budget` — which is why the RAW flag is the discriminator here rather than
 * the parsed seconds: the child's `budgetSecs` is the 300 s default, not
 * anything the operator typed.
 *
 * `--budget 0` alongside `--cost-log` is allowed: both say "nobody is
 * supervising this", so there is no contradiction to report.
 *
 * @param options - The run
 * @param options.costLog - The hidden `--cost-log` value, or undefined
 * @param options.budgetRaw - What the operator actually typed for `--budget`
 * @param options.budgetSecs - The parsed bound; 0 means none
 * @throws When both flags were passed and the budget could not be honoured
 */
export function requireSupervisableFlags(options: {
  costLog: string | undefined;
  budgetRaw: string | undefined;
  budgetSecs: number;
}): void {
  if (options.costLog === undefined) return;
  if (options.budgetRaw === undefined || options.budgetSecs === 0) return;

  throw new Error(
    '--budget cannot be combined with --cost-log. --cost-log means "you are the'
    + ' child a supervisor already spawned", so this process does the work rather'
    + ' than bounding it, and the budget would be silently ignored. Drop one:'
    + ' --budget alone gets you the bound, --cost-log alone gets you the progress'
    + ' log with no bound at all.',
  );
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
   * The watchdog fired and the KILL WAS REFUSED — so the child is, as far as
   * this process can tell, still running.
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
  }
  | { readonly kind: 'no-status' };

/** What a child's ending MEANT, once the watchdog's belief is reconciled with it. */
export type RunResolution =
  | { readonly kind: 'completed'; readonly code: number }
  | { readonly kind: 'killed' }
  | { readonly kind: 'abnormal'; readonly death: AbnormalDeath };

/**
 * Read `close`'s two arguments, and the watchdog's belief, into one answer.
 *
 * ## 🚨 The defect this closes: a signal death READ AS SUCCESS
 *
 * `close` fires with `(code, signal)`, and a process that dies from a signal has
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
 * @param ending - What `close` reported, plus what the supervisor did and saw
 * @param ending.code - `close`'s first argument
 * @param ending.signal - `close`'s second argument
 * @param ending.killed - Whether the watchdog sent SIGKILL
 * @param ending.spawnError - Set when the child never started at all
 * @param ending.killFailure - Set when the watchdog's SIGKILL was REFUSED
 * @returns What actually happened
 */
export function resolveChildEnding(ending: {
  code: number | null;
  signal: string | null;
  killed: boolean;
  spawnError?: { binary: string; detail: string } | undefined;
  killFailure?: { detail: string; pid: number | undefined } | undefined;
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

/** How a supervised run ended. */
export type SupervisedRun =
  | { readonly outcome: 'completed'; readonly code: number; readonly stdout: string }
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
 * `stdio` is `['ignore', 'pipe', 'inherit']`: the child's stdout is accumulated
 * so the parent can forward the document verbatim, and its stderr is INHERITED
 * so warnings and blob-stage refusals stream live exactly as they do today.
 *
 * ⚠️ Asynchronous `spawn`, never `spawnSync`. The parent's event loop is the
 * thing holding the watchdog timer; a synchronous spawn would block it for
 * precisely as long as the run it is supposed to be bounding.
 *
 * 🚨 There is an `error` listener as well as a `close` one, and it is not
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
 * @param options - The run
 * @param options.args - The child's argv after the node binary, `--cost-log` included
 * @param options.logPath - The progress log both sides agreed on
 * @param options.budgetMs - How long silence is allowed to last
 * @returns How the child ended, and what it left behind
 */
export async function superviseCheck(options: {
  args: readonly string[];
  logPath: string;
  budgetMs: number;
}): Promise<SupervisedRun> {
  const startedAt = Date.now();
  const binary = resolveVatBinPath();
  const child = spawn(process.execPath, [binary, ...options.args], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  const chunks: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));

  let killed = false;
  let killAttempts = 0;
  let killFailure: { detail: string; pid: number | undefined } | undefined;
  let spawnError: { binary: string; detail: string } | undefined;
  let state: WatchdogState = { bytesSeen: 0, quietSince: startedAt };
  // 🪤 Declared out here and started INSIDE the promise, so the watchdog can
  // settle the run itself when it runs out of kills. Starting it outside would
  // put the escalation out of the timer's reach and force the `error` handler
  // back into resolving on a child that is still alive.
  let timer: NodeJS.Timeout | undefined;

  const resolution = await new Promise<RunResolution>((resolve) => {
    // 🪤 `error` does not always end the process, and it is not always followed
    // by `close` — so a SPAWN failure is remembered and resolved on immediately.
    // A promise settles once, so whichever event arrives first wins and the
    // other is a no-op. A failed KILL is the opposite case: see this function's
    // header for why it must not settle here.
    child.on('error', (cause: Error) => {
      if (killed) {
        killFailure = { detail: cause.message, pid: child.pid };
        return;
      }
      spawnError = { binary, detail: cause.message };
      resolve(resolveChildEnding({ code: null, signal: null, killed, spawnError }));
    });
    // ⛔ BOTH arguments. `exitCode ?? 0` here read every signal death as a
    // successful run — see {@link resolveChildEnding}.
    child.on('close', (code, signal) => {
      resolve(resolveChildEnding({ code, signal, killed, spawnError, killFailure }));
    });

    timer = setInterval(() => {
      const poll = pollWatchdog(state, {
        bytes: logSize(options.logPath),
        now: Date.now(),
        budgetMs: options.budgetMs,
      });
      state = poll.state;
      if (!poll.breach) return;
      killed = true;
      killAttempts += 1;
      // SIGKILL, because no code the child could ever gain can handle, ignore
      // or block it. See this module's header — and note the reason is NOT that
      // SIGTERM fails to reach a blocked process, which was measured false.
      child.kill('SIGKILL');
      if (killFailure !== undefined && killAttempts >= KILL_ATTEMPTS_BEFORE_REPORTING) {
        resolve(resolveChildEnding({ code: null, signal: null, killed, killFailure }));
      }
    }, pollIntervalMs(options.budgetMs));
  });
  clearInterval(timer);

  if (resolution.kind === 'completed') {
    return {
      outcome: 'completed',
      code: resolution.code,
      stdout: Buffer.concat(chunks).toString('utf-8'),
    };
  }
  const wreckage = { log: readLog(options.logPath), elapsedMs: Date.now() - startedAt };
  return resolution.kind === 'killed'
    ? { outcome: 'killed', ...wreckage }
    : { outcome: 'abnormal', death: resolution.death, ...wreckage };
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
 * @param path - The progress log
 * @returns Its size in bytes
 */
function logSize(path: string): number {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path this process minted for this run
    return statSync(path).size;
  } catch {
    return 0;
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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path this process minted for this run
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Run `work` with a fresh progress log, and remove it however that ends.
 *
 * ⚠️ Ephemeral, per run, and it carries NO format version — see
 * `check-progress.ts`. It is written and read by one process pair within one run
 * of one build, so the reader's own `.strict()` schema is the entire contract.
 *
 * @param work - Given the log's path
 * @returns Whatever `work` returned
 */
export async function withProgressLog<T>(work: (logPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-check-'));
  try {
    return await work(safePath.join(dir, 'progress.jsonl'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
