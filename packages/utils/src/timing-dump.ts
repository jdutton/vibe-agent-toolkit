/**
 * The on-disk plumbing every VAT timing seam shares.
 *
 * Two seams write per-process JSON dumps to an operator-named directory:
 * `@vibe-agent-toolkit/resources`' `parse-timing.ts` (which pass inside a parser
 * owns the time) and this package's `crawl-timing.ts` (which contributor or
 * crawler owns the time). They sit in different packages because `crawl-timing`
 * has to bracket `GitTracker`, which is here — so this module lives at the lower
 * of the two and is exported for the higher one. What they
 * MEASURE could not be less alike — one axis is a closed enum of parser passes,
 * the other is an open set of contributor ids — but every property that makes
 * the *file* trustworthy is identical between them, and the lab's
 * `harness/dumps.ts` already says so from the reading end:
 *
 * 1. A directory that cannot be created is reported the moment the seam turns
 *    on, while there is still a run to abandon — never at exit, where a failure
 *    costs the whole measurement.
 * 2. A dump failure is written to **stderr and never thrown**. These run from
 *    an `exit` listener, where a throw changes the process's exit behaviour, and
 *    they must never touch stdout, which carries vat's report.
 * 3. A pid can file more than one dump, and the name is CLAIMED rather than
 *    checked. `vat validate` spawns the vat binary once per phase and pids are
 *    reused, so `<stem>-<pid>.json` genuinely collides; worse, worker threads
 *    SHARE their parent's pid, so a thread pool's whole cohort competes for one
 *    `<stem>-<pid>` sequence at the same instant. The name gains a counter
 *    rather than overwriting, and the counter is settled by
 *    {@link EXCLUSIVE_CREATE} so the OS — not a check-then-write gap — decides
 *    who won it.
 * 4. The process's own wall and CPU time is read ONCE, at dump time. It is a
 *    lifetime figure for the process and never a duration of the measured work;
 *    its value is the RATIO, which tells a reader whether the wall-timed
 *    brackets above it were competing with a loaded machine.
 *
 *    ⚠️ **A reader must never SUM these across dumps.** Point 3 means one
 *    command routinely files several, and a vat command's phase processes
 *    overlap in time — so summing their lifetimes counts the same wall clock
 *    more than once and produces a "total" longer than the command took. The
 *    figure is per process, and the only honest aggregate over several is the
 *    per-process ratio read one dump at a time. The `crawl` facet keeps one
 *    record per dump and publishes no total for exactly this reason; `parse`
 *    still sums, which is review finding F2 (2026-08-14) and is annotated at
 *    `facets/parse/dump.ts`. This list is where both seams learn what makes a
 *    dump trustworthy, so the hazard belongs here rather than only beside the
 *    consumer that already fixed it.
 *
 * Writing that twice would give two seams two chances to diverge on the one
 * thing a reader has to be able to trust identically. What each seam keeps for
 * itself is its accumulator shape, its dump body and the noun it is called by.
 */

import { writeFileSync } from 'node:fs';

import { safePath } from './path-core.js';
import { mkdirSyncReal } from './path-utils.js';

/**
 * Process-level wall and CPU time, read ONCE when a dump is written.
 *
 * All three are lifetime figures for the whole process, not for the measured
 * work: the point of carrying them is the *ratio*. CPU well below wall means the
 * process was waiting rather than computing, and every wall-timed bracket in the
 * dump carries that waiting inside it. CPU above wall is normal and not an
 * error — `process.cpuUsage()` sums every thread, including libuv's pool.
 */
export interface TimingProcess {
  /** Wall clock since this process started. */
  wallMs: number;
  /** User CPU consumed by the process, across all its threads. */
  cpuUserMs: number;
  /** System CPU consumed by the process, across all its threads. */
  cpuSystemMs: number;
}

/** `process.cpuUsage()` reports microseconds; a dump reports milliseconds. */
const MICROSECONDS_PER_MS = 1000;

/** `process.uptime()` reports seconds; a dump reports milliseconds. */
const MS_PER_SECOND = 1000;

/**
 * Ceiling on the pid-collision search. A directory holding this many dumps for
 * one pid is a runaway, not a collision, and giving up on a reported line is a
 * better outcome than spinning.
 *
 * Exhausting it does NOT fall back to overwriting the last slot. That was the
 * old behaviour, and it destroyed a dump for the same reason the check-then-
 * write gap did — silently, and precisely when the directory was busiest.
 */
export const MAX_DUMP_COLLISIONS = 1000;

/**
 * The `writeFileSync` flag that makes claiming a name atomic.
 *
 * `wx` is create-exclusive: the OS fails the call with `EEXIST` when the path
 * already exists, so exactly one caller wins each name no matter how many are
 * racing for it. Asking `existsSync` first and writing second is two operations
 * with a gap in between, and threads sharing a pid land in that gap routinely —
 * a measured 8-worker parse pool lost 6 of 9 dumps to it, reporting 44 of 172
 * documents as if that were the whole run.
 */
const EXCLUSIVE_CREATE = 'wx';

/** How the failure line names the ceiling case, so it reads unlike an OS error. */
const CEILING_DETAIL = `every name up to the ${String(MAX_DUMP_COLLISIONS)}-collision ceiling was already claimed`;

/**
 * What one attempt to claim and fill a dump name came to.
 *
 * `exhausted` and `failed` are deliberately separate: "every name was taken" is
 * a runaway dump directory, "the disk refused the write" is a broken one, and an
 * operator handed one line for both cannot tell which they have.
 */
type TimingDumpClaim =
  | { readonly outcome: 'written'; readonly path: string }
  | { readonly outcome: 'exhausted'; readonly path: string }
  | { readonly outcome: 'failed'; readonly path: string; readonly error: unknown };

/**
 * Reduce a raw env value to a directory or `null`.
 *
 * An empty-string value counts as absent: `VAT_PARSE_TIMING=` in a shell profile
 * is a variable somebody meant to unset, not a request to dump into the process's
 * working directory.
 *
 * @param raw - The env var's value, if set
 * @returns The dump directory, or `null` when the seam is off
 */
export function normalizeTimingDirectory(raw: string | undefined): string | null {
  return raw === undefined || raw === '' ? null : raw;
}

/**
 * Report a dump problem on stderr.
 *
 * Never throws and never touches stdout: vat's stdout carries a YAML report, and
 * an exit handler that threw would change the process's exit behaviour.
 *
 * @param noun - What the seam is called, so a reader knows which instrument failed
 * @param target - Path the failure concerns
 * @param error - Whatever was caught
 */
export function reportTimingDumpFailure(noun: string, target: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`vat: ${noun} dump failed for ${target}: ${detail}\n`);
}

/**
 * Create the dump directory, swallowing failure.
 *
 * Done once when the seam turns on rather than at exit, so a bad path is
 * reported while there is still a run to abandon — and so the exit handler does
 * the minimum possible work.
 *
 * @param noun - What the seam is called, for the failure line
 * @param directory - Directory dumps will be written to
 */
export function ensureTimingDirectory(noun: string, directory: string): void {
  try {
    mkdirSyncReal(directory, { recursive: true });
  } catch (error) {
    reportTimingDumpFailure(noun, directory, error);
  }
}

/**
 * Read this process's lifetime wall and CPU time.
 *
 * Called ONCE per dump — two syscalls for a whole run, which is why the process
 * level can afford a CPU reading that a per-bracket level cannot. Deliberately
 * not an accumulator and deliberately not reset: it describes the process, not
 * the measurement window.
 *
 * @returns Wall clock and CPU since process start, in milliseconds
 */
export function readTimingProcess(): TimingProcess {
  const cpu = process.cpuUsage();
  return {
    wallMs: process.uptime() * MS_PER_SECOND,
    cpuUserMs: cpu.user / MICROSECONDS_PER_MS,
    cpuSystemMs: cpu.system / MICROSECONDS_PER_MS,
  };
}

/**
 * The nth candidate name in one pid's dump sequence.
 *
 * @param directory - Directory dumps are written to
 * @param stem - Basename and pid, already joined
 * @param collision - 0 for the unsuffixed name, then the collision counter
 * @returns The candidate path
 */
function timingDumpCandidate(directory: string, stem: string, collision: number): string {
  const suffix = collision === 0 ? '' : `-${String(collision)}`;
  return safePath.join(directory, `${stem}${suffix}.json`);
}

/**
 * Whether a caught write failure means somebody else already holds the name.
 *
 * @param error - Whatever `writeFileSync` threw
 * @returns `true` only for `EEXIST`, which is a lost race and not a fault
 */
function isNameAlreadyTaken(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

/**
 * Claim a name by creating it, and fill it in the same operation.
 *
 * Choosing the name and writing it CANNOT be two steps: whatever separates them
 * is a window in which another writer takes the name that was just declared
 * free, and the loser's dump disappears with no error raised anywhere. So each
 * candidate is written create-exclusively ({@link EXCLUSIVE_CREATE}) and an
 * `EEXIST` — the OS saying somebody else got there — advances to the next
 * counter rather than overwriting.
 *
 * @param directory - Directory dumps are written to
 * @param basename - Basename stem; the pid and any collision counter follow
 * @param contents - The already-serialized dump body
 * @returns Which name was claimed, or why none could be
 */
function claimTimingDump(directory: string, basename: string, contents: string): TimingDumpClaim {
  const stem = `${basename}-${String(process.pid)}`;
  for (let collision = 0; collision <= MAX_DUMP_COLLISIONS; collision += 1) {
    const candidate = timingDumpCandidate(directory, stem, collision);
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-supplied diagnostic directory from a VAT_*_TIMING variable
      writeFileSync(candidate, contents, { encoding: 'utf-8', flag: EXCLUSIVE_CREATE });
      return { outcome: 'written', path: candidate };
    } catch (error) {
      if (!isNameAlreadyTaken(error)) return { outcome: 'failed', path: candidate, error };
    }
  }
  return {
    outcome: 'exhausted',
    path: timingDumpCandidate(directory, stem, MAX_DUMP_COLLISIONS),
  };
}

/**
 * Write one seam's dump, if the seam is on.
 *
 * The body is built lazily, inside this call, so a disabled seam never pays to
 * snapshot accumulators nobody will read — and a `build` that throws is reported
 * like any other failure, because this runs from an `exit` listener where a
 * throw would change the process's exit behaviour.
 *
 * @param noun - What the seam is called, for any failure line
 * @param directory - Where to write, or `null` when the seam is off
 * @param basename - Basename stem for the file
 * @param build - Produces the dump body
 * @returns The path written, or `null` when the seam is off or nothing was written
 */
export function writeTimingDump(
  noun: string,
  directory: string | null,
  basename: string,
  build: () => unknown,
): string | null {
  if (directory === null) return null;

  let claim: TimingDumpClaim;
  try {
    claim = claimTimingDump(directory, basename, `${JSON.stringify(build(), null, 2)}\n`);
  } catch (error) {
    // Only `build()` and its serialization can reach here; every filesystem
    // failure is already an outcome rather than a throw.
    reportTimingDumpFailure(noun, directory, error);
    return null;
  }

  if (claim.outcome === 'written') return claim.path;
  reportTimingDumpFailure(
    noun,
    claim.path,
    claim.outcome === 'exhausted' ? CEILING_DETAIL : claim.error,
  );
  return null;
}
