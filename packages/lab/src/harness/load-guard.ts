/**
 * The machine-load contamination guard.
 *
 * A timing taken while the machine was simultaneously running a build, a test
 * suite, or another lab run is contaminated — the number is real, but it is a
 * number about the machine, not about vat. This module reads machine load
 * around a capture so the report can *say so*.
 *
 * **It records, it does not enforce.** The capture still writes the report and
 * the reader decides whether to trust it. A number that silently disappeared
 * teaches less than one labelled untrustworthy: the suppressed run leaves no
 * trace of why the gate went quiet, while a labelled one tells the next reader
 * exactly which repeat to redo.
 *
 * ## The cross-platform trap: `[0, 0, 0]` is not an idle machine
 *
 * `os.loadavg()` returns `[0, 0, 0]` on Windows — always, unconditionally,
 * because Windows exposes no load average for Node to read. Taken at face
 * value that is the *most* trustworthy reading possible: a perfectly idle
 * machine. It is in fact **no reading at all**, and a guard that believed it
 * would stamp "measured, machine was idle" on every Windows report ever
 * produced, including the ones taken mid-build.
 *
 * So this module never lets a Windows zero enter the arithmetic. An
 * unmeasurable reading is `null` — never a number, and never an in-band
 * sentinel that could be mistaken for one — and {@link LoadReadings.available}
 * is the explicit tell a reader checks before believing `contaminated: false`.
 * One fact, one encoding: two encodings of "no data" can disagree, and the one
 * that disagrees silently is the one that ships.
 *
 * ## Why two readings
 *
 * A one-minute load average lags what the machine is doing right now, so a
 * single reading taken before the repeats can miss a build that started
 * halfway through them. A machine that was idle before and loaded after
 * contaminated the run just as much as one that was busy throughout, which is
 * why {@link judgeLoad} consults both and judges on the busiest.
 */

import { cpus as logicalCpus, loadavg, platform } from 'node:os';

import type { LoadReadings } from '../facets/perf/types.js';

/**
 * Default contamination threshold, in load units per logical CPU.
 *
 * `0.5` means "half the machine's cores already have work queued". The exact
 * figure is a judgement call rather than a derived constant — which is
 * precisely why it is overridable per capture via
 * {@link JudgeLoadOptions.maxLoadPerCpu}, and why the raw readings travel in
 * the report so a reader can apply their own line after the fact.
 */
export const DEFAULT_LOAD_PER_CPU_THRESHOLD = 0.5;

/** One reading of the machine, taken at a point in time. */
export interface LoadSample {
  /**
   * One-minute load average, or `null` where it cannot be measured.
   *
   * Nullable rather than carrying a numeric "unavailable" marker, matching
   * {@link LoadReadings}: any in-band value is eventually read as a
   * measurement by something that does not know the convention.
   */
  readonly loadAvg1: number | null;
  /** Logical CPU count, so the reading can be judged proportionally. */
  readonly cpus: number;
}

/** Options for {@link judgeLoad}. */
export interface JudgeLoadOptions {
  /**
   * Load per logical CPU above which the capture is called contaminated.
   *
   * Defaults to {@link DEFAULT_LOAD_PER_CPU_THRESHOLD}. Strictly *above*: a
   * machine sitting exactly on the line is reported clean, so the threshold
   * reads as a ceiling rather than as a coin flip at the boundary.
   */
  readonly maxLoadPerCpu?: number;
}

/**
 * Keep a reading only if a real machine could have produced it.
 *
 * `NaN` and `Infinity` fold into `null` here rather than travelling onward:
 * both serialise to JSON `null` anyway, so letting them through as numbers
 * would mean the in-memory value and the value a reader sees state different
 * facts about the same capture.
 *
 * @param value - A candidate reading, already possibly absent
 * @returns The reading, or `null` when it is absent or impossible
 */
function usableOrNull(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/**
 * The one-minute load average, or `null` when this platform has none.
 *
 * Windows is short-circuited by platform rather than by value, because the
 * value it returns (`0`) is indistinguishable from a genuine idle reading on
 * every other platform. Detecting the *platform* is unambiguous; detecting the
 * *zero* would also swallow real idle machines on Linux and macOS.
 *
 * @returns A usable one-minute load average, or `null`
 */
function readOneMinuteLoad(): number | null {
  if (platform() === 'win32') return null;
  // `noUncheckedIndexedAccess`: the array is documented as length 3, but the
  // type system does not know that, and an empty one would otherwise yield an
  // `undefined` silently coerced to `NaN` by the arithmetic downstream.
  return usableOrNull(loadavg()[0] ?? null);
}

/**
 * Read the machine's current load and logical CPU count.
 *
 * The only impure function here; {@link judgeLoad} takes readings as arguments
 * so the judgement itself is testable without a machine in a particular state.
 *
 * @returns The one-minute load average (or `null` where unmeasurable) and the
 *   logical CPU count
 */
export function readLoad(): LoadSample {
  // `os.cpus()` returns an empty array on some containerised and virtualised
  // hosts. That is a reporting failure, not a zero-CPU machine — and it would
  // make every load-per-CPU division `Infinity`, flipping every such report to
  // contaminated. One is the honest floor: whatever ran the capture had at
  // least one CPU.
  const detected = logicalCpus().length;
  return {
    loadAvg1: readOneMinuteLoad(),
    cpus: detected >= 1 ? detected : 1,
  };
}

/**
 * Judge whether a capture's timings are contaminated by machine load.
 *
 * Pure: hand it the two readings and the CPU count and it decides, so every
 * branch below is reachable from a unit test without arranging for a busy
 * machine.
 *
 * Three rules, each chosen so that missing data can never *launder* a
 * measurement:
 *
 * 1. **Both readings count, and the busiest wins.** Load arriving partway
 *    through the repeats contaminates them exactly as much as load that was
 *    there from the start.
 * 2. **Absence is never cleanliness.** With no usable reading at all,
 *    `contaminated` is `false` — there is nothing to accuse the run of — but
 *    `available` is `false` too, so that verdict reads as "not judged" rather
 *    than as "found clean".
 * 3. **One usable reading still gets to speak.** If only one of the pair came
 *    back and it says the machine was busy, the capture is contaminated even
 *    though the pair is incomplete. Losing the second reading must not erase
 *    what the first one saw. `available: false` alongside `contaminated: true`
 *    is therefore a documented guarantee, not an implementation accident.
 *
 * `cpus` is echoed exactly as given. A count below one cannot divide a load
 * into anything meaningful, so it suppresses the verdict — but it does not
 * clear `available`, which records whether the *load* could be read. Such a
 * body never reaches a reader anyway: `PerfBodySchema` requires `cpus` to be a
 * positive integer, so an impossible count fails validation at the producer
 * instead of being quietly rounded up into a plausible-looking report.
 *
 * @param before - One-minute load average before the first repeat, or `null`
 * @param after - One-minute load average after the last repeat, or `null`
 * @param cpus - Logical CPU count the readings should be judged against
 * @param options - See {@link JudgeLoadOptions}
 * @returns Readings normalised for the report, plus the contamination verdict
 */
export function judgeLoad(
  before: number | null,
  after: number | null,
  cpus: number,
  options: JudgeLoadOptions = {},
): LoadReadings {
  const threshold = options.maxLoadPerCpu ?? DEFAULT_LOAD_PER_CPU_THRESHOLD;
  const measuredBefore = usableOrNull(before);
  const measuredAfter = usableOrNull(after);
  const measured = [measuredBefore, measuredAfter].filter((value) => value !== null);
  const judgeable = measured.length > 0 && cpus >= 1;

  return {
    before: measuredBefore,
    after: measuredAfter,
    cpus,
    available: measuredBefore !== null && measuredAfter !== null,
    contaminated: judgeable && Math.max(...measured) / cpus > threshold,
  };
}
