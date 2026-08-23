/**
 * The line a user sees when the blob stage declined to derive something.
 *
 * These are unit tests over literal report objects rather than over a corpus,
 * deliberately: the property under test is the FORMATTING RULE — which buckets
 * are refusals, which are ordinary shapes of a tree, and what a clean run says —
 * and reaching each of those through a real fixture would mean planting a
 * permissions error, a mid-run edit and a parser crash on one machine. The
 * end-to-end proof that a really-declined binary reaches this function lives in
 * `projection-blob-not-text-binary.test.ts`, over real PNG bytes.
 */
import { describe, expect, it } from 'vitest';

import type { BlobPopulationResult } from '../src/projection/blob-population.js';
import { describeBlobRefusals } from '../src/projection/blob-refusals.js';
import type { BlobPopulationReport } from '../src/projection/merge.js';

/**
 * A run that derived `blobsDerived` blobs and refused nothing.
 *
 * Every bucket named explicitly rather than spread from a partial: a bucket
 * added to `BlobPopulationResult` and forgotten here is a type error, which is
 * the only thing that stops this file silently ignoring a new refusal class.
 *
 * Grouped by what each family MEANS for the line under test, since that is the
 * entire subject of this file: four buckets are refusals, five are ordinary
 * shapes of a tree that must stay silent, two are losses inside a derived blob,
 * and three describe a blob that was derived WRONGLY.
 *
 * @param overrides - The buckets this case is about
 * @returns A complete result
 */
function runOf(overrides: Partial<BlobPopulationResult> = {}): BlobPopulationResult {
  return {
    blobsDerived: 10,
    blobsAlreadyPresent: 0,
    // Refusals: each one is reported, each one has a `blob_conditions` row.
    blobsUnreadable: 0,
    blobsContentChanged: 0,
    blobsParseFailed: 0,
    blobsNotText: 0,
    // Ordinary shapes of a tree, plus deferral. None of these is reported.
    realizationsSkippedDirectory: 0,
    realizationsSkippedAbsent: 0,
    realizationsSkippedDanglingSymlink: 0,
    realizationsSkippedUnkeyed: 0,
    realizationsContentDeferred: 0,
    // Losses inside a blob that WAS derived — no row exists to carry them.
    headingsSkippedForMissingLine: 0,
    referencesSkippedForMissingLine: 0,
    // A blob derived from text that is not what the file says.
    blobsDecodedWithReplacements: 0,
    blobsAssumedEncodingWithReplacements: 0,
    replacementCharacters: 0,
    ...overrides,
  };
}

/** A whole-population report with no post-fixpoint run. */
function reportOf(overrides: Partial<BlobPopulationResult> = {}): BlobPopulationReport {
  return runOf(overrides);
}

describe('describeBlobRefusals', () => {
  it('says nothing at all about a run that refused nothing', () => {
    // Undefined rather than an empty string: a caller that forgets to check
    // would otherwise print a blank line on every clean run, and a warning
    // printed unconditionally is one nobody reads.
    expect(describeBlobRefusals(reportOf())).toBeUndefined();
  });

  it('names each refused bucket with its count, and how many blobs it looked at', () => {
    const line = describeBlobRefusals(reportOf({
      blobsDerived: 1380,
      blobsNotText: 2,
      blobsUnreadable: 1,
    }));

    expect(line).toContain('2 not text');
    expect(line).toContain('1 unreadable');
    expect(line).toContain('declined 3 of 1383 blob(s)');
    // The denominator is the positive control, in the OUTPUT rather than only in
    // a test: "nothing was refused" and "nothing was enumerated" are otherwise
    // the same line, and the second is the failure that actually ships.
    expect(line).toContain('blob_conditions');
  });

  it('reports the two skips no condition row can carry, even with no blob declined', () => {
    // `headingsSkippedForMissingLine` and `referencesSkippedForMissingLine`
    // describe rows that were NEVER EMITTED. There is nothing in the projection
    // to query, so if they do not surface here they do not surface anywhere.
    const line = describeBlobRefusals(reportOf({
      headingsSkippedForMissingLine: 3,
      referencesSkippedForMissingLine: 77,
    }));

    expect(line).toContain('3 heading(s)');
    expect(line).toContain('77 reference(s)');
    expect(line).toContain('for want of a source line');
    // No blob was declined, so the "declined N of M" clause must be absent
    // rather than reading "declined 0".
    expect(line).not.toContain('declined');
  });

  it('reports realizations that could not be keyed, which no blob bucket covers', () => {
    // The one realization-level bucket that is a refusal: `contentState:
    // 'unreadable'` means the read was attempted and threw. There is no content
    // key, so there is no `blob_conditions` row either.
    const line = describeBlobRefusals(reportOf({ realizationsSkippedUnkeyed: 4 }));

    expect(line).toContain('could not key 4 realization(s)');
  });

  it('stays silent for the ordinary shapes of a tree, which are not refusals', () => {
    // Directories, absent paths, dangling symlinks and DEFERRED content are all
    // non-zero on any real repository — `realizationsContentDeferred`'s own
    // docstring calls a non-zero value "the demand-driven keying design doing
    // its job". Reporting them would fire this line on every run, which is how
    // a warning becomes wallpaper.
    expect(describeBlobRefusals(reportOf({
      realizationsSkippedDirectory: 2096,
      realizationsSkippedAbsent: 12,
      realizationsSkippedDanglingSymlink: 1,
      realizationsContentDeferred: 8548,
      blobsAlreadyPresent: 4425,
    }))).toBeUndefined();
  });

  it('describes the post-fixpoint run separately rather than summing the two', () => {
    // `BlobPopulationReport` states the rule this enforces: `blobsAlreadyPresent`
    // counts nearly the whole corpus on the second pass, so there is no honest
    // arithmetic between the runs.
    const line = describeBlobRefusals({
      ...runOf({ blobsDerived: 1380, blobsNotText: 2 }),
      afterClosurePromotion: runOf({
        blobsDerived: 0,
        blobsAlreadyPresent: 1382,
        blobsUnreadable: 1,
      }),
    });

    expect(line).toContain('blob derivation declined 2 of 1382 blob(s)');
    expect(line).toContain('after promotion, declined 1 of 1383 blob(s)');
    // Never a single fused figure — 2 and 1 stay 2 and 1.
    expect(line).not.toContain('declined 3');
  });

  it('names the blobs it mis-decoded, how many characters were lost, and that they were guesses', () => {
    // The failure this whole column set exists for: the blob WAS derived, so no
    // condition row and no refusal bucket describes it. Without this clause a
    // corpus of mojibake reports exactly what a clean corpus reports.
    const line = describeBlobRefusals(reportOf({
      blobsDerived: 1380,
      blobsDecodedWithReplacements: 3,
      blobsAssumedEncodingWithReplacements: 3,
      replacementCharacters: 3200,
    }));

    expect(line).toContain('mis-decoded 3 of 1380 blob(s) into 3200 replacement character(s)');
    expect(line).toContain('all with no BOM, so the encoding was assumed');
    // The pointer names `blobs`, not `blob_conditions`: a mis-decoded blob has
    // no condition row, so the other pointer would send a reader to an empty
    // result set.
    expect(line).toContain('replacementCharacters > 0');
  });

  it('separates the blobs whose encoding was a FACT from the ones that were guessed', () => {
    // A BOM'd blob that still decoded badly is a different diagnosis — corrupt
    // bytes in a known encoding, not the wrong encoding — and the remedy differs.
    const line = describeBlobRefusals(reportOf({
      blobsDecodedWithReplacements: 4,
      blobsAssumedEncodingWithReplacements: 1,
      replacementCharacters: 12,
    }));

    expect(line).toContain('mis-decoded 4 of 10 blob(s) into 12 replacement character(s)');
    expect(line).toContain('1 with no BOM, so the encoding was assumed');
  });

  it('says the encoding was a fact when every mis-decoded blob carried a BOM', () => {
    const line = describeBlobRefusals(reportOf({
      blobsDecodedWithReplacements: 2,
      blobsAssumedEncodingWithReplacements: 0,
      replacementCharacters: 9,
    }));

    expect(line).toContain('all with a BOM, so the encoding was a fact and the bytes are corrupt');
  });

  it('stays silent when every blob decoded cleanly, however many were assumed', () => {
    // `encodingSource: 'assumed'` is true of every ordinary UTF-8 file, so it is
    // deliberately NOT a trigger. A line that fires on every corpus is wallpaper,
    // and then the mojibake case goes unread with it.
    const line = describeBlobRefusals(reportOf({ blobsDerived: 4425 }));
    expect(line).toBeUndefined();
    // Positive control: the same report with one mis-decode DOES speak, so the
    // silence above is the rule firing correctly rather than the clause being
    // unreachable.
    expect(describeBlobRefusals(reportOf({
      blobsDerived: 4425,
      blobsDecodedWithReplacements: 1,
      blobsAssumedEncodingWithReplacements: 1,
      replacementCharacters: 1,
    }))).toContain('mis-decoded 1 of 4425 blob(s)');
  });

  it('stays silent when a post-fixpoint run happened and refused nothing', () => {
    // A second run is not itself a refusal: promotion succeeding is the design
    // working, and this line is only about what was declined.
    expect(describeBlobRefusals({
      ...runOf(),
      afterClosurePromotion: runOf({ blobsDerived: 1, blobsAlreadyPresent: 10 }),
    })).toBeUndefined();
  });
});
