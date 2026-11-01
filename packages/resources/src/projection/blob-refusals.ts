/**
 * Turn a population's stored rows into the one line a user should see when the
 * population holds content it declined to derive — or derived and cannot vouch
 * for.
 *
 * ## Why the input is ROWS, not what this process derived
 *
 * The line describes the POPULATION, not the run. A store hit derives nothing,
 * so a line built from the blob stage's run counters printed on a cold run and
 * vanished on the warm one over the same tree — the same binary was refused
 * both times, and only one run said so. Every fact this line states is a row
 * the store round-trips:
 *
 * - a declined blob is a `blob_conditions` row coded `BLOB_NOT_TEXT`,
 *   `BLOB_UNREADABLE`, `BLOB_CONTENT_CHANGED` or `BLOB_PARSE_FAILED`;
 * - an unkeyed realization is a `resource_realizations` row whose
 *   `contentState` is `unreadable` or `oversize`;
 * - a mis-decoded blob is a `blobs` row with `replacementCharacters > 0`.
 *
 * So a hit and a derive describe alike, and there is one route: the lane that
 * owns the projection hands it here. Run-only counters that no row carries
 * (headings or references dropped for want of a source line) are not reported;
 * an absent row is unqueryable, and a line that only a cold run can print is
 * the defect this shape exists to remove.
 *
 * ## Why the denominator is in the line
 *
 * "Nothing was refused" and "nothing was enumerated" are the same output
 * otherwise, and the second is the failure mode that actually ships. Naming how
 * many blobs the population holds makes a line reading `0 of 0` self-refuting.
 *
 * ## Why a mis-decode is reported HERE, next to the refusals
 *
 * It is not a refusal — the blob was read, parsed and stored — but this
 * module's subject is *what the population cannot vouch for*, and nothing is
 * less trustworthy than a document decoded with the wrong encoding: a complete,
 * plausible, queryable row full of mojibake. `replacementCharacters > 0` fires
 * on **proof** rather than suspicion, since the decoder tries fatal-mode decoding
 * first. `encodingSource: 'assumed'` alone is deliberately NOT a trigger: it is
 * true of every ordinary UTF-8 file, and a line that fires on all of them is
 * wallpaper within a day.
 */

import {
  BLOB_CONTENT_CHANGED,
  BLOB_NOT_TEXT,
  BLOB_PARSE_FAILED,
  BLOB_UNREADABLE,
} from './blob-population.js';
import type { Projection } from './projection.js';

/** The three tables the line is a function of — every one of them stored. */
export type BlobRefusalRows = Pick<Projection, 'blobs' | 'blobConditions' | 'resourceRealizations'>;

/** One bucket's contribution to the line, in the order the line reads. */
interface RefusalBucket {
  /** How the bucket is named to a user. */
  readonly label: string;
  /** How many distinct blobs or paths it holds. */
  readonly count: number;
}

/**
 * The refusal codes, in the order a reader should meet them.
 *
 * `BLOB_NOT_TEXT` first because it is the expected one — any corpus shipping an
 * image or an archive has it — and the three that follow are progressively more
 * likely to mean something is wrong. Any other condition code (`PARSE_ODDITY`
 * and the rest) describes a blob that WAS derived, so it is not a refusal.
 */
const REFUSAL_CODES: ReadonlyArray<readonly [code: string, label: string]> = [
  [BLOB_NOT_TEXT, 'not text'],
  [BLOB_UNREADABLE, 'unreadable'],
  [BLOB_CONTENT_CHANGED, 'changed under the run'],
  [BLOB_PARSE_FAILED, 'parse failed'],
];

/**
 * The realization states that are refusals, named apart because the remedies
 * differ: one is a permissions problem, the other a file no JS string can hold.
 * `none`, `deferred` and `keyed` are the ordinary shapes of a tree and the
 * demand-driven design working, so they are deliberately absent.
 */
const UNKEYED_STATES = [
  ['unreadable', 'unreadable'],
  ['oversize', 'too large to decode'],
] as const;

/**
 * One bucket as the line spells it — `"2 not text"`.
 *
 * @param bucket - The bucket
 * @returns Its count and label
 */
function countAndLabel(bucket: RefusalBucket): string {
  return `${bucket.count} ${bucket.label}`;
}

/**
 * The non-empty buckets and their total, or undefined when every bucket is empty.
 *
 * @param buckets - Every bucket, in reading order
 * @returns The total and the breakdown text, or undefined
 */
function tally(buckets: readonly RefusalBucket[]): { total: number; breakdown: string } | undefined {
  const present = buckets.filter((bucket) => bucket.count > 0);
  if (present.length === 0) return undefined;
  const total = present.reduce((sum, bucket) => sum + bucket.count, 0);
  return { total, breakdown: present.map(countAndLabel).join(', ') };
}

/**
 * The distinct blobs carrying each refusal code — a blob is counted once
 * however many paths realize it or how many rows restate it.
 *
 * @param rows - The population's rows
 * @returns Each code's distinct blob set, in reading order
 */
function refusedBlobs(rows: BlobRefusalRows): ReadonlyArray<{ label: string; blobs: ReadonlySet<string> }> {
  return REFUSAL_CODES.map(([code, label]) => ({
    label,
    blobs: new Set(rows.blobConditions.filter((row) => row.code === code).map((row) => row.blob)),
  }));
}

/**
 * The clause naming realizations that are in the corpus and got no content key,
 * counted by distinct path, or nothing when every one with bytes was keyed or
 * deliberately deferred.
 *
 * @param rows - The population's rows
 * @returns The clause, or undefined
 */
function describeUnkeyed(rows: BlobRefusalRows): string | undefined {
  const unkeyed = tally(UNKEYED_STATES.map(([state, label]) => ({
    label,
    count: new Set(rows.resourceRealizations.filter((row) => row.contentState === state).map((row) => row.path)).size,
  })));
  return unkeyed === undefined
    ? undefined
    : `could not key ${unkeyed.total} realization(s) (${unkeyed.breakdown})`;
}

/**
 * The clause naming what the population holds decoded WRONGLY, or nothing when
 * every blob decoded cleanly.
 *
 * The BOM split is spelled out only when there is a split to spell: all-assumed
 * is the expected shape (nothing but a BOM ever selects a non-UTF-8 encoding,
 * so a BOM'd blob decoding badly means corrupt bytes rather than a wrong guess).
 *
 * @param rows - The population's rows
 * @param considered - Every blob the population reached a decision about
 * @returns The clause, or undefined when nothing decoded to U+FFFD
 */
function describeMisdecoded(rows: BlobRefusalRows, considered: number): string | undefined {
  const misdecoded = rows.blobs.filter((row) => row.replacementCharacters > 0);
  if (misdecoded.length === 0) return undefined;

  const assumed = misdecoded.filter((row) => row.encodingSource === 'assumed').length;
  const characters = misdecoded.reduce((sum, row) => sum + row.replacementCharacters, 0);
  let basis: string;
  if (assumed === misdecoded.length) {
    basis = 'all with no BOM, so the encoding was assumed';
  } else if (assumed === 0) {
    basis = 'all with a BOM, so the encoding was a fact and the bytes are corrupt';
  } else {
    basis = `${assumed} with no BOM, so the encoding was assumed`;
  }

  return `mis-decoded ${misdecoded.length} of ${considered} blob(s) into `
    + `${characters} replacement character(s) (${basis})`;
}

/**
 * The one line to show a user, or undefined when the population holds no
 * refusal and no mis-decode.
 *
 * Undefined rather than an empty string, so a caller cannot print a blank line
 * by forgetting to check — and so a clean population stays silent, which is the
 * only thing that keeps the line worth reading on a dirty one.
 *
 * @param rows - The population's stored rows, from a derive or a store hit alike
 * @returns A single line naming every non-zero refusal and every mis-decode, or undefined
 */
export function describeBlobRefusals(rows: BlobRefusalRows): string | undefined {
  const refused = refusedBlobs(rows);
  const refusedKeys = new Set(refused.flatMap((bucket) => [...bucket.blobs]));
  // The denominator: every blob the population reached a decision about,
  // derived or declined, each once.
  const considered = new Set([...rows.blobs.map((row) => row.contentKey), ...refusedKeys]).size;

  const clauses: string[] = [];
  const declined = tally(refused.map(({ label, blobs }) => ({ label, count: blobs.size })));
  if (declined !== undefined) {
    clauses.push(`declined ${refusedKeys.size} of ${considered} blob(s) (${declined.breakdown})`);
  }
  const unkeyed = describeUnkeyed(rows);
  if (unkeyed !== undefined) clauses.push(unkeyed);
  const misdecoded = describeMisdecoded(rows, considered);
  if (misdecoded !== undefined) clauses.push(misdecoded);

  if (clauses.length === 0) return undefined;

  // Two different tables answer "which ones", so the pointer names whichever
  // is actually relevant. A mis-decoded blob has NO condition row — it was
  // derived, not declined — so `blob_conditions` alone would send a reader to
  // an empty result set.
  const pointers = ["Per-blob reasons are in the projection's blob_conditions table."];
  if (misdecoded !== undefined) {
    pointers.push('The mis-decoded blobs are the `blobs` rows with replacementCharacters > 0.');
  }
  return `blob derivation ${clauses.join('; ')}. ${pointers.join(' ')}`;
}
