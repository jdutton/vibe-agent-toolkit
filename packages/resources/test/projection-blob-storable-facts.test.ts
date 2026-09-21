/**
 * What a run may file in the SHARED, content-addressed blob tier.
 *
 * A row there must be a pure function of the bytes, because every root on the
 * machine that holds those bytes is served it. `BLOB_UNREADABLE` and
 * `BLOB_CONTENT_CHANGED` are not: each records that one READ, at one path, in one
 * run, failed to observe the bytes at all. Filed, either one marked the key
 * "held" — a key is held when it has a `blobs` row OR a `blob_conditions` row —
 * so a single transient failure stopped those bytes being parsed again, in any
 * repository, until the store was cleared.
 */

import { describe, expect, it } from 'vitest';

import {
  BLOB_CONTENT_CHANGED,
  BLOB_NOT_TEXT,
  BLOB_PARSE_FAILED,
  BLOB_UNREADABLE,
  storableBlobFacts,
} from '../src/projection/blob-population.js';
import { emptyBlobRows } from '../src/projection/store-hydration.js';
import type { BlobConditionRow } from '../src/schemas/projection-blobs.js';

/**
 * One condition row for one key.
 *
 * @param blob - The content key
 * @param code - The condition code
 * @returns The row
 */
function conditionFor(blob: string, code: string): BlobConditionRow {
  return { blob, code, severity: 'warning', message: `${code} happened`, line: null };
}

describe('storableBlobFacts', () => {
  it('keeps the conditions that are facts about the bytes', () => {
    const blobConditions = [conditionFor('k1', BLOB_NOT_TEXT), conditionFor('k2', BLOB_PARSE_FAILED)];
    const stored = storableBlobFacts({ ...emptyBlobRows(), blobConditions });

    expect(stored.blobConditions).toStrictEqual(blobConditions);
  });

  it('drops the conditions that are facts about one read attempt', () => {
    const kept = conditionFor('k3', BLOB_NOT_TEXT);
    const stored = storableBlobFacts({
      ...emptyBlobRows(),
      blobConditions: [conditionFor('k1', BLOB_UNREADABLE), kept, conditionFor('k2', BLOB_CONTENT_CHANGED)],
    });

    // The key those rows named is now held by nothing, so the next run
    // re-derives it instead of being served a failure that may never recur.
    expect(stored.blobConditions).toStrictEqual([kept]);
  });
});
