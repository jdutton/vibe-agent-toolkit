/**
 * The capture loop shared by every facet whose measurement is written from
 * *inside* the measured process.
 *
 * Three properties are load-bearing and none of them is about what is being
 * measured, which is why writing this per facet is how one of them quietly stops
 * holding in one of them:
 *
 * 1. **Commands run one after another, never concurrently.** Two vat processes
 *    racing for the same machine would each measure the other's interference,
 *    and these are durations.
 * 2. **One fresh dump directory per repeat**, removed however the repeat ends.
 *    Nothing downstream can tell a leftover dump from an earlier repeat apart
 *    from a descendant of this one, so a reused directory silently inflates
 *    every number.
 * 3. **The directory is injected per repeat, through `envFor` rather than
 *    `env`.** Only the measured run is instrumented, so a `cold` mode cache
 *    clear cannot write dumps of its own into the repeat that is about to be
 *    read.
 */

import { withDumpDirs } from './dumps.js';
import { measureSpec, type SpecMeasurement } from './repeat.js';
import type { CaptureRequest } from './types.js';

/**
 * Run every requested command, each over its own fresh per-repeat dump
 * directories, and fold each one into a report row.
 *
 * @param options - The capture request
 * @param prefix - Temp-directory prefix, so a stray directory names its facet
 * @param dirEnv - The variable whose VALUE switches the seam on and names its directory
 * @param rowFrom - How this facet turns repeats plus their dumps into a row
 * @returns One row per command, in request order
 */
export async function captureCommandRows<TRow>(
  options: CaptureRequest,
  prefix: string,
  dirEnv: string,
  rowFrom: (measurement: SpecMeasurement, directories: readonly string[]) => Promise<TRow>,
): Promise<TRow[]> {
  const rows: TRow[] = [];
  for (const spec of options.commands) {
    // Sequential on purpose — see rule 1 in this module's header. Awaiting inside
    // the loop is the mechanism, not an oversight.
    rows.push(
      await withDumpDirs(options.runs, prefix, async (directories) => {
        const perRepeat = directories.map((directory) => ({ [dirEnv]: directory }));
        const measurement = measureSpec(options, spec, (index) => perRepeat[index]);
        return rowFrom(measurement, directories);
      }),
    );
  }
  return rows;
}
