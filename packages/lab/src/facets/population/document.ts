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
 * ## Why JSON and not the YAML the command prints by default
 *
 * `vat resources scan --format json` emits the same document. Taking it as JSON
 * keeps this package free of a YAML parser it would otherwise need only here —
 * and the `--format json` flag exists on the subject precisely so a programmatic
 * consumer does not need one.
 */

import { z } from 'zod';

import type { PopulationEntry } from './types.js';

/**
 * The part of a `vat resources scan` document this facet reads.
 *
 * Deliberately **not** strict, and deliberately narrow: the document carries
 * link and anchor totals, per-collection counts and a duration, none of which
 * are this facet's business. Modelling them would make an unrelated addition to
 * the subject's output a refusal here.
 *
 * `files` is optional because the command omits it without `--verbose`, and that
 * case needs its own sentence rather than a schema error — see
 * {@link readPopulationDocument}.
 */
const ScanDocumentSchema = z.object({
  root: z.string().min(1),
  filesScanned: z.number().int().nonnegative(),
  // A free string, matching the body's own field: an unknown lane name must
  // survive verbatim rather than be folded into a value this build recognises.
  lane: z.string().min(1).optional(),
  // Nullable as well as optional, and the difference is load-bearing: vat emits
  // `null` for the walk (a lane with no extent to source) and omits the key
  // entirely on a build too old to report it. Rejecting the null would refuse
  // every walk-lane document.
  extentSource: z.string().min(1).nullable().optional(),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        checksum: z.string(),
      }),
    )
    .optional(),
});

/** A population successfully read out of a command's output. */
export interface PopulationDocument {
  /** The one absolute path every {@link PopulationDocument.files} path is relative to. */
  readonly root: string;
  /** Which enumerator the command said produced this set, or `null` if it did not say. */
  readonly lane: string | null;
  /** Which source the reported lane enumerated from, or `null` if it did not say. */
  readonly extentSource: string | null;
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
  let raw: unknown;
  try {
    raw = JSON.parse(stdout) as unknown;
  } catch {
    return {
      ok: false,
      refusal:
        'the command printed no JSON document, so it reports no population this facet can read — ' +
        'measure a command that emits one (`resources scan … --format json --verbose`)',
    };
  }

  const parsed = ScanDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      refusal:
        'the command printed a JSON document that is not a resource-scan document — ' +
        parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; '),
    };
  }

  const document = parsed.data;
  if (document.files === undefined) {
    // The count is right there and it is exactly the wrong thing to take. A row
    // built from `filesScanned` alone would compare byte-identically against any
    // other run of the same size while knowing nothing about which files those
    // were — the failure this whole facet exists to prevent.
    return {
      ok: false,
      refusal:
        `the command reported ${String(document.filesScanned)} files scanned but listed none, ` +
        'so there is a count and no population — re-run the command with `--verbose`',
    };
  }

  return {
    ok: true,
    document: {
      root: document.root,
      lane: document.lane ?? null,
      extentSource: document.extentSource ?? null,
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
