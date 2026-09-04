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
 * - **SIGTERM does not kill the child either**, for the same reason. The kill is
 *   `SIGKILL`, which the kernel delivers without the process's cooperation.
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
 * 🔑 **Hex is deliberately KEPT.** `Number('0x10')` is 16 and `--budget 0x10`
 * runs with a sixteen-second bound. That is unambiguous, it cannot arise by
 * accident the way an empty variable can, and refusing it would buy nothing —
 * recorded here so the next reader does not "fix" it into a refusal.
 *
 * @param raw - Whatever Commander parsed, or undefined
 * @returns The budget in seconds; 0 means no bound
 * @throws When the value is blank, or is not a non-negative number
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
 * @param ending - What `close` reported, plus what the supervisor did and saw
 * @param ending.code - `close`'s first argument
 * @param ending.signal - `close`'s second argument
 * @param ending.killed - Whether the watchdog sent SIGKILL
 * @param ending.spawnError - Set when the child never started at all
 * @returns What actually happened
 */
export function resolveChildEnding(ending: {
  code: number | null;
  signal: string | null;
  killed: boolean;
  spawnError?: { binary: string; detail: string } | undefined;
}): RunResolution {
  if (ending.spawnError !== undefined) {
    return { kind: 'abnormal', death: { kind: 'spawn-failed', ...ending.spawnError } };
  }
  if (ending.code !== null && ending.signal === null) {
    return { kind: 'completed', code: ending.code };
  }
  if (ending.killed) return { kind: 'killed' };
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
  let state: WatchdogState = { bytesSeen: 0, quietSince: startedAt };
  const timer = setInterval(() => {
    const poll = pollWatchdog(state, {
      bytes: logSize(options.logPath),
      now: Date.now(),
      budgetMs: options.budgetMs,
    });
    state = poll.state;
    if (!poll.breach) return;
    killed = true;
    // SIGKILL, because SIGTERM is measured NOT to reach a process blocked in
    // synchronous native SQLite. See this module's header.
    child.kill('SIGKILL');
  }, pollIntervalMs(options.budgetMs));

  const resolution = await new Promise<RunResolution>((resolve) => {
    let spawnError: { binary: string; detail: string } | undefined;
    // 🪤 `error` does not always end the process, and it is not always followed
    // by `close` — so it is REMEMBERED here and resolved on immediately. A
    // promise settles once, so whichever event arrives first wins and the other
    // is a no-op.
    child.on('error', (cause: Error) => {
      spawnError = { binary, detail: cause.message };
      resolve(resolveChildEnding({ code: null, signal: null, killed, spawnError }));
    });
    // ⛔ BOTH arguments. `exitCode ?? 0` here read every signal death as a
    // successful run — see {@link resolveChildEnding}.
    child.on('close', (code, signal) => {
      resolve(resolveChildEnding({ code, signal, killed, spawnError }));
    });
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
