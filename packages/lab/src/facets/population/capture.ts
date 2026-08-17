/**
 * Capturing a `population` report: run each command N times, read the file set
 * it enumerated, and check the repeats agreed.
 *
 * ## Why `warm`, and why no repeat is discarded
 *
 * There is nothing here for a cache to make faster or slower — a population is
 * the same set whether the parse cache was hot or cold — so the steady state is
 * the honest mode. And a repeat that enumerated a different set is a finding
 * about the subject, not a warm-up to be dropped: {@link PopulationCommandStats.stable}
 * exists to report it.
 *
 * ## Why the FIRST repeat is reported rather than a middle one
 *
 * The measurement facets pick a median repeat because their observable is a
 * number with a distribution. This one has no distribution: either every repeat
 * agreed, in which case any of them is the answer, or they did not, in which case
 * `stable` is `false` and no single repeat is *the* population. Picking a middle
 * one would suggest a spread that a set does not have.
 */

import type { ReportEnvelope } from '../../envelope/envelope.js';
import { trackedPaths } from '../../harness/git-state.js';
import { judgeLoad, readLoad } from '../../harness/load-guard.js';
import { measureSpec, type SpecMeasurement } from '../../harness/repeat.js';
import { buildReportEnvelope } from '../../harness/report.js';
import type { CaptureRequest } from '../../harness/types.js';

import {
  type PopulationDocument,
  readPopulationDocument,
  samePopulation,
} from './document.js';
import {
  POPULATION_FACET,
  POPULATION_FACET_VERSION,
  type PopulationBody,
  type PopulationCommandStats,
} from './types.js';

/**
 * Everything a capture needs.
 *
 * Exactly the shared request. This facet reads what the measured command prints,
 * so — unlike `io`, which has to be told where its counter lives — there is
 * nothing of its own to configure.
 */
export type CapturePopulationOptions = CaptureRequest;

/**
 * The row a command produces before any population is folded into it.
 *
 * A `Pick` of the published row rather than a fresh interface, so the identity a
 * failed row keeps and the identity a measured row keeps cannot drift apart.
 */
type RowBase = Pick<PopulationCommandStats, 'name' | 'args' | 'cache'>;

/**
 * A row that read no population, with every field zeroed and `failed` set.
 *
 * Zeros and empties rather than absent fields: the schema is strict and a reader
 * must not have to guess. `attribution: 'not-measured'`, `failed` and `failure`
 * carry the meaning — an empty population must never be readable as a small one.
 *
 * @param base - Name, arguments and cache mode
 * @param runs - How many repeats actually ran
 * @param failure - Why there is no population
 * @returns The failed row
 */
function failedRow(base: RowBase, runs: number, failure: string): PopulationCommandStats {
  return {
    ...base,
    runs,
    stable: null,
    attribution: 'not-measured',
    lane: null,
    extentSource: null,
    root: null,
    count: 0,
    files: [],
    gitTracked: null,
    offGit: [],
    failed: true,
    failure,
  };
}

/**
 * Read every repeat's population, in repeat order.
 *
 * @param measurement - The repeats that ran
 * @returns Every document, or the first refusal
 */
function readEveryRepeat(
  measurement: SpecMeasurement,
): readonly PopulationDocument[] | { readonly refusal: string } {
  const documents: PopulationDocument[] = [];
  for (const result of measurement.results) {
    const read = readPopulationDocument(result.stdout);
    if (!read.ok) return { refusal: read.refusal };
    documents.push(read.document);
  }
  return documents;
}

/**
 * Did every repeat enumerate the same set?
 *
 * Checked against each repeat's PREDECESSOR: equality of the compared fields is
 * transitive, so adjacent equality throughout is equality throughout.
 *
 * @param documents - Every repeat's population, in capture order
 * @returns True when all agreed, or `null` when fewer than two repeats ran
 */
function agreementOf(documents: readonly PopulationDocument[]): boolean | null {
  if (documents.length < 2) return null;
  return documents.every((document, index) => {
    if (index === 0) return true;
    const previous = documents[index - 1];
    return previous !== undefined && samePopulation(previous.files, document.files);
  });
}

/**
 * The enumerated paths git does not track, and how many it does.
 *
 * Taken at the population's OWN stated root, never at the subject directory —
 * `vat` resolves a project root that may be an ancestor of the path it was
 * handed, and every path in the document is relative to that root. Listing git
 * somewhere else would compare two different bases and render the whole
 * population as off-git.
 *
 * @param document - The population to check
 * @returns The reference reading, with `offGit` empty when git could not answer
 */
function gitReference(
  document: PopulationDocument,
): Pick<PopulationCommandStats, 'gitTracked' | 'offGit'> {
  const tracked = trackedPaths(document.root);
  if (tracked === null) return { gitTracked: null, offGit: [] };
  return {
    gitTracked: tracked.size,
    // Already path-sorted upstream, so this stays sorted without re-sorting.
    offGit: document.files.filter((entry) => !tracked.has(entry.path)).map((entry) => entry.path),
  };
}

/**
 * Fold what the repeats printed into a report row.
 *
 * Whether the repeats are usable at all is already decided — `measureSpec` owns
 * that, so every measurement facet refuses exactly the same repeats for exactly
 * the same reasons, phrased the same way. What is left here is this facet's own
 * question: which files, and did the repeats agree.
 *
 * @param measurement - What was asked for, what ran, and whether it is usable
 * @returns The row, marked failed when no usable population exists
 */
function rowFor(measurement: SpecMeasurement): PopulationCommandStats {
  const { spec, args, cache, results, failure } = measurement;
  const base: RowBase = { name: spec.name, args, cache };

  if (results.length === 0) return failedRow(base, 0, 'no repeats were requested');
  if (failure !== null) return failedRow(base, results.length, failure);

  const documents = readEveryRepeat(measurement);
  if ('refusal' in documents) return failedRow(base, results.length, documents.refusal);

  const reported = documents[0];
  if (reported === undefined) {
    return failedRow(base, results.length, 'no repeat produced a population document');
  }

  return {
    ...base,
    runs: results.length,
    stable: agreementOf(documents),
    // An empty population is a MEASUREMENT and says so in its own word. It is
    // very often the finding — a command pointed somewhere it enumerates
    // nothing — and folding it into `measured` would leave a reader reading a
    // count of zero as a small population.
    attribution: reported.files.length === 0 ? 'nothing-enumerated' : 'measured',
    lane: reported.lane,
    extentSource: reported.extentSource,
    root: reported.root,
    count: reported.files.length,
    files: reported.files,
    ...gitReference(reported),
    failed: false,
    failure: null,
  };
}

/**
 * Capture a `population` report.
 *
 * Commands are measured one after another, never concurrently — the shared
 * repeat loop spawns them, and two vat processes racing over one subject would
 * be reading a tree the other might be caching against.
 *
 * @param options - See {@link CapturePopulationOptions}
 * @returns A complete report envelope, ready to store
 */
export function capturePopulation(
  options: CapturePopulationOptions,
): ReportEnvelope<PopulationBody> {
  const loadBefore = readLoad();
  const commands = options.commands.map((spec) => rowFor(measureSpec(options, spec)));
  const loadAfter = readLoad();

  return buildReportEnvelope(POPULATION_FACET, POPULATION_FACET_VERSION, options, {
    commands,
    load: judgeLoad(loadBefore.loadAvg1, loadAfter.loadAvg1, loadAfter.cpus),
  });
}
