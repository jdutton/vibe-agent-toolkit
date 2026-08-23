/**
 * Turn a {@link BlobPopulationReport} into the one line a user should see when
 * the blob stage declined to derive something — or derived something it cannot
 * vouch for.
 *
 * ## Why this exists at all
 *
 * `looksBinary`'s contract is "this is a refusal, not a silence", and
 * `BlobPopulationResult.blobsNotText` claims to be "what makes the refusal
 * auditable rather than a quiet speed-up". Both were false in every shipped run:
 * `PopulateOptions.onBlobPopulation` was optional, no production caller passed
 * one, and every count the stage computed was dropped at the end of `populate()`.
 * A corpus in which every document was declined as binary produced an empty
 * `blobs` table, exit 0, and no output whatsoever.
 *
 * The condition ROWS survived — `blob_conditions` carries a `BLOB_NOT_TEXT`,
 * `BLOB_UNREADABLE`, `BLOB_CONTENT_CHANGED` or `BLOB_PARSE_FAILED` row per
 * declined blob — so this module deliberately does **not** restate what they
 * hold. It carries the two things they cannot:
 *
 * 1. **The counts.** A row set is only auditable by someone who queries it, and
 *    nobody queries a projection they were never told to look at.
 * 2. **The two skips no row can carry.** `headingsSkippedForMissingLine` and
 *    `referencesSkippedForMissingLine` describe rows that were never emitted, and
 *    an absent row is definitionally unqueryable.
 *
 * ## Why the denominator is in the line
 *
 * "Nothing was refused" and "nothing was enumerated" are the same output
 * otherwise, and the second is the failure mode that actually ships. Naming how
 * many blobs the stage considered makes a line reading `0 of 0` self-refuting.
 *
 * ## Why a mis-decode is reported HERE, next to the refusals
 *
 * It is not a refusal — the blob was read, parsed and stored — so the obvious
 * move is a second reporter beside this one. That would be a mistake, and not
 * only for tidiness: this module's whole subject is *what the run cannot vouch
 * for*, and there is nothing a run can vouch for less than a document it decoded
 * with the wrong encoding. A refused blob is at least visible as a missing row;
 * a mis-decoded one produces a complete, plausible, queryable row full of
 * mojibake, which a byte-level tokenizer will happily embed and index without
 * erroring anywhere. It is strictly the quieter failure, so it belongs in the
 * line that already exists rather than in a second one nobody wired up.
 *
 * `replacementCharacters > 0` is the trigger, and it fires on **proof** rather
 * than on suspicion: the decoder attempts fatal-mode decoding first, so valid
 * input — including a document whose own text contains U+FFFD — reports zero and
 * says nothing here. `encodingSource: 'assumed'` alone is deliberately NOT a
 * trigger: it is true of every ordinary UTF-8 file in every corpus, and a line
 * that fires on all of them is wallpaper within a day.
 */

import type { BlobPopulationResult } from './blob-population.js';
import type { BlobPopulationReport } from './merge.js';

/** One bucket's contribution to the line, in the order the line reads. */
interface RefusalBucket {
  /** How the bucket is named to a user. */
  readonly label: string;
  /** How many blobs it declined. */
  readonly count: number;
}

/**
 * The blob-level refusals, in the order a reader should meet them.
 *
 * `blobsNotText` first because it is the expected one — any corpus shipping an
 * image or an archive reports it — and the three that follow are progressively
 * more likely to mean something is wrong.
 *
 * `realizationsSkippedDirectory`, `realizationsSkippedAbsent`,
 * `realizationsSkippedDanglingSymlink` and `realizationsContentDeferred` are
 * deliberately NOT here. The first three are ordinary shapes of a tree rather
 * than refusals, and the fourth is the demand-driven design working — its own
 * docstring calls a non-zero value "the design doing its job". Reporting them
 * would fire this line on every run over any repository, which is how a warning
 * becomes wallpaper.
 *
 * @param result - One run of the stage
 * @returns The non-empty buckets, in reading order
 */
function refusedBlobs(result: BlobPopulationResult): RefusalBucket[] {
  return [
    { label: 'not text', count: result.blobsNotText },
    { label: 'unreadable', count: result.blobsUnreadable },
    { label: 'changed under the run', count: result.blobsContentChanged },
    { label: 'parse failed', count: result.blobsParseFailed },
  ].filter((bucket) => bucket.count > 0);
}

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
 * Describe one run of the stage, or nothing when it refused nothing and decoded
 * everything cleanly.
 *
 * @param result - One run of the stage
 * @returns The clause for that run, or undefined when there is nothing to report about it
 */
function describeRun(result: BlobPopulationResult): string | undefined {
  const buckets = refusedBlobs(result);
  const refusedTotal = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  // The denominator: every blob the stage reached a decision about, refusals
  // included. `blobsAlreadyPresent` is in it because on the post-fixpoint run
  // that is most of the corpus, and a second run reporting "1 of 1" would
  // understate what it looked at by three orders of magnitude.
  const considered = result.blobsDerived + result.blobsAlreadyPresent + refusedTotal;

  const clauses: string[] = [];
  if (refusedTotal > 0) {
    const breakdown = buckets.map(countAndLabel).join(', ');
    clauses.push(`declined ${refusedTotal} of ${considered} blob(s) (${breakdown})`);
  }

  // Reported even when no blob was declined: these two are skips INSIDE a blob
  // that was otherwise derived successfully, so they are invisible to every
  // bucket above and to every condition row.
  const skipped = [
    { label: 'heading(s)', count: result.headingsSkippedForMissingLine },
    { label: 'reference(s)', count: result.referencesSkippedForMissingLine },
  ].filter((bucket) => bucket.count > 0);
  if (skipped.length > 0) {
    const breakdown = skipped.map(countAndLabel).join(' and ');
    clauses.push(`dropped ${breakdown} for want of a source line`);
  }

  // `realizationsSkippedUnkeyed` is the one realization-level bucket that IS a
  // refusal: its own docstring calls it "the only bucket here that indicates
  // something went wrong rather than something is not a blob or was not asked
  // for".
  if (result.realizationsSkippedUnkeyed > 0) {
    clauses.push(`could not key ${result.realizationsSkippedUnkeyed} realization(s)`);
  }

  const misdecoded = describeMisdecoded(result, considered);
  if (misdecoded !== undefined) clauses.push(misdecoded);

  return clauses.length > 0 ? clauses.join('; ') : undefined;
}

/**
 * The clause naming what this run decoded WRONGLY, or nothing when it decoded
 * everything cleanly.
 *
 * The denominator is the same `considered` the refusal clause uses, for the same
 * reason: "no blob was mis-decoded" and "no blob was looked at" must not print
 * the same way.
 *
 * The BOM split is spelled out only when there is a split to spell — when every
 * mis-decoded blob had its encoding assumed, which is the ordinary case, `(all
 * with no BOM…)` says it once instead of restating the count.
 *
 * @param result - One run of the stage
 * @param considered - Every blob the stage reached a decision about
 * @returns The clause, or undefined when nothing decoded to U+FFFD
 */
function describeMisdecoded(result: BlobPopulationResult, considered: number): string | undefined {
  const blobs = result.blobsDecodedWithReplacements;
  if (blobs === 0) return undefined;

  const assumed = result.blobsAssumedEncodingWithReplacements;
  // Which half of the population is worth naming depends on which one is the
  // exception. All-assumed is the expected shape (nothing but a BOM ever selects
  // a non-UTF-8 encoding, so a BOM'd blob decoding badly means genuinely corrupt
  // bytes rather than a wrong guess), and restating the full count for it would
  // add a number that carries no information.
  let basis: string;
  if (assumed === blobs) {
    basis = 'all with no BOM, so the encoding was assumed';
  } else if (assumed === 0) {
    basis = 'all with a BOM, so the encoding was a fact and the bytes are corrupt';
  } else {
    basis = `${assumed} with no BOM, so the encoding was assumed`;
  }

  return `mis-decoded ${blobs} of ${considered} blob(s) into `
    + `${result.replacementCharacters} replacement character(s) (${basis})`;
}

/**
 * The one line to show a user, or undefined when the run refused nothing.
 *
 * Undefined rather than an empty string, so a caller cannot print a blank line
 * by forgetting to check — and so a clean run stays silent, which is the only
 * thing that keeps the line worth reading on a dirty one.
 *
 * The two runs of the stage are described **separately** rather than summed, for
 * the reason {@link BlobPopulationReport} already gives: `blobsAlreadyPresent`
 * counts nearly the whole corpus on the second pass, so there is no honest
 * arithmetic between them and this function declines to invent one.
 *
 * @param report - What the whole population's blob stage did
 * @returns A single line naming every non-zero refusal and every mis-decode, or undefined
 */
export function describeBlobRefusals(report: BlobPopulationReport): string | undefined {
  const first = describeRun(report);
  const second = report.afterClosurePromotion === undefined
    ? undefined
    : describeRun(report.afterClosurePromotion);

  if (first === undefined && second === undefined) return undefined;

  const parts: string[] = [];
  if (first !== undefined) parts.push(`blob derivation ${first}`);
  if (second !== undefined) parts.push(`after promotion, ${second}`);

  // Two different tables answer "which ones", so the pointer names whichever
  // is actually relevant. A mis-decoded blob has NO condition row — it was
  // derived, not declined — so pointing a reader at `blob_conditions` for it
  // would send them to an empty result set.
  const pointers = ["Per-blob reasons are in the projection's blob_conditions table."];
  if (misdecodedAnywhere(report)) {
    pointers.push('The mis-decoded blobs are the `blobs` rows with replacementCharacters > 0.');
  }
  return `${parts.join('; ')}. ${pointers.join(' ')}`;
}

/**
 * Did either run of the stage mis-decode anything?
 *
 * @param report - What the whole population's blob stage did
 * @returns True when at least one derived blob decoded to U+FFFD
 */
function misdecodedAnywhere(report: BlobPopulationReport): boolean {
  return report.blobsDecodedWithReplacements > 0
    || (report.afterClosurePromotion?.blobsDecodedWithReplacements ?? 0) > 0;
}
