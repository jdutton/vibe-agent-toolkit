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
 * both times, and only one run said so. Every fact this line states is a row of
 * the population's answer:
 *
 * - a declined blob is a `blob_conditions` row coded `BLOB_NOT_TEXT`,
 *   `BLOB_UNREADABLE`, `BLOB_CONTENT_CHANGED`, `BLOB_PARSE_FAILED`,
 *   `BLOB_PARSE_LIMIT_EXCEEDED` or `BLOB_PARSE_WORKER_DIED`;
 * - an unkeyed realization is a `resource_realizations` row whose
 *   `contentState` is `unreadable` or `oversize`;
 * - a mis-decoded blob is a `blobs` row with `replacementCharacters > 0`.
 *
 * Every one of those the store round-trips, with four deliberate exceptions:
 * `BLOB_UNREADABLE` and `BLOB_CONTENT_CHANGED` record one READ at one path, not
 * the bytes, `BLOB_PARSE_LIMIT_EXCEEDED` records one run's limits and
 * `BLOB_PARSE_WORKER_DIED` one thread's death, so `storableBlobFacts` never files them in the shared,
 * content-addressed tier. A store hit therefore does not repeat them — the run
 * that observed the failed read is the one that says so, and the next run that
 * derives the key reads it again. Everything else describes alike on a hit and
 * a derive, and there is one route: the lane that owns the projection hands it
 * here. Run-only counters that no row carries
 * (headings or references dropped for want of a source line) are not reported;
 * an absent row is unqueryable, and a line that only a cold run can print is
 * the defect this shape exists to remove.
 *
 * ## Why a binary at an untyped path is NOT a refusal worth a line
 *
 * Every committed image is a NUL-bearing blob, so a line counting every
 * `BLOB_NOT_TEXT` row fired on nearly every repository on every run — and a
 * line that always fires is read by no one. A not-text blob is reported only
 * when some realization of it is TYPED as text ({@link isTextMimeType}: `.md`,
 * `.json`, a collection's declared `mimeType`), because only there is binary
 * content a surprise. One exception keeps the failure that ships visible: when
 * the population derived NO blob at all, every refusal is reported, so a corpus
 * that is entirely binary still says it read nothing it could use.
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


import { safePath, TextTooLargeError } from '@vibe-agent-toolkit/utils';

import { isTextMimeType } from '../mime-type.js';
import type { NotAdmittedLog } from '../not-admitted.js';
import type { ParseRefusedResource, UnreadableResource } from '../resource-registry.js';

import {
  BLOB_CONTENT_CHANGED,
  BLOB_NOT_TEXT,
  BLOB_PARSE_FAILED,
  BLOB_PARSE_LIMIT_EXCEEDED,
  BLOB_PARSE_WORKER_DIED,
  BLOB_UNREADABLE,
} from './blob-population.js';
import { formatParseFailures, parseFailureOf } from './parse-failure.js';
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
  [BLOB_PARSE_LIMIT_EXCEEDED, 'over a parse limit'],
  [BLOB_PARSE_WORKER_DIED, 'parse worker died'],
];

const REFUSAL_CODE_SET: ReadonlySet<string> = new Set(REFUSAL_CODES.map(([code]) => code));

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
 * A `BLOB_NOT_TEXT` blob counts only when it is a surprise — see the module
 * header, "Why a binary at an untyped path is NOT a refusal worth a line".
 *
 * @param rows - The population's rows
 * @returns Each code's distinct blob set, in reading order
 */
function refusedBlobs(rows: BlobRefusalRows): ReadonlyArray<{ label: string; blobs: ReadonlySet<string> }> {
  const textTyped = new Set(
    rows.resourceRealizations
      .filter((row) => row.contentKey !== null && isTextMimeType(row.mime))
      .map((row) => row.contentKey),
  );
  const reportAll = rows.blobs.length === 0;
  return REFUSAL_CODES.map(([code, label]) => {
    const matching = rows.blobConditions
      .filter((row) => row.code === code && (code !== BLOB_NOT_TEXT || reportAll || textTyped.has(row.blob)));
    return {
      label: code === BLOB_PARSE_FAILED ? withFailureLabels(label, matching) : label,
      blobs: new Set(matching.map((row) => row.blob)),
    };
  });
}

/**
 * The parse-failed label naming what each parse threw ({@link formatParseFailures}): every
 * distinct code first, then the first few messages quoted and a count of the rest, on one line —
 * `parse failed [ERR_WORKER_OUT_OF_MEMORY]`. A worker that ran out of heap is not a corpus
 * fault, and only the code says which it was.
 *
 * @param label - The bucket's bare label
 * @param rows - Its `BLOB_PARSE_FAILED` rows
 * @returns The label, with the failures when any row names one
 */
function withFailureLabels(label: string, rows: ReadonlyArray<{ message: string }>): string {
  const failures = formatParseFailures(rows.flatMap((row) => parseFailureOf(row.message) ?? []));
  return failures === '' ? label : `${label} [${failures}]`;
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
  // derived or declined, each once — a declined image it stays silent about
  // included, since the population did consider it.
  const declinedAtAll = rows.blobConditions.filter((row) => REFUSAL_CODE_SET.has(row.code)).map((row) => row.blob);
  const considered = new Set([...rows.blobs.map((row) => row.contentKey), ...declinedAtAll]).size;

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

  // Three tables answer "which ones", so the pointer names only the ones that
  // hold THIS line's rows: an unkeyed realization has no condition row (it was
  // never read), and a mis-decoded blob has none either (it was derived, not
  // declined) — `blob_conditions` alone would send a reader to an empty result set.
  const pointers: string[] = [];
  if (declined !== undefined) pointers.push("Per-blob reasons are in the projection's blob_conditions table.");
  if (unkeyed !== undefined) {
    pointers.push('The unkeyed paths are the `resource_realizations` rows by contentState.');
  }
  if (misdecoded !== undefined) {
    pointers.push('The mis-decoded blobs are the `blobs` rows with replacementCharacters > 0.');
  }
  return `blob derivation ${clauses.join('; ')}. ${pointers.join(' ')}`;
}

/** The finding code a per-run parse refusal is reported under, from its blob condition code. */
const PARSE_REFUSAL_CODE_OF_BLOB: ReadonlyMap<string, ParseRefusedResource['code']> = new Map([
  [BLOB_PARSE_LIMIT_EXCEEDED, 'RESOURCE_PARSE_LIMIT_EXCEEDED'],
  [BLOB_PARSE_WORKER_DIED, 'RESOURCE_PARSE_WORKER_DIED'],
]);

/**
 * The blob conditions that leave every realization of a blob with no rows: its
 * bytes could not be read, changed under the run, or its parser threw.
 */
const UNADMITTED_BLOB_CODES: ReadonlySet<string> = new Set([BLOB_UNREADABLE, BLOB_CONTENT_CHANGED, BLOB_PARSE_FAILED]);

/** Which of the two logs one realization goes in, and its entry less the path. */
type NotAdmittedEntry =
  | { readonly log: 'unreadable'; readonly entry: Omit<UnreadableResource, 'filePath'> }
  | { readonly log: 'parseRefused'; readonly entry: Omit<ParseRefusedResource, 'filePath'> };

/**
 * The entry for one blob condition row, or `undefined` when the row leaves the
 * blob admitted (`BLOB_NOT_TEXT`, `PARSE_ODDITY`, …).
 *
 * A `BLOB_PARSE_FAILED` row — a stored fact of the bytes — is logged
 * `unreadable` under the code its parser threw (`parseFailureOf`, the one reader
 * of that message), so the file fails `RESOURCE_UNREADABLE` like any other file
 * the run holds no rows for. The registry lane never gets that far: a parse that
 * throws anything but a read failure ends its run.
 *
 * @param row - A blob condition row
 * @returns Its entry, or `undefined`
 */
function blobConditionEntry(row: Projection['blobConditions'][number]): NotAdmittedEntry | undefined {
  const refusalCode = PARSE_REFUSAL_CODE_OF_BLOB.get(row.code);
  if (refusalCode !== undefined) return { log: 'parseRefused', entry: { code: refusalCode, reason: row.message } };
  if (!UNADMITTED_BLOB_CODES.has(row.code)) return undefined;
  const failure = row.code === BLOB_PARSE_FAILED ? parseFailureOf(row.message) : undefined;
  return { log: 'unreadable', entry: { reason: row.message, ...(failure?.kind === 'code' && { code: failure.text }) } };
}

/**
 * The entry for a realization with no content key: `unreadable` and `oversize`
 * are the two states in which the bytes are there and the run holds none of them.
 *
 * @param contentState - The realization's state
 * @returns Its entry, or `undefined` when the state is not a refusal (`none`, `deferred`)
 */
function unkeyedEntry(contentState: Projection['resourceRealizations'][number]['contentState']): NotAdmittedEntry | undefined {
  if (contentState === 'unreadable') {
    return { log: 'unreadable', entry: { reason: 'its bytes could not be read when the realization was keyed' } };
  }
  // The registry lane's code for the same file (`TextTooLargeError`), so both lanes name it alike.
  if (contentState === 'oversize') return { log: 'unreadable', entry: { reason: 'too large to decode', code: TextTooLargeError.code } };
  return undefined;
}

/**
 * Every realization the population enumerated and holds no rows for, in the
 * registry's own two logs — the projection's counterpart of
 * `ResourceRegistry.getNotAdmitted()`, so a lane answering from a projection
 * reports such a file through the same contract (`not-admitted.ts`) as the
 * registry lane, never as though it were absent or admitted:
 *
 * - `unreadable`: a realization whose bytes could not be read or were too large
 *   to decode (`contentState` `unreadable` / `oversize`), and every realization
 *   of a blob that could not be read, changed under the run, or whose parser
 *   threw (`BLOB_UNREADABLE`, `BLOB_CONTENT_CHANGED`, `BLOB_PARSE_FAILED`);
 * - `parseRefused`: every realization of a blob whose parse this run refused
 *   (`BLOB_PARSE_LIMIT_EXCEEDED`, `BLOB_PARSE_WORKER_DIED`).
 *
 * Per REALIZATION, each path once: a condition row is per blob and carries only
 * the reason, so two files holding the same bytes each come back under their own
 * path, and a path several extents realize comes back once. The first condition
 * row of a blob decides it.
 *
 * @param rows - The population's rows (a store hit repeats only `BLOB_PARSE_FAILED`: the per-run rows are never filed)
 * @param root - The absolute root the realizations' paths are relative to
 * @returns The two logs, each in realization order, each entry at its absolute path
 */
export function notAdmittedRealizations(
  rows: Pick<Projection, 'blobConditions' | 'resourceRealizations'>,
  root: string,
): NotAdmittedLog {
  const byBlob = new Map<string, NotAdmittedEntry>();
  for (const row of rows.blobConditions) {
    const found = byBlob.has(row.blob) ? undefined : blobConditionEntry(row);
    if (found !== undefined) byBlob.set(row.blob, found);
  }
  const seen = new Set<string>();
  const log: { unreadable: UnreadableResource[]; parseRefused: ParseRefusedResource[] } = { unreadable: [], parseRefused: [] };
  for (const row of rows.resourceRealizations) {
    const found = row.contentKey === null ? unkeyedEntry(row.contentState) : byBlob.get(row.contentKey);
    if (found === undefined || seen.has(row.path)) continue;
    seen.add(row.path);
    const filePath = safePath.resolve(root, row.path);
    if (found.log === 'parseRefused') log.parseRefused.push({ filePath, ...found.entry });
    else log.unreadable.push({ filePath, ...found.entry });
  }
  return log;
}
