/**
 * Reading a population out of what a vat command printed.
 *
 * Kept apart from the capture, and pure, for one reason: every way this can go
 * wrong is a way a report can quietly claim a population it never observed, and
 * those cases are trivial to state against a literal string and awkward to
 * provoke through a spawn. A command that reported a count but no file list, a
 * command that reports no population at all, a document this build cannot read —
 * each has to become a **refusal**, never an empty set. An empty set is a
 * measurement; "we could not read one" is not, and the two render identically to
 * anyone scanning for a number.
 *
 * ## Reading through `document-shape.ts`, and what changes when `resources
 * scan` becomes a `Report`
 *
 * `vat resources scan` prints YAML by default and the same document as JSON
 * under `--format json`; this reader takes either, through `parseDocument`,
 * rather than requiring `--format json` to avoid carrying a second YAML parser.
 * `parseDocument` also decides which of the document's two shapes this run
 * printed: today's per-command document (`legacy`), or the `Report<T>` envelope
 * every command has published since rc.11 (`report`) — which `resources scan`
 * itself does not print YET (wave 3). `ScanDocumentSchema` below is applied to
 * `parseDocument`'s `payload`, which is the right value in both cases without
 * this module knowing which one it got: the legacy document itself, or a
 * report's `data`. The one field that is NOT read off the payload either way is
 * the file count — see {@link readPopulationDocument} for why.
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
 * `lane` and `extentSource` are here by EXTENDING the shared `harness/lane.ts`
 * schema rather than by restating it, and the distinction is load-bearing in
 * both directions. Extending keeps one definition of what the two fields may
 * hold, so this facet and `io` cannot disagree about what a document said its
 * arm was. Having them in THIS schema at all is what makes a malformed arm a
 * refusal here: `io` reads a lane of the wrong type as `null` (a qualifier on
 * counts that are real either way), but a population is nothing but the
 * subject's own claim, and `null` is the label an old-but-honest build gets.
 * A subject that printed a corrupt lane must not be indistinguishable from one
 * that printed none.
 *
 * `files` is optional because the command omits it without `--verbose`, and that
 * case needs its own sentence rather than a schema error — see
 * {@link readPopulationDocument}.
 *
 * `filesScanned` is optional for a different reason: it is validated here (so a
 * present-but-malformed one is still a refusal, never silently ignored), but it
 * is NOT the count {@link readPopulationDocument} reports. A `Report`'s `data`
 * has no reason to repeat the envelope's own `examined` under a second,
 * per-command name, so a report-shaped payload legitimately omits this key —
 * only a legacy document is refused for lacking it.
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
