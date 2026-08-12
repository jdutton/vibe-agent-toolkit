/**
 * Shared `io` fixtures for the comparator and renderer suites.
 *
 * Not a test file — no `.test.ts` suffix, so the runner does not collect it.
 * Extracted for the same reason `report-fixtures.ts` was: both `io` suites need
 * a well-formed body to vary one field of, and two copies of an eleven-field
 * command literal drift apart the moment the contract changes. The zero-
 * duplication gate would also reject the second copy outright.
 *
 * The defaults are the real measurement this facet was built on — `vat resources
 * scan docs/` on a warm cache: 436 user calls, 6,371 loader calls, two processes.
 * Using the real numbers means a test that prints them reads like a report.
 */

import type { ReportEnvelope } from '../src/envelope/envelope.js';
import { compareIo, type IoComparisonResult } from '../src/facets/io/compare.js';
import {
  IO_FACET,
  IO_FACET_VERSION,
  type IoBody,
  type IoCommandStats,
  type IoSite,
} from '../src/facets/io/types.js';
import type { LoadReadings } from '../src/harness/types.js';

import { makeReport } from './report-fixtures.js';

/** A quiet machine, so contamination is never an accidental variable. */
export const CLEAN_LOAD: LoadReadings = {
  before: 1,
  after: 1.2,
  cpus: 8,
  available: true,
  contaminated: false,
};

/** The same readings, but taken while the machine was busy. */
export const BUSY_LOAD: LoadReadings = { ...CLEAN_LOAD, before: 40, after: 44, contaminated: true };

/**
 * One call site, defaulting to necessary work — 436 reads of 436 distinct files.
 *
 * A case that wants an N+1 lowers `distinctArgs`; a case that wants a floor sets
 * `argsCapped`.
 *
 * @param over - Fields to replace
 * @returns A complete site row
 */
export function ioSite(over: Partial<IoSite> = {}): IoSite {
  return {
    method: 'fs.readFileSync',
    site: 'packages/resources/dist/content-key.js:141',
    count: 436,
    distinctArgs: 436,
    argsCapped: false,
    ...over,
  };
}

/**
 * One measured command, defaulting to a clean, stable, two-process warm run.
 *
 * @param over - Fields to replace
 * @returns A complete command row
 */
export function ioCommand(over: Partial<IoCommandStats> = {}): IoCommandStats {
  return {
    name: 'resources-scan',
    args: ['resources', 'scan', 'docs/'],
    cache: 'warm',
    runs: 3,
    comparedRuns: 2,
    stable: true,
    processes: 2,
    loaderCalls: 6371,
    userCalls: 436,
    sites: [ioSite()],
    failed: false,
    failure: null,
    ...over,
  };
}

/**
 * A body around the given rows.
 *
 * @param commands - The measured commands
 * @param load - Machine load, defaulting to a quiet machine
 * @returns A complete `io` body
 */
export function ioBody(
  commands: readonly IoCommandStats[],
  load: LoadReadings = CLEAN_LOAD,
): IoBody {
  return { commands, load };
}

/**
 * An `io` envelope wrapping the given rows.
 *
 * Built through `makeReport` so the coordinate and the format version stay in
 * one place; only the facet header and the body are overridden here.
 *
 * @param commands - The measured commands
 * @param over - Envelope fields the case varies (coordinate, load-bearing ones)
 * @returns A complete `io` report
 */
export function ioReport(
  commands: readonly IoCommandStats[],
  over: Partial<ReportEnvelope<unknown>> = {},
): ReportEnvelope<IoBody> {
  return makeReport({
    facet: IO_FACET,
    facetVersion: IO_FACET_VERSION,
    body: ioBody(commands),
    ...over,
  }) as ReportEnvelope<IoBody>;
}

/**
 * Compare two one-command reports at the shared baseline coordinate.
 *
 * Both io suites need this — the comparator suite to read verdicts off it, the
 * renderer suite to feed a real comparison into the renderer rather than a
 * hand-built literal that could drift from what compareIo actually emits.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @returns The comparison, which never refuses at a shared coordinate
 * @throws When the comparison refused, which no caller of this helper expects
 */
export function compareOneCommand(
  before: IoCommandStats,
  after: IoCommandStats,
): IoComparisonResult {
  const result = compareIo(ioReport([before]), ioReport([after]));
  if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal}`);
  return result;
}
