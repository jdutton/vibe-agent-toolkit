/**
 * The `io` facet's body — how much filesystem and child-process work a vat
 * command does.
 *
 * **These are Node `fs` and `child_process` calls, not kernel syscalls.** The
 * counter wraps Node's own APIs, so one `fs.readFile` here is one call into
 * Node's library, whatever number of `openat`/`read`/`close` the kernel ends up
 * seeing. Calling them syscalls would invite a reader to compare these numbers
 * against `strace` or `dtruss` output, which they will never match. The word is
 * avoided everywhere in this facet for that reason.
 *
 * **What the facet is for.** Wall time says a command is slow; it does not say
 * why, and it moves with the machine. A call count does not move with the
 * machine, and paired with {@link IoSite.distinctArgs} it separates work that
 * had to happen from work that was repeated — which is the N+1 detector, and the
 * reason this facet exists alongside `perf` rather than inside it.
 */

import { z } from 'zod';

import { LoadReadingsSchema, measuredCommandShape } from '../../harness/schemas.js';
import type { CacheMode, LoadReadings } from '../../harness/types.js';

/** Stable name of this facet, as it appears in the envelope header. */
export const IO_FACET = 'io';

/**
 * Version of this body schema.
 *
 * Bumped whenever the shape below changes. Two `io` reports at different body
 * versions are refused against each other, because differences across a schema
 * change belong to the schema rather than to the subject.
 */
export const IO_FACET_VERSION = 2;

/** One call site, with everything needed to judge whether its work was necessary. */
export interface IoSite {
  /** The Node API called — `fs.readFile`, `child_process.spawnSync`. Not a syscall name. */
  readonly method: string;
  /**
   * Where the call was made, normalized so two machines produce one string.
   *
   * Absolute paths are rewritten at merge time — `node_modules` collapsed to its
   * last segment, the instrument's own files made root-relative — because a raw
   * `/Users/someone/...` makes every report incomparable to every other, and a
   * bun-nested real path (`node_modules/.bun/isexe@3.1.4/node_modules/isexe/…`)
   * additionally bakes in a version and a package-manager layout.
   */
  readonly site: string;
  /** How many calls this site made. */
  readonly count: number;
  /**
   * How many *distinct first arguments* this site was called with, or `null`
   * when no such reading was taken.
   *
   * The whole point of the facet. `count: 66, distinctArgs: 66` is 66 reads of
   * 66 different files — necessary work. `count: 66, distinctArgs: 1` is 66
   * reads of the same file — an N+1, and a cache that is missing or being
   * defeated. A bare count cannot tell those apart, which is why the two travel
   * together and never separately.
   *
   * **`null` means no reading, and it is not a small number.** That argument
   * holds exactly while argument 0 identifies the work, which it does not for
   * `child_process` methods (argument 0 is the *binary*; every vat spawn of git
   * passes the one path `which.sync('git')` returned) nor for two-path `fs`
   * operations (`copyFile`, `rename`, …, where argument 0 is only the source)
   * nor for `mkdtemp` (argument 0 is a prefix, and every call makes a new
   * directory). Measured on the real `vat audit .` report at `119f4d5b`,
   * `child_process.spawnSync` at `packages/utils/dist/git-utils.js:60` read
   * `count=8, distinctArgs=1` — a structurally guaranteed 8.00x "redundancy"
   * that said nothing about whether the spawns were redundant. The counter now
   * takes no reading there, and this field says so out loud rather than through
   * a `0` or a `1` that a reader would take for a measurement. Same distinction
   * {@link IoCommandStats.stable} draws with its own `null`.
   *
   * **Merged across processes it is an UPPER BOUND.** Each process counts its
   * own distinct arguments, and two processes reading the same file each count
   * it, so the sum can exceed the true number of distinct files. That direction
   * of error is safe for the detector: it can only make repeated work look more
   * necessary than it was, never less.
   *
   * **When {@link IoSite.argsCapped} is true it is instead a FLOOR** — the
   * counter stopped tracking new arguments at that site, so the true count is at
   * least this. Reading a capped value as exact would report a fake N+1.
   */
  readonly distinctArgs: number | null;
  /**
   * True when the counter hit its per-site argument limit and stopped tracking.
   *
   * Recorded rather than silently dropped, because {@link IoSite.distinctArgs}
   * changes meaning when it is set — see there. Necessarily `false` when that
   * field is `null`: there is no set to have filled up, and a `true` would make
   * an absent reading look like an exact one that merely overflowed. Both
   * schemas below enforce that.
   */
  readonly argsCapped: boolean;
}

/**
 * The schema fields describing one call site.
 *
 * Declared once and shared with the dump reader, which validates the same five
 * fields arriving from the counter and then adds `cls` to them. Two copies would
 * be free to disagree about, say, whether `count` may be negative — and the
 * disagreement would show up as a dump that parses on the way in and fails on
 * the way out, or worse, does not.
 */
export const ioSiteShape = {
  /** The Node API called — `fs.readFile`, `child_process.spawnSync`. Not a syscall name. */
  method: z.string().min(1),
  site: z.string(),
  count: z.number().int().nonnegative(),
  distinctArgs: z.number().int().nonnegative().nullable(),
  argsCapped: z.boolean(),
} as const;

/** What {@link cappedNeedsAReading} rejects, said the way a reader needs it. */
export const CAPPED_WITHOUT_READING_MESSAGE =
  "a row with no distinct-argument reading cannot be 'capped' — there is no set to have filled up, " +
  'and a true here would make an absent reading look like an exact one that overflowed';

/**
 * Refuse a row that claims to have capped a reading it never took.
 *
 * Shared by both schemas that validate this shape — the dump reader's row and
 * the report body's site. Two copies would be free to disagree, and the
 * disagreement would show up as a dump that parses on the way in and fails on
 * the way out.
 *
 * @param row - The row being validated
 * @returns True when the row is coherent
 */
export function cappedNeedsAReading(row: {
  readonly distinctArgs: number | null;
  readonly argsCapped: boolean;
}): boolean {
  return row.distinctArgs !== null || !row.argsCapped;
}

/** The measured result for one command. */
export interface IoCommandStats {
  /** Stable artifact name, appearing in the report and any diff. */
  readonly name: string;
  /** Arguments as actually run, so the report records what produced the number. */
  readonly args: readonly string[];
  readonly cache: CacheMode;
  /**
   * How many times the command actually ran.
   *
   * The same meaning as `perf`'s `runs` — every repeat that was performed. That
   * facet discards nothing, so its count is also the number that contributed;
   * this one discards a warm-up, which is why the two are separate fields here
   * rather than one field meaning different things in different reports.
   */
  readonly runs: number;
  /**
   * How many repeats were compared with each other to decide
   * {@link IoCommandStats.stable}.
   *
   * In `warm` cache mode the first repeat populates vat's on-disk cache and
   * therefore systematically differs from the rest, so it is a warm-up and is
   * dropped; the *last* repeat is what appears below. `comparedRuns` is
   * therefore `runs - 1` in the normal case, and it is the number that decides
   * whether `stable` asserts anything at all.
   */
  readonly comparedRuns: number;
  /**
   * Whether the compared repeats produced identical buckets — or `null` when
   * there were not enough of them to tell.
   *
   * **`null` is not `true`.** Below two compared repeats nothing can disagree, so
   * a `boolean` here would report `true` for a determinism that was never tested,
   * and a comparator reading it would trust an exact-equality delta it has no
   * warrant for. This is the same distinction {@link LoadReadings} already draws
   * between "measured, and it was quiet" and "never measured": an in-band value
   * that means "no data" is eventually read as data.
   *
   * **False does not invalidate the report.** It says a comparator must not read
   * an exact-equality delta from these numbers — something in this command's I/O
   * is not deterministic (a timestamped path, a directory order, a race), so a
   * difference against another report may belong to the run rather than to the
   * change. The numbers themselves are still the last repeat's, and still real.
   */
  readonly stable: boolean | null;
  /**
   * How many distinct PIDs produced a dump for the reported repeat.
   *
   * ⚠️ **1 is the ORDINARY case, and this field's own guidance used to say the
   * opposite.** It read "never 1 in practice… the launcher spawns a second node
   * process for the binary", which was true only while the lab measured the
   * context-detecting wrapper. `tree:` and `dist:` now resolve
   * `packages/cli/dist/bin.js` directly and refuse the wrapper outright, so the
   * measured vat does its work in one process and there is no second PID to
   * count. Reading 1 as a failure made the io facet warn on every correct run.
   *
   * The number is still reported, because a reader comparing two arms wants to
   * know a spawn appeared or vanished. What it must NOT be read as, on its own,
   * is evidence that the counter failed — see `measuredLauncherOnly` in
   * `render.ts` for the test that replaced it.
   */
  readonly processes: number;
  /**
   * Calls attributed to Node's own ESM module loader, in aggregate.
   *
   * **This must never be hidden.** Measured on `vat resources scan docs/`:
   * 6,371 of 6,411 `fs` calls came from the loader resolving and reading
   * modules, not from vat doing work. The facet buckets those out of
   * {@link IoCommandStats.sites} — otherwise every report is a list of Node
   * internals and vat's own 40 calls are invisible — but bucketing them out of
   * the detail and dropping them from the report are different things. Without
   * this aggregate a reader cannot tell "6,371 were bucketed out" from "there
   * were only 40", and those support opposite conclusions about where the time
   * goes.
   */
  readonly loaderCalls: number;
  /** Calls attributed to vat's own code and its dependencies — the sum over `sites`. */
  readonly userCalls: number;
  /**
   * Every user-class call site, descending by count.
   *
   * Loader-class calls are deliberately absent; they are counted in
   * {@link IoCommandStats.loaderCalls} instead. Ties are broken by method and
   * then site so that two identical measurements serialise identically — a sort
   * that fell back to read order would make a report differ from itself.
   */
  readonly sites: readonly IoSite[];
  /**
   * True when this command did not produce a usable measurement — a non-zero
   * exit, a spawn failure, or dumps that could not be read.
   *
   * A failed command keeps its row so the report says what happened, but a
   * comparator must not read a delta from it. Counting the calls a crash made
   * before it died measures how far vat got, not what it does.
   */
  readonly failed: boolean;
  /** Why it failed, when it did. */
  readonly failure: string | null;
}

/** The `io` facet's report body. */
export interface IoBody {
  readonly commands: readonly IoCommandStats[];
  /**
   * Machine load around the capture.
   *
   * Carried even though call counts do not move with load, because a contaminated
   * machine is evidence about the *run* — a capture that was fighting for CPU may
   * also have been fighting for the filesystem, and a reader comparing an `io`
   * report against a `perf` report taken in the same session needs the same tell
   * on both.
   */
  readonly load: LoadReadings;
}

/**
 * Runtime schema for {@link IoBody}.
 *
 * The envelope reader deliberately does not validate bodies — it does not know
 * their shapes. Each facet validates its own after confirming the header names
 * it, which is why this lives here rather than beside the envelope.
 *
 * Strict, not passthrough: this validates data *we* wrote. An unrecognised field
 * means a producer this build does not model, and reading it as an `io` body
 * would be a guess.
 */
export const IoBodySchema = z
  .object({
    commands: z.array(
      z
        .object({
          ...measuredCommandShape,
          comparedRuns: z.number().int().nonnegative(),
          stable: z.boolean().nullable(),
          processes: z.number().int().nonnegative(),
          loaderCalls: z.number().int().nonnegative(),
          userCalls: z.number().int().nonnegative(),
          sites: z.array(
            z.object(ioSiteShape).strict().refine(cappedNeedsAReading, {
              message: CAPPED_WITHOUT_READING_MESSAGE,
            }),
          ),
        })
        .strict(),
    ),
    load: LoadReadingsSchema,
  })
  .strict();
