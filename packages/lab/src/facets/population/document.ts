/**
 * Reading a population out of what a vat command printed.
 *
 * Pure, and apart from the capture: a count with no file list, no population,
 * or an unreadable document each becomes a **refusal**, never an empty set — an
 * empty set is a measurement, and the two render identically.
 *
 * ## Two shapes, one reader
 *
 * YAML or JSON, through `parseDocument`, which also says which shape printed:
 * an older build's per-command document (`legacy`), or the `Report<T>` envelope
 * `resources scan` publishes from 0.2.0 on (count in `examined`, population in
 * `data.files`). `ScanDocumentSchema` reads `parseDocument`'s `payload` — the
 * legacy document or a report's `data` — so both stay readable. The file count
 * is not read off the payload; see {@link readPopulationDocument}.
 */

import { z } from 'zod';

import { parseDocument } from '../../harness/document-shape.js';
import { LaneFieldsSchema, laneOfDocument, type ReportedLane } from '../../harness/lane.js';

import type { PopulationEntry } from './types.js';

/**
 * The part of a `vat resources scan` document this facet reads.
 *
 * Deliberately **not** strict, and deliberately narrow: the document carries
 * link and anchor totals, per-collection counts and a duration, none of which
 * are this facet's business. Modelling them would make an unrelated addition to
 * the subject's output a refusal here.
 *
 * `lane` and `extentSource` EXTEND the shared `harness/lane.ts` schema, so this
 * facet and `io` share one definition of an arm — and a malformed arm is a
 * refusal here (a population is nothing but the subject's claim), where `io`
 * reads it as `null`.
 *
 * `files` is optional because the command omits it without `--verbose`; that
 * case gets its own sentence in {@link readPopulationDocument}.
 *
 * `filesScanned` is validated (a malformed one is a refusal) but optional: a
 * report's count is the envelope's `examined`, so only a legacy document is
 * refused for lacking it.
 */
const ScanDocumentSchema = LaneFieldsSchema.extend({
  root: z.string().min(1),
  filesScanned: z.number().int().nonnegative().optional(),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        checksum: z.string(),
      }).strip(), /* a row ANOTHER vat build printed: keep only the two fields a population compares on */
    )
    .optional(),
});

/**
 * A population successfully read out of a command's output.
 *
 * Extends {@link ReportedLane}: the arm the command said it took travels with
 * the set, read by the same reader every facet uses.
 */
export interface PopulationDocument extends ReportedLane {
  /** The one absolute path every {@link PopulationDocument.files} path is relative to. */
  readonly root: string;
  /** Every enumerated file, sorted by path. */
  readonly files: readonly PopulationEntry[];
}

/** What {@link readPopulationDocument} produced. */
export type PopulationDocumentResult =
  | { readonly ok: true; readonly document: PopulationDocument }
  | { readonly ok: false; readonly refusal: string };

/**
 * Read a command's stdout as a population document.
 *
 * @param stdout - Everything the command wrote to stdout
 * @returns The population, or why it is not readable as one
 */
export function readPopulationDocument(stdout: string): PopulationDocumentResult {
  const parsed = parseDocument(stdout);
  if (parsed.shape === 'unparsed') {
    return {
      ok: false,
      refusal:
        `the command printed no document this facet can read (${parsed.reason}), so it reports no population — ` +
        'measure a command that emits one (`resources scan … --verbose`)',
    };
  }

  const validated = ScanDocumentSchema.safeParse(parsed.payload);
  if (!validated.success) {
    return {
      ok: false,
      refusal:
        'the command printed a document that is not a resource-scan document — ' +
        validated.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; '),
    };
  }

  const document = validated.data;
  // `examined` for a report, `filesScanned` for legacy — see the schema's
  // docstring on why `filesScanned` is optional there. `isReportRoot`
  // (document-shape.ts) already proved `examined` is a number for `report`.
  const filesScanned = parsed.shape === 'report'
    ? (parsed.document['examined'] as number)
    : document.filesScanned;

  if (filesScanned === undefined) {
    return {
      ok: false,
      refusal:
        'the command printed a resource-scan document with no file count (`filesScanned`) — ' +
        're-run with a build that reports one',
    };
  }

  if (document.files === undefined) {
    // The count is right there and it is exactly the wrong thing to take. A row
    // built from the count alone would compare byte-identically against any
    // other run of the same size while knowing nothing about which files those
    // were — the failure this whole facet exists to prevent.
    return {
      ok: false,
      refusal:
        `the command reported ${String(filesScanned)} files scanned but listed none, ` +
        'so there is a count and no population — re-run the command with `--verbose`',
    };
  }

  // Read off the VALIDATED document, never off `parsed.payload` or off `stdout`
  // again. The schema above has already refused every malformed arm, so the
  // shared reader's lenient "unreadable ⇒ null" path is unreachable from here:
  // what it does for this facet is the one normalisation both facets share (an
  // omitted key becomes `null`), and it does it off a value the schema already
  // vouched for.
  const arm = laneOfDocument(document);
  return {
    ok: true,
    document: {
      root: document.root,
      lane: arm.lane,
      extentSource: arm.extentSource,
      files: sortByPath(document.files),
    },
  };
}

/**
 * Sort entries by path.
 *
 * The subject enumerates in whatever order its registry holds, which is not a
 * property anyone wants to compare. Sorting here means a set difference later is
 * a difference in membership rather than in iteration order — and it is done
 * once, at the boundary, so no downstream reader has to remember to.
 *
 * `localeCompare` is deliberately NOT used: it is locale-dependent, so the same
 * two reports could order differently on two machines and a stored report would
 * stop matching itself.
 *
 * @param files - Entries as the document listed them
 * @returns The same entries, ordered by path
 */
function sortByPath(files: readonly PopulationEntry[]): readonly PopulationEntry[] {
  return [...files].sort((a, b) => comparePaths(a.path, b.path));
}

/**
 * Order two paths by code unit.
 *
 * @param a - One path
 * @param b - Another
 * @returns Negative, zero or positive, as a comparator wants
 */
function comparePaths(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Do two populations contain the same files with the same content?
 *
 * Compares membership and checksums, which is the whole of what this facet
 * measures. Used to decide {@link PopulationCommandStats.stable} across repeats.
 *
 * @param a - One population
 * @param b - Another
 * @returns True when they are the same set with the same contents
 */
export function samePopulation(
  a: readonly PopulationEntry[],
  b: readonly PopulationEntry[],
): boolean {
  if (a.length !== b.length) return false;
  // Both sides are path-sorted by the time they reach here, so a positional walk
  // is a set comparison — and it reports a checksum difference on an otherwise
  // identical membership, which a set of paths alone would call equal.
  return a.every((entry, index) => {
    const other = b[index];
    return other?.path === entry.path && other.checksum === entry.checksum;
  });
}
